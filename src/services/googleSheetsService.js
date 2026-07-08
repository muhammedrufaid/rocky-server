/**
 * Google Sheets treats values starting with =, +, -, or @ as formulas.
 * A leading apostrophe forces plain-text display (e.g. +971 50 123 4567).
 */
function escapeGoogleSheetCell(value) {
  if (value == null || value === '') return value;
  const str = String(value).trim();
  if (str.startsWith("'")) return str;
  return /^[=+\-@]/.test(str) ? `'${str}` : str;
}

function escapeGoogleSheetPhone(phone) {
  if (phone == null || phone === '') return phone;
  const str = String(phone).trim();
  return str.startsWith("'") ? str : `'${str}`;
}

function sanitizePayloadForGoogleSheets(payload) {
  const sanitized = { ...payload };
  if ('phone' in sanitized) {
    sanitized.phone = escapeGoogleSheetPhone(sanitized.phone);
  }
  for (const key of Object.keys(sanitized)) {
    if (key !== 'phone') {
      sanitized[key] = escapeGoogleSheetCell(sanitized[key]);
    }
  }
  return sanitized;
}

/**
 * POSTs JSON to a Google Apps Script web app that appends a row to Google Sheets.
 * Failures are logged only; this function does not throw.
 *
 * @param {string} envVarName
 * @param {Object} payload
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string }>}
 */
async function sendToGoogleSheet(envVarName, payload) {
  const url = process.env[envVarName];

  if (!url || typeof url !== 'string' || !url.trim()) {
    console.warn(`[Google Sheets] ${envVarName} is not set; skipping`);
    return { ok: false, skipped: true };
  }

  try {
    const response = await fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sanitizePayloadForGoogleSheets(payload)),
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

async function sendCareerToGoogleSheet(payload) {
  return sendToGoogleSheet('GOOGLE_SHEETS_WEBHOOK_URL', payload);
}

async function sendJewelTowerLeadToGoogleSheet(payload) {
  return sendToGoogleSheet('GOOGLE_SHEETS_JEWEL_TOWER_LEAD_URL', payload);
}

async function sendBinghattiLeadToGoogleSheet(payload) {
  return sendToGoogleSheet('GOOGLE_SHEETS_BINGHATTI_LEAD_URL', payload);
}

async function sendLandingPageLeadToGoogleSheet(payload) {
  return sendToGoogleSheet('GOOGLE_SHEETS_LANDING_PAGE_LEAD_URL', payload);
}

module.exports = {
  sendCareerToGoogleSheet,
  sendJewelTowerLeadToGoogleSheet,
  sendBinghattiLeadToGoogleSheet,
  sendLandingPageLeadToGoogleSheet,
};
