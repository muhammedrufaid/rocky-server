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
  afterResultsQuickActions,
} = require('./quickActions');

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
    lower === 'off plan properties'
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

  if (text === 'studio' || text === '0') return '0';
  if (text === '1' || text === '1 bed' || text === '1 bedroom') return '1';
  if (text === '2' || text === '2 bed' || text === '2 bedroom') return '2';
  if (
    text === '3' ||
    text === '3+' ||
    text === '3 bed' ||
    text === '3 bedroom' ||
    text === '3 bedrooms'
  ) {
    return '3';
  }

  const bedMatch = text.match(/\b(\d+)\s*(?:bed(?:room)?s?|br)\b/i);
  if (bedMatch) return bedMatch[1];

  if (/^\d+$/.test(text)) return text;
  if (/\bstudio\b/i.test(text)) return '0';

  return null;
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
    if (bed !== null) filters.bedrooms = bed;
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
    // Only apply short/exact type replies when already in a property flow
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

  let search =
    (extracted.search && extracted.search.trim()) ||
    (context && typeof context.search === 'string' && context.search.trim()) ||
    '';

  if (context?.pendingClarification === 'location' || context?.pendingClarification === 'otherArea') {
    const loc = parseLocationSelection(message);
    if (loc) search = loc;
  } else if (!extracted.search) {
    // Location-only quick actions while in property flow
    const loc = parseLocationSelection(message);
    if (
      loc &&
      context?.flow === 'property_search' &&
      /^(dubai marina|downtown dubai|business bay|dubai south|arabian ranches|palm jumeirah|jvc|jlt|dubai hills|jebel ali)$/i.test(
        String(message || '').trim()
      )
    ) {
      search = loc;
    }
  }

  // Change area / change budget intents clear the relevant field
  const lower = String(message || '').trim().toLowerCase();
  if (lower === 'change area') {
    search = '';
  }
  if (lower === 'change budget') {
    delete filters.priceMin;
    delete filters.priceMax;
  }
  if (lower === 'change search') {
    return {
      filters: {},
      search: '',
      listingType: listingType || context?.listingType || null,
      resetPending: true,
    };
  }

  return { filters, search, listingType };
};

/**
 * Whether we have enough filters to run a property search without more questions.
 * Requires listing type + location. Property type / bedrooms / budget are used when present.
 * @param {{ listingType: string|null, filters: object, search: string }} state
 */
const hasEnoughToSearch = (state) => {
  if (!state.listingType) return false;
  if (!state.search || !String(state.search).trim()) return false;
  // Prefer having property type for residential searches, but allow search if bedrooms given
  if (state.filters?.propertyType) return true;
  if (state.filters?.bedrooms !== undefined && state.filters?.bedrooms !== null) {
    return true;
  }
  // listing + location alone is enough for conversion (avoid over-questioning)
  return true;
};

/**
 * Next missing clarification step for guided funnel.
 * Order: listingType → propertyType → location → bedrooms (skip beds for commercial)
 * @param {{ listingType: string|null, filters: object, search: string }} state
 * @returns {string|null}
 */
const nextMissingClarification = (state) => {
  if (!state.listingType) return 'listingType';
  if (!state.filters?.propertyType) return 'propertyType';
  if (!state.search || !String(state.search).trim()) return 'location';
  const type = String(state.filters.propertyType || '');
  const isCommercial = /commercial|office|shop|retail|warehouse|showroom|labour/i.test(
    type
  );
  if (
    !isCommercial &&
    (state.filters.bedrooms === undefined ||
      state.filters.bedrooms === null ||
      state.filters.bedrooms === '')
  ) {
    return 'bedrooms';
  }
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
 */
const formatPropertySearchReply = (result) => {
  const shown = Array.isArray(result.properties) ? result.properties.length : 0;
  const total = result.total || 0;
  if (total === 0 || shown === 0) {
    return 'I could not find matching public listings for those filters. Try adjusting the location, bedrooms, or listing type.';
  }

  const n = total > shown ? total : shown;
  return `I found ${n} ${n === 1 ? 'property' : 'properties'} matching your requirements. Would you like to see more properties or speak with an agent?`;
};

/**
 * Build recent-properties summary for conversation context.
 * @param {object[]} cards
 */
const toRecentProperties = (cards) =>
  (Array.isArray(cards) ? cards : []).slice(0, 5).map((p, index) => ({
    id: p.id || null,
    title: p.title || null,
    url: p.url || null,
    listingType: p.listingType || null,
    index,
  }));

/**
 * Clarification response helper.
 * @param {string} reply
 * @param {object} quick_actions
 * @param {object} partial
 */
const clarificationResult = (reply, quick_actions, partial) => ({
  kind: 'clarification',
  reply,
  quick_actions,
  context: {
    flow: 'property_search',
    intent: 'PROPERTY_SEARCH',
    conversionIntent: 'medium',
    ...partial,
  },
  openaiCalls: 0,
});

/**
 * @param {object} state
 * @param {object|null} context
 */
const buildResultsPayload = async (state, context = null) => {
  const result = await searchByListingType({
    listingType: state.listingType,
    filters: state.filters,
    search: state.search,
  });
  const recentProperties = toRecentProperties(result.properties);
  return {
    kind: 'results',
    reply: formatPropertySearchReply(result),
    property_results: {
      properties: result.properties,
      total: result.total,
    },
    quick_actions: afterResultsQuickActions(false),
    context: {
      flow: 'property_search',
      intent: 'PROPERTY_SEARCH',
      listingType: state.listingType,
      filters: state.filters,
      search: state.search,
      pendingClarification: null,
      recentProperties,
      selectedProperty: context?.selectedProperty || null,
      conversionIntent: 'medium',
    },
    openaiCalls: 0,
  };
};

/**
 * Conversational property search: only ask for missing filters, then structured results.
 * Does not guess buy/rent/off-plan. Does not re-ask known fields.
 * @param {string} message
 * @param {object|null} [context]
 */
const resolveConversationalPropertySearch = async (message, context = null) => {
  const lower = String(message || '').trim().toLowerCase();

  // Change-area: keep filters/listing, clear location, re-ask
  if (lower === 'change area' && context?.flow === 'property_search') {
    const state = mergePropertySearchState(message, context);
    const qa = locationQuickActions();
    return clarificationResult(qa.question, qa, {
      listingType: state.listingType,
      filters: state.filters,
      search: '',
      pendingClarification: 'location',
      recentProperties: context.recentProperties,
      selectedProperty: context.selectedProperty,
    });
  }

  // Change budget
  if (lower === 'change budget' && context?.flow === 'property_search') {
    const state = mergePropertySearchState(message, context);
    return {
      kind: 'clarification',
      reply: 'What is your maximum budget in AED?',
      context: {
        flow: 'property_search',
        intent: 'PROPERTY_SEARCH',
        listingType: state.listingType,
        filters: state.filters,
        search: state.search,
        pendingClarification: 'budget',
        conversionIntent: 'medium',
        recentProperties: context.recentProperties,
      },
      openaiCalls: 0,
    };
  }

  // Change search: restart
  if (lower === 'change search' && context?.flow === 'property_search') {
    const qa = listingTypeQuickActions();
    return clarificationResult(qa.question, qa, {
      listingType: null,
      filters: {},
      search: '',
      pendingClarification: 'listingType',
    });
  }

  // Other Area → free text
  if (
    /^other\s+area$/i.test(String(message || '').trim()) &&
    (context?.pendingClarification === 'location' ||
      context?.flow === 'property_search')
  ) {
    return {
      kind: 'clarification',
      reply: 'Which area are you interested in?',
      context: {
        flow: 'property_search',
        intent: 'PROPERTY_SEARCH',
        listingType: context?.listingType || null,
        filters: context?.filters || {},
        search: '',
        pendingClarification: 'otherArea',
        conversionIntent: 'medium',
      },
      openaiCalls: 0,
    };
  }

  // Budget clarification reply → search
  if (context?.pendingClarification === 'budget') {
    const state = mergePropertySearchState(message, context);
    const budgetMatch = String(message || '').match(
      /(?:aed\s*)?([\d,.]+)\s*(million|m)?/i
    );
    if (budgetMatch) {
      let n = parseFloat(String(budgetMatch[1]).replace(/,/g, ''));
      if (Number.isFinite(n)) {
        if (budgetMatch[2]) n *= 1_000_000;
        state.filters.priceMax = n;
      }
    }
    if (state.listingType && state.search) {
      return buildResultsPayload(state, context);
    }
  }

  const state = mergePropertySearchState(message, context);
  const { filters, search, listingType } = state;

  // Guided funnel: ask only for the next missing field
  const missing = nextMissingClarification(state);
  if (missing === 'listingType') {
    const qa = listingTypeQuickActions();
    return clarificationResult(`Sure! ${qa.question}`, qa, {
      listingType: null,
      filters,
      search,
      pendingClarification: 'listingType',
    });
  }
  if (missing === 'propertyType') {
    const qa = propertyTypeQuickActions();
    return clarificationResult(qa.question, qa, {
      listingType,
      filters,
      search,
      pendingClarification: 'propertyType',
    });
  }
  if (missing === 'location') {
    const qa = locationQuickActions();
    return clarificationResult(qa.question, qa, {
      listingType,
      filters,
      search: '',
      pendingClarification: 'location',
    });
  }
  if (missing === 'bedrooms') {
    const qa = bedroomQuickActions();
    return clarificationResult(qa.question, qa, {
      listingType,
      filters,
      search,
      pendingClarification: 'bedrooms',
    });
  }

  return buildResultsPayload(state, context);
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
  nextMissingClarification,
  sanitizePublicProperty,
  toPropertyCard,
  searchByListingType,
  formatPropertySearchReply,
  formatCountReply,
  getSearchLimit,
  PUBLIC_PROPERTY_FIELDS,
  FORBIDDEN_PROPERTY_FIELDS,
  pickApprovedFilters,
};
