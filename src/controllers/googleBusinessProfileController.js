const {
  OAUTH_STATE_COOKIE,
  createOAuthState,
  getOAuthCookieOptions,
  parseCookies,
  statesMatch,
  getAuthorizationUrl,
  exchangeCodeForTokens,
  saveTokensFromOAuth,
  refreshStoredAccessToken,
  hydrateAccountMetadata,
  getSafeConnectionStatus,
} = require('../services/googleBusinessProfileService');

function queryValue(value) {
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendHtml(res, statusCode, title, message) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return res.status(statusCode).type('html').send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
  </head>
  <body>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
  </body>
</html>`);
}

function clearOAuthStateCookie(res) {
  res.clearCookie(OAUTH_STATE_COOKIE, {
    ...getOAuthCookieOptions(),
    maxAge: 0,
  });
}

// GET /auth/google
const startGoogleBusinessProfileOAuth = async (req, res) => {
  try {
    const state = createOAuthState();
    const authorizationUrl = getAuthorizationUrl(state);

    res.cookie(OAUTH_STATE_COOKIE, state, getOAuthCookieOptions());
    return res.redirect(authorizationUrl);
  } catch (error) {
    console.error('[google-business-profile] Failed to start OAuth:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to start Google Business Profile authorization',
    });
  }
};

// GET /auth/google/callback
const handleGoogleBusinessProfileCallback = async (req, res) => {
  try {
    const errorParam = queryValue(req.query.error);
    if (errorParam) {
      clearOAuthStateCookie(res);
      const description = queryValue(req.query.error_description) || errorParam;
      return sendHtml(
        res,
        400,
        'Google Business Profile authorization failed',
        description
      );
    }

    const code = queryValue(req.query.code);
    const returnedState = queryValue(req.query.state);
    const cookies = parseCookies(req.headers.cookie);
    const expectedState = cookies[OAUTH_STATE_COOKIE];

    if (!statesMatch(expectedState, returnedState)) {
      clearOAuthStateCookie(res);
      return sendHtml(
        res,
        403,
        'Google Business Profile authorization failed',
        'Invalid OAuth state. Please start the connection again.'
      );
    }

    if (!code) {
      clearOAuthStateCookie(res);
      return sendHtml(
        res,
        400,
        'Google Business Profile authorization failed',
        'Missing authorization code.'
      );
    }

    const tokens = await exchangeCodeForTokens(code);
    await saveTokensFromOAuth(tokens);

    let refreshVerified = false;
    try {
      await refreshStoredAccessToken();
      refreshVerified = true;
    } catch (refreshError) {
      console.error(
        '[google-business-profile] Refresh token stored, but immediate refresh failed:',
        refreshError.message
      );
    }

    try {
      await hydrateAccountMetadata();
    } catch (apiError) {
      console.warn(
        '[google-business-profile] OAuth succeeded, but listing Business Profile accounts failed:',
        apiError.message
      );
    }

    clearOAuthStateCookie(res);

    const refreshNote = refreshVerified
      ? 'The stored refresh token was verified and can obtain new access tokens.'
      : 'The connection was saved. If reviews fail later, reconnect to issue a new refresh token.';

    return sendHtml(
      res,
      200,
      'Google Business Profile connected',
      `Authorization complete. This backend can now access the company Google Business Profile. ${refreshNote} You can close this window.`
    );
  } catch (error) {
    console.error('[google-business-profile] OAuth callback failed:', error.message);
    clearOAuthStateCookie(res);
    return sendHtml(
      res,
      500,
      'Google Business Profile authorization failed',
      error.message || 'Could not complete Google Business Profile authorization.'
    );
  }
};

// GET /auth/google/status
const getGoogleBusinessProfileStatus = async (req, res) => {
  try {
    const status = await getSafeConnectionStatus();
    return res.status(200).json(status);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

module.exports = {
  startGoogleBusinessProfileOAuth,
  handleGoogleBusinessProfileCallback,
  getGoogleBusinessProfileStatus,
};
