const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Require a valid logged-in user JWT.
 * Expects: Authorization: Bearer <token>
 *
 * Used together with requireApiKey (global /api):
 *   x-api-key: <API_SECRET_KEY>
 *   Authorization: Bearer <USER_JWT>
 */
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      console.warn('[auth] Missing authentication token');
      return res.status(401).json({
        success: false,
        message: 'Authentication token is required',
      });
    }

    if (!authHeader.startsWith('Bearer ')) {
      console.warn('[auth] Invalid authentication token scheme');
      return res.status(401).json({
        success: false,
        message: 'Unauthorized. Bearer token required',
      });
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      console.warn('[auth] Missing authentication token');
      return res.status(401).json({
        success: false,
        message: 'Authentication token is required',
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      console.warn('[auth] Invalid authentication token');
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
      });
    }

    req.user = user;
    return next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      console.warn('[auth] Invalid authentication token');
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
      });
    }
    if (error.name === 'TokenExpiredError') {
      console.warn('[auth] Invalid authentication token');
      return res.status(401).json({
        success: false,
        message: 'Token expired',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
};

/** Alias used on enquiry/lead admin routes */
const requireUserToken = protect;

module.exports = { protect, requireUserToken };
