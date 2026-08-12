/**
 * Confidential / private-data guard.
 * Blocks BEFORE any MongoDB access.
 */

const CONFIDENTIAL_PATTERNS = [
  /\b(customer|client)\s+(leads?|contacts?|data|records?|emails?|phones?|numbers?)\b/i,
  /\b(leads?|crm)\b/i,
  /\b(contacts?)\b.{0,30}\b(mongodb|database|collection|mongo)\b/i,
  /\b(mongodb|database|collection|mongo)\b.{0,30}\b(contacts?|leads?|users?)\b/i,
  /\b(show|give|list|export|dump|share)\b.{0,40}\b(contacts?|leads?|crm)\b/i,
  /\b(show|give|list|export|dump|share)\b.{0,40}\b(contacts?\s+collection|users?\s+collection)\b/i,
  /\b(show|give|list|share|provide)\s+me\s+(the\s+)?(contacts?|users?)(\s+collection)?\b/i,
  /\b(career\s+applications?|job\s+applications?)\b/i,
  /\b(newsletter\s+(subscribers?|users?|list))\b/i,
  /\b(internal\s+users?|admin\s+users?|user\s+accounts?|users?\s+collection)\b/i,
  /\b(private|confidential|personal)\s+(data|information|details|contacts?)\b/i,
  /\b(sell\s+enquir(?:y|ies)|enquiry\s+list)\b/i,
  /\b(property\s+management\s+leads?|area\s+guide\s+leads?|landing\s+page\s+leads?)\b/i,
  /\b(give|show|list|share|provide)\b.{0,40}\b(phone|email|whatsapp|contact)\s*(numbers?|addresses?|details?)?\b/i,
  /\b([A-Za-z]+(?:'s)?)\s+(phone|email|whatsapp)\s*(number|address|details?)?\b/i,
  /\b(phone|email|whatsapp)\s+(numbers?|addresses?|details?)\b.{0,40}\b(agent|team|employee|staff|customer|client|lead|owner)\b/i,
  /\b(agent|team\s*member|employee|staff|team|owner)\b.{0,40}\b(phone|email|whatsapp|contact)\s*(numbers?|addresses?|details?)?\b/i,
  /\b(owner('s)?)\s+(phone|email|whatsapp|contact|details?|information)\b/i,
  /\bwho\s+owns\s+(this|the|a|an|my|our)\s+propert/i,
  /\b(property\s+owner|owner\s+of\s+(this|the)\s+propert)/i,
  /\bbusiness\s*card\b/i,
];

const CONFIDENTIAL_REFUSAL =
  "I can't provide private or confidential customer, lead, or personal contact information.";

/**
 * @param {string} message
 * @returns {{ blocked: boolean, reason?: string }}
 */
const detectConfidentialRequest = (message) => {
  const text = String(message || '').trim();
  if (!text) return { blocked: false };

  for (const pattern of CONFIDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return {
        blocked: true,
        reason: 'confidential_or_private_request',
      };
    }
  }

  return { blocked: false };
};

module.exports = {
  detectConfidentialRequest,
  CONFIDENTIAL_REFUSAL,
};
