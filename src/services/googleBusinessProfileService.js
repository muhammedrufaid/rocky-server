require('dotenv').config();
const crypto = require('crypto');
const { google } = require('googleapis');
const GoogleBusinessProfileConnection = require('../models/GoogleBusinessProfileConnection');
const { encryptToken, decryptToken } = require('../utils/tokenCrypto');

const CONNECTION_KEY = 'company';
const BUSINESS_MANAGE_SCOPE = 'https://www.googleapis.com/auth/business.manage';
const OAUTH_STATE_COOKIE = 'gbp_oauth_state';
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

function getOAuthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_CALLBACK_URL ||
    'https://backend.rockyrealestate.com/auth/google/callback';

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured');
  }

  return { clientId, clientSecret, redirectUri };
}

function createOAuth2Client() {
  const { clientId, clientSecret, redirectUri } = getOAuthConfig();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function createOAuthState() {
  return crypto.randomBytes(32).toString('hex');
}

function getOAuthCookieOptions() {
  const redirectUri = process.env.GOOGLE_CALLBACK_URL || '';
  const secure = redirectUri.startsWith('https://') || process.env.NODE_ENV === 'production';

  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: OAUTH_STATE_MAX_AGE_MS,
    path: '/auth/google',
  };
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;

  for (const part of String(cookieHeader).split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = part.slice(0, separatorIndex).trim();
    const value = decodeURIComponent(part.slice(separatorIndex + 1).trim());
    cookies[key] = value;
  }

  return cookies;
}

function statesMatch(expected, received) {
  if (!expected || !received) return false;

  const expectedBuffer = Buffer.from(String(expected));
  const receivedBuffer = Buffer.from(String(received));
  if (expectedBuffer.length !== receivedBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function getAuthorizationUrl(state) {
  const oauth2Client = createOAuth2Client();

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [BUSINESS_MANAGE_SCOPE],
    state,
  });
}

async function exchangeCodeForTokens(code) {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

async function getConnectionWithTokens() {
  return GoogleBusinessProfileConnection.findOne({ connectionKey: CONNECTION_KEY }).select(
    '+refreshToken +accessToken'
  );
}

async function persistTokenUpdate(tokens) {
  const connection = await getConnectionWithTokens();
  if (!connection) return;

  if (tokens.access_token) {
    connection.accessToken = encryptToken(tokens.access_token);
  }
  if (tokens.refresh_token) {
    connection.refreshToken = encryptToken(tokens.refresh_token);
  }
  if (tokens.expiry_date) {
    connection.tokenExpiry = new Date(tokens.expiry_date);
  }
  if (tokens.scope) {
    connection.scope = tokens.scope;
  }

  await connection.save();
}

async function upsertConnection({
  accessToken,
  refreshToken,
  tokenExpiry,
  scope,
  googleAccountId,
  googleAccountEmail,
  googleAccountName,
}) {
  const existing = await getConnectionWithTokens();
  const existingRefreshToken = existing?.refreshToken
    ? decryptToken(existing.refreshToken)
    : null;
  const resolvedRefreshToken = refreshToken || existingRefreshToken;

  if (!resolvedRefreshToken) {
    throw new Error(
      'Google did not return a refresh token and no existing token is stored. Reconnect and grant offline access.'
    );
  }

  const payload = {
    connectionKey: CONNECTION_KEY,
    accessToken: accessToken ? encryptToken(accessToken) : existing?.accessToken,
    refreshToken: encryptToken(resolvedRefreshToken),
    tokenExpiry: tokenExpiry || existing?.tokenExpiry,
    scope: scope || existing?.scope || BUSINESS_MANAGE_SCOPE,
    googleAccountId: googleAccountId || existing?.googleAccountId,
    googleAccountEmail: googleAccountEmail || existing?.googleAccountEmail,
    googleAccountName: googleAccountName || existing?.googleAccountName,
    connectedAt: existing?.connectedAt || new Date(),
  };

  if (existing) {
    Object.assign(existing, payload);
    await existing.save();
    return existing;
  }

  return GoogleBusinessProfileConnection.create(payload);
}

async function saveTokensFromOAuth(tokens) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials(tokens);

  let googleAccountId;
  let googleAccountEmail;
  let scope = tokens.scope || BUSINESS_MANAGE_SCOPE;

  if (tokens.access_token) {
    try {
      const tokenInfo = await oauth2Client.getTokenInfo(tokens.access_token);
      googleAccountId = tokenInfo.sub || tokenInfo.user_id || undefined;
      googleAccountEmail = tokenInfo.email || undefined;
      scope = tokenInfo.scopes?.join(' ') || tokenInfo.scope || scope;
    } catch (error) {
      console.warn(
        '[google-business-profile] Could not read token info:',
        error.message
      );
    }
  }

  const connection = await upsertConnection({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    scope,
    googleAccountId,
    googleAccountEmail,
  });

  return connection;
}

/**
 * Loads the stored refresh token and returns an authenticated OAuth2 client.
 * google-auth-library refreshes the access token automatically when needed.
 */
async function getAuthenticatedClient() {
  const connection = await getConnectionWithTokens();
  if (!connection?.refreshToken) {
    throw new Error('Google Business Profile is not connected');
  }

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    refresh_token: decryptToken(connection.refreshToken),
    access_token: connection.accessToken ? decryptToken(connection.accessToken) : undefined,
    expiry_date: connection.tokenExpiry ? connection.tokenExpiry.getTime() : undefined,
    scope: connection.scope,
  });

  oauth2Client.on('tokens', (refreshedTokens) => {
    persistTokenUpdate(refreshedTokens).catch((error) => {
      console.error(
        '[google-business-profile] Failed to persist refreshed tokens:',
        error.message
      );
    });
  });

  return oauth2Client;
}

/**
 * Forces a refresh using the stored refresh token and persists the new access token.
 * Used to verify the OAuth connection after authorization.
 */
async function refreshStoredAccessToken() {
  const connection = await getConnectionWithTokens();
  if (!connection?.refreshToken) {
    throw new Error('Google Business Profile is not connected');
  }

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    refresh_token: decryptToken(connection.refreshToken),
  });

  const accessTokenResponse = await oauth2Client.getAccessToken();
  const credentials = oauth2Client.credentials;

  await persistTokenUpdate({
    access_token: accessTokenResponse?.token || credentials.access_token,
    refresh_token: credentials.refresh_token,
    expiry_date: credentials.expiry_date,
    scope: credentials.scope,
  });

  if (!accessTokenResponse?.token && !credentials.access_token) {
    throw new Error('Failed to obtain a fresh access token from the stored refresh token');
  }

  return {
    refreshed: true,
    tokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
  };
}

async function listAccounts() {
  const auth = await getAuthenticatedClient();
  const accountManagement = google.mybusinessaccountmanagement({
    version: 'v1',
    auth,
  });
  const response = await accountManagement.accounts.list();
  return response.data.accounts || [];
}

async function hydrateAccountMetadata() {
  const accounts = await listAccounts();
  const firstAccount = accounts[0];
  const googleAccountName = firstAccount?.accountName || firstAccount?.name;

  if (!googleAccountName) {
    return accounts;
  }

  await GoogleBusinessProfileConnection.findOneAndUpdate(
    { connectionKey: CONNECTION_KEY },
    { googleAccountName }
  );

  return accounts;
}

async function getSafeConnectionStatus() {
  const connection = await GoogleBusinessProfileConnection.findOne({
    connectionKey: CONNECTION_KEY,
  });

  if (!connection) {
    return {
      connected: false,
      connectedAt: null,
      scope: null,
    };
  }

  return {
    connected: true,
    connectedAt: connection.connectedAt,
    scope: connection.scope || BUSINESS_MANAGE_SCOPE,
  };
}

module.exports = {
  BUSINESS_MANAGE_SCOPE,
  CONNECTION_KEY,
  OAUTH_STATE_COOKIE,
  createOAuthState,
  getOAuthCookieOptions,
  parseCookies,
  statesMatch,
  getAuthorizationUrl,
  exchangeCodeForTokens,
  saveTokensFromOAuth,
  getAuthenticatedClient,
  refreshStoredAccessToken,
  listAccounts,
  hydrateAccountMetadata,
  getSafeConnectionStatus,
};
