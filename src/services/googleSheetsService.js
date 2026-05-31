/**
 * POSTs career application data to a Google Apps Script web app
 * that appends a row to Google Sheets.
 * Failures are logged only; this function does not throw.
 *
 * @param {Object} payload
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string }>}
 */
async function sendCareerToGoogleSheet(payload) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;

  if (!url || typeof url !== 'string' || !url.trim()) {
    console.warn('[Google Sheets] GOOGLE_SHEETS_WEBHOOK_URL is not set; skipping');
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
        '[Google Sheets] Webhook returned non-success status:',
        response.status,
        body
      );
      return { ok: false, error: `HTTP ${response.status}` };
    }

    return { ok: true };
  } catch (error) {
    console.error('[Google Sheets] Webhook failed:', error.message);
    return { ok: false, error: error.message };
  }
}

module.exports = {
  sendCareerToGoogleSheet,
};
