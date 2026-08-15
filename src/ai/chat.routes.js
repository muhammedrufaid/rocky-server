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
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, message: 'message is required' });
  }
  if (message.length > maxMessageLength) {
    return res.status(400).json({
      success: false,
      message: `message must be at most ${maxMessageLength} characters`,
    });
  }

  req.body.sessionId = sessionId.trim();
  req.body.message = message.trim();
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
