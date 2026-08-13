/**
 * Minimal client-echoed conversation context for multi-turn property/sell flows.
 * Stateless: server never persists this — client resends on the next request.
 * Treat as untrusted hints; always re-sanitize filter keys.
 */

const APPROVED_FILTER_KEYS = [
  'propertyType',
  'city',
  'locality',
  'subLocality',
  'towerName',
  'bedrooms',
  'bathrooms',
  'furnished',
  'offPlan',
  'propertyStatus',
  'priceMin',
  'priceMax',
  'propertySizeMin',
  'propertySizeMax',
];

const LISTING_TYPES = new Set(['buy', 'rent', 'off-plan']);
const FLOWS = new Set(['property_search', 'sell_property']);
const PENDING = new Set([
  'listingType',
  'bedrooms',
  'sellPropertyType',
  'sellLocation',
  'sellBuilding',
  'sellPrice',
]);

const pickSafeFilters = (filters) => {
  if (!filters || typeof filters !== 'object') return {};
  const out = {};
  for (const key of APPROVED_FILTER_KEYS) {
    if (filters[key] !== undefined && filters[key] !== null && filters[key] !== '') {
      out[key] = filters[key];
    }
  }
  return out;
};

/**
 * Sanitize inbound context from the client.
 * @param {unknown} raw
 * @returns {object|null}
 */
const sanitizeIncomingContext = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const out = {};

  if (FLOWS.has(raw.flow)) {
    out.flow = raw.flow;
  }

  if (LISTING_TYPES.has(raw.listingType)) {
    out.listingType = raw.listingType;
  }

  if (raw.filters && typeof raw.filters === 'object') {
    out.filters = pickSafeFilters(raw.filters);
  }

  if (typeof raw.search === 'string' && raw.search.trim()) {
    out.search = raw.search.trim().slice(0, 120);
  }

  if (PENDING.has(raw.pendingClarification)) {
    out.pendingClarification = raw.pendingClarification;
  }

  if (raw.sellDraft && typeof raw.sellDraft === 'object') {
    const draft = {};
    for (const key of ['propertyType', 'location', 'building', 'expectedPrice']) {
      if (typeof raw.sellDraft[key] === 'string' && raw.sellDraft[key].trim()) {
        draft[key] = raw.sellDraft[key].trim().slice(0, 200);
      }
    }
    if (Object.keys(draft).length) {
      out.sellDraft = draft;
    }
  }

  return Object.keys(out).length ? out : null;
};

/**
 * @param {object|null|undefined} context
 * @returns {boolean}
 */
const hasActivePropertyFlow = (context) =>
  Boolean(
    context &&
      context.flow === 'property_search' &&
      (context.pendingClarification ||
        context.listingType ||
        (context.filters && Object.keys(context.filters).length) ||
        context.search)
  );

/**
 * @param {object|null|undefined} context
 * @returns {boolean}
 */
const hasActiveSellFlow = (context) =>
  Boolean(context && context.flow === 'sell_property');

module.exports = {
  sanitizeIncomingContext,
  hasActivePropertyFlow,
  hasActiveSellFlow,
  LISTING_TYPES,
};
