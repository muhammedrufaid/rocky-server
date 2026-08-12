/**
 * Phase 1–3 intent router — rules only.
 * Priority: COMPANY → SERVICES → TEAM → PROPERTY_COUNT → PROPERTY_SEARCH → UNSUPPORTED
 *
 * Owner/Founder/Director/established/HQ stay on COMPANY (company.md).
 * Property ownership questions are handled by the confidential guard / refusal paths.
 */

const COMPANY_PATTERNS = [
  /\b(who\s+(is|are)\s+(the\s+)?)?(owner|founder|director)\b/i,
  // Company ownership only — not "who owns this property"
  /\bwho\s+owns\b(?!\s+(?:this|the|a|an|my|our)\b)/i,
  /\b(founded|established|founded\s+by|established\s+in|since\s+when|when\s+was\s+.{0,40}established)\b/i,
  /\b(head\s*office|headquarters|hq|where\s+(are|is)\s+you\s+(based|located)|office\s+address|where\s+is\s+your\s+office)\b/i,
  /\b(tell\s+me\s+about|what\s+is|who\s+is)\s+rocky(\s+real\s+estate)?\b/i,
  /\brocky\s+real\s+estate\b.{0,40}\b(about|overview|history|company)\b/i,
  /\b(company\s+name|key\s+strengths|website)\b/i,
  /\b(about\s+(the\s+)?company|company\s+overview)\b/i,
];

const SERVICE_PATTERNS = [
  /\bwhat\s+services\b/i,
  /\bservices\s+(do|does|are|available|offered|provide|you)\b/i,
  /\byour\s+services\b/i,
  /\b(offer|provide|available)\b.{0,40}\bservices?\b/i,
  /\btell\s+me\s+about\s+(?:your\s+)?services\b/i,
  /\bwhat\s+does\s+rocky.{0,30}\bdo\b/i,
  /\b(property\s+management|professional\s+inspection|brokerage|mortgage|after[\s-]?sales|property\s+listing\s*(?:&|and)?\s*marketing)\b/i,
  /\btell\s+me\s+about\s+(?:your\s+)?(property\s+management|brokerage|mortgage|inspection|listing)\b/i,
  /\bdo\s+you\s+(provide|offer)\b/i,
];

const TEAM_PATTERNS = [
  /\bwho\s+is\s+(?:the\s+)?(ceo|general\s+manager|head\s+of\b)/i,
  /\bwho\s+are\s+(?:the\s+)?(property\s+consultants?|agents?)\b/i,
  /\bproperty\s+consultants?\b/i,
  /\bwho\s+works\s+in\b/i,
  /\btell\s+me\s+about\s+(?!rocky\b)([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)+)\b/i,
  /\bwho\s+is\s+(?!the\s+(?:owner|founder|director)\b)(?!rocky\b)([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)+)\b/i,
  /\bhead\s+of\s+[a-z]/i,
  /\b(ceo|general\s+manager)\b/i,
];

const PROPERTY_COUNT_PATTERNS = [
  /\bhow\s+many\s+(properties|listings|homes|units)\b/i,
  /\b(property|listing)\s+count\b/i,
  /\bnumber\s+of\s+(properties|listings)\b/i,
];

const PROPERTY_SEARCH_PATTERNS = [
  /\b(show|find|list|search|get)\b.{0,40}\b(apartments?|villas?|townhouses?|penthouses?|offices?|properties|listings|homes)\b/i,
  /\b(apartments?|villas?|townhouses?|penthouses?)\s+in\b/i,
  /\bproperties?\s+(under|below|less\s+than|above|over|in|at|for)\b/i,
  /\blistings?\s+(under|below|in|at|for)\b/i,
  /\b(under|below)\s+(?:aed\s*)?[\d,.]+\s*(million|m)?\b.{0,20}\b(propert|listing|apartment|villa)/i,
  /\b(dubai\s+marina|arabian\s+ranches|jvc|jumeirah|palm\s+jumeirah|business\s+bay|downtown)\b/i,
];

/**
 * @param {string} message
 * @returns {'COMPANY_INFO'|'SERVICE_INFO'|'TEAM_INFO'|'PROPERTY_COUNT'|'PROPERTY_SEARCH'|'UNSUPPORTED'}
 */
const classifyIntent = (message) => {
  const text = String(message || '').trim();
  if (!text) return 'UNSUPPORTED';

  for (const pattern of COMPANY_PATTERNS) {
    if (pattern.test(text)) return 'COMPANY_INFO';
  }

  for (const pattern of SERVICE_PATTERNS) {
    if (pattern.test(text)) return 'SERVICE_INFO';
  }

  for (const pattern of TEAM_PATTERNS) {
    if (pattern.test(text)) return 'TEAM_INFO';
  }

  for (const pattern of PROPERTY_COUNT_PATTERNS) {
    if (pattern.test(text)) return 'PROPERTY_COUNT';
  }

  for (const pattern of PROPERTY_SEARCH_PATTERNS) {
    if (pattern.test(text)) return 'PROPERTY_SEARCH';
  }

  return 'UNSUPPORTED';
};

module.exports = {
  classifyIntent,
};
