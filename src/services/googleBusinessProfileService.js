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

function summarizeAccount(account) {
  return {
    name: account?.name || null,
    accountName: account?.accountName || null,
    type: account?.type || null,
  };
}

function summarizeLocation(location) {
  return {
    name: location?.name || null,
    title: location?.title || null,
  };
}

async function listAccounts() {
  return listBusinessAccounts();
}

async function listBusinessAccounts() {
  const auth = await getAuthenticatedClient();
  const accountManagement = google.mybusinessaccountmanagement({
    version: 'v1',
    auth,
  });

  const accounts = [];
  let pageToken;

  do {
    const response = await accountManagement.accounts.list({
      pageSize: 20,
      pageToken,
    });
    accounts.push(...(response.data.accounts || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  const v4 = await fetchMyBusinessV4Accounts(auth);
  if (!v4.accounts.length) {
    return accounts;
  }

  const byName = new Map();
  for (const account of [...accounts, ...v4.accounts]) {
    if (account?.name) byName.set(account.name, account);
  }
  return Array.from(byName.values());
}

async function fetchMyBusinessV4Accounts(auth) {
  const accounts = [];
  let pageToken;

  try {
    do {
      const response = await auth.request({
        url: 'https://mybusiness.googleapis.com/v4/accounts',
        params: {
          pageSize: 100,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      accounts.push(
        ...(response.data.accounts || []).map((account) => ({
          name: account.name,
          accountName: account.accountName || account.accountNumber || null,
          type: account.type || null,
        }))
      );
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    return { accounts, error: null };
  } catch (error) {
    return {
      accounts,
      error: sanitizeGoogleApiError(error),
    };
  }
}

function sanitizeGoogleApiError(error) {
  const status = error.response?.status || null;
  const data = error.response?.data;
  const googleMessage = data?.error?.message;
  if (googleMessage) {
    return {
      status,
      message: googleMessage,
    };
  }

  const htmlBody = typeof data === 'string' ? data : '';
  if (htmlBody.includes('<html') || htmlBody.includes('<!DOCTYPE html>')) {
    return {
      status,
      message:
        `Google returned HTTP ${status} HTML for this request. ` +
        'This usually means the Google My Business API (mybusiness.googleapis.com) is not enabled on the OAuth Cloud project.',
    };
  }

  return {
    status,
    message: error.message || 'Google Business Profile API request failed',
  };
}

function toPublicLocation(location) {
  if (!location) return null;
  return {
    name: location.name || null,
    title: location.title || location.locationName || null,
    storeCode: location.storeCode || null,
    metadata: location.metadata
      ? {
          placeId: location.metadata.placeId || null,
          mapsUri: location.metadata.mapsUri || null,
          newReviewUri: location.metadata.newReviewUri || null,
          canDelete: location.metadata.canDelete ?? null,
          canHaveFoodMenus: location.metadata.canHaveFoodMenus ?? null,
        }
      : null,
  };
}

async function fetchBusinessInformationLocations(auth, accountName) {
  const businessInformation = google.mybusinessbusinessinformation({
    version: 'v1',
    auth,
  });

  const locations = [];
  const pages = [];
  let pageToken;

  try {
    do {
      const response = await businessInformation.accounts.locations.list({
        parent: accountName,
        readMask: 'name,title,storeCode,metadata',
        pageSize: 100,
        pageToken,
      });
      const pageLocations = response.data.locations || [];
      locations.push(...pageLocations);
      pages.push({
        api: 'mybusinessbusinessinformation.accounts.locations.list',
        httpStatus: response.status,
        locationCount: pageLocations.length,
        responseKeys: Object.keys(response.data || {}),
        nextPageToken: Boolean(response.data.nextPageToken),
      });
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    return { locations, pages, error: null };
  } catch (error) {
    return {
      locations,
      pages,
      error: sanitizeGoogleApiError(error),
    };
  }
}

async function fetchMyBusinessV4Locations(auth, accountName) {
  const locations = [];
  const pages = [];
  let pageToken;

  try {
    do {
      const response = await auth.request({
        url: `https://mybusiness.googleapis.com/v4/${accountName}/locations`,
        params: {
          pageSize: 100,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      const pageLocations = response.data.locations || [];
      locations.push(
        ...pageLocations.map((location) => ({
          name: location.name,
          title: location.locationName || location.title || null,
          storeCode: location.storeCode || location.storeInfo?.storeCode || null,
          metadata: location.metadata || null,
        }))
      );
      pages.push({
        api: 'mybusiness.googleapis.com/v4/{account}/locations',
        httpStatus: response.status,
        locationCount: pageLocations.length,
        responseKeys: Object.keys(response.data || {}),
        nextPageToken: Boolean(response.data.nextPageToken),
      });
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    return { locations, pages, error: null };
  } catch (error) {
    return {
      locations,
      pages,
      error: sanitizeGoogleApiError(error),
    };
  }
}

async function listBusinessLocations(accountName) {
  if (!accountName) {
    throw new Error('A Google Business Profile account name is required to list locations');
  }

  const auth = await getAuthenticatedClient();
  const v1 = await fetchBusinessInformationLocations(auth, accountName);
  if (v1.error) {
    throw new Error(
      v1.error.status
        ? `Google locations API failed (${v1.error.status}): ${v1.error.message}`
        : v1.error.message
    );
  }
  if (v1.locations.length) {
    return v1.locations;
  }

  const v4 = await fetchMyBusinessV4Locations(auth, accountName);
  if (v4.error && v4.error.status !== 404) {
    throw new Error(
      v4.error.status
        ? `Google locations API failed (${v4.error.status}): ${v4.error.message}`
        : v4.error.message
    );
  }
  return v4.locations;
}

function explainMissingLocations({ accounts, locationCount, accountDiagnostics }) {
  if (accounts.length === 0) {
    return 'Google returned no Business Profile accounts for this OAuth connection. Reconnect with a Google account that manages the company listing.';
  }
  if (locationCount > 0) return null;

  const v4Disabled = accountDiagnostics.some(
    (item) => item.myBusinessV4Api?.error?.status === 404
  );
  const personalOnly = accounts.every((account) => account.type === 'PERSONAL');
  const reasons = [
    'Google returned accounts, but no locations were attached to them.',
  ];
  if (personalOnly) {
    reasons.push(
      'Only a PERSONAL account was returned. Company listings usually appear under a LOCATION_GROUP or ORGANIZATION account that this Google user can manage.'
    );
  }
  if (v4Disabled) {
    reasons.push(
      'Google My Business API v4 returned 404, so reviews/locations on mybusiness.googleapis.com are not available on this Cloud project yet.'
    );
  }
  reasons.push(
    'The connected Google user must be an owner or manager of the Google Business Profile listing, and My Business Account Management API plus My Business Business Information API must be enabled.'
  );
  return reasons.join(' ');
}

async function inspectGoogleBusinessProfiles() {
  const connection = await getSafeConnectionStatus();
  if (!connection.connected) {
    return {
      connected: false,
      success: false,
      accounts: [],
      locations: [],
      message:
        'Google Business Profile is not connected. Complete GET /auth/google before listing accounts and locations.',
      diagnostics: null,
    };
  }

  const accounts = await listBusinessAccounts();
  const auth = await getAuthenticatedClient();
  const accountDiagnostics = [];
  const publicAccounts = [];
  const publicLocations = [];

  for (const account of accounts) {
    const v1 = await fetchBusinessInformationLocations(auth, account.name);
    const v4 =
      v1.locations.length || v1.error
        ? { locations: [], pages: [], error: null }
        : await fetchMyBusinessV4Locations(auth, account.name);

    const locations = v1.locations.length ? v1.locations : v4.locations;

    publicAccounts.push({
      name: account.name || null,
      title: account.accountName || null,
      type: account.type || null,
    });

    for (const location of locations) {
      const publicLocation = toPublicLocation(location);
      if (!publicLocation) continue;
      publicLocations.push({
        name: publicLocation.name,
        title: publicLocation.title,
        accountName: account.name || null,
        storeCode: publicLocation.storeCode,
        metadata: publicLocation.metadata,
      });
    }

    accountDiagnostics.push({
      account: account.name,
      businessInformationApi: v1.error
        ? { error: v1.error, pages: v1.pages }
        : { error: null, pages: v1.pages, locationCount: v1.locations.length },
      myBusinessV4Api: v1.locations.length
        ? { skipped: true, reason: 'Business Information API already returned locations' }
        : v4.error
          ? { error: v4.error, pages: v4.pages }
          : { error: null, pages: v4.pages, locationCount: v4.locations.length },
    });
  }

  const locationCount = publicLocations.length;
  const zeroLocationMessage =
    'The connected Google account does not currently have access to any Google Business Profile locations.';

  return {
    connected: true,
    success: true,
    accounts: publicAccounts,
    locations: publicLocations,
    message:
      locationCount === 0
        ? zeroLocationMessage
        : `Google returned ${publicAccounts.length} account(s) and ${locationCount} location(s).`,
    diagnostics: {
      accountCount: publicAccounts.length,
      locationCount,
      google: accountDiagnostics,
      explanation: explainMissingLocations({
        accounts,
        locationCount,
        accountDiagnostics,
      }),
    },
  };
}

function resourceNamesMatch(itemName, configuredName) {
  if (!itemName || !configuredName) return false;
  if (itemName === configuredName) return true;

  const itemParts = String(itemName).split('/').filter(Boolean);
  const configuredParts = String(configuredName).split('/').filter(Boolean);
  const itemTail = itemParts.slice(-2).join('/');
  const configuredTail = configuredParts.slice(-2).join('/');
  if (itemTail && configuredTail && itemTail === configuredTail) return true;

  return itemParts.pop() === configuredParts.pop();
}

function pickConfiguredResource(items, configuredName, resourceLabel, summarize) {
  if (!configuredName) return null;

  const match = items.find((item) => resourceNamesMatch(item?.name, configuredName));
  if (match) return match;

  const summaries = items.map(summarize);
  console.warn(`[google-business-profile] Configured ${resourceLabel} not found:`, configuredName);
  console.warn(`[google-business-profile] Available ${resourceLabel}s:`, summaries);
  throw new Error(
    `Configured Google Business Profile ${resourceLabel} "${configuredName}" was not found. ` +
      `Available: ${summaries.map((item) => item.name).filter(Boolean).join(', ') || '(none)'}`
  );
}

function requireSingleResource(items, resourceLabel, summarize) {
  if (!items.length) {
    throw new Error(
      `Google returned no Business Profile ${resourceLabel}s for this OAuth connection. ` +
        'Reconnect with a Google account that manages the company listing. Do not invent resource names.'
    );
  }

  if (items.length === 1) return items[0];

  const summaries = items.map(summarize);
  console.warn(`[google-business-profile] Multiple ${resourceLabel}s found:`, summaries);
  throw new Error(
    `Google returned multiple Business Profile ${resourceLabel}s. ` +
      'Do not auto-select. Available names: ' +
      summaries.map((item) => item.name).filter(Boolean).join(', ')
  );
}

async function getGoogleBusinessLocation() {
  const accounts = await listBusinessAccounts();
  const configuredAccountName = (process.env.GOOGLE_BUSINESS_ACCOUNT_NAME || '').trim();
  const account =
    pickConfiguredResource(accounts, configuredAccountName, 'account', summarizeAccount) ||
    requireSingleResource(accounts, 'account', summarizeAccount);

  console.log('[google-reviews] Found account:', account.name);

  const locations = await listBusinessLocations(account.name);
  const configuredLocationName = (process.env.GOOGLE_BUSINESS_LOCATION_NAME || '').trim();
  const location =
    pickConfiguredResource(locations, configuredLocationName, 'location', summarizeLocation) ||
    requireSingleResource(locations, 'location', summarizeLocation);

  console.log('[google-reviews] Found location:', location.name);

  return {
    account,
    location,
    accountName: account.name,
    locationName: location.name,
    locationTitle: location.title || location.locationName || null,
  };
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
  listBusinessAccounts,
  listBusinessLocations,
  getGoogleBusinessLocation,
  inspectGoogleBusinessProfiles,
  hydrateAccountMetadata,
  getSafeConnectionStatus,
};
