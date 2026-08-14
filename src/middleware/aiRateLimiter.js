/**
 * In-memory rate limiter for AI chat endpoints only.
 *
 * Suitable for a single Node process. Limits are NOT shared across
 * multiple backend instances (no Redis).
 *
 * Local development: set AI_RATE_LIMIT_ENABLED=false to bypass.
 * Production / unset: rate limiting remains enabled.
 */

const rateLimit = require('express-rate-limit');

const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX = 30;

const getWindowMs = () => {
  const raw = process.env.AI_RATE_LIMIT_WINDOW_MS;
  if (!raw || !String(raw).trim()) return DEFAULT_WINDOW_MS;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1000) return DEFAULT_WINDOW_MS;
  return n;
};

const getMax = () => {
  const raw = process.env.AI_RATE_LIMIT_MAX;
  if (!raw || !String(raw).trim()) return DEFAULT_MAX;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX;
  return n;
};

/**
 * AI application rate limit enabled unless explicitly disabled.
 * @returns {boolean}
 */
const isAiRateLimitEnabled = () => {
  const raw = process.env.AI_RATE_LIMIT_ENABLED;
  if (raw === undefined || raw === null || !String(raw).trim()) {
    return true;
  }
  const value = String(raw).trim().toLowerCase();
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no');
};

const passthroughAiRateLimiter = (req, res, next) => next();

/**
 * @param {{ windowMs?: number, max?: number, enabled?: boolean }} [overrides]
 */
const createAiRateLimiter = (overrides = {}) => {
  const enabled =
    overrides.enabled !== undefined
      ? Boolean(overrides.enabled)
      : isAiRateLimitEnabled();

  if (!enabled) {
    return passthroughAiRateLimiter;
  }

  return rateLimit({
    windowMs: overrides.windowMs || getWindowMs(),
    max: overrides.max || getMax(),
    standardHeaders: true,
    legacyHeaders: false,
    // trust proxy is already set to 1 in src/index.js (one hop: nginx/etc.).
    // Disable permissive-trust-proxy validation noise for that intentional config.
    validate: {
      trustProxy: false,
    },
    handler: (req, res) => {
      // Always JSON 429 — never start SSE for rate-limited stream requests.
      return res.status(429).json({
        success: false,
        message: 'Too many AI requests. Please try again later.',
      });
    },
  });
};

/**
 * Rate limiter applied only to POST /api/ai/chat and /api/ai/chat/stream.
 * Runs after requireApiKey (mounted on /api) and before AI controllers.
 */
const aiRateLimiter = createAiRateLimiter();

module.exports = {
  aiRateLimiter,
  createAiRateLimiter,
  isAiRateLimitEnabled,
  getWindowMs,
  getMax,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX,
};
