const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../middleware/apiKeyMiddleware');
const {
  startGoogleBusinessProfileOAuth,
  handleGoogleBusinessProfileCallback,
  getGoogleBusinessProfileStatus,
} = require('../controllers/googleBusinessProfileController');

// Start company Google Business Profile OAuth (browser redirect; not website login)
router.get('/', startGoogleBusinessProfileOAuth);

// Google OAuth callback — must match the authorized redirect URI
router.get('/callback', handleGoogleBusinessProfileCallback);

// Safe connection status (no tokens). Protected with the existing API key.
router.get('/status', requireApiKey, getGoogleBusinessProfileStatus);

module.exports = router;
