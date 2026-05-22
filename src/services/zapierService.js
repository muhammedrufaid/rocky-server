const ZAPIER_SOURCES = {
  CONTACT_US: 'Contact Us',
  SELL_INQUIRY: 'Sell Inquiry',
  CAREERS: 'Careers',
};

/**
 * POSTs a lead payload to the Zapier Catch Hook URL (same webhook for all forms).
 * Failures are logged only; this function does not throw.
 *
 * @param {Object} payload - Must include `source` (use ZAPIER_SOURCES)
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string }>}
 */
async function sendToZapier(payload) {
  const url = process.env.ZAPIER_WEBHOOK_URL;

  if (!url || typeof url !== 'string' || !url.trim()) {
    console.warn('[Zapier] ZAPIER_WEBHOOK_URL is not set; skipping webhook');
    return { ok: false, skipped: true };
  }

  if (!payload?.source) {
    console.warn('[Zapier] payload missing source; skipping webhook');
    return { ok: false, skipped: true };
  }

  try {
    const response = await fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(
        '[Zapier] Webhook returned non-success status:',
        response.status,
        body
      );
      return { ok: false, error: `HTTP ${response.status}` };
    }

    return { ok: true };
  } catch (error) {
    console.error('[Zapier] Webhook failed:', error.message);
    return { ok: false, error: error.message };
  }
}

module.exports = {
  sendToZapier,
  ZAPIER_SOURCES,
};
