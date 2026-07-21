const ZAPIER_SOURCES = {
  AREA_GUIDES: 'Area Guides',
  CONTACT_US: 'Contact Us',
  SELL_INQUIRY: 'Sell Inquiry',
  JEWEL_TOWER_LEAD: 'Jewel Tower Lead',
  LANDING_PAGE_LEAD: 'Landing Page Lead',
  PROPERTY_MANAGEMENT_LEAD: 'Property Management Lead',

  // CAREERS: 'Careers',
  // DUBAI_SOUTH_LEAD: 'Dubai South Lead',
};

/**
 * POSTs a lead payload to a Zapier Catch Hook URL.
 * Failures are logged only; this function does not throw.
 *
 * @param {string} envVarName
 * @param {Object} payload
 * @param {{ requireSource?: boolean, logLabel?: string }} [options]
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string }>}
 */
async function sendToZapierWebhook(envVarName, payload, options = {}) {
  const { requireSource = true, logLabel = 'Zapier' } = options;
  const url = process.env[envVarName];

  if (!url || typeof url !== 'string' || !url.trim()) {
    console.warn(`[${logLabel}] ${envVarName} is not set; skipping webhook`);
    return { ok: false, skipped: true };
  }

  if (requireSource && !payload?.source) {
    console.warn(`[${logLabel}] payload missing source; skipping webhook`);
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
        `[${logLabel}] Webhook returned non-success status:`,
        response.status,
        body
      );
      return { ok: false, error: `HTTP ${response.status}` };
    }

    return { ok: true };
  } catch (error) {
    console.error(`[${logLabel}] Webhook failed:`, error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * POSTs a lead payload to the shared Zapier Catch Hook URL.
 *
 * @param {Object} payload - Must include `source` (use ZAPIER_SOURCES)
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string }>}
 */
async function sendToZapier(payload) {
  return sendToZapierWebhook('ZAPIER_WEBHOOK_URL', payload);
}

async function sendJewelTowerLeadToZapier(payload) {
  return sendToZapierWebhook('JEWEL_TOWER_ZAPIER_WEBHOOK_URL', payload);
}

module.exports = {
  sendToZapier,
  sendJewelTowerLeadToZapier,
  ZAPIER_SOURCES,
};
