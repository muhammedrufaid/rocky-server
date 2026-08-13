/**
 * Minimal client-echoed conversation context for conversion-first multi-turn flows.
 * Stateless: server never persists this — client resends on the next request.
 */

const { sanitizeFunnelStage } = require('./funnelStages');

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
const FLOWS = new Set([
  'property_search',
  'sell_property',
  'service',
  'conversion',
]);
const PENDING = new Set([
  'listingType',
  'propertyType',
  'location',
  'bedrooms',
  'budget',
  'sellPropertyType',
  'sellLocation',
  'sellBuilding',
  'sellPrice',
  'otherArea',
]);
const CONVERSION_LEVELS = new Set(['low', 'medium', 'high', 'very_high']);

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

const sanitizeLocations = (list) => {
  if (!Array.isArray(list)) return [];
  return list
    .map((v) => (typeof v === 'string' ? v.trim().slice(0, 80) : ''))
    .filter(Boolean)
    .slice(0, 5);
};

const sanitizeRecentProperties = (list) => {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 5)
    .map((p, index) => {
      if (!p || typeof p !== 'object') return null;
      return {
        id: typeof p.id === 'string' ? p.id.slice(0, 80) : null,
        title: typeof p.title === 'string' ? p.title.slice(0, 200) : null,
        building: typeof p.building === 'string' ? p.building.slice(0, 120) : null,
        locality: typeof p.locality === 'string' ? p.locality.slice(0, 120) : null,
        url: typeof p.url === 'string' ? p.url.slice(0, 300) : null,
        listingType: LISTING_TYPES.has(p.listingType) ? p.listingType : null,
        price: p.price !== undefined && p.price !== null ? p.price : null,
        index: typeof p.index === 'number' ? p.index : index,
      };
    })
    .filter((p) => p && (p.id || p.url || p.title));
};

/**
 * Safe selected-property summary for conversion (no images, no agent fields).
 * @param {unknown} raw
 */
const sanitizeSelectedProperty = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.slice(0, 200) : null;
  const url = typeof raw.url === 'string' ? raw.url.slice(0, 300) : null;
  if (!title && !url) return null;

  return {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 80) : null,
    title,
    building: typeof raw.building === 'string' ? raw.building.slice(0, 120) : null,
    locality: typeof raw.locality === 'string' ? raw.locality.slice(0, 120) : null,
    url,
    listingType: LISTING_TYPES.has(raw.listingType) ? raw.listingType : null,
    price: raw.price !== undefined && raw.price !== null ? raw.price : null,
  };
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

  if (typeof raw.intent === 'string' && raw.intent.trim()) {
    out.intent = raw.intent.trim().slice(0, 64);
  }

  const funnelStage = sanitizeFunnelStage(raw.funnelStage);
  if (funnelStage) out.funnelStage = funnelStage;

  if (LISTING_TYPES.has(raw.listingType)) {
    out.listingType = raw.listingType;
  }

  if (raw.filters && typeof raw.filters === 'object') {
    out.filters = pickSafeFilters(raw.filters);
  }

  if (typeof raw.search === 'string' && raw.search.trim()) {
    out.search = raw.search.trim().slice(0, 120);
  }

  const locations = sanitizeLocations(raw.locations);
  if (locations.length) out.locations = locations;

  if (PENDING.has(raw.pendingClarification)) {
    out.pendingClarification = raw.pendingClarification;
  }

  if (CONVERSION_LEVELS.has(raw.conversionIntent)) {
    out.conversionIntent = raw.conversionIntent;
  }

  if (raw.budgetMin !== undefined && Number.isFinite(Number(raw.budgetMin))) {
    out.budgetMin = Number(raw.budgetMin);
  }
  if (raw.budgetMax !== undefined && Number.isFinite(Number(raw.budgetMax))) {
    out.budgetMax = Number(raw.budgetMax);
  }

  const recent = sanitizeRecentProperties(raw.recentProperties);
  if (recent.length) out.recentProperties = recent;

  const previousRecent = sanitizeRecentProperties(raw.previousRecentProperties);
  if (previousRecent.length) out.previousRecentProperties = previousRecent;

  const selected = sanitizeSelectedProperty(raw.selectedProperty);
  if (selected) out.selectedProperty = selected;

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
        context.search ||
        (Array.isArray(context.locations) && context.locations.length) ||
        (Array.isArray(context.recentProperties) && context.recentProperties.length))
  );

/**
 * @param {object|null|undefined} context
 * @returns {boolean}
 */
const hasActiveSellFlow = (context) =>
  Boolean(context && context.flow === 'sell_property');

module.exports = {
  sanitizeIncomingContext,
  sanitizeSelectedProperty,
  hasActivePropertyFlow,
  hasActiveSellFlow,
  LISTING_TYPES,
  APPROVED_FILTER_KEYS,
};
