/**
 * Fixed AI property tools — MongoDB `properties` only via propertyDbService.
 * LLM never constructs Mongo queries.
 */

const propertyDbService = require('../../services/propertyDbService');
const { buildPropertyPublicUrl } = require('./knownLinks');
const {
  listingTypeQuickActions,
  propertyTypeQuickActions,
  locationQuickActions,
  bedroomQuickActions,
  budgetQuickActions,
  fewResultsQuickActions,
  manyResultsRefineQuickActions,
  zeroResultsRecoveryQuickActions,
  budgetZeroRecoveryQuickActions,
} = require('./quickActions');
const { FUNNEL_STAGES } = require('./funnelStages');

/** 1–3 results → show cards + selection CTAs. Above this → show cards + refine options. */
const FEW_RESULTS_MAX = 3;

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
  'embedding',
  'embeddingHash',
  'permitNumber',
  'trakheesiPermitUrl',
];

/**
 * Digits-only phone for tel: links. Returns null if invalid.
 * Never accepts client-supplied phones blindly — callers must pass DB values.
 * @param {unknown} raw
 * @returns {string|null}
 */
const sanitizeListingAgentPhone = (raw) => {
  if (raw === undefined || raw === null) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  // UAE local 05xxxxxxxx → 9715xxxxxxxx
  if (digits.length === 10 && digits.startsWith('0')) {
    digits = `971${digits.slice(1)}`;
  }
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
};

/**
 * Load listing agent contact from Mongo for the currently selected property.
 * Phone/name come ONLY from the DB document matching selectedProperty.id (ref).
 * Never trusts client-echoed listingAgentPhone / listingAgentEmail.
 * @param {{ id?: string|null }|null} selected
 * @returns {Promise<{ found: boolean, listingAgent: string|null, listingAgentPhone: string|null }>}
 */
const fetchListingAgentForSelectedProperty = async (selected) => {
  const ref =
    selected && typeof selected.id === 'string' ? selected.id.trim().slice(0, 80) : '';
  if (!ref) {
    return { found: false, listingAgent: null, listingAgentPhone: null };
  }

  const doc = await propertyDbService.fetchPropertyByRefNo(ref);
  if (!doc || String(doc.propertyRefNo || '').trim() !== ref) {
    return { found: false, listingAgent: null, listingAgentPhone: null };
  }

  const listingAgent =
    typeof doc.listingAgent === 'string' && doc.listingAgent.trim()
      ? doc.listingAgent.trim().slice(0, 120)
      : null;
  const listingAgentPhone = sanitizeListingAgentPhone(doc.listingAgentPhone);

  return { found: true, listingAgent, listingAgentPhone };
};

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
 * Fixed tool: public property inventory count with optional filters/search.
 * Uses the same propertyDbService filtering as property search / frontend APIs.
 * @param {object} [opts]
 * @param {object} [opts.filters]
 * @param {string} [opts.search]
 * @returns {Promise<{ count: number, collection: string, filters: object, search: string }>}
 */
const getPropertyCount = async (opts = {}) => {
  const hasOptsShape =
    Object.prototype.hasOwnProperty.call(opts, 'filters') ||
    Object.prototype.hasOwnProperty.call(opts, 'search');
  const rawFilters = hasOptsShape ? opts.filters || {} : opts;
  const search = hasOptsShape && typeof opts.search === 'string' ? opts.search.trim() : '';
  const safeFilters = pickApprovedFilters(rawFilters);

  const { total } = await propertyDbService.fetchAllProperties({
    page: 1,
    limit: 1,
    search,
    filters: safeFilters,
  });

  return {
    count: total || 0,
    collection: 'properties',
    filters: safeFilters,
    search,
  };
};

/**
 * Resolve property count using the same NL → filter/search parsing as property search.
 * Count always comes from MongoDB via propertyDbService (never RAG / LLM estimates).
 * @param {string} message
 * @returns {Promise<{ count: number, collection: string, filters: object, search: string }>}
 */
const resolvePropertyCountContext = async (message) => {
  const query = extractPropertySearchQuery(message);
  return getPropertyCount({
    filters: query.filters,
    search: query.search,
  });
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
 * Detect buy / rent / off-plan from natural language.
 * @param {string} message
 * @returns {'buy'|'rent'|'off-plan'|null}
 */
const detectListingType = (message) => {
  const text = String(message || '').trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  // Exact quick-action / starter values first
  if (
    lower === 'buy' ||
    lower === 'sale' ||
    lower === 'for sale' ||
    lower === 'buy a property'
  ) {
    return 'buy';
  }
  if (
    lower === 'rent' ||
    lower === 'for rent' ||
    lower === 'rent a property'
  ) {
    return 'rent';
  }
  if (
    lower === 'off-plan' ||
    lower === 'off plan' ||
    lower === 'offplan' ||
    lower === 'off-plan properties' ||
    lower === 'off plan properties' ||
    lower === 'off-plan'
  ) {
    return 'off-plan';
  }

  if (/\boff[\s-]?plan\b/i.test(text)) return 'off-plan';
  if (
    /\b(for\s+rent|to\s+rent|want\s+to\s+rent|looking\s+to\s+rent|rentals?)\b/i.test(
      text
    )
  ) {
    return 'rent';
  }
  // Standalone "rent" as a short selection (already handled), or "rent a ..."
  if (/^\s*rent\b/i.test(text) || /\brent\s+a\b/i.test(text)) return 'rent';
  if (
    /\b(for\s+sale|to\s+buy|want\s+to\s+buy|looking\s+to\s+buy|purchase)\b/i.test(
      text
    )
  ) {
    return 'buy';
  }
  if (/\bbuy\s+a\b/i.test(text) || /^\s*buy\b/i.test(text)) return 'buy';

  return null;
};

/**
 * Parse property-type quick action / short reply.
 * @param {string} message
 * @returns {string|null}
 */
const parsePropertyTypeSelection = (message) => {
  const text = String(message || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  const map = {
    apartment: 'Apartment',
    apartments: 'Apartment',
    villa: 'Villa',
    villas: 'Villa',
    townhouse: 'Townhouse',
    townhouses: 'Townhouse',
    penthouse: 'Penthouse',
    penthouses: 'Penthouse',
    commercial: 'Commercial',
  };
  if (map[lower]) return map[lower];

  for (const type of KNOWN_PROPERTY_TYPES) {
    const re = new RegExp(`\\b${escapeRegex(type)}s?\\b`, 'i');
    if (re.test(text)) return type;
  }
  if (/\bapartments?\b/i.test(text)) return 'Apartment';
  if (/\bvillas?\b/i.test(text)) return 'Villa';
  if (/\btownhouses?\b/i.test(text)) return 'Townhouse';
  if (/\bpenthouses?\b/i.test(text)) return 'Penthouse';
  if (/\bcommercial\b/i.test(text)) return 'Commercial';
  return null;
};

/**
 * Parse location quick action / free-text area.
 * @param {string} message
 * @returns {string|null}
 */
const parseLocationSelection = (message) => {
  const text = String(message || '').trim();
  if (!text) return null;
  if (/^other\s+area$/i.test(text)) return null;

  const knownAreas = [
    'Dubai Marina',
    'Downtown Dubai',
    'Business Bay',
    'Dubai South',
    'Arabian Ranches',
    'Palm Jumeirah',
    'Jumeirah Village Circle',
    'JVC',
    'Dubai Hills',
    'Jumeirah Lake Towers',
    'JLT',
    'Jebel Ali',
  ];
  for (const area of knownAreas) {
    if (new RegExp(`^${escapeRegex(area)}$`, 'i').test(text)) return area;
    if (new RegExp(`\\b${escapeRegex(area)}\\b`, 'i').test(text)) return area;
  }

  // Free-text area during location clarification (keep short)
  if (text.length <= 60 && !/^(buy|rent|off-plan|studio|\d+)$/i.test(text)) {
    return text;
  }
  return null;
};

/**
 * Parse bedroom quick-action / short reply.
 * @param {string} message
 * @returns {string|null} bedrooms filter value
 */
const parseBedroomSelection = (message) => {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return null;

  if (text === 'any' || text === 'any bedrooms') return 'any';
  if (text === 'studio' || text === '0') return '0';
  if (text === '1' || text === '1 bed' || text === '1 bedroom') return '1';
  if (text === '2' || text === '2 bed' || text === '2 bedroom') return '2';
  if (text === '3' || text === '3 bed' || text === '3 bedroom' || text === '3 bedrooms') {
    return '3';
  }
  if (
    text === '4' ||
    text === '4+' ||
    text === '4 bed' ||
    text === '4 bedroom' ||
    text === '4 bedrooms'
  ) {
    return '4';
  }

  const bedMatch = text.match(/\b(\d+)\s*(?:bed(?:room)?s?|br)\b/i);
  if (bedMatch) return bedMatch[1];

  if (/^\d+$/.test(text)) return text;
  if (/\bstudio\b/i.test(text)) return '0';

  return null;
};

/**
 * Parse budget quick-action values or natural-language budget.
 * @param {string} message
 * @returns {{ priceMin?: number, priceMax?: number, flexible?: boolean }|null}
 */
const parseBudgetSelection = (message) => {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return null;

  if (text === 'budget:flexible' || text === 'flexible') {
    return { flexible: true };
  }

  const presets = {
    'budget:buy:under_1m': { priceMax: 1_000_000 },
    'budget:buy:1m_2m': { priceMin: 1_000_000, priceMax: 2_000_000 },
    'budget:buy:2m_5m': { priceMin: 2_000_000, priceMax: 5_000_000 },
    'budget:buy:5m_plus': { priceMin: 5_000_000 },
    'budget:offplan:under_1m': { priceMax: 1_000_000 },
    'budget:offplan:1m_2m': { priceMin: 1_000_000, priceMax: 2_000_000 },
    'budget:offplan:2m_5m': { priceMin: 2_000_000, priceMax: 5_000_000 },
    'budget:offplan:5m_plus': { priceMin: 5_000_000 },
    'budget:rent:under_80k': { priceMax: 80_000 },
    'budget:rent:80k_120k': { priceMin: 80_000, priceMax: 120_000 },
    'budget:rent:120k_200k': { priceMin: 120_000, priceMax: 200_000 },
    'budget:rent:200k_plus': { priceMin: 200_000 },
  };
  if (presets[text]) return presets[text];

  // under 150k / under AED 150,000 / below 2m
  const under = text.match(
    /\b(?:under|below|less\s+than|up\s+to)\s+(?:aed\s*)?([\d,.]+)\s*(k|thousand|million|m)?\b/i
  );
  if (under) {
    let n = parseFloat(String(under[1]).replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    const unit = (under[2] || '').toLowerCase();
    if (unit === 'k' || unit === 'thousand') n *= 1_000;
    if (unit === 'm' || unit === 'million') n *= 1_000_000;
    return { priceMax: n };
  }

  const range = text.match(
    /(?:aed\s*)?([\d,.]+)\s*(k|m|million)?\s*[-–to]+\s*(?:aed\s*)?([\d,.]+)\s*(k|m|million)?/i
  );
  if (range) {
    let min = parseFloat(String(range[1]).replace(/,/g, ''));
    let max = parseFloat(String(range[3]).replace(/,/g, ''));
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const u1 = (range[2] || '').toLowerCase();
    const u2 = (range[4] || '').toLowerCase();
    if (u1 === 'k') min *= 1_000;
    if (u1 === 'm' || u1 === 'million') min *= 1_000_000;
    if (u2 === 'k') max *= 1_000;
    if (u2 === 'm' || u2 === 'million') max *= 1_000_000;
    return { priceMin: min, priceMax: max };
  }

  return null;
};

/**
 * Parse multi-location selections (comma / + / and / JSON array).
 * @param {string} message
 * @returns {string[]}
 */
const parseLocationsSelection = (message) => {
  const text = String(message || '').trim();
  if (!text || /^other\s+area$/i.test(text)) return [];

  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .map((v) => String(v || '').trim())
          .filter(Boolean)
          .slice(0, 5);
      }
    } catch (_) {
      // fall through
    }
  }

  const parts = text
    .split(/\s*(?:,|\+|\/|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length > 1) {
    return parts.slice(0, 5).map((p) => parseLocationSelection(p) || p).filter(Boolean);
  }

  const single = parseLocationSelection(text);
  return single ? [single] : [];
};

/**
 * Parse a natural-language property search into approved filters + search text.
 * @param {string} message
 * @returns {{ filters: object, search: string, listingType: ('buy'|'rent'|'off-plan'|null) }}
 */
const extractPropertySearchQuery = (message) => {
  const text = String(message || '').trim();
  const filters = {};
  let search = '';
  const listingType = detectListingType(text);

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
  if (!filters.propertyType && /\btownhouses?\b/i.test(text)) {
    filters.propertyType = 'Townhouse';
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
  } else if (/\bstudio\b/i.test(text)) {
    filters.bedrooms = '0';
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

  return {
    filters: pickApprovedFilters(filters),
    search,
    listingType,
  };
};

/**
 * Merge extracted query with prior conversation context.
 * @param {string} message
 * @param {object|null} context
 */
const mergePropertySearchState = (message, context = null) => {
  const extracted = extractPropertySearchQuery(message);
  const prevFilters =
    context && context.filters && typeof context.filters === 'object'
      ? pickApprovedFilters(context.filters)
      : {};

  const filters = pickApprovedFilters({
    ...prevFilters,
    ...extracted.filters,
  });

  // Short bedroom-only replies during clarification
  if (
    context?.pendingClarification === 'bedrooms' &&
    extracted.filters.bedrooms === undefined
  ) {
    const bed = parseBedroomSelection(message);
    if (bed === 'any') {
      delete filters.bedrooms;
      // mark as answered so we don't re-ask — use sentinel via context later
    } else if (bed !== null) {
      filters.bedrooms = bed;
    }
  }

  // Budget quick-action / NL during budget clarification or free-text
  const budget = parseBudgetSelection(message);
  if (budget) {
    if (budget.flexible) {
      delete filters.priceMin;
      delete filters.priceMax;
    } else {
      if (budget.priceMin !== undefined) filters.priceMin = budget.priceMin;
      if (budget.priceMax !== undefined) filters.priceMax = budget.priceMax;
    }
  } else if (context?.budgetMax && !filters.priceMax) {
    filters.priceMax = context.budgetMax;
  } else if (context?.budgetMin && !filters.priceMin) {
    filters.priceMin = context.budgetMin;
  }

  // Property type quick-action replies
  if (
    context?.pendingClarification === 'propertyType' &&
    !extracted.filters.propertyType
  ) {
    const type = parsePropertyTypeSelection(message);
    if (type) filters.propertyType = type;
  } else if (!filters.propertyType) {
    const type = parsePropertyTypeSelection(message);
    if (
      type &&
      (context?.flow === 'property_search' ||
        /^(apartment|villa|townhouse|penthouse|commercial)s?$/i.test(
          String(message || '').trim()
        ))
    ) {
      filters.propertyType = type;
    }
  }

  let listingType =
    detectListingType(message) ||
    extracted.listingType ||
    (context && context.listingType) ||
    null;

  if (context?.pendingClarification === 'listingType') {
    const selected = detectListingType(message);
    if (selected) listingType = selected;
  }

  let locations = Array.isArray(context?.locations)
    ? context.locations.filter(Boolean).slice(0, 5)
    : [];

  let search =
    (extracted.search && extracted.search.trim()) ||
    (context && typeof context.search === 'string' && context.search.trim()) ||
    '';

  if (
    context?.pendingClarification === 'location' ||
    context?.pendingClarification === 'otherArea'
  ) {
    const locs = parseLocationsSelection(message);
    if (locs.length) {
      locations = locs;
      search = locs[0];
    } else {
      const loc = parseLocationSelection(message);
      if (loc) {
        search = loc;
        locations = [loc];
      }
    }
  } else if (!extracted.search) {
    const locs = parseLocationsSelection(message);
    if (
      locs.length &&
      context?.flow === 'property_search' &&
      (locs.length > 1 ||
        /^(dubai marina|downtown dubai|business bay|dubai south|arabian ranches|palm jumeirah|jvc|jlt|dubai hills|jebel ali|jumeirah)$/i.test(
          String(message || '').trim()
        ))
    ) {
      locations = locs;
      search = locs[0];
    }
  }

  if (!search && locations.length) {
    search = locations[0];
  }

  // Change area / change budget intents clear the relevant field
  const lower = String(message || '').trim().toLowerCase();
  if (lower === 'change area') {
    search = '';
    locations = [];
  }
  if (lower === 'change budget' || lower === 'refine budget') {
    delete filters.priceMin;
    delete filters.priceMax;
  }
  if (lower === 'change search') {
    return {
      filters: {},
      search: '',
      locations: [],
      listingType: listingType || context?.listingType || null,
      resetPending: true,
      bedroomsAny: false,
    };
  }

  const bedroomsAny =
    parseBedroomSelection(message) === 'any' ||
    context?.bedroomsAny === true;

  if (bedroomsAny) {
    delete filters.bedrooms;
  }

  return { filters, search, listingType, locations, bedroomsAny };
};

/**
 * Enough to search: listing type + property type + location.
 * Bedrooms and budget are optional (budget asked only if results are too large).
 * @param {{ listingType: string|null, filters: object, search: string, locations?: string[] }} state
 */
const hasEnoughToSearch = (state) => {
  if (!state.listingType) return false;
  if (!state.filters?.propertyType) return false;
  const hasLocation =
    (state.search && String(state.search).trim()) ||
    (Array.isArray(state.locations) && state.locations.length > 0);
  return Boolean(hasLocation);
};

/**
 * Next missing clarification step for guided funnel.
 * Order: listingType → propertyType → location
 * Bedrooms/budget are optional refinements (budget when results are large).
 * @param {{ listingType: string|null, filters: object, search: string, locations?: string[], bedroomsAny?: boolean }} state
 * @returns {string|null}
 */
const nextMissingClarification = (state) => {
  if (!state.listingType) return 'listingType';
  if (!state.filters?.propertyType) return 'propertyType';
  const hasLocation =
    (state.search && String(state.search).trim()) ||
    (Array.isArray(state.locations) && state.locations.length > 0);
  if (!hasLocation) return 'location';
  return null;
};

/**
 * Map a sanitized public property to a safe property-card payload.
 * @param {object} sanitized
 * @param {'buy'|'rent'|'off-plan'} listingType
 */
const toPropertyCard = (sanitized, listingType) => {
  if (!sanitized || typeof sanitized !== 'object') return null;
  const ref = sanitized.propertyRefNo || null;
  const url = buildPropertyPublicUrl(listingType, ref);

  let pricePeriod = null;
  if (listingType === 'rent') {
    pricePeriod = sanitized.rentFrequency || 'year';
  }

  const card = {
    id: ref,
    title: sanitized.propertyTitle || null,
    building: sanitized.towerName || null,
    locality: sanitized.locality || null,
    subLocality: sanitized.subLocality || null,
    propertyType: sanitized.propertyType || null,
    bedrooms: sanitized.bedrooms || null,
    bathrooms: sanitized.bathrooms || null,
    size: sanitized.propertySize || null,
    price: sanitized.price || null,
    pricePeriod,
    listingType,
    url,
    image: sanitized.image || null,
    ctaLabel: 'View Property',
  };

  assertNoPrivatePropertyFields(card);
  return card;
};

/**
 * Fetch properties for an explicit listing type using existing DbService helpers.
 * @param {{ listingType: string, filters: object, search: string, limit?: number }} opts
 */
const searchByListingType = async (opts) => {
  const listingType = opts.listingType;
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || getSearchLimit(), 1), 20);
  const search = typeof opts.search === 'string' ? opts.search.trim() : '';
  const safeFilters = pickApprovedFilters(opts.filters || {});

  let result;
  if (listingType === 'rent') {
    result = await propertyDbService.fetchRentProperties({
      page: 1,
      limit,
      search,
      filters: safeFilters,
    });
  } else if (listingType === 'off-plan') {
    result = await propertyDbService.fetchOffPlanProperties({
      page: 1,
      limit,
      search,
      filters: safeFilters,
    });
  } else if (listingType === 'buy') {
    result = await propertyDbService.fetchBuyProperties({
      page: 1,
      limit,
      search,
      filters: safeFilters,
    });
  } else {
    result = await propertyDbService.fetchAllProperties({
      page: 1,
      limit,
      search,
      filters: safeFilters,
    });
  }

  const sanitized = (result.properties || []).map(sanitizePublicProperty).filter(Boolean);
  assertNoPrivatePropertyFields(sanitized);

  const cards = sanitized
    .map((p) => toPropertyCard(p, listingType))
    .filter(Boolean);

  return {
    properties: cards,
    sanitized,
    total: result.total || 0,
    limit,
    collection: 'properties',
    filters: safeFilters,
    search,
    listingType,
  };
};

/**
 * Concise human reply for structured property results (no GPT listing text).
 * @param {{ properties: object[], total: number, listingType: string, filters: object, search: string }} result
 * @param {'few'|'many'} [mode]
 */
const formatPropertySearchReply = (result, mode = 'few') => {
  const shown = Array.isArray(result.properties) ? result.properties.length : 0;
  const total = result.total || 0;
  if (total === 0 || shown === 0) {
    return "I couldn't find an exact match. Would you like to try nearby options?";
  }

  const type = result.filters?.propertyType
    ? String(result.filters.propertyType).toLowerCase()
    : 'propert';
  const typeLabel =
    type === 'propert' ? 'properties' : type.endsWith('s') ? type : `${type}s`;

  const beds = result.filters?.bedrooms;
  const bedLabel =
    beds === '0' || beds === 0
      ? 'studio '
      : beds
        ? `${beds}-bedroom `
        : '';

  const area = result.search ? ` in ${result.search}` : '';

  if (mode === 'many') {
    return `I found several ${bedLabel}${typeLabel}${area}. Want to narrow them down?`;
  }

  const n = Math.min(shown, total);
  return `I found ${n} ${bedLabel}${typeLabel}${area}.`.replace(/\s+/g, ' ').trim();
};

/**
 * Build recent-properties summary for conversation context.
 * @param {object[]} cards
 */
const toRecentProperties = (cards) =>
  (Array.isArray(cards) ? cards : []).slice(0, 5).map((p, index) => ({
    id: p.id || null,
    title: p.title || null,
    building: p.building || null,
    locality: p.locality || null,
    url: p.url || null,
    listingType: p.listingType || null,
    price: p.price ?? null,
    index,
  }));

/**
 * Clarification response helper.
 * @param {string} reply
 * @param {object} quick_actions
 * @param {object} partial
 */
const clarificationResult = (reply, quick_actions, partial) => {
  const out = {
    kind: 'clarification',
    reply,
    context: {
      flow: 'property_search',
      intent: 'PROPERTY_SEARCH',
      funnelStage: FUNNEL_STAGES.PROPERTY_REQUIREMENTS,
      conversionIntent: 'medium',
      ...partial,
    },
    openaiCalls: 0,
  };
  if (quick_actions) out.quick_actions = quick_actions;
  return out;
};

/**
 * Zero-result recovery while preserving prior successful results when available.
 * @param {object} state
 * @param {object|null} context
 * @param {{ refinedBudget?: boolean }} [meta]
 */
const buildZeroResultRecovery = (state, context = null, meta = {}) => {
  const priorRecent = Array.isArray(context?.recentProperties)
    ? context.recentProperties
    : Array.isArray(context?.previousRecentProperties)
      ? context.previousRecentProperties
      : [];

  const typeRaw = state.filters?.propertyType
    ? String(state.filters.propertyType)
    : 'property';
  const typeLabel = typeRaw.toLowerCase();
  const area = state.search ? ` in ${state.search}` : '';
  const budgetBit =
    meta.refinedBudget && state.filters?.priceMax
      ? ` under AED ${Number(state.filters.priceMax).toLocaleString('en-US')}`
      : meta.refinedBudget
        ? ' with that budget'
        : '';

  if (meta.refinedBudget && priorRecent.length) {
    return {
      kind: 'recovery',
      reply: `I couldn't find ${
        /^[aeiou]/i.test(typeLabel) ? 'an' : 'a'
      } ${typeLabel}${area}${budgetBit}. Would you like to see the closest available options?`,
      quick_actions: budgetZeroRecoveryQuickActions(),
      context: {
        flow: 'property_search',
        intent: 'PROPERTY_SEARCH',
        funnelStage: FUNNEL_STAGES.PROPERTY_RESULTS,
        listingType: state.listingType,
        filters: state.filters,
        search: state.search,
        locations: state.locations || [],
        bedroomsAny: state.bedroomsAny || false,
        budgetMin: state.filters?.priceMin,
        budgetMax: state.filters?.priceMax,
        pendingClarification: null,
        recentProperties: priorRecent,
        previousRecentProperties: priorRecent,
        selectedProperty: context?.selectedProperty || null,
        conversionIntent: 'medium',
      },
      openaiCalls: 0,
    };
  }

  return {
    kind: 'recovery',
    reply: "I couldn't find an exact match. Would you like to try nearby options?",
    quick_actions: zeroResultsRecoveryQuickActions(),
    context: {
      flow: 'property_search',
      intent: 'PROPERTY_SEARCH',
      funnelStage: FUNNEL_STAGES.PROPERTY_RESULTS,
      listingType: state.listingType,
      filters: state.filters,
      search: state.search,
      locations: state.locations || [],
      bedroomsAny: state.bedroomsAny || false,
      budgetMin: state.filters?.priceMin,
      budgetMax: state.filters?.priceMax,
      pendingClarification: null,
      recentProperties: priorRecent,
      previousRecentProperties: priorRecent.length ? priorRecent : undefined,
      selectedProperty: context?.selectedProperty || null,
      conversionIntent: 'medium',
    },
    openaiCalls: 0,
  };
};

/**
 * Search immediately when listingType + propertyType + location are known.
 * Result count controls next actions — budget is never a mandatory pre-search gate.
 * @param {object} state
 * @param {object|null} context
 * @param {{ refinedBudget?: boolean }} [opts]
 */
const buildResultsPayload = async (state, context = null, opts = {}) => {
  const result = await searchByListingType({
    listingType: state.listingType,
    filters: state.filters,
    search: state.search,
  });

  const total = result.total || 0;

  if (total === 0 || !result.properties.length) {
    return buildZeroResultRecovery(state, context, {
      refinedBudget: Boolean(opts.refinedBudget),
    });
  }

  const recentProperties = toRecentProperties(result.properties);
  const few = total <= FEW_RESULTS_MAX;
  const mode = few ? 'few' : 'many';

  return {
    kind: 'results',
    reply: formatPropertySearchReply(result, mode),
    property_results: {
      properties: result.properties,
      total,
    },
    quick_actions: few
      ? fewResultsQuickActions()
      : manyResultsRefineQuickActions(),
    context: {
      flow: 'property_search',
      intent: 'PROPERTY_SEARCH',
      funnelStage: FUNNEL_STAGES.PROPERTY_RESULTS,
      listingType: state.listingType,
      filters: state.filters,
      search: state.search,
      locations: state.locations || [],
      bedroomsAny: state.bedroomsAny || false,
      budgetMin: state.filters?.priceMin,
      budgetMax: state.filters?.priceMax,
      pendingClarification: null,
      recentProperties,
      previousRecentProperties: recentProperties,
      selectedProperty: context?.selectedProperty || null,
      conversionIntent: 'medium',
    },
    openaiCalls: 0,
  };
};

/**
 * Re-run search without budget filters (closest / similar options).
 * @param {object|null} context
 */
const searchWithoutBudget = async (context = null) => {
  const filters = { ...(context?.filters || {}) };
  delete filters.priceMin;
  delete filters.priceMax;
  const state = {
    listingType: context?.listingType || null,
    filters,
    search: context?.search || '',
    locations: context?.locations || [],
    bedroomsAny: context?.bedroomsAny || false,
  };
  if (!hasEnoughToSearch(state)) {
    return clarificationResult(
      'Which area are you interested in?',
      locationQuickActions(),
      {
        listingType: state.listingType,
        filters: state.filters,
        search: '',
        locations: [],
        pendingClarification: 'location',
        recentProperties: context?.recentProperties || context?.previousRecentProperties,
        selectedProperty: context?.selectedProperty,
      }
    );
  }
  return buildResultsPayload(state, {
    ...context,
    filters,
    recentProperties: context?.previousRecentProperties || context?.recentProperties,
  });
};

/**
 * Conversational property search: only ask for missing filters, then structured results.
 * Does not guess buy/rent/off-plan. Does not re-ask known fields.
 * @param {string} message
 * @param {object|null} [context]
 */
const resolveConversationalPropertySearch = async (message, context = null) => {
  const lower = String(message || '').trim().toLowerCase();

  // Show closest / similar → re-search without budget, keep prior context
  if (
    (lower === 'show closest options' ||
      lower === 'show similar properties' ||
      lower === 'show similar') &&
    context?.flow === 'property_search'
  ) {
    return searchWithoutBudget(context);
  }

  // Many-results refinement menu shortcuts
  if (context?.flow === 'property_search') {
    if (lower === 'budget' || lower === 'refine budget' || lower === 'change budget') {
      const qa = budgetQuickActions(context.listingType);
      return clarificationResult(qa.question, qa, {
        listingType: context.listingType,
        filters: context.filters || {},
        search: context.search || '',
        locations: context.locations || [],
        pendingClarification: 'budget',
        recentProperties: context.recentProperties,
        previousRecentProperties:
          context.previousRecentProperties || context.recentProperties,
        selectedProperty: context.selectedProperty,
      });
    }
    if (lower === 'bedrooms') {
      const qa = bedroomQuickActions();
      return clarificationResult(qa.question, qa, {
        listingType: context.listingType,
        filters: context.filters || {},
        search: context.search || '',
        locations: context.locations || [],
        pendingClarification: 'bedrooms',
        recentProperties: context.recentProperties,
        previousRecentProperties:
          context.previousRecentProperties || context.recentProperties,
        selectedProperty: context.selectedProperty,
      });
    }
    if (lower === 'property type') {
      const filters = { ...(context.filters || {}) };
      delete filters.propertyType;
      const qa = propertyTypeQuickActions(true);
      return clarificationResult(qa.question, qa, {
        listingType: context.listingType,
        filters,
        search: context.search || '',
        locations: context.locations || [],
        pendingClarification: 'propertyType',
        recentProperties: context.recentProperties,
        previousRecentProperties:
          context.previousRecentProperties || context.recentProperties,
        selectedProperty: context.selectedProperty,
      });
    }
    if (lower === 'refine search') {
      return clarificationResult(
        'Want to narrow them down?',
        manyResultsRefineQuickActions(),
        {
          listingType: context.listingType,
          filters: context.filters || {},
          search: context.search || '',
          locations: context.locations || [],
          recentProperties: context.recentProperties,
          previousRecentProperties:
            context.previousRecentProperties || context.recentProperties,
          selectedProperty: context.selectedProperty,
          funnelStage: FUNNEL_STAGES.PROPERTY_RESULTS,
        }
      );
    }
  }

  // Change-area
  if (lower === 'change area' && context?.flow === 'property_search') {
    const state = mergePropertySearchState(message, context);
    const qa = locationQuickActions();
    return clarificationResult(qa.question, qa, {
      listingType: state.listingType,
      filters: state.filters,
      search: '',
      locations: [],
      pendingClarification: 'location',
      recentProperties: context.recentProperties,
      previousRecentProperties:
        context.previousRecentProperties || context.recentProperties,
      selectedProperty: context.selectedProperty,
    });
  }

  // Change search: restart
  if (lower === 'change search' && context?.flow === 'property_search') {
    const qa = listingTypeQuickActions();
    return clarificationResult(qa.question, qa, {
      listingType: null,
      filters: {},
      search: '',
      locations: [],
      pendingClarification: 'listingType',
      funnelStage: FUNNEL_STAGES.DISCOVERY,
    });
  }

  // Other Area → free text
  if (
    /^other\s+area$/i.test(String(message || '').trim()) &&
    (context?.pendingClarification === 'location' ||
      context?.flow === 'property_search')
  ) {
    return clarificationResult('Which area are you interested in?', null, {
      listingType: context?.listingType || null,
      filters: context?.filters || {},
      search: '',
      locations: [],
      pendingClarification: 'otherArea',
      recentProperties: context?.recentProperties,
      previousRecentProperties:
        context?.previousRecentProperties || context?.recentProperties,
    });
  }

  // Bedrooms clarification → search (optional filter)
  if (context?.pendingClarification === 'bedrooms') {
    const state = mergePropertySearchState(message, context);
    if (hasEnoughToSearch(state)) {
      return buildResultsPayload(state, context);
    }
  }

  // Budget clarification reply → search; preserve prior results on zero
  if (context?.pendingClarification === 'budget') {
    const state = mergePropertySearchState(message, context);
    const budget = parseBudgetSelection(message);
    if (budget?.flexible) {
      delete state.filters.priceMin;
      delete state.filters.priceMax;
    } else if (budget) {
      if (budget.priceMin !== undefined) state.filters.priceMin = budget.priceMin;
      if (budget.priceMax !== undefined) state.filters.priceMax = budget.priceMax;
    }
    if (hasEnoughToSearch(state)) {
      return buildResultsPayload(state, context, { refinedBudget: true });
    }
  }

  const state = mergePropertySearchState(message, context);
  const { filters, search, listingType, locations, bedroomsAny } = state;

  // Guided funnel: ask only for the next missing required field
  const missing = nextMissingClarification(state);
  if (missing === 'listingType') {
    const qa = listingTypeQuickActions();
    return clarificationResult(`Sure! ${qa.question}`, qa, {
      listingType: null,
      filters,
      search,
      locations,
      pendingClarification: 'listingType',
    });
  }
  if (missing === 'propertyType') {
    const qa = propertyTypeQuickActions(true);
    return clarificationResult(qa.question, qa, {
      listingType,
      filters,
      search,
      locations,
      pendingClarification: 'propertyType',
    });
  }
  if (missing === 'location') {
    const qa = locationQuickActions();
    return clarificationResult(qa.question, qa, {
      listingType,
      filters,
      search: '',
      locations: [],
      pendingClarification: 'location',
    });
  }

  // Minimum requirements met → SEARCH IMMEDIATELY (budget is optional refinement)
  return buildResultsPayload(
    { listingType, filters, search, locations, bedroomsAny },
    context
  );
};

/**
 * Resolve property search context for PROPERTY_SEARCH intent.
 * Uses existing buy/rent/off-plan helpers when purpose is explicit; otherwise general search.
 * @param {string} message
 */
const resolvePropertySearchContext = async (message) => {
  const query = extractPropertySearchQuery(message);
  const listingType = query.listingType;
  const limit = getSearchLimit();

  if (listingType === 'rent' || listingType === 'buy' || listingType === 'off-plan') {
    const result = await searchByListingType({
      listingType,
      filters: query.filters,
      search: query.search,
      limit,
    });
    return {
      properties: result.sanitized,
      total: result.total,
      limit: result.limit,
      collection: 'properties',
      filters: query.filters,
      search: query.search,
      listingType,
      cards: result.properties,
    };
  }

  return searchPublicProperties({
    filters: query.filters,
    search: query.search,
    limit,
  });
};

/**
 * @param {number} count
 * @param {{ filters?: object, search?: string }} [meta]
 */
const formatCountReply = (count, meta = {}) => {
  const formatted = Number(count || 0).toLocaleString('en-US');
  const hasFilter =
    (typeof meta.search === 'string' && meta.search.trim()) ||
    (meta.filters && Object.keys(meta.filters).length > 0);

  if (!hasFilter) {
    return `There are currently ${formatted} properties in the public property inventory.`;
  }

  return `There are currently ${formatted} matching properties in the public property inventory.`;
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
  getPropertyCount,
  searchPublicProperties,
  resolvePropertySearchContext,
  resolvePropertyCountContext,
  resolveConversationalPropertySearch,
  extractPropertySearchQuery,
  mergePropertySearchState,
  detectListingType,
  parseBedroomSelection,
  parsePropertyTypeSelection,
  parseLocationSelection,
  parseLocationsSelection,
  parseBudgetSelection,
  nextMissingClarification,
  hasEnoughToSearch,
  sanitizePublicProperty,
  toPropertyCard,
  searchByListingType,
  formatPropertySearchReply,
  formatCountReply,
  getSearchLimit,
  PUBLIC_PROPERTY_FIELDS,
  FORBIDDEN_PROPERTY_FIELDS,
  pickApprovedFilters,
  FEW_RESULTS_MAX,
  searchWithoutBudget,
  sanitizeListingAgentPhone,
  fetchListingAgentForSelectedProperty,
};
