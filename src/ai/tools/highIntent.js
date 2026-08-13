/**
 * High-intent / conversion phrase detection and property mention resolution.
 */

const HIGH_INTENT_PATTERNS = [
  /\bi\s+like\s+(this|the|that)\b/i,
  /\bi\s*(?:'|a)?m\s+interested\b/i,
  /\bi\s+want\s+(this|it|that)\b/i,
  /\bi\s+want\s+to\s+(buy|rent)\s+(it|this|that)\b/i,
  /\bcan\s+i\s+(view|see|visit)\s+(it|this|that|the\s+property)?\b/i,
  /\bcan\s+i\s+book\s+a\s+viewing\b/i,
  /\bschedule\s+a\s+viewing\b/i,
  /\bis\s+(it|this|that)\s+(still\s+)?available\b/i,
  /\bcan\s+someone\s+contact\s+me\b/i,
  /\bi\s+need\s+an\s+agent\b/i,
  /\bcan\s+i\s+speak\s+to\s+someone\b/i,
  /\btalk\s+to\s+(an\s+)?agent\b/i,
  /\bspeak\s+(to|with)\s+(an\s+)?agent\b/i,
  /\bwhatsapp\s+rocky\b/i,
  /\bcontact\s+(me|rocky|your\s+team)\b/i,
];

const VIEWING_PATTERNS = [
  /\b(view|viewing|visit|tour|see\s+(it|this|the\s+property))\b/i,
  /\bschedule\s+a\s+viewing\b/i,
  /\bcan\s+i\s+view\b/i,
];

/**
 * @param {string} message
 * @returns {boolean}
 */
const detectHighIntent = (message) => {
  const text = String(message || '').trim();
  if (!text) return false;
  return HIGH_INTENT_PATTERNS.some((re) => re.test(text));
};

/**
 * Detect explicit conversion CTA selection / request.
 * @param {string} message
 * @returns {'whatsapp'|'agent'|'viewing'|'view_more'|'change_search'|'change_area'|'change_budget'|null}
 */
const detectConversionAction = (message) => {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return null;

  if (
    text === 'whatsapp rocky' ||
    text === 'whatsapp' ||
    /\bwhatsapp\s+rocky\b/i.test(text)
  ) {
    return 'whatsapp';
  }
  if (
    text === 'talk to an agent' ||
    text === 'contact rocky' ||
    text === 'talk to rocky' ||
    text === 'contact property management' ||
    /\btalk\s+to\s+(an\s+)?agent\b/i.test(text) ||
    /\btalk\s+to\s+rocky\b/i.test(text) ||
    /\bspeak\s+(to|with)\s+(an\s+)?agent\b/i.test(text) ||
    /\bi\s+need\s+an\s+agent\b/i.test(text)
  ) {
    return 'agent';
  }
  if (
    text === 'schedule a viewing' ||
    /\bschedule\s+a\s+viewing\b/i.test(text) ||
    /\bcan\s+i\s+(view|book\s+a\s+viewing)\b/i.test(text)
  ) {
    return 'viewing';
  }
  if (
    text === "i'm interested" ||
    text === 'im interested' ||
    text === "i am interested" ||
    /^i'?m\s+interested(\s+in\s+(the\s+)?(first|second|third|this|that).*)?$/i.test(
      text
    )
  ) {
    return 'interested';
  }
  if (
    text === 'show closest options' ||
    text === 'show similar properties' ||
    text === 'show similar'
  ) {
    return 'show_similar';
  }
  if (text === 'refine search') {
    return 'refine_search';
  }
  if (text === 'budget' || text === 'bedrooms' || text === 'property type') {
    return 'refine_field';
  }
  if (
    text === 'view more properties' ||
    text === 'view more' ||
    /\bview\s+more\s+propert/i.test(text)
  ) {
    return 'view_more';
  }
  if (text === 'view property' || /\bview\s+property\b/i.test(text)) {
    return 'view_property';
  }
  if (text === 'change search' || /\bchange\s+search\b/i.test(text)) {
    return 'change_search';
  }
  if (text === 'change area' || /\bchange\s+area\b/i.test(text)) {
    return 'change_area';
  }
  if (
    text === 'change budget' ||
    text === 'refine budget' ||
    /\b(change|refine)\s+budget\b/i.test(text)
  ) {
    return 'change_budget';
  }
  return null;
};

/**
 * Resolve ordinal / "this" property references from recent results.
 * @param {string} message
 * @param {object|null} context
 * @returns {object|null} selected recent property summary
 */
const resolvePropertyMention = (message, context = null) => {
  const recent = Array.isArray(context?.recentProperties)
    ? context.recentProperties
    : [];
  if (!recent.length) {
    if (context?.selectedProperty && typeof context.selectedProperty === 'object') {
      return context.selectedProperty;
    }
    return null;
  }

  const text = String(message || '').trim().toLowerCase();

  const ordinals = [
    [/(\bfirst\b|\b1st\b|#\s*1\b)/i, 0],
    [/(\bsecond\b|\b2nd\b|#\s*2\b)/i, 1],
    [/(\bthird\b|\b3rd\b|#\s*3\b)/i, 2],
    [/(\bfourth\b|\b4th\b|#\s*4\b)/i, 3],
    [/(\bfifth\b|\b5th\b|#\s*5\b)/i, 4],
  ];
  for (const [re, idx] of ordinals) {
    if (re.test(text) && recent[idx]) return recent[idx];
  }

  const numMatch = text.match(/\b(?:property|option|one)\s*#?\s*(\d+)\b/i);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (recent[idx]) return recent[idx];
  }

  if (
    /\b(this|that|the)\s+(property|one|listing)\b/i.test(text) ||
    /\bi\s+like\s+(this|it|that)\b/i.test(text) ||
    /\bi\s*(?:'|a)?m\s+interested\b/i.test(text) ||
    /\b(view|available|buy|rent)\s+(it|this)\b/i.test(text)
  ) {
    if (context?.selectedProperty) return context.selectedProperty;
    return recent[0];
  }

  if (context?.selectedProperty) return context.selectedProperty;
  return null;
};

/**
 * @param {string} message
 * @returns {boolean}
 */
const isViewingRequest = (message) =>
  VIEWING_PATTERNS.some((re) => re.test(String(message || '')));

module.exports = {
  detectHighIntent,
  detectConversionAction,
  resolvePropertyMention,
  isViewingRequest,
};
