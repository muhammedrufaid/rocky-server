const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { chat } = require('./chat.controller');

const router = express.Router();

const DEFAULT_ORIGINS = [
  'https://www.rockyrealestate.com',
  'https://rockyrealestate.com',
  'http://localhost:3000',
];

const allowedOrigins = (process.env.CHAT_ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const maxMessageLength = Number(process.env.CHAT_MESSAGE_MAX_LENGTH) || 2000;

const chatCors = cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  },
  credentials: true,
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
});

function restrictChatOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) return next();
  return res.status(403).json({ success: false, message: 'Origin not allowed' });
}

function validateChat(req, res, next) {
  const { sessionId, message } = req.body || {};

  if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
    return res.status(400).json({ success: false, message: 'sessionId is required' });
  }
  if (sessionId.trim().length > 128) {
    return res.status(400).json({ success: false, message: 'sessionId is too long' });
  }

  const action = req.body?.action;
  if (action != null && action !== '') {
    if (typeof action !== 'string') {
      return res.status(400).json({ success: false, message: 'action must be a string' });
    }
    req.body.action = action.trim();
  }

  const hasAction = !!(req.body.action && String(req.body.action).trim());
  if ((!message || typeof message !== 'string' || !message.trim()) && !hasAction) {
    return res.status(400).json({ success: false, message: 'message is required' });
  }
  if (typeof message === 'string' && message.trim()) {
    if (message.length > maxMessageLength) {
      return res.status(400).json({
        success: false,
        message: `message must be at most ${maxMessageLength} characters`,
      });
    }
    req.body.message = message.trim();
  } else if (hasAction) {
    // Structured actions may omit free-text; use a stable label so slot parsers work.
    req.body.message = String(req.body.message || action || 'View properties in these 3 communities').trim();
  }

  req.body.sessionId = sessionId.trim();

  if (req.body.contextKey != null && req.body.contextKey !== '') {
    if (typeof req.body.contextKey !== 'string') {
      return res.status(400).json({ success: false, message: 'contextKey must be a string' });
    }
    req.body.contextKey = req.body.contextKey.trim();
  }
  if (req.body.communities != null) {
    if (!Array.isArray(req.body.communities)) {
      return res.status(400).json({ success: false, message: 'communities must be an array' });
    }
    req.body.communities = req.body.communities
      .map((c) => String(c || '').trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  for (const key of ['propertyRefNo', 'propertyId', 'propertyTitle']) {
    const value = req.body?.[key];
    if (value == null || value === '') continue;
    if (typeof value !== 'string') {
      return res.status(400).json({ success: false, message: `${key} must be a string` });
    }
    req.body[key] = value.trim();
  }
  const intent = req.body?.intent;
  if (intent != null && intent !== '') {
    if (typeof intent !== 'string') {
      return res.status(400).json({ success: false, message: 'intent must be a string' });
    }
    const allowed = ['BUY', 'RENT', 'OFF_PLAN', 'SELL_PROPERTY', 'PROPERTY_MANAGEMENT'];
    const normalized = intent.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!allowed.includes(normalized)) {
      return res.status(400).json({ success: false, message: 'intent is not recognised' });
    }
    req.body.intent = normalized;
  }
  return next();
}

const chatLimiter = rateLimit({
  windowMs: Number(process.env.CHAT_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.CHAT_RATE_LIMIT_MAX) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const sessionId = req.body?.sessionId;
    if (sessionId && typeof sessionId === 'string' && sessionId.trim()) {
      return `chat-session:${sessionId.trim()}`;
    }
    return rateLimit.ipKeyGenerator(req.ip || 'unknown');
  },
  message: { success: false, message: 'Too many chat requests, please try again shortly' },
});

router.use(restrictChatOrigin);
router.use(chatCors);
router.post('/', validateChat, chatLimiter, chat);

module.exports = router;
