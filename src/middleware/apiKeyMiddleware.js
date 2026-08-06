/**
 * Simple shared API key check.
 * Frontend must send:  x-api-key: <API_SECRET_KEY>
 * or: Authorization: Bearer <API_SECRET_KEY>
 */
const requireApiKey = (req, res, next) => {
  const expected = process.env.API_SECRET_KEY;

  if (!expected) {
    return res.status(500).json({
      success: false,
      message: 'API_SECRET_KEY is not configured on the server',
    });
  }

  const fromHeader = req.headers['x-api-key'];
  const fromBearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;

  const provided = fromHeader || fromBearer;

  if (!provided || provided !== expected) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized. Invalid or missing API key',
    });
  }

  next();
};

module.exports = { requireApiKey };
