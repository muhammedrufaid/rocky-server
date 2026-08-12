/**
 * Fixed AI property tools — MongoDB `properties` only via propertyDbService.
 * LLM never constructs Mongo queries.
 */

const propertyDbService = require('../../services/propertyDbService');

const PUBLIC_PROPERTY_FIELDS = [
  'propertyRefNo',
  'propertyTitle',
  'propertyType',
  'propertyPurpose',
  'propertyStatus',
  'propertySize',
  'propertySizeUnit',
  'bedrooms',
  'bathrooms',
  'city',
  'locality',
  'subLocality',
  'towerName',
  'price',
  'rentFrequency',
  'furnished',
  'offPlan',
  'images',
];

const FORBIDDEN_PROPERTY_FIELDS = [
  'listingAgent',
  'listingAgentEmail',
  'listingAgentPhone',
  'owner',
  'ownerPhone',
  'ownerEmail',
  'agentPhone',
  'agentEmail',
  'agentWhatsApp',
  'internalNotes',
  '_id',
  '__v',
  'createdAt',
  'updatedAt',
];

const KNOWN_PROPERTY_TYPES = [
  'Apartment',
  'Villa',
  'Townhouse',
  'Penthouse',
  'Office',
  'Shop',
  'Retail',
  'Showroom',
  'Commercial Land',
  'Residential Land',
  'Labour Camp',
];

const getSearchLimit = () => {
  const n = parseInt(process.env.PROPERTY_AI_SEARCH_LIMIT, 10);
  if (Number.isFinite(n) && n > 0) return Math.min(n, 20);
  return 5;
};

/**
 * Sanitize a property doc to public AI-safe fields only.
 * @param {object} doc
 * @returns {object|null}
 */
const sanitizePublicProperty = (doc) => {
  if (!doc || typeof doc !== 'object') return null;
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : doc;

  const images = Array.isArray(raw.images) ? raw.images.filter(Boolean).slice(0, 1) : [];

  const out = {
    propertyRefNo: raw.propertyRefNo || null,
    propertyTitle: raw.propertyTitle || null,
    propertyType: raw.propertyType || null,
    propertyPurpose: raw.propertyPurpose || null,
    propertyStatus: raw.propertyStatus || null,
    propertySize: raw.propertySize || null,
    propertySizeUnit: raw.propertySizeUnit || null,
    bedrooms: raw.bedrooms || null,
    bathrooms: raw.bathrooms || null,
    city: raw.city || null,
    locality: raw.locality || null,
    subLocality: raw.subLocality || null,
    towerName: raw.towerName || null,
    price: raw.price || null,
    rentFrequency: raw.rentFrequency || null,
    furnished: raw.furnished || null,
    offPlan: raw.offPlan || null,
    image: images[0] || null,
  };

  assertNoPrivatePropertyFields(out);
  return out;
};

/**
 * @param {object|object[]} data
 */
const assertNoPrivatePropertyFields = (data) => {
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const key of FORBIDDEN_PROPERTY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(item, key)) {
        throw new Error(`Property sanitization leaked field: ${key}`);
      }
    }
  }
};

/**
 * Fixed tool: total public property inventory count.
 * Uses existing propertyDbService filters (same as frontend APIs).
 * @param {object} [filters]
 * @returns {Promise<{ count: number, collection: string, filters: object }>}
 */
const getPropertyCount = async (filters = {}) => {
  const safeFilters = pickApprovedFilters(filters);
  const { total } = await propertyDbService.fetchAllProperties({
    page: 1,
    limit: 1,
    filters: safeFilters,
  });

  return {
    count: total || 0,
    collection: 'properties',
    filters: safeFilters,
  };
};

/**
 * Fixed tool: search public properties with allowlisted filters only.
 * @param {object} opts
 * @param {object} [opts.filters]
 * @param {string} [opts.search]
 * @param {number} [opts.limit]
 * @returns {Promise<{ properties: object[], total: number, limit: number, collection: string, filters: object, search: string }>}
 */
const searchPublicProperties = async (opts = {}) => {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || getSearchLimit(), 1), 20);
  const search = typeof opts.search === 'string' ? opts.search.trim() : '';
  const safeFilters = pickApprovedFilters(opts.filters || {});

  const { properties, total } = await propertyDbService.fetchAllProperties({
    page: 1,
    limit,
    search,
    filters: safeFilters,
  });

  const sanitized = (properties || []).map(sanitizePublicProperty).filter(Boolean);
  assertNoPrivatePropertyFields(sanitized);

  return {
    properties: sanitized,
    total: total || 0,
    limit,
    collection: 'properties',
    filters: safeFilters,
    search,
  };
};

/**
 * Only allow filters already supported by frontend property APIs / propertyDbService.
 * @param {object} filters
 */
const pickApprovedFilters = (filters) => {
  if (!filters || typeof filters !== 'object') return {};

  const allowed = [
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

  const out = {};
  for (const key of allowed) {
    if (filters[key] !== undefined && filters[key] !== null && filters[key] !== '') {
      out[key] = filters[key];
    }
  }
  return out;
};

/**
 * Parse a natural-language property search into approved filters + search text.
 * @param {string} message
 * @returns {{ filters: object, search: string }}
 */
const extractPropertySearchQuery = (message) => {
  const text = String(message || '').trim();
  const filters = {};
  let search = '';

  // Property type
  for (const type of KNOWN_PROPERTY_TYPES) {
    const re = new RegExp(`\\b${escapeRegex(type)}s?\\b`, 'i');
    if (re.test(text)) {
      filters.propertyType = type;
      break;
    }
  }
  if (!filters.propertyType && /\bapartments?\b/i.test(text)) {
    filters.propertyType = 'Apartment';
  }
  if (!filters.propertyType && /\bvillas?\b/i.test(text)) {
    filters.propertyType = 'Villa';
  }

  // Purpose
  if (/\bfor\s+rent\b|\bto\s+rent\b|\brentals?\b/i.test(text)) {
    // propertyPurpose is applied via dedicated service methods in public API;
    // propertyDbService also accepts it as a forced match in buy/rent helpers.
    // buildCommonPipeline does not treat propertyPurpose as a list filter unless forced.
    // Use search hint only if needed — prefer dedicated fetch when purpose-only.
  }

  // Price: under / below / less than AED X (million supported)
  const priceMaxMatch = text.match(
    /\b(?:under|below|less\s+than|up\s+to)\s+(?:aed\s*)?([\d,.]+)\s*(million|m)?\b/i
  );
  if (priceMaxMatch) {
    let n = parseFloat(String(priceMaxMatch[1]).replace(/,/g, ''));
    if (Number.isFinite(n)) {
      if (priceMaxMatch[2]) n *= 1_000_000;
      filters.priceMax = n;
    }
  }

  const priceMinMatch = text.match(
    /\b(?:above|over|more\s+than|at\s+least)\s+(?:aed\s*)?([\d,.]+)\s*(million|m)?\b/i
  );
  if (priceMinMatch) {
    let n = parseFloat(String(priceMinMatch[1]).replace(/,/g, ''));
    if (Number.isFinite(n)) {
      if (priceMinMatch[2]) n *= 1_000_000;
      filters.priceMin = n;
    }
  }

  // Bedrooms
  const bedMatch = text.match(/\b(\d+)\s*(?:bed(?:room)?s?|br)\b/i);
  if (bedMatch) {
    filters.bedrooms = bedMatch[1];
  }

  // Location: "in/at/around/near <area>"
  const areaMatch = text.match(
    /\b(?:in|at|around|near)\s+([A-Za-z0-9][A-Za-z0-9\s&()'./-]{1,60}?)(?:\s*[.?!]|$)/i
  );
  if (areaMatch?.[1]) {
    let area = areaMatch[1].trim();
    // Strip trailing price/type fragments if any slipped in
    area = area
      .replace(/\b(under|below|less\s+than|up\s+to|for\s+rent|for\s+sale)\b.*$/i, '')
      .replace(/\b(apartments?|villas?|townhouses?|penthouses?|offices?|properties|listings)\b.*$/i, '')
      .trim()
      .replace(/[.,;:]+$/, '')
      .trim();
    if (area) {
      // Use API `search` (contains across locality/city/tower) — safer than exact locality only
      search = area;
    }
  }

  // Known Dubai areas mentioned without an "in/at" preposition
  if (!search) {
    const knownAreas = [
      'Dubai Marina',
      'Arabian Ranches',
      'Business Bay',
      'Palm Jumeirah',
      'Downtown Dubai',
      'Jumeirah Village Circle',
      'JVC',
      'Dubai Hills',
      'Jumeirah Lake Towers',
      'JLT',
      'Dubai South',
      'Jebel Ali',
    ];
    for (const area of knownAreas) {
      if (new RegExp(`\\b${escapeRegex(area)}\\b`, 'i').test(text)) {
        search = area;
        break;
      }
    }
  }

  return { filters: pickApprovedFilters(filters), search };
};

/**
 * Resolve property search context for PROPERTY_SEARCH intent.
 * Uses existing buy/rent helpers when purpose is explicit; otherwise general search.
 * @param {string} message
 */
const resolvePropertySearchContext = async (message) => {
  const query = extractPropertySearchQuery(message);
  const text = String(message || '');
  const limit = getSearchLimit();

  if (/\bfor\s+rent\b|\bto\s+rent\b/i.test(text)) {
    const rent = await propertyDbService.fetchRentProperties({
      page: 1,
      limit,
      search: query.search,
      filters: query.filters,
    });
    const sanitized = (rent.properties || []).map(sanitizePublicProperty).filter(Boolean);
    assertNoPrivatePropertyFields(sanitized);
    return {
      properties: sanitized,
      total: rent.total || 0,
      limit,
      collection: 'properties',
      filters: query.filters,
      search: query.search,
    };
  }

  if (/\bfor\s+sale\b|\bto\s+buy\b/i.test(text)) {
    const buy = await propertyDbService.fetchBuyProperties({
      page: 1,
      limit,
      search: query.search,
      filters: query.filters,
    });
    const sanitized = (buy.properties || []).map(sanitizePublicProperty).filter(Boolean);
    assertNoPrivatePropertyFields(sanitized);
    return {
      properties: sanitized,
      total: buy.total || 0,
      limit,
      collection: 'properties',
      filters: query.filters,
      search: query.search,
    };
  }

  return searchPublicProperties({
    filters: query.filters,
    search: query.search,
    limit,
  });
};

const formatCountReply = (count) => {
  const formatted = Number(count || 0).toLocaleString('en-US');
  return `There are currently ${formatted} properties in the public property inventory.`;
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
  getPropertyCount,
  searchPublicProperties,
  resolvePropertySearchContext,
  extractPropertySearchQuery,
  sanitizePublicProperty,
  formatCountReply,
  getSearchLimit,
  PUBLIC_PROPERTY_FIELDS,
  FORBIDDEN_PROPERTY_FIELDS,
  pickApprovedFilters,
};
