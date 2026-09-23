const OpenAI = require('openai');
const propertyDbService = require('../services/propertyDbService');
const { Lead } = require('./chat.models');
const ChatbotKnowledge = require('../models/ChatbotKnowledge');
const { formatAed } = require('./chat.format');

const VECTOR_INDEX_NAME = process.env.CHATBOT_VECTOR_INDEX || 'chatbot_knowledge_vector_index';
const VECTOR_MIN_SCORE = Number(process.env.CHAT_VECTOR_MIN_SCORE) || 0.75;
const CONTENT_LIMIT = 8;
const PROPERTY_LIMIT = 6;
const MAX_RELATED_CONTENT_ACTIONS = 2;

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_properties',
      description:
        'Search live Rocky listings. Use for buy, rent, or off-plan requests and when offering matching properties. Required before search: purpose, property type, location, and bedrooms for residential types. Budget is optional — search without it and offer budget as a refinement. purpose is Buy, Rent, or Off-plan — never guess it. Omit purpose only when lastSearchFilters.purpose / the visitor profile already has one (the server merges it). If a required field is missing, still call this tool so the server can ask the next missing field with chips — do not write that question yourself. NEVER invent bedrooms or budget. Only pass bedrooms or budgetMin/budgetMax if the visitor actually stated them. "Any budget" is a valid answered budget. The server ignores guessed bedroom counts and guessed budgets. Do not call this again with a nearby area after count 0 — the server offers explicit chips. Never claim listings exist unless this tool returned at least one result.',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'Area, community, tower, or city (e.g. Dubai Marina, JVC, Business Bay).',
          },
          bedrooms: {
            type: 'number',
            description:
              'Bedroom count the visitor actually stated. Use 0 for studio. Omit this unless they said a number, studio, 4+, or Any. Never invent a default such as 2.',
          },
          budgetMin: {
            type: 'number',
            description: 'Minimum price in AED. Omit unless the visitor stated a minimum. Never invent a default.',
          },
          budgetMax: {
            type: 'number',
            description: 'Maximum price in AED. Omit unless the visitor stated a maximum. Never invent a default such as 5000000.',
          },
          type: {
            type: 'string',
            description:
              'Property type (Apartment, Villa, Townhouse, Penthouse, Office, etc.). If the visitor asked for more than one type, pass them comma-separated (e.g. "Apartment, Villa") and also pass types. Never drop a requested type.',
          },
          types: {
            type: 'array',
            items: { type: 'string' },
            description:
              'All requested property types when the visitor asked for more than one (e.g. Apartment and Villa). Prefer this over a single type in that case.',
          },
          purpose: {
            type: 'string',
            description:
              'Buy, Rent, or Off-plan. Optional only when already known from lastSearchFilters or the visitor profile. Never invent Buy.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_content',
      description:
        'Search Rocky website content (blogs, area guides, FAQs, services, company info). Use for Golden Visa, flexi rent / flexible payment plans, buying costs, off-plan financing, can-I-sell off-plan policy questions, property management overview, company facts, process, eligibility, and any question that might be answered on our site. Do not use this for live listing prices or availability. Answer only the visitor\'s latest question — do not reuse a prior article topic. After results, write MAXIMUM 2 short sentences with the single key fact only — never paste or expand the chunks.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The visitor question or search query.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'capture_lead',
      description:
        'Save a lead only when the visitor has actually provided their name, phone, and email. Details may come from earlier turns in this same conversation, not only the latest message. Never invent these values.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          intent: {
            type: 'string',
            description: 'Short note on what they want (buy, rent, viewing, callback, etc.).',
          },
        },
        required: ['name', 'phone', 'email', 'intent'],
      },
    },
  },
];

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  return new OpenAI({ apiKey });
}

function frontendBase() {
  return (process.env.FRONTEND_URL || 'https://www.rockyrealestate.com').replace(/\/$/, '');
}

function normalizeContentUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
}

function isHomepageUrl(url) {
  const u = normalizeContentUrl(url);
  if (!u) return true;
  const origin = normalizeContentUrl(frontendBase());
  return u === origin || u === 'https://www.rockyrealestate.com' || u === 'https://rockyrealestate.com';
}

function contentSourceKind(source = {}) {
  const url = normalizeContentUrl(source.url);
  const type = String(source.sourceType || '').toLowerCase();
  if (type === 'blog' || /\/blogs?\//.test(url)) return 'blog';
  if (type === 'area_guide' || /\/area-guides?\//.test(url)) return 'area_guide';
  if (type === 'company_info') return 'company_info';
  if (type === 'faq' || /\/faqs?\//.test(url)) return 'faq';
  if (type === 'service' || /\/services?\//.test(url)) return 'service';
  if (
    type === 'property' ||
    /\/off-plan/.test(url) ||
    /\/properties\//.test(url) ||
    /\/buy\//.test(url) ||
    /\/rent\//.test(url)
  ) {
    return 'listing';
  }
  return 'other';
}

function titledSource(source) {
  const url = String(source.url || '').trim();
  const title = String(source.title || '').trim();
  const sourceType = source.sourceType || null;
  if (title && !/^https?:\/\//i.test(title)) return { title, url, sourceType };
  const slug = url.replace(/\/+$/, '').split('/').pop() || 'Related page';
  const fromSlug = slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { title: fromSlug, url, sourceType };
}

/**
 * Related-action buttons from live chatbot_knowledge hits only (CMS embeddings).
 * Prefer blog → area guide → company_info → FAQ → service → listing. Never homepage. Max 2 unique URLs.
 * No hardcoded topic → URL maps — new CMS content appears automatically after embed.
 */
function rankRelatedContentSources(sources = []) {
  const cleaned = (sources || [])
    .filter((s) => s && s.url && !isHomepageUrl(s.url))
    .map(titledSource);

  const byKind = {
    blog: [],
    area_guide: [],
    company_info: [],
    faq: [],
    service: [],
    listing: [],
    other: [],
  };
  for (const item of cleaned) {
    byKind[contentSourceKind(item)].push(item);
  }

  const ordered = [];
  const seen = new Set();
  const pick = (item) => {
    if (!item || ordered.length >= MAX_RELATED_CONTENT_ACTIONS) return;
    const key = normalizeContentUrl(item.url);
    if (!key || seen.has(key)) return;
    seen.add(key);
    ordered.push({ title: item.title, url: item.url });
  };

  for (const kind of ['blog', 'area_guide', 'company_info', 'faq', 'service', 'listing', 'other']) {
    for (const item of byKind[kind]) pick(item);
  }
  return ordered;
}

function buildListingUrl(property) {
  const purpose = String(property.propertyPurpose || '')
    .trim()
    .toLowerCase();
  const path = purpose === 'rent' ? 'rent' : 'buy';
  return `${frontendBase()}/properties/${path}/in-dubai/${property.propertyRefNo}`;
}

function listingSearchPath(purpose) {
  if (purpose === 'Rent') return 'rent/in-dubai';
  if (purpose === 'Off-plan') return 'off-plan';
  return 'buy/in-dubai';
}

function buildListingSearchUrl(filters = {}) {
  const purpose = normalizePurpose(filters.purpose);
  const path = listingSearchPath(purpose);
  const params = new URLSearchParams();
  const loc = hasLocationConstraint(filters) ? String(filters.location || '').trim() : '';
  if (loc) params.set('q', loc.toLowerCase());
  const types = typesFromFilters(filters);
  if (types.length) params.set('type', String(types[0]).trim().toLowerCase());
  if (requiresBedroomsForSearch(filters) && !filters.bedroomsAny) {
    if (isBedroomsSet(filters.bedrooms)) params.set('beds', String(Number(filters.bedrooms)));
    else if (isBedroomsSet(filters.bedroomsMin)) params.set('beds', String(Number(filters.bedroomsMin)));
  }
  if (filters.budgetMin !== undefined && filters.budgetMin !== null && filters.budgetMin !== '') {
    params.set('priceMin', String(filters.budgetMin));
  }
  if (filters.budgetMax !== undefined && filters.budgetMax !== null && filters.budgetMax !== '') {
    params.set('priceMax', String(filters.budgetMax));
  }
  const qs = params.toString().replace(/\+/g, '%20');
  return `${frontendBase()}/properties/${path}${qs ? `?${qs}` : ''}`;
}

function viewAllCtaLabel(filters = {}) {
  const purpose = normalizePurpose(filters.purpose);
  const loc = hasLocationConstraint(filters) ? String(filters.location).trim() : '';
  const types = typesFromFilters(filters);
  const typeWord = types.length ? pluraliseType(types[0]).toLowerCase() : 'properties';
  const n = isBedroomsSet(filters.bedrooms) ? Number(filters.bedrooms) : null;
  const commercial = searchTypesAreCommercial(filters);
  let head = typeWord;
  if (!commercial && n === 0) head = `studio ${typeWord}`;
  else if (!commercial && Number.isFinite(n)) head = `${n}-bedroom ${typeWord}`;

  let label;
  if (purpose === 'Rent') {
    label = loc ? `View all ${head} for rent in ${loc}` : `View all ${head} for rent`;
  } else if (purpose === 'Off-plan') {
    label = loc ? `View all off-plan ${head} in ${loc}` : `View all off-plan ${head}`;
  } else if (commercial) {
    label = loc ? `View all ${head} for sale in ${loc}` : `View all ${head} for sale`;
  } else {
    label = loc ? `View all ${head} in ${loc}` : `View all ${head}`;
  }
  return `${label} →`;
}

function buildViewAllMatching(total, filters) {
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    total,
    url: buildListingSearchUrl(filters),
    label: viewAllCtaLabel(filters),
  };
}

function isRawBooleanLabel(value) {
  const raw = String(value || '').trim().toLowerCase();
  return ['yes', 'no', 'true', 'false', 'null', 'undefined', 'n/a', 'na', 'none', '-'].includes(raw);
}

function displayFurnished(value) {
  const raw = String(value || '').trim();
  if (!raw || isRawBooleanLabel(raw)) return '';
  if (/unfurnished/i.test(raw)) return 'Unfurnished';
  if (/semi/i.test(raw)) return 'Semi-furnished';
  if (/furnished/i.test(raw)) return 'Furnished';
  return raw;
}

function sanitizeListingPrice(price) {
  return String(price || '')
    .trim()
    .replace(/[, ]+(yes|no|true|false|null|undefined)\s*$/i, '')
    .trim();
}

function listingCompletionLabel(property) {
  const raw = String(property.offPlan ?? '').trim().toLowerCase();
  if (raw === 'yes' || raw === 'true') return 'Off-plan';
  return null;
}

function toPropertyCard(property) {
  const size = (property.propertySize || '').toString().trim();
  const unit = (property.propertySizeUnit || '').toString().trim();
  const place = [property.towerName, property.subLocality, property.locality]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i);
  const features = Array.isArray(property.features)
    ? property.features
        .map((f) => String(f || '').trim())
        .filter((f) => f && !isRawBooleanLabel(f))
        .slice(0, 6)
    : [];
  return {
    id: property.propertyRefNo,
    propertyRefNo: property.propertyRefNo,
    title: property.propertyTitle || '',
    location: place.join(' — ') || '',
    price: sanitizeListingPrice(property.price),
    beds: property.bedrooms != null && property.bedrooms !== '' ? property.bedrooms : '',
    baths: property.bathrooms || '',
    area: [size, unit].filter(Boolean).join(' '),
    furnished: displayFurnished(property.furnished),
    completionStatus: listingCompletionLabel(property),
    features,
    imageUrl: Array.isArray(property.images) && property.images[0] ? property.images[0] : '',
    listingUrl: buildListingUrl(property),
  };
}

const PURPOSE_OPTIONS = ['Buy', 'Rent', 'Off-plan'];
const COMMERCIAL_PURPOSE_OPTIONS = ['Buy', 'Rent'];
const PURPOSE_SELECT = 'single';
const PROPERTY_TYPE_CHANGE_OPTIONS = [
  'Apartment',
  'Villa',
  'Townhouse',
  'Penthouse',
  'Office',
  'Shop',
  'Warehouse',
];
const BEDROOM_OPTIONS = ['Studio', '1 BR', '2 BR', '3 BR', '4+ BR', 'Any'];
const PROPERTY_TYPE_OPTIONS = ['Apartment', 'Villa', 'Townhouse', 'Penthouse'];
const BUY_BUDGET_OPTIONS = [
  'Below AED 1M',
  'Below AED 1.5M',
  'Below AED 2M',
  'Below AED 3M',
  'Above AED 3M',
  'Any budget',
];
const BUY_BUDGET_CHIP_MAP = {
  'below aed 1m': { budgetMax: 1_000_000 },
  'below aed 1.5m': { budgetMax: 1_500_000 },
  'below aed 2m': { budgetMax: 2_000_000 },
  'below aed 3m': { budgetMax: 3_000_000 },
  'above aed 3m': { budgetMin: 3_000_000 },
  'any budget': { any: true },
};
const RENT_BUDGET_OPTIONS = [
  'Below AED 60K/year',
  'Below AED 100K/year',
  'Below AED 150K/year',
  'Below AED 250K/year',
  'Above AED 250K/year',
  'Any budget',
];
const RENT_BUDGET_CHIP_MAP = {
  'below aed 60k': { budgetMax: 60_000 },
  'below aed 100k': { budgetMax: 100_000 },
  'below aed 150k': { budgetMax: 150_000 },
  'below aed 250k': { budgetMax: 250_000 },
  'above aed 250k': { budgetMin: 250_000 },
  'any budget': { any: true },
};
const SELL_OPTIONS = ['Get a valuation', 'Talk to an agent'];
const SELL_TYPE_OPTIONS = PROPERTY_TYPE_OPTIONS;
const PM_NEED_OPTIONS = [
  'Full property management',
  'Tenant management',
  'Rent collection',
  'Maintenance',
  'Inspections',
];

const CONVERSATION_INTENTS = {
  BUY: 'BUY',
  RENT: 'RENT',
  OFF_PLAN: 'OFF_PLAN',
  SELL_PROPERTY: 'SELL_PROPERTY',
  PROPERTY_MANAGEMENT: 'PROPERTY_MANAGEMENT',
};

const LISTING_MODES = {
  READY_BUY: 'READY_BUY',
  READY_RENT: 'READY_RENT',
  OFF_PLAN: 'OFF_PLAN',
};

const SEARCH_OUTCOME = {
  MATCHES_FOUND: 'MATCHES_FOUND',
  MORE_EXACT_RESULTS: 'MATCHES_FOUND',
  BUDGET_TOO_LOW: 'BUDGET_TOO_LOW',
  EXACT_RESULTS_EXHAUSTED: 'EXACT_RESULTS_EXHAUSTED',
  NO_INVENTORY: 'NO_INVENTORY',
  NO_SEGMENT_INVENTORY: 'NO_INVENTORY',
  NO_MORE_MATCHES: 'EXACT_RESULTS_EXHAUSTED',
};

const LISTING_INTENTS = new Set([
  CONVERSATION_INTENTS.BUY,
  CONVERSATION_INTENTS.RENT,
  CONVERSATION_INTENTS.OFF_PLAN,
]);

function emptySearchFilters() {
  return {
    location: null,
    locationAny: false,
    bedrooms: null,
    bedroomsMin: null,
    bedroomsAny: false,
    bedroomsResolved: false,
    budgetMin: null,
    budgetMax: null,
    budgetProvided: false,
    type: null,
    types: [],
    purpose: null,
    furnished: null,
  };
}

function emptyViewingRequest() {
  return {
    active: false,
    propertyRefNo: null,
    propertyId: null,
    propertyTitle: null,
    name: null,
    email: null,
    phone: null,
    preferredDate: null,
    preferredTime: null,
    schedulingMode: null,
    notes: null,
    submitted: false,
    askedTimeRefinement: false,
  };
}

function copyViewingRequest(vr = {}) {
  return {
    active: !!vr.active,
    propertyRefNo: vr.propertyRefNo || null,
    propertyId: vr.propertyId || vr.propertyRefNo || null,
    propertyTitle: vr.propertyTitle || null,
    name: vr.name || null,
    email: vr.email || null,
    phone: vr.phone || null,
    preferredDate: vr.preferredDate || null,
    preferredTime: vr.preferredTime || null,
    schedulingMode: vr.schedulingMode || null,
    notes: vr.notes || null,
    submitted: !!vr.submitted,
    askedTimeRefinement: !!vr.askedTimeRefinement,
  };
}

function uniqueTypeList(list = []) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const value = String(item || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function uniqueIdList(list = []) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const value = String(item || '').trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.slice(-200);
}

function copySearchFilters(filters = {}) {
  const types = typesFromFilters(filters);
  const locationAny =
    filters.locationAny === true || isUnrestrictedLocationPhrase(filters.location);
  const location = locationAny ? null : sanitizeSearchLocation(filters.location);
  return {
    location,
    locationAny,
    bedrooms: filters.bedrooms ?? null,
    bedroomsMin: filters.bedroomsMin ?? null,
    bedroomsAny: !!filters.bedroomsAny,
    bedroomsResolved:
      !!filters.bedroomsResolved ||
      !!filters.bedroomsAny ||
      isBedroomsSet(filters.bedrooms) ||
      isBedroomsSet(filters.bedroomsMin),
    budgetMin: filters.budgetMin ?? null,
    budgetMax: filters.budgetMax ?? null,
    budgetProvided: filters.budgetProvided === true,
    type: types.length === 1 ? types[0] : types.length ? types.join(', ') : filters.type || null,
    types,
    purpose: filters.purpose || null,
    furnished: filters.furnished || null,
  };
}

function purposeToIntent(purpose) {
  const p = normalizePurpose(purpose);
  if (p === 'Buy') return CONVERSATION_INTENTS.BUY;
  if (p === 'Rent') return CONVERSATION_INTENTS.RENT;
  if (p === 'Off-plan') return CONVERSATION_INTENTS.OFF_PLAN;
  return null;
}

function intentToPurpose(intent) {
  if (intent === CONVERSATION_INTENTS.BUY) return 'Buy';
  if (intent === CONVERSATION_INTENTS.RENT) return 'Rent';
  if (intent === CONVERSATION_INTENTS.OFF_PLAN) return 'Off-plan';
  return null;
}

function listingModeFromPurpose(purpose) {
  const p = normalizePurpose(purpose);
  if (p === 'Rent') return LISTING_MODES.READY_RENT;
  if (p === 'Off-plan') return LISTING_MODES.OFF_PLAN;
  if (p === 'Buy') return LISTING_MODES.READY_BUY;
  return null;
}

function listingModeFromFilters(filters = {}) {
  return listingModeFromPurpose(filters.purpose);
}

function isListingIntent(intent) {
  return LISTING_INTENTS.has(intent);
}

function normalizeIntentValue(value) {
  const raw = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (!raw) return null;
  if (raw === 'BUY' || raw === 'PURCHASE' || raw === 'SALE') return CONVERSATION_INTENTS.BUY;
  if (raw === 'RENT' || raw === 'RENTAL' || raw === 'LEASE') return CONVERSATION_INTENTS.RENT;
  if (raw === 'OFF_PLAN' || raw === 'OFFPLAN') return CONVERSATION_INTENTS.OFF_PLAN;
  if (raw === 'SELL_PROPERTY' || raw === 'SELL' || raw === 'SELLING') {
    return CONVERSATION_INTENTS.SELL_PROPERTY;
  }
  if (
    raw === 'PROPERTY_MANAGEMENT' ||
    raw === 'PROPERTYMANAGEMENT' ||
    raw === 'PM' ||
    raw === 'MANAGEMENT'
  ) {
    return CONVERSATION_INTENTS.PROPERTY_MANAGEMENT;
  }
  return CONVERSATION_INTENTS[raw] || null;
}

function isExplicitIntentStarter(text) {
  const raw = String(text || '')
    .trim()
    .replace(/[.!?]/g, '');
  if (!raw) return false;
  if (/^(buy a property|buy property|i want to buy a property)$/i.test(raw)) return true;
  if (/^(rent a property|rent property|i want to rent a property)$/i.test(raw)) return true;
  if (/^(off[-\s]?plan|off[-\s]?plan properties)$/i.test(raw)) return true;
  if (/^(sell my property|sell property|i want to sell my property)$/i.test(raw)) return true;
  if (/^property management$/i.test(raw)) return true;
  return false;
}

function isPurposeChipReply(text) {
  return /^(buy|rent|off[-\s]?plan)$/i.test(String(text || '').trim());
}

function isPropertyUiAction(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return false;
  return /^(view listing|book a viewing|view all matching properties|talk to an agent)$/.test(raw);
}

function normalizePurpose(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase();
  if (v === 'rent' || v === 'rental' || v === 'lease') return 'Rent';
  if (v === 'buy' || v === 'sale' || v === 'purchase') return 'Buy';
  if (
    v === 'off-plan' ||
    v === 'offplan' ||
    v === 'off plan' ||
    v === 'off_plan' ||
    v === 'off-plan properties' ||
    v === 'off plan properties'
  ) {
    return 'Off-plan';
  }
  return null;
}

function parseSellIntent(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return false;
  if (isSellCta(raw)) return false;
  // Policy / FAQ questions about selling (e.g. off-plan resale rules) — not list-my-property intent
  if (
    /\b(can\s+i\s+sell|could\s+i\s+sell|am\s+i\s+allowed\s+to\s+sell|is\s+it\s+(?:possible|allowed)\s+to\s+sell|before\s+completion|how\s+(?:do|can|does)\s+(?:i|one|you)\s+sell|what\s+happens\s+if\s+i\s+sell|rules?\s+for\s+sell|sell(?:ing)?\s+(?:before|after|rules?|process|fees?))\b/.test(
      raw
    )
  ) {
    return false;
  }
  // "I need an apartment for sale" is a buy search, not list-my-property.
  if (
    /\b(i\s+(need|want|would\s+like)|looking\s+for|show\s+me|find(?:\s+me)?)\b/.test(raw) &&
    /\bfor\s+sale\b/.test(raw) &&
    !/\b(sell|selling|list(?:ing)?\s+my)\b/.test(raw)
  ) {
    return false;
  }
  if (/\b(i\s+(need|want|have|'d like|would like)\s+to\s+sell|sell(ing)?\s+(my|our)|list(ing)?\s+(my|our)|market\s+(my|our))\b/.test(raw)) {
    return true;
  }
  if (/\b(apartment|villa|townhouse|penthouse|property|home|house|flat)\b.{0,40}\b(i\s+want\s+to\s+sell|to\s+sell|for\s+sale)\b/.test(raw)) {
    return true;
  }
  if (/\b(sell|selling|list|listing)\b.{0,24}\b(property|properties|home|house|villa|apartment|flat|townhouse)\b/.test(raw)) {
    return true;
  }
  if (/\b(property|home|house)\s+(valuation|appraisal)\b/.test(raw)) return true;
  return false;
}

function isAlreadySharedDetails(text) {
  return /\b(already\s+(shared|gave|provided|sent|told)|you\s+already\s+have|i\s+already\s+(did|gave|shared|provided))\b/i.test(
    String(text || '')
  );
}

function emptySellListing() {
  return {
    intent: null,
    type: null,
    location: null,
    bedrooms: null,
    priceNote: null,
    occupancy: null,
    name: null,
    phone: null,
    email: null,
  };
}

function copySellListing(listing = {}) {
  return {
    intent: listing.intent || null,
    type: listing.type || null,
    location: listing.location || null,
    bedrooms: listing.bedrooms ?? null,
    priceNote: listing.priceNote || null,
    occupancy: listing.occupancy || null,
    name: listing.name || null,
    phone: listing.phone || null,
    email: listing.email || null,
  };
}

function normalizePersonName(value) {
  return String(value || '')
    .replace(/[,.;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyNonNamePhrase(value) {
  return /\b(villa|apartments?|townhouses?|penthouses?|studios?|offices?|shops?|flats?|houses?|properties|property|sell|selling|buy|rent|valuation|agent|sunday|saturday|weekend|morning|afternoon|evening|tomorrow|barsha|dubai|marina|hello|thanks?|please|yes|yeah|yep|nope|okay|ok)\b/i.test(
    String(value || '')
  );
}

function isPlausiblePersonName(value) {
  const leftover = normalizePersonName(value);
  if (!leftover || leftover.length < 2 || leftover.length > 80) return false;
  const words = leftover.split(' ');
  if (words.length > 4) return false;
  if (!/^[A-Za-z][A-Za-z\s.'-]*$/.test(leftover)) return false;
  if (isLikelyNonNamePhrase(leftover)) return false;
  if (/^(hi|hey|yo|sup)$/i.test(leftover)) return false;
  return true;
}

function extractStandalonePersonName(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (/@/.test(raw) || /(?:\+|00)?\d[\d\s\-()]{5,}\d/.test(raw)) return null;
  const candidate = normalizePersonName(
    raw
      .replace(/^\s*(?:my name is|i am|i'm)\s+/i, '')
      .replace(/^\s*name\s*[:\-]\s*/i, '')
  );
  return isPlausiblePersonName(candidate) ? candidate : null;
}

function parseContactDetails(text, current = {}) {
  const raw = String(text || '');
  const labeledName = raw.match(
    /\bname\s*[:\-]\s*([A-Za-z][A-Za-z\s.'-]{0,80}?)(?=\s*(?:,|;|(?:e-?mail|phone|tel|mobile|whatsapp)\b|$))/i
  );
  const labeledEmail = raw.match(/\b(?:e-?mail)\s*[:\-]\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);
  const labeledWhatsapp = raw.match(/\bwhatsapp\s*[:\-]\s*((?:\+|00)?\d[\d\s\-()]{6,}\d)/i);
  const labeledPhone = raw.match(/\b(?:phone|tel|mobile)\s*[:\-]\s*((?:\+|00)?\d[\d\s\-()]{6,}\d)/i);
  const emailMatch =
    labeledEmail || raw.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  const whatsappMatch = labeledWhatsapp;
  const bareNumber = raw.match(/^\s*((?:\+|00)?\d[\d\s\-()]{5,18}\d|\d{7,15})\s*$/);
  const phoneMatch =
    labeledPhone ||
    (!labeledWhatsapp ? raw.match(/(?:\+|00)?\d[\d\s\-()]{5,14}\d/) : null) ||
    bareNumber;
  let name = current.name || null;
  if (labeledName) {
    const labeled = normalizePersonName(labeledName[1]);
    if (labeled) name = labeled;
  } else {
    const nameMatch = raw.match(/\b(?:my name is|i am|i'm)\s+([A-Za-z][A-Za-z\s.'-]{0,80})/i);
    if (nameMatch) {
      const prefixed = normalizePersonName(
        nameMatch[1].replace(/\s+(and|my|email|phone|whatsapp).*$/i, '')
      );
      if (prefixed) name = prefixed;
    } else if (emailMatch || phoneMatch || whatsappMatch) {
      const leftover = normalizePersonName(
        raw
          .replace(emailMatch ? emailMatch[0] : '', ' ')
          .replace(phoneMatch ? phoneMatch[0] : '', ' ')
          .replace(whatsappMatch ? whatsappMatch[0] : '', ' ')
          .replace(/\b(?:name|email|e-?mail|phone|tel|mobile|whatsapp)\s*[:\-]?\s*/gi, ' ')
          .replace(/[,]/g, ' ')
      );
      if (isPlausiblePersonName(leftover)) {
        name = leftover;
      }
    }
  }
  return {
    name,
    phone: phoneMatch ? String(phoneMatch[1] || phoneMatch[0]).replace(/\s+/g, ' ').trim() : current.phone || null,
    whatsapp: whatsappMatch
      ? String(whatsappMatch[1] || whatsappMatch[0]).replace(/\s+/g, ' ').trim()
      : current.whatsapp || null,
    email: emailMatch ? String(emailMatch[1] || emailMatch[0]) : current.email || null,
  };
}

function parseViewingContactDetails(text, current = {}) {
  const parsed = parseContactDetails(text, current);
  if (looksCollected(parsed.name)) return parsed;
  if (
    parseViewingPreference(text) ||
    isViewingClosePhrase(text) ||
    isBookViewingAction(text) ||
    isPropertyUiAction(text)
  ) {
    return parsed;
  }
  const standalone = extractStandalonePersonName(text);
  if (standalone) return { ...parsed, name: standalone };
  return parsed;
}

const VIEWING_NEUTRAL_OPTIONS = ['Tomorrow', 'This weekend', 'Next week', 'Agent can coordinate'];
const VIEWING_WEEKEND_OPTIONS = [
  'Saturday morning',
  'Saturday afternoon',
  'Sunday morning',
  'Sunday afternoon',
  'Agent can coordinate',
];
const VIEWING_TIME_OPTIONS = VIEWING_WEEKEND_OPTIONS;
const VIEWING_AWAITING = ['viewingContact', 'viewingTime', 'viewingProperty'];

function isBookViewingAction(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  return raw === 'book a viewing';
}

function isBookViewingRequest(message, selection = {}) {
  const action = String(selection.action || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (action === 'BOOK_VIEWING' || action === 'BOOK_A_VIEWING') return true;
  return isBookViewingAction(message);
}

function viewingPropertyChoiceLabel(card = {}) {
  const title = String(card.title || '').trim();
  const id = String(card.id || card.propertyRefNo || '').trim();
  if (title && id) return `${title} [${id}]`;
  return title || id || 'This listing';
}

function parseViewingPropertyChoice(text, cards = []) {
  const raw = String(text || '').trim();
  if (!raw || !cards.length) return null;
  const bracket = raw.match(/\[([^\]]+)\]\s*$/);
  const token = (bracket ? bracket[1] : raw).trim();
  const byRef = cards.find((card) => {
    const id = String(card.id || card.propertyRefNo || '').trim();
    return id && (token === id || raw === id);
  });
  if (byRef) return byRef;
  const lower = raw.toLowerCase();
  const titleHits = cards.filter(
    (card) => card.title && String(card.title).trim().toLowerCase() === lower
  );
  if (titleHits.length === 1) return titleHits[0];
  return null;
}

function resolveSelectedViewingProperty(profile = {}, selection = {}) {
  const cards = profile.lastPropertyCards || [];
  const explicit = String(selection.propertyRefNo || selection.propertyId || '').trim();
  if (explicit) {
    const card =
      cards.find((item) => String(item.id || item.propertyRefNo || '').trim() === explicit) || {};
    return {
      propertyRefNo: explicit,
      propertyId: card.id || explicit,
      propertyTitle: card.title || selection.propertyTitle || null,
      ambiguous: false,
    };
  }
  if (cards.length === 1) {
    const card = cards[0] || {};
    return {
      propertyRefNo: card.id || card.propertyRefNo || null,
      propertyId: card.id || card.propertyRefNo || null,
      propertyTitle: card.title || null,
      ambiguous: false,
    };
  }
  if (cards.length > 1) {
    return {
      propertyRefNo: null,
      propertyId: null,
      propertyTitle: null,
      ambiguous: true,
      cards,
    };
  }
  return {
    propertyRefNo: null,
    propertyId: null,
    propertyTitle: null,
    ambiguous: false,
    missing: true,
  };
}

function viewingPropertyPrompt(cards = []) {
  return {
    reply: 'Which property would you like to view?',
    options: (cards || []).map(viewingPropertyChoiceLabel),
  };
}

function isViewingClosePhrase(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return false;
  return /^(no|no thanks|no thank you|nothing else|nothing to share|that'?s all|thats all|nope|i'?m good|im good|all good)$/.test(
    raw
  );
}

function isListingSearchOverride(text) {
  const raw = String(text || '').trim();
  if (!raw || isBookViewingAction(raw) || isPropertyUiAction(raw)) return false;
  if (isShowMoreRequest(raw) || isViewingClosePhrase(raw)) return false;
  if (parsePropertyTypesFromMessage(raw).length) return true;
  if (
    parseLocationFromMessage(raw) &&
    /\b(show|find|search|looking|apartments?|villas?|offices?|properties|homes?|listings?)\b/i.test(raw)
  ) {
    return true;
  }
  return /\b(show me|find me|looking for)\b/i.test(raw) && !!parseLocationFromMessage(raw);
}

function parseViewingPreference(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return null;
  if (
    /^agent can coordinate$/.test(raw) ||
    /\bagent can coordinate\b/.test(raw) ||
    /\byou can coordinate\b/.test(raw) ||
    /^(any time|anytime|whenever|flexible|no preference)$/.test(raw) ||
    /\bany time\b/.test(raw)
  ) {
    return {
      date: null,
      time: 'Agent can coordinate',
      schedulingMode: 'AGENT_COORDINATE',
      refine: null,
    };
  }
  if (
    /^(this\s+)?weekends?$/.test(raw) ||
    (/\b(this\s+)?weekends?\b/.test(raw) && !/\b(saturday|sunday|morning|afternoon|evening)\b/.test(raw))
  ) {
    return { date: 'weekends', time: null, schedulingMode: null, refine: 'weekend' };
  }
  if (/^next week$/.test(raw) || /\bnext week\b/.test(raw)) {
    return { date: 'next week', time: 'Next week', schedulingMode: 'USER_PREFERENCE', refine: null };
  }
  if (/\bafter\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/.test(raw)) {
    return { date: null, time: String(text).trim(), schedulingMode: 'USER_PREFERENCE', refine: null };
  }
  const dayTime = raw.match(/\b(saturday|sunday|tomorrow)\b(?:\s+(morning|afternoon|evening))?\b/);
  if (dayTime) {
    const day = dayTime[1].replace(/^\w/, (c) => c.toUpperCase());
    const slot = dayTime[2] || null;
    if (slot) {
      return {
        date: day,
        time: `${day} ${slot}`,
        schedulingMode: 'USER_PREFERENCE',
        refine: null,
      };
    }
    if (day === 'Tomorrow') {
      return { date: 'Tomorrow', time: 'Tomorrow', schedulingMode: 'USER_PREFERENCE', refine: null };
    }
    return { date: day, time: null, schedulingMode: null, refine: 'daypart' };
  }
  if (/^(morning|afternoon|evening)$/.test(raw)) {
    return { date: null, time: raw, schedulingMode: 'USER_PREFERENCE', refine: null };
  }
  return null;
}

function applyViewingPreference(vr, pref) {
  if (!pref) return vr;
  if (pref.date !== undefined && pref.date !== null) vr.preferredDate = pref.date;
  if (pref.time) vr.preferredTime = pref.time;
  if (pref.schedulingMode) vr.schedulingMode = pref.schedulingMode;
  if (pref.refine === 'weekend') {
    vr.preferredTime = null;
    vr.schedulingMode = null;
  }
  if (pref.refine === 'daypart') {
    vr.preferredTime = null;
    vr.schedulingMode = null;
  }
  return vr;
}

function viewingMissingContactFields(vr = {}) {
  const missing = [];
  if (!looksCollected(vr.name)) missing.push('name');
  if (!looksCollected(vr.phone) && !looksCollected(vr.email)) missing.push('phoneOrEmail');
  return missing;
}

function viewingHasRequiredContact(vr = {}) {
  return looksCollected(vr.name) && (looksCollected(vr.phone) || looksCollected(vr.email));
}

function viewingContactPrompt(vr = {}) {
  const missing = viewingMissingContactFields(vr);
  if (!missing.includes('name') && missing.includes('phoneOrEmail')) {
    return 'Please share a phone number or email so the agent can reach you.';
  }
  if (missing.includes('name') && !missing.includes('phoneOrEmail')) {
    return 'Please share your name as well.';
  }
  return 'I can arrange a viewing for this property. Please share your name and either your phone number or email.';
}

function viewingHasSchedulingPreference(vr = {}) {
  if (vr.schedulingMode === 'AGENT_COORDINATE') return true;
  if (vr.preferredDate === 'weekends' && !looksCollected(vr.preferredTime)) return false;
  if (/^(Saturday|Sunday)$/.test(String(vr.preferredDate || '')) && !looksCollected(vr.preferredTime)) {
    return false;
  }
  if (vr.schedulingMode === 'USER_PREFERENCE' && (looksCollected(vr.preferredTime) || looksCollected(vr.preferredDate))) {
    return true;
  }
  return looksCollected(vr.preferredTime);
}

function viewingNeedsWeekendRefinement(vr = {}) {
  return vr.preferredDate === 'weekends' && !looksCollected(vr.preferredTime);
}

function viewingNeedsDaypartRefinement(vr = {}) {
  return /^(Saturday|Sunday)$/.test(String(vr.preferredDate || '')) && !looksCollected(vr.preferredTime);
}

function viewingNextStep(vr = {}, message = '', selection = {}) {
  if (vr.submitted && !isBookViewingRequest(message, selection)) return 'already_submitted';
  if (!vr.propertyRefNo) return 'select_property';
  const missing = viewingMissingContactFields(vr);
  if (missing.length) return 'collect_contact';
  if (viewingNeedsWeekendRefinement(vr) || viewingNeedsDaypartRefinement(vr)) return 'collect_time';
  if (!viewingHasSchedulingPreference(vr)) return 'collect_time';
  return 'submit_viewing';
}

function logViewingDebug(label, payload) {
  if (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test') return;
  console.log(label, JSON.stringify(payload));
}

function viewingTimePrompt() {
  return 'Do you have a preferred date or time for the viewing, or should the agent coordinate a suitable slot with you?';
}

function viewingSchedulingPrompt(vr = {}) {
  if (viewingNeedsWeekendRefinement(vr)) {
    return {
      reply: 'Do you have a preferred weekend time?',
      options: VIEWING_WEEKEND_OPTIONS.slice(),
    };
  }
  const day = String(vr.preferredDate || '');
  if (viewingNeedsDaypartRefinement(vr)) {
    return {
      reply: `Do you have a preferred time on ${day}?`,
      options: [`${day} morning`, `${day} afternoon`, `${day} evening`, 'Agent can coordinate'],
    };
  }
  return {
    reply: viewingTimePrompt(),
    options: VIEWING_NEUTRAL_OPTIONS.slice(),
  };
}

function viewingSuccessReply(vr = {}) {
  const when = vr.preferredTime || vr.preferredDate;
  const agent =
    vr.schedulingMode === 'AGENT_COORDINATE' || /^agent can coordinate$/i.test(String(when || ''));
  if (when && !agent) {
    return `Your viewing request has been recorded for ${when}. A Rocky Real Estate specialist will contact you using the details you provided to coordinate the viewing.`;
  }
  return 'Your viewing request has been recorded. A Rocky Real Estate specialist will contact you using the details you provided to coordinate the viewing.';
}

function viewingFailureReply() {
  return "I have your details, but I couldn't submit the viewing request right now. Please try again or contact the team directly.";
}

function viewingCompleteOptions() {
  return ['See similar properties', 'New property search'];
}

function viewingCloseReply() {
  return "You're all set. The team will contact you about the viewing.";
}

function buildViewingLeadIntent(vr = {}, profile = {}) {
  const bits = ['property viewing', 'source: website chatbot'];
  if (vr.propertyRefNo) bits.push(`ref ${vr.propertyRefNo}`);
  if (vr.propertyTitle) bits.push(vr.propertyTitle);
  const filters = profile.lastSearchFilters || {};
  if (filters.purpose) bits.push(String(filters.purpose));
  if (filters.location) bits.push(filters.location);
  if (filters.bedrooms != null && filters.bedrooms !== '') bits.push(`${filters.bedrooms} BR`);
  if (filters.budgetMin != null || filters.budgetMax != null) {
    bits.push(`budget ${filters.budgetMin || ''}-${filters.budgetMax || ''}`.replace(/-$/, '').trim());
  }
  if (vr.schedulingMode) bits.push(vr.schedulingMode);
  const when = vr.preferredTime || vr.preferredDate;
  if (when) bits.push(when);
  return bits.join(' — ').slice(0, 400);
}

function selectedViewingProperty(profile = {}, selection = {}) {
  return resolveSelectedViewingProperty(profile, selection);
}

function seedViewingContact(profile = {}, history = []) {
  const fromHistory = contactFromHistory(history);
  const sell = profile.sellListing || {};
  const service = profile.serviceInquiry || {};
  const vr = profile.viewingRequest || {};
  return {
    name: vr.name || sell.name || service.name || fromHistory.name || null,
    email: vr.email || sell.email || service.email || fromHistory.email || null,
    phone: vr.phone || sell.phone || service.phone || fromHistory.phone || fromHistory.whatsapp || null,
  };
}

function resetViewingSchedule(vr) {
  vr.preferredDate = null;
  vr.preferredTime = null;
  vr.schedulingMode = null;
  vr.askedTimeRefinement = false;
  vr.notes = null;
  vr.submitted = false;
  return vr;
}

function assignViewingProperty(vr, selected = {}) {
  vr.propertyRefNo = selected.propertyRefNo || null;
  vr.propertyId = selected.propertyId || selected.propertyRefNo || null;
  vr.propertyTitle = selected.propertyTitle || null;
  return vr;
}

function finalizeViewingCapture(viewingRequest, captureResult) {
  const vr = copyViewingRequest(viewingRequest);
  const ok = !!(captureResult?.leadCaptured || captureResult?.modelPayload?.ok);
  if (ok) {
    vr.submitted = true;
    vr.active = false;
    return {
      viewingRequest: vr,
      reply: viewingSuccessReply(vr),
      options: viewingCompleteOptions(),
      leadCaptured: true,
    };
  }
  vr.submitted = false;
  vr.active = true;
  return {
    viewingRequest: vr,
    reply: viewingFailureReply(),
    options: undefined,
    leadCaptured: false,
  };
}

function applyViewingRequestFlow(message, profile = {}, history = [], selection = {}) {
  const awaiting = profile.slotFlow?.awaiting;
  const previous = copyViewingRequest(profile.viewingRequest || {});
  const booking = isBookViewingRequest(message, selection);
  const inViewing =
    previous.active ||
    VIEWING_AWAITING.includes(awaiting) ||
    booking;

  if (!inViewing && previous.submitted && isViewingClosePhrase(message)) {
    return {
      type: 'clarify',
      profilePatch: {
        viewingRequest: { ...previous, active: false },
        slotFlow: { awaiting: null, alternatives: null },
      },
      reply: viewingCloseReply(),
      options: undefined,
    };
  }

  if (!inViewing) return null;
  if (isListingSearchOverride(message) && !booking) return null;

  const vr = copyViewingRequest(previous);
  let extracted = { name: previous.name, email: previous.email, phone: previous.phone };

  if (booking) {
    const selected = resolveSelectedViewingProperty(profile, selection);
    vr.active = true;
    resetViewingSchedule(vr);
    const seeded = seedViewingContact({ ...profile, viewingRequest: previous }, history);
    vr.name = seeded.name;
    vr.email = seeded.email;
    vr.phone = seeded.phone;
    extracted = { name: seeded.name, email: seeded.email, phone: seeded.phone };
    if (selected.ambiguous) {
      assignViewingProperty(vr, {});
      const prompt = viewingPropertyPrompt(selected.cards || profile.lastPropertyCards || []);
      logViewingDebug('VIEWING_STATE', {
        rawMessage: message,
        previousState: previous,
        extracted,
        mergedState: vr,
        missingFields: viewingMissingContactFields(vr),
        nextStep: 'select_property',
      });
      return {
        type: 'clarify',
        profilePatch: {
          viewingRequest: vr,
          slotFlow: { awaiting: 'viewingProperty', alternatives: null },
        },
        reply: prompt.reply,
        options: prompt.options,
      };
    }
    assignViewingProperty(vr, selected);
  } else if (previous.submitted && isViewingClosePhrase(message)) {
    vr.active = false;
    return {
      type: 'clarify',
      profilePatch: {
        viewingRequest: vr,
        slotFlow: { awaiting: null, alternatives: null },
      },
      reply: viewingCloseReply(),
    };
  } else if (previous.submitted) {
    logViewingDebug('VIEWING_STATE', {
      rawMessage: message,
      previousState: previous,
      extracted,
      mergedState: previous,
      missingFields: viewingMissingContactFields(previous),
      nextStep: 'already_submitted',
    });
    logViewingDebug('VIEWING_LEAD_CREATE', {
      skipped: true,
      reason: 'already_submitted',
      propertyRefNo: previous.propertyRefNo || null,
    });
    return {
      type: 'clarify',
      profilePatch: {
        viewingRequest: { ...previous, active: false },
        slotFlow: { awaiting: null, alternatives: null },
      },
      reply: viewingSuccessReply(previous),
      options: viewingCompleteOptions(),
    };
  } else if (awaiting === 'viewingProperty' || !vr.propertyRefNo) {
    const chosen =
      parseViewingPropertyChoice(message, profile.lastPropertyCards || []) ||
      (resolveSelectedViewingProperty(profile, selection).propertyRefNo
        ? resolveSelectedViewingProperty(profile, selection)
        : null);
    if (!chosen || (!chosen.id && !chosen.propertyRefNo)) {
      const prompt = viewingPropertyPrompt(profile.lastPropertyCards || []);
      return {
        type: 'clarify',
        profilePatch: {
          viewingRequest: vr,
          slotFlow: { awaiting: 'viewingProperty', alternatives: null },
        },
        reply: prompt.reply,
        options: prompt.options.length ? prompt.options : undefined,
      };
    }
    assignViewingProperty(vr, {
      propertyRefNo: chosen.id || chosen.propertyRefNo,
      propertyId: chosen.id || chosen.propertyRefNo,
      propertyTitle: chosen.title || chosen.propertyTitle || null,
    });
  } else {
    const contact = parseViewingContactDetails(message, vr);
    extracted = {
      name: contact.name,
      email: contact.email,
      phone: contact.phone || contact.whatsapp || null,
    };
    vr.name = contact.name || vr.name;
    vr.email = contact.email || vr.email;
    vr.phone = contact.phone || contact.whatsapp || vr.phone;
    applyViewingPreference(vr, parseViewingPreference(message));
    if (isViewingClosePhrase(message) && viewingHasRequiredContact(vr)) {
      vr.preferredTime = vr.preferredTime || 'Agent can coordinate';
      vr.schedulingMode = vr.schedulingMode || 'AGENT_COORDINATE';
    }
  }

  if (!vr.propertyRefNo && (profile.lastPropertyCards || []).length > 1) {
    const prompt = viewingPropertyPrompt(profile.lastPropertyCards || []);
    return {
      type: 'clarify',
      profilePatch: {
        viewingRequest: vr,
        slotFlow: { awaiting: 'viewingProperty', alternatives: null },
      },
      reply: prompt.reply,
      options: prompt.options,
    };
  }

  const missingFields = viewingMissingContactFields(vr);
  const nextStep = viewingNextStep(vr, message, selection);
  logViewingDebug('VIEWING_STATE', {
    rawMessage: message,
    previousState: previous,
    extracted,
    mergedState: vr,
    missingFields,
    nextStep,
  });

  if (!viewingHasRequiredContact(vr)) {
    return {
      type: 'clarify',
      profilePatch: {
        viewingRequest: vr,
        slotFlow: { awaiting: 'viewingContact', alternatives: null },
      },
      reply: viewingContactPrompt(vr),
    };
  }

  if (!viewingHasSchedulingPreference(vr)) {
    vr.askedTimeRefinement = true;
    const prompt = viewingSchedulingPrompt(vr);
    return {
      type: 'clarify',
      profilePatch: {
        viewingRequest: vr,
        slotFlow: { awaiting: 'viewingTime', alternatives: null },
      },
      reply: prompt.reply,
      options: prompt.options,
    };
  }

  logViewingDebug('VIEWING_LEAD_CREATE', {
    skipped: false,
    reason: 'submit_viewing',
    propertyRefNo: vr.propertyRefNo || null,
    name: vr.name || null,
    email: vr.email || null,
    phone: vr.phone || null,
    schedulingMode: vr.schedulingMode || null,
  });

  return {
    type: 'submit_viewing',
    profilePatch: {
      viewingRequest: vr,
      slotFlow: { awaiting: null, alternatives: null },
    },
  };
}

function contactFromHistory(messages = []) {
  let contact = { name: null, phone: null, email: null, whatsapp: null };
  for (const item of messages || []) {
    if (item.role !== 'user') continue;
    contact = parseContactDetails(item.content, contact);
  }
  return contact;
}

function propertyFromHistory(messages = []) {
  let type = null;
  let location = null;
  let bedrooms = null;
  let priceNote = null;
  for (const item of messages || []) {
    if (item.role !== 'user') continue;
    const parsed = parseSellListingDetails(item.content, { type, location, bedrooms, priceNote });
    type = parsed.type || type;
    location = parsed.location || location;
    bedrooms = parsed.bedrooms ?? bedrooms;
    priceNote = parsed.priceNote || priceNote;
  }
  return { type, location, bedrooms, priceNote };
}

function persistSellListing(current = {}, lastSearchFilters = {}, history = []) {
  const prior = copySellListing(current);
  const fromHistory = contactFromHistory(history);
  // Never seed type/location from lastSearchFilters or prior chat mentions —
  // those leak Buy/Rent search areas and content questions (e.g. "tell me about Dubai Marina").
  // Only keep fields already collected in this sellListing, plus contact from history.
  return {
    intent: 'sell',
    type: prior.type || null,
    location: prior.location || null,
    bedrooms: prior.bedrooms ?? null,
    priceNote: prior.priceNote || null,
    occupancy: prior.occupancy || null,
    name: prior.name || fromHistory.name || null,
    phone: prior.phone || fromHistory.phone || null,
    email: prior.email || fromHistory.email || null,
  };
}

function advanceSellListing(message, current = {}, history = [], lastSearchFilters = {}) {
  const seeded = persistSellListing(current, lastSearchFilters, history);
  // CTA / "already shared" must not re-parse the latest message — it has no contact fields.
  if (isSellCta(message) || isAlreadySharedDetails(message)) {
    return seeded;
  }
  const listing = parseSellListingDetails(message, seeded);
  const contact = parseContactDetails(message, listing);
  listing.intent = 'sell';
  listing.name = contact.name || seeded.name;
  listing.phone = contact.phone || seeded.phone;
  listing.email = contact.email || seeded.email;
  listing.type = listing.type || seeded.type;
  listing.location = listing.location || seeded.location;
  listing.occupancy = listing.occupancy || seeded.occupancy;
  return listing;
}

function missingSellContactFields(listing = {}) {
  return ['name', 'phone', 'email'].filter((key) => !listing[key]);
}

function hasSellContact(listing = {}) {
  return missingSellContactFields(listing).length === 0;
}

function buildSellLeadIntent(message = '', listing = {}) {
  const type = listing.type || 'Property';
  const loc = listing.location || 'Dubai';
  if (/valuation/i.test(String(message || ''))) {
    return `Sell valuation - ${type} in ${loc}`;
  }
  return `Sell listing - ${type} in ${loc}`;
}

/** Capture a sell lead once contact is complete and the user confirms via CTA or "already shared". */
function shouldCaptureSellLead(message, listing = {}) {
  if (!hasSellContact(listing)) return false;
  if (isSellCta(message)) return true;
  if (isAlreadySharedDetails(message)) return true;
  return false;
}

function isSellCta(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  return /^(get a valuation|valuation|talk to an agent|talk to agent|listing agent)$/i.test(raw);
}

const SELL_AREA_ALIASES = [
  { match: /\b(al\s+)?barsha\b/i, canonical: 'Al Barsha' },
  { match: /\bdubai\s+hills\b/i, canonical: 'Dubai Hills' },
  { match: /\bdubai\s+south\b/i, canonical: 'Dubai South' },
  { match: /\bdubai\s+marina\b/i, canonical: 'Dubai Marina' },
  { match: /\barabian\s+ranches\b/i, canonical: 'Arabian Ranches' },
  { match: /\bbusiness\s+bay\b/i, canonical: 'Business Bay' },
  { match: /\bjvc\b|\bjumeirah\s+village\s+circle\b/i, canonical: 'JVC' },
  { match: /\bsheikh\s+zayed\s+road\b|\bszr\b/i, canonical: 'Sheikh Zayed Road' },
  { match: /\bjebel\s+ali\b/i, canonical: 'Jebel Ali' },
  { match: /\bpalm\s+jumeirah\b/i, canonical: 'Palm Jumeirah' },
  { match: /\bdowntown(\s+dubai)?\b/i, canonical: 'Downtown Dubai' },
  { match: /\bjbr\b|\bjumeirah\s+beach\s+residence\b/i, canonical: 'JBR' },
];

function parseSellLocation(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  for (const row of SELL_AREA_ALIASES) {
    if (row.match.test(raw)) return row.canonical;
  }
  const named = parseLocationFromMessage(raw);
  if (named && !isUnspecifiedLocationPhrase(named) && !/^(call|amount|discuss|later)$/i.test(named)) {
    return named;
  }
  // Bare area replies while collecting sell details ("Sheikh Zayed Road", "Mudon").
  // Do not treat full sell-intent sentences or type replies as locations.
  if (parseSellIntent(raw)) return null;
  if (/^(type|property\s+type)\s+is\b/i.test(raw)) return null;
  if (/\b(sell|selling|buy|rent|need|want|show|find|looking|valuation|agent)\b/i.test(raw)) return null;
  if (normalizePropertyType(raw) && raw.split(/\s+/).length <= 3 && !/\b(in|near|at|on)\b/i.test(raw)) {
    return null;
  }
  if (raw.split(/\s+/).length > 6) return null;
  const reply = parseLocationReply(raw);
  if (!reply) return null;
  if (normalizePropertyType(reply) && reply.split(/\s+/).length <= 2) return null;
  if (parsePurposeFromMessage(reply) || isSellCta(reply)) return null;
  return reply;
}

function parseSellPriceNote(text) {
  const raw = String(text || '').toLowerCase();
  if (/\b(discuss|on\s+the\s+call|in\s+(a\s+)?call|later|negotiable|tbd|not\s+sure|skip|unsure)\b/.test(raw)) {
    return 'discuss';
  }
  const budget = parseBudgetFromMessage(text);
  if (budget?.budgetMax) return String(budget.budgetMax);
  return null;
}

function parseOccupancyFromMessage(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return null;
  if (/^(not sure|unsure|skip|n\/?a|any|doesn'?t matter)$/i.test(raw)) return 'unknown';
  if (/\bvacant\b|\bempty\b|\bunoccupied\b/.test(raw)) return 'vacant';
  if (/\btenanted\b|\brented\s+out\b|\bwith\s+(a\s+)?tenant\b|\binvestor\b/.test(raw)) return 'tenanted';
  if (/\bowner[-\s]?occupied\b|\bi\s+live\s+(in|there)\b|\bwe\s+live\s+(in|there)\b/.test(raw)) {
    return 'owner-occupied';
  }
  return null;
}

function parseSellListingDetails(text, current = {}) {
  const type = parseDesiredPropertyType(text) || normalizePropertyType(text) || current.type || null;
  const location = parseSellLocation(text) || current.location || null;
  const priceNote = parseSellPriceNote(text) || current.priceNote || null;
  const occupancy = parseOccupancyFromMessage(text) || current.occupancy || null;
  const beds = parseBedroomChoice(text);
  const next = {
    ...current,
    type,
    location,
    priceNote,
    occupancy,
    purpose: null,
  };
  if (beds && !beds.any && String(text || '').length < 80) {
    if (beds.exact != null) next.bedrooms = beds.exact;
    if (beds.min != null) next.bedroomsMin = beds.min;
  }
  return next;
}

function hasSellBedrooms(details = {}) {
  return details.bedrooms != null || details.bedroomsMin != null;
}

function sellReadyForCta(details = {}) {
  return !!(details.type && details.location && hasSellBedrooms(details) && details.priceNote && details.occupancy);
}

/** Progressive chips: type → bedrooms → occupancy → valuation/agent. */
function sellFlowOptions(details = {}, message = '') {
  if (isSellCta(message) || isAlreadySharedDetails(message)) return null;
  if (!details.type) return SELL_TYPE_OPTIONS;
  if (!details.location) return null;
  if (!hasSellBedrooms(details)) return BEDROOM_OPTIONS;
  if (!details.priceNote) return null;
  if (!details.occupancy) return ['Vacant', 'Owner-occupied', 'Tenanted'];
  return SELL_OPTIONS;
}

function sellClarificationReply(details = {}, message = '') {
  const typeLabel = details.type ? String(details.type).toLowerCase() : 'property';
  const loc = details.location || '';
  const hasProperty = !!(details.type && details.location);
  const contactMissing = missingSellContactFields(details);
  const already = isAlreadySharedDetails(message);
  const cta = isSellCta(message);

  if (hasProperty && contactMissing.length === 0) {
    if (cta && !/valuation/i.test(message)) {
      return `Thanks — I have your details for the ${loc} ${typeLabel}. I'll connect you with a listing agent.`;
    }
    if (cta || already) {
      return `Thanks — I have your details for the ${loc} ${typeLabel}. I can connect you with a listing agent for a valuation.`;
    }
    // Bare "yes" / "ok" — acknowledge and clarify which CTA, don't silently re-ask the same line
    if (isVagueConfirm(message)) {
      return 'Just to confirm — would you like the valuation, or to speak with an agent?';
    }
    return `Thanks — I have your details for the ${loc} ${typeLabel}. Would you like a quick valuation or to speak with a listing agent?`;
  }

  if (hasProperty && (cta || already)) {
    if (contactMissing.length === 1) {
      if (contactMissing[0] === 'phone') {
        return 'What phone number should the agent use to contact you?';
      }
      return `I still need your ${contactMissing[0]} to connect you with a listing agent.`;
    }
    if (contactMissing.length > 1 && already) {
      return `Please share your ${contactMissing.join(', ').replace(/, ([^,]*)$/, ' and $1')} so I can connect you with a listing agent.`;
    }
    if (cta && /valuation/i.test(message)) {
      return `I can help with a valuation for your ${typeLabel} in ${loc}. Please share your name, phone, and email.`;
    }
    if (cta) {
      return `I can connect you with a listing agent for your ${typeLabel} in ${loc}. Please share your name, phone, and email.`;
    }
  }

  if (!details.type && !details.location) {
    return 'I can help you sell your property. What type of property are you looking to sell — apartment, villa, townhouse, penthouse, or another type?';
  }
  if (details.type && !details.location) {
    return `Understood — a ${typeLabel}. Which area or community is it in?`;
  }
  if (!details.type && details.location) {
    return `Understood — a property in ${details.location}. What type of property are you looking to sell — apartment, villa, townhouse, penthouse, or another type?`;
  }
  if (hasProperty && !hasSellBedrooms(details) && !cta && !already) {
    return `A ${typeLabel} in ${loc} — how many bedrooms does it have?`;
  }
  if (hasProperty && !details.priceNote && !cta && !already) {
    const bedsLabel =
      details.bedrooms === 0
        ? 'studio '
        : Number.isFinite(Number(details.bedrooms))
          ? `${details.bedrooms}-bedroom `
          : details.bedroomsMin
            ? `${details.bedroomsMin}+ bedroom `
            : '';
    const spec = `${bedsLabel}${typeLabel}`.replace(/\s+/g, ' ').trim();
    return `For your ${spec} in ${loc}, do you have an expected selling price, or would you prefer to discuss valuation with an agent?`;
  }
  if (hasProperty && !details.occupancy && !cta && !already) {
    return 'Is the property currently vacant, owner-occupied, or tenanted?';
  }
  if (isVagueConfirm(message)) {
    return 'Just to confirm — would you like the valuation, or to speak with an agent?';
  }
  return `I can help you sell your ${typeLabel} in ${loc}. Would you like a quick valuation or to speak with a listing agent?`;
}

function isOffPlanInformationalQuery(lower) {
  return /\b(financ|payment\s+plans?|articles?|blogs?|posts?|faq|can\s+i\s+sell|before\s+completion|how\s+(?:does|do|to|can)|what\s+(?:is|are|does)|options|costs?|eligib|invest(?:ment|ing)?|tell\s+me|explain|need\s+to\s+know)\b/.test(
    lower
  );
}

function isBuyContentQuestion(lower) {
  return /\b(buying\s+costs?|cost\s+(?:of|to)\s+buy(?:ing)?|how\s+to\s+buy|can\s+(?:i|foreigners|you)\s+buy|before\s+buying|rules?\s+for\s+buy)\b/.test(
    lower
  );
}

function mentionsOffPlan(lower) {
  const collapsed = String(lower || '').replace(/[\s_-]+/g, '');
  return /off[\s-_]*plan/.test(lower) || collapsed.includes('offplan');
}

function isOffPlanNegation(lower) {
  const collapsed = String(lower || '').replace(/[\s_-]+/g, '');
  return (
    /\b(?:not|no|non)[\s,-]+(?:an?\s+)?off[\s-_]*plan\b/.test(lower) ||
    collapsed.includes('notoffplan') ||
    collapsed.includes('nooffplan')
  );
}

function isReadyInventoryRequest(lower) {
  return /\bready\b/.test(lower);
}

function isExplicitRentIntent(lower) {
  if (/\brent\s+collection\b/.test(lower)) return false;
  if (/\bbuy\b|\bpurchase\b|\bfor\s+sale\b/.test(lower) && !/\b(?:for\s+rent|to\s+rent|rental|lease)\b/.test(lower)) {
    return false;
  }
  return (
    /^(i\s+(want\s+to\s+|would\s+like\s+to\s+)?|i'?d\s+like\s+to\s+|i'?m\s+(looking\s+to\s+|looking\s+for\s+)?|i\s+am\s+(looking\s+to\s+|looking\s+for\s+)?|looking\s+to\s+|looking\s+for\s+)?(rent|rental|lease|renting|leasing)\b/.test(
      lower
    ) ||
    /\b((?:i(?:'| a)?m|i\s+am)\s+)?looking\s+to\s+rent\b/.test(lower) ||
    /\b((?:i(?:'| a)?m|i\s+am)\s+)?looking\s+for\b.{0,60}\b(to\s+rent|for\s+rent|rental)\b/.test(lower) ||
    /\b(?:want|would\s+like|('d\s+like)|need)\s+(?:to\s+)?(?:rent|rental|lease)\b/.test(lower) ||
    /\bneed\s+a\b.{0,40}\b(for\s+rent|to\s+rent)\b/.test(lower) ||
    /\b(apartment|villa|townhouse|penthouse|studio|flat|property|home)\s+to\s+rent\b/.test(lower) ||
    /\bfor\s+rent\b/.test(lower) ||
    /\bto\s+rent\b/.test(lower) ||
    /\bto\s+lease\b/.test(lower) ||
    /\brenting\s+(?:a|an|the)\b/.test(lower) ||
    /\bleasing\s+(?:a|an|the)\b/.test(lower)
  );
}

function isExplicitBuyIntent(lower) {
  if (isBuyContentQuestion(lower)) return false;
  if (/\brent\b|\blease\b/.test(lower)) return false;
  return (
    /^(i\s+(want\s+to\s+|would\s+like\s+to\s+)?|i'?d\s+like\s+to\s+|i'?m\s+(looking\s+to\s+|looking\s+for\s+)?|i\s+am\s+(looking\s+to\s+|looking\s+for\s+)?|looking\s+to\s+|looking\s+for\s+)?(buy|purchase|buying|purchasing)\b/.test(
      lower
    ) ||
    /\b((?:i(?:'| a)?m|i\s+am)\s+)?looking\s+to\s+buy\b/.test(lower) ||
    /\b((?:i(?:'| a)?m|i\s+am)\s+)?looking\s+for\s+(?:a\s+|an\s+)?(?:to\s+)?buy\b/.test(lower) ||
    /\b(?:want|would\s+like|('d\s+like)|need)\s+(?:to\s+)?buy\b/.test(lower) ||
    /\b(?:want|would\s+like|('d\s+like)|need)\s+(?:to\s+)?purchase\b/.test(lower) ||
    /\bto\s+buy\b/.test(lower) ||
    /\bto\s+purchase\b/.test(lower) ||
    /\bfor\s+sale\b/.test(lower) ||
    /\bbuying\s+(?:a|an|the)\b/.test(lower) ||
    /\bpurchasing\s+(?:a|an|the)\b/.test(lower)
  );
}

function parsePurposeFromMessage(text, previous = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (parseSellIntent(raw)) return null;
  const exact = normalizePurpose(raw);
  if (exact) return exact;

  const lower = raw.toLowerCase().replace(/[.!?]/g, '').trim();
  const collapsed = lower.replace(/[\s_-]+/g, '');
  const rejectsOffPlan = isOffPlanNegation(lower);
  const wantsReady = isReadyInventoryRequest(lower);
  const wantsRent = isExplicitRentIntent(lower);
  const wantsBuy = isExplicitBuyIntent(lower);
  const wantsOffPlan =
    !rejectsOffPlan &&
    !wantsReady &&
    !wantsRent &&
    (collapsed === 'offplan' ||
      collapsed === 'offplanproperties' ||
      mentionsOffPlan(lower) ||
      (/\bunder\s+construction\b/.test(lower) && !isOffPlanInformationalQuery(lower)) ||
      (/\b(new\s+projects?|new\s+developments?)\b/.test(lower) && !isOffPlanInformationalQuery(lower)));

  if (wantsOffPlan && isOffPlanInformationalQuery(lower)) return null;

  // Latest-message priority: rent > buy > off-plan > ready / not off-plan.
  if (wantsRent) return 'Rent';
  if (wantsBuy) return 'Buy';
  if (wantsOffPlan) return 'Off-plan';
  if (rejectsOffPlan || wantsReady) {
    if (isRentalPurpose(previous.purpose)) return 'Rent';
    return 'Buy';
  }
  return null;
}

function isBedroomsSet(value) {
  if (value === undefined || value === null || value === '') return false;
  return Number.isFinite(Number(value));
}

function isBedroomsResolved(filters = {}) {
  if (filters.bedroomsResolved === true) return true;
  if (filters.bedroomsAny === true) return true;
  if (isBedroomsSet(filters.bedrooms)) return true;
  if (isBedroomsSet(filters.bedroomsMin)) return true;
  return false;
}

function applyBedroomChoice(filters, choice) {
  if (!filters || !choice) return filters;
  filters.bedroomsResolved = true;
  if (choice.any) {
    filters.bedrooms = null;
    filters.bedroomsMin = null;
    filters.bedroomsAny = true;
    return filters;
  }
  filters.bedroomsAny = false;
  if (choice.min != null) {
    filters.bedrooms = null;
    filters.bedroomsMin = choice.min;
    return filters;
  }
  filters.bedrooms = choice.exact;
  filters.bedroomsMin = null;
  return filters;
}

function clearUntrustedBedrooms(filters) {
  if (!filters) return filters;
  if (isBedroomsResolved(filters)) {
    filters.bedroomsResolved = true;
    return filters;
  }
  filters.bedrooms = null;
  filters.bedroomsMin = null;
  filters.bedroomsAny = false;
  filters.bedroomsResolved = false;
  return filters;
}

function applyBudgetChoice(filters, choice) {
  if (!filters || !choice) return filters;
  filters.budgetProvided = true;
  if (choice.any) {
    filters.budgetMin = null;
    filters.budgetMax = null;
    return filters;
  }
  filters.budgetMin = choice.budgetMin != null ? choice.budgetMin : null;
  filters.budgetMax = choice.budgetMax != null ? choice.budgetMax : null;
  return filters;
}

function parseAedToken(numStr, unit) {
  const n = Number(numStr);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = String(unit || '').toLowerCase();
  if (!u) return n >= 1000 ? n : null;
  if (u.startsWith('m')) return n * 1_000_000;
  if (u.startsWith('k') || u.includes('thousand')) return n * 1_000;
  return n;
}

function parseBudgetFromMessage(text, { requireBudgetContext = false } = {}) {
  const original = String(text || '').trim();
  const raw = original
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/\/year/g, '')
    .replace(/\bper\s+year\b/g, '')
    .replace(/\byear\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;

  if (
    /^any budget$/.test(raw) ||
    /^no budget$/.test(raw) ||
    /^no limit$/.test(raw) ||
    /^no budget limit$/.test(raw) ||
    /^no budget restriction$/.test(raw)
  ) {
    return { any: true };
  }
  if (BUY_BUDGET_CHIP_MAP[raw]) return { ...BUY_BUDGET_CHIP_MAP[raw] };
  if (RENT_BUDGET_CHIP_MAP[raw]) return { ...RENT_BUDGET_CHIP_MAP[raw] };
  if (/^(any|skip|none|no preference|doesn'?t matter)$/.test(raw)) {
    return requireBudgetContext ? { any: true } : null;
  }

  const bedroomLike = parseBedroomChoice(raw);
  const mentionsMoney = /(budget|aed|million|thousand|\bm\b|\bk\b|dirham|maximum|max\b|under|below|up to|cap)/.test(
    raw
  );
  const hadCommaNumber = /\d{1,3}(?:,\d{3})+/.test(original);
  const mostlyNumber = /^(?:aed\s*)?\d{4,9}$/.test(raw);
  if (bedroomLike && !mentionsMoney && !hadCommaNumber && !mostlyNumber) return null;

  const plus = raw.match(/(?:aed\s*)?(\d+(?:\.\d+)?)\s*(k|m|mn|million|thousand)?\s*\+/);
  if (plus) {
    const min = parseAedToken(plus[1], plus[2] || 'm');
    if (min) return { budgetMin: min };
  }

  const range = raw.match(
    /(?:between\s+)?(?:aed\s*)?(\d+(?:\.\d+)?)\s*(k|m|mn|million|thousand)?\s*(?:-|–|to|and)\s*(?:aed\s*)?(\d+(?:\.\d+)?)\s*(k|m|mn|million|thousand)?/
  );
  if (range) {
    let unit1 = range[2];
    let unit2 = range[4];
    if (!unit1 && unit2) unit1 = unit2;
    if (!unit2 && unit1) unit2 = unit1;
    const min = parseAedToken(range[1], unit1);
    const max = parseAedToken(range[3], unit2);
    if (min && max && min < max) return { budgetMin: min, budgetMax: max };
  }

  const under = /(?:under|below|max(?:imum)?|up to|less than|within|cap(?:ped)?(?: at)?|no more than)\b/.test(raw);

  let n = null;
  const mil = raw.match(/(\d+(?:\.\d+)?)\s*(m|mn|million)\b/);
  if (mil) n = Number(mil[1]) * 1_000_000;
  if (n == null) {
    const k = raw.match(/(\d+(?:\.\d+)?)\s*(k|thousand)\b/);
    if (k) n = Number(k[1]) * 1_000;
  }
  if (n == null) {
    const aed = raw.match(/(?:aed\s*)(\d{4,9})\b/);
    if (aed) n = Number(aed[1]);
  }
  if (n == null && (under || mentionsMoney || requireBudgetContext || hadCommaNumber || mostlyNumber)) {
    const plain = raw.match(/\b(\d{4,9})\b/);
    if (plain) n = Number(plain[1]);
  }

  if (!Number.isFinite(n) || n <= 0) return null;
  if (/\b(from|minimum|min|at least|starting|above|over)\b/.test(raw) && !under) {
    return { budgetMin: n };
  }
  return { budgetMax: n };
}

function isVagueConfirm(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  return /^(ok|okay|k|yes|yep|yeah|sure|go ahead|please|alright|all right|fine|do it)$/.test(raw);
}

function describeBedroomPhrase(filters = {}) {
  if (filters.bedroomsAny) return '';
  if (isBedroomsSet(filters.bedroomsMin)) return `${filters.bedroomsMin}+ bedroom `;
  if (!isBedroomsSet(filters.bedrooms)) return '';
  const n = Number(filters.bedrooms);
  if (n === 0) return 'studio ';
  if (Number.isFinite(n)) return `${n}-bedroom `;
  return '';
}

function describeTypePhrase(filters = {}, count = 0) {
  const types = typesFromFilters(filters);
  const n = Number(count);
  if (!types.length) return n === 1 ? 'property' : 'properties';
  const labels = types.map((t) =>
    n === 1 && types.length === 1 ? t.toLowerCase() : pluraliseType(t).toLowerCase()
  );
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/** Singular form, capitalised — e.g. "Villa", "Apartment", "property". */
function describeTypeSingular(filters = {}) {
  const types = typesFromFilters(filters);
  if (!types.length) return 'property';
  if (types.length === 1) return types[0];
  if (types.length === 2) return `${types[0]} or ${types[1]}`;
  return types.join(', ');
}

function foundListingsReply(filters = {}, total = 0, { isShowMore = false, newCount = 0 } = {}) {
  const area = describeLocationClause(filters);
  const beds = describeBedroomPhrase(filters);
  const count = Number.isFinite(Number(total)) ? Number(total) : 0;
  const shownNow = Number.isFinite(Number(newCount)) && newCount > 0 ? newCount : count;
  const type = describeTypePhrase(filters, isShowMore ? shownNow : count);
  const purpose = normalizePurpose(filters.purpose);
  let purposeBit = 'for sale';
  if (purpose === 'Rent') purposeBit = 'for rent';
  if (purpose === 'Off-plan') purposeBit = 'off-plan';
  const purposeSuffix = purpose === 'Off-plan' ? '' : ` ${purposeBit}`;
  if (isShowMore) {
    const budgetBit = describeBudgetPossessive(filters);
    return `Here are more ${beds}${type}${area}${budgetBit}.`.replace(/\s+/g, ' ').trim();
  }
  return `I found ${count} ${beds}${type}${purposeSuffix}${area}. Would you like the details?`
    .replace(/\s+/g, ' ')
    .trim();
}

function moreMatchesOptions(filters = {}, { hasMore = false, nearbyCount } = {}) {
  const opts = [];
  if (hasMore) opts.push('Show more');
  opts.push('Change budget');
  if (requiresBedroomsForSearch(filters)) opts.push('Change bedrooms');
  const includeNearby =
    hasLocationConstraint(filters) && (nearbyCount === undefined || nearbyCount > 0);
  if (includeNearby) opts.push('Nearby areas');
  return opts;
}

function describeBudgetRange(filters = {}) {
  const min = budgetNumber(filters.budgetMin);
  const max = budgetNumber(filters.budgetMax);
  const hasMin = min != null;
  const hasMax = max != null;
  if (hasMin && hasMax) {
    const maxLabel = formatAed(max).replace(/^AED\s/, '');
    return `within ${formatAed(min)}–${maxLabel}`;
  }
  if (hasMax) return `within ${formatAed(max)}`;
  if (hasMin) return `from ${formatAed(min)}`;
  return '';
}

function budgetNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function describeBudgetBare(filters = {}) {
  const min = budgetNumber(filters.budgetMin);
  const max = budgetNumber(filters.budgetMax);
  const hasMin = min != null;
  const hasMax = max != null;
  if (hasMin && hasMax) {
    return `${formatAed(min)}–${formatAed(max).replace(/^AED\s/, '')}`;
  }
  if (hasMax) return formatAed(max);
  if (hasMin) return `${formatAed(min)}+`;
  return '';
}

function describeBudgetConstraint(filters = {}) {
  const min = budgetNumber(filters.budgetMin);
  const max = budgetNumber(filters.budgetMax);
  if (min != null && max != null) {
    return `within ${formatAed(min)}–${formatAed(max).replace(/^AED\s/, '')}`;
  }
  if (max != null) return `below ${formatAed(max)}`;
  if (min != null) return `above ${formatAed(min)}`;
  return '';
}

function matchingSegmentPhrase(filters = {}) {
  const beds = describeBedroomPhrase(filters).trim();
  const type = describeTypePhrase(filters, 2);
  const purpose = normalizePurpose(filters.purpose);
  if (purpose === 'Off-plan') return [beds, 'off-plan', type].filter(Boolean).join(' ');
  if (purpose === 'Rent') return [beds, type, 'for rent'].filter(Boolean).join(' ');
  if (purpose === 'Buy') return [beds, type, 'for sale'].filter(Boolean).join(' ');
  return [beds, type].filter(Boolean).join(' ');
}

function exactNoMatchLine(filters = {}) {
  const loc = hasLocationConstraint(filters) ? ` in ${String(filters.location).trim()}` : '';
  const budget = describeBudgetConstraint(filters);
  const segment = matchingSegmentPhrase(filters);
  return `I couldn't find any ${segment}${loc}${budget ? ` ${budget}` : ''}.`.replace(/\s+/g, ' ').trim();
}

function unconstrainedBudgetLine(count, filters = {}) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return '';
  const loc = hasLocationConstraint(filters) ? ` in ${String(filters.location).trim()}` : '';
  return `Across all budgets, there are ${n} matching ${matchingSegmentPhrase(filters)}${loc}.`
    .replace(/\s+/g, ' ')
    .trim();
}

function complementaryBudgetChip(filters = {}) {
  const min = budgetNumber(filters.budgetMin);
  const max = budgetNumber(filters.budgetMax);
  const rent = isRentalPurpose(filters.purpose);
  if (min != null && max == null) {
    if (rent) {
      if (min === 250_000) return 'Below AED 250K/year';
      if (min === 150_000) return 'Below AED 150K/year';
      if (min === 100_000) return 'Below AED 100K/year';
      if (min === 60_000) return 'Below AED 60K/year';
      return null;
    }
    if (min === 3_000_000) return 'Below AED 3M';
    if (min === 2_000_000) return 'Below AED 2M';
    if (min === 1_500_000) return 'Below AED 1.5M';
    if (min === 1_000_000) return 'Below AED 1M';
    return null;
  }
  if (max != null && min == null) {
    if (rent && max === 250_000) return 'Above AED 250K/year';
    if (!rent && max === 3_000_000) return 'Above AED 3M';
    return null;
  }
  return null;
}

function describeBudgetPossessive(filters = {}) {
  const range = describeBudgetRange(filters);
  if (!range) return '';
  if (range.startsWith('within ')) return ` within your ${range.slice('within '.length)} budget`;
  if (range.startsWith('from ')) return ` ${range}`;
  return ` ${range}`;
}

function exactResultsExhaustedReply(filters = {}, stats = {}) {
  const area = describeLocationClause(filters);
  const segment = describeBedsAndType(filters, { plural: true });
  const budgetBit = describeBudgetRange(filters);
  const where = `${segment}${area}${budgetBit ? ` ${budgetBit}` : ''}`.replace(/\s+/g, ' ').trim();
  const min = stats.minimumPrice != null ? formatAed(stats.minimumPrice) : null;
  const avg = stats.averagePrice != null ? formatAed(stats.averagePrice) : null;
  const lines = [`There aren't any more ${where} right now.`];
  if (min && avg) {
    lines.push(
      `Current ${segment}${area} start from around ${min}, with an average asking price of about ${avg}.`
    );
  } else if (min) {
    lines.push(`Current ${segment}${area} start from around ${min}.`);
  }
  lines.push(searchBroadenReply(filters, { budgetHint: true }));
  return lines.join('\n\n');
}

function bedroomFallbackOptions(filters = {}) {
  if (!requiresBedroomsForSearch(filters)) return [];
  const n = Number(filters.bedrooms);
  if (Number.isFinite(n) && n >= 4) return ['Try 3 BR'];
  if (Number.isFinite(n) && n >= 2) return ['Try 1 BR'];
  if (n === 1) return ['Try Studio'];
  return ['Change bedrooms'];
}

function nearbyFallbackOptions(filters = {}) {
  return hasLocationConstraint(filters) ? ['Nearby areas'] : [];
}

function exactResultsExhaustedOptions(filters = {}) {
  const opts = [];
  const capped = isBudgetProvided(filters) && (filters.budgetMin != null || filters.budgetMax != null);
  const anyBudget = isBudgetProvided(filters) && filters.budgetMin == null && filters.budgetMax == null;
  if (capped) opts.push('Increase budget');
  opts.push(...bedroomFallbackOptions(filters).filter((opt) => opt !== 'Change bedrooms'));
  opts.push(...nearbyFallbackOptions(filters));
  if (!anyBudget) opts.push('Any budget');
  if (!opts.includes('Increase budget') && !opts.includes('Any budget')) opts.push('Change budget');
  return opts;
}

function searchBroadenReply(filters = {}, { budgetHint = false } = {}) {
  const parts = [];
  if (budgetHint) parts.push('increasing your budget');
  if (hasLocationConstraint(filters)) parts.push('checking nearby areas');
  if (requiresBedroomsForSearch(filters)) parts.push('trying another bedroom configuration');
  parts.push('trying a different property type');
  if (!budgetHint && !requiresBedroomsForSearch(filters)) {
    parts.unshift('changing your budget');
  }
  if (parts.length === 1) return `I can broaden the search by ${parts[0]}.`;
  if (parts.length === 2) return `I can broaden the search by ${parts[0]} or ${parts[1]}.`;
  return `I can broaden the search by ${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}.`;
}

function noAdditionalSegmentReply(filters = {}) {
  const segment = describeBedsAndType(filters, { plural: true });
  const place = describeLocationClause(filters);
  return (
    `I couldn't find any additional ${segment} currently available${place}.\n\n` +
    searchBroadenReply(filters)
  );
}

function noAdditionalSegmentOptions(filters = {}) {
  const opts = [...nearbyFallbackOptions(filters), ...bedroomFallbackOptions(filters), 'Change property type'];
  if (!requiresBedroomsForSearch(filters) && !opts.includes('Change budget')) opts.push('Change budget');
  return opts;
}

function emptyResultsReply(filters = {}) {
  const loc = hasLocationConstraint(filters)
    ? String(filters.location).trim()
    : '';
  const beds = describeBedroomPhrase(filters).trim();
  const type = describeTypeSingular(filters);
  const bedsType = beds ? `${beds} ${type.toLowerCase()}` : type.toLowerCase();
  if (loc) return `Looking for a ${bedsType} in ${loc} — let me check the closest options for you.`;
  return `Looking for a ${bedsType} — let me check the closest options for you.`;
}

/** Soft nearby-offer copy when the requested location has zero inventory for purpose+type. */
function locationEmptyNearbyReply(filters = {}, nearbyAreas = []) {
  const loc = (filters.location || 'that area').toString().trim() || 'that area';
  const areas = (nearbyAreas || []).map((a) => String(a).trim()).filter(Boolean);
  if (!areas.length) {
    return `Let me check what's available near ${loc} for you. Would you like to try a different area or adjust the search?`;
  }
  if (areas.length === 1) {
    return `We don't currently have matching listings in ${loc}, but there are options nearby in ${areas[0]}. Would you like me to show those?`;
  }
  const head = areas.slice(0, -1).join(', ');
  const tail = areas[areas.length - 1];
  return `Let me check what's available near ${loc} for you. I can show nearby options in ${head}, or ${tail}. Which area would you like?`;
}

function emptyResultOptions(filters = {}) {
  const opts = [...bedroomFallbackOptions(filters).filter((opt) => opt !== 'Change bedrooms')];
  if (requiresBedroomsForSearch(filters)) {
    const n = Number(filters.bedrooms);
    const min = Number(filters.bedroomsMin);
    const beds = [];
    if (min >= 4 || n >= 4) beds.push('Try 3 BR');
    else if (n === 3) beds.push('Try 2 BR');
    else if (n === 2) beds.push('Try 1 BR');
    else if (n === 1) beds.push('Try Studio');
    opts.length = 0;
    opts.push(...beds);
  }
  opts.push(...nearbyFallbackOptions(filters), 'Change budget');
  return opts;
}

const NEARBY_AREA_MAP = [
  { match: /dubai hills/i, areas: ['Arabian Ranches', 'Town Square', 'The Springs'] },
  { match: /dubai south|dwc/i, areas: ['Dubai Investment Park', 'Jebel Ali', 'Discovery Gardens'] },
  { match: /\bmarina\b/i, areas: ['JBR', 'JLT', 'Dubai Harbour', 'Palm Jumeirah'] },
  { match: /downtown/i, areas: ['Business Bay', 'DIFC'] },
  { match: /jvc|jumeirah village circle/i, areas: ['JVT', 'Dubai Sports City'] },
  { match: /arabian ranches/i, areas: ['Dubai Hills', 'Mudon', 'Town Square'] },
  { match: /palm jumeirah/i, areas: ['Dubai Marina', 'JBR'] },
  { match: /business bay/i, areas: ['Downtown Dubai', 'DIFC'] },
  { match: /\bjbr\b|jumeirah beach/i, areas: ['Dubai Marina', 'Dubai Harbour', 'JLT'] },
  { match: /\bjlt\b|jumeirah lake/i, areas: ['Dubai Marina', 'Dubai Harbour', 'JBR'] },
];

function nearbyAreaOptions(location) {
  const loc = String(location || '');
  for (const row of NEARBY_AREA_MAP) {
    if (row.match.test(loc)) return row.areas.slice();
  }
  return ['Dubai Hills', 'Arabian Ranches', 'Dubai Marina'];
}

function parseEmptyResultChoice(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (/^nearby areas$/i.test(raw)) return { nearby: true };
  if (/^(change|increase) budget$/i.test(raw)) return { budget: true };
  if (/^change bedrooms$/i.test(raw)) return { askBedrooms: true };
  if (/^(property type|change property type)$/i.test(raw)) return { askType: true };
  const tryBr = raw.match(/^try\s+(.+)$/i);
  if (tryBr) {
    const choice = parseBedroomChoice(tryBr[1]);
    if (choice) return { bedrooms: choice };
    const loc = parseLocationFromMessage(`in ${tryBr[1]}`) || parseLocationFromMessage(raw);
    if (loc) return { location: loc };
  }
  const beds = parseBedroomChoice(raw);
  if (beds) return { bedrooms: beds };
  return null;
}

function matchesNamedOption(text, options = []) {
  const raw = String(text || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  const hit = (options || []).find((opt) => String(opt).trim().toLowerCase() === raw);
  return hit || null;
}

function parseBedroomChoice(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return null;

  if (
    raw === 'any' ||
    raw === 'any br' ||
    isBedroomSkip(raw)
  ) {
    return { any: true };
  }

  if (/\bstudio\b/.test(raw) || raw === '0' || raw === '0 br' || raw === '0 bedroom' || raw === '0 bedrooms') {
    return { exact: 0 };
  }

  if (/4\s*\+|4\s*or\s*more|4\s*and\s*(up|above|more)|four\s*or\s*more|at\s*least\s*4/.test(raw)) {
    return { min: 4 };
  }

  const chip = raw.match(/^(\d+)\s*br$/);
  if (chip) {
    const n = Number(chip[1]);
    if (n >= 1 && n <= 3) return { exact: n };
  }

  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  if (Object.prototype.hasOwnProperty.call(words, raw)) return { exact: words[raw] };

  const wordBed = raw.match(/\b(one|two|three|four|five|six)\s*-?\s*(bed|br|bhk|bedroom)s?\b/);
  if (wordBed) return { exact: words[wordBed[1]] };

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 12) return { exact: n };
  }

  const numbered = raw.match(/\b(\d+)\s*-?\s*(bed|br|bhk|bedroom)s?\b/);
  if (numbered) {
    const n = Number(numbered[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 12) return { exact: n };
  }
  return null;
}

function parseBedroomsFromMessage(text) {
  const choice = parseBedroomChoice(text);
  if (!choice || choice.any) return null;
  if (choice.min != null) return choice.min;
  if (choice.exact != null) return choice.exact;
  return null;
}

const PROPERTY_TYPE_MAP = [
  {
    canonical: 'Apartment',
    patterns:
      /\b(apartment|apartments|flat|flats|condo|condos|unit|units|studio apartment|studio unit|studio room|studio flat|studios?)\b/,
  },
  { canonical: 'Villa', patterns: /\b(villa|villas)\b/ },
  { canonical: 'Townhouse', patterns: /\b(townhouse|townhouses|town house|town houses)\b/ },
  { canonical: 'Penthouse', patterns: /\b(penthouse|penthouses)\b/ },
  { canonical: 'Duplex', patterns: /\b(duplex|duplexes)\b/ },
  { canonical: 'Office', patterns: /\b(office|offices|commercial)\b/ },
  { canonical: 'Shop', patterns: /\b(shop|shops|retail)\b/ },
  { canonical: 'Warehouse', patterns: /\b(warehouse|warehouses)\b/ },
];

function normalizePropertyType(raw) {
  const lower = String(raw || '').trim().toLowerCase();
  if (!lower || lower === 'other') return null;
  for (const entry of PROPERTY_TYPE_MAP) {
    if (entry.patterns.test(lower)) return entry.canonical;
  }
  return null;
}

function resolvePropertyTypeValue(raw) {
  const text = String(raw || '').trim();
  if (!text || /^other$/i.test(text)) return null;
  const canonical = normalizePropertyType(text);
  if (canonical) return canonical;
  if (!/^[A-Za-z][A-Za-z0-9 \-]{0,40}$/.test(text)) return null;
  return text.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseOtherCustomType(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const labeled = raw.match(/\bother\s*[:\-]\s*([A-Za-z][A-Za-z0-9 \-]{1,40})/i);
  if (!labeled) return null;
  return resolvePropertyTypeValue(labeled[1]);
}

function splitTypeTokens(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(/\s*(?:,|&|\/|\+| and | or )\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function uniqueTypes(list = []) {
  return uniqueTypeList((list || []).map(resolvePropertyTypeValue).filter(Boolean));
}

function typesFromFilters(filters = {}) {
  if (Array.isArray(filters.types) && filters.types.length) return uniqueTypes(filters.types);
  if (filters.type) return uniqueTypes(splitTypeTokens(filters.type));
  return [];
}

function applyTypesToFilters(filters, types) {
  const list = uniqueTypes(types);
  filters.types = list;
  filters.type = list.length === 1 ? list[0] : list.length ? list.join(', ') : null;
  return filters;
}

const RESIDENTIAL_PROPERTY_TYPES = new Set([
  'apartment',
  'villa',
  'townhouse',
  'penthouse',
  'duplex',
  'studio',
  'flat',
  'house',
  'hotel apartment',
  'residential',
]);

const COMMERCIAL_PROPERTY_TYPES = new Set([
  'office',
  'shop',
  'retail',
  'warehouse',
  'commercial',
  'commercial building',
  'commercial land',
  'store',
  'showroom',
  'industrial',
  'land',
  'plot',
  'building',
]);

function normalizeTypeKey(type) {
  return String(type || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function isResidentialPropertyType(type) {
  const key = normalizeTypeKey(type);
  if (!key) return false;
  if (COMMERCIAL_PROPERTY_TYPES.has(key)) return false;
  if (RESIDENTIAL_PROPERTY_TYPES.has(key)) return true;
  const canonical = normalizePropertyType(key);
  if (!canonical) return false;
  const canonicalKey = normalizeTypeKey(canonical);
  return RESIDENTIAL_PROPERTY_TYPES.has(canonicalKey) && !COMMERCIAL_PROPERTY_TYPES.has(canonicalKey);
}

function isCommercialPropertyType(type) {
  const key = normalizeTypeKey(type);
  if (!key) return false;
  if (RESIDENTIAL_PROPERTY_TYPES.has(key)) return false;
  if (COMMERCIAL_PROPERTY_TYPES.has(key)) return true;
  const canonical = normalizePropertyType(key);
  if (!canonical) return false;
  const canonicalKey = normalizeTypeKey(canonical);
  return COMMERCIAL_PROPERTY_TYPES.has(canonicalKey) && !RESIDENTIAL_PROPERTY_TYPES.has(canonicalKey);
}

function searchTypesAreCommercial(filters = {}) {
  const types = typesFromFilters(filters);
  if (!types.length) return false;
  return types.every(isCommercialPropertyType);
}

function requiresBedroomsForSearch(filters = {}) {
  const types = typesFromFilters(filters);
  if (!types.length) return true;
  if (searchTypesAreCommercial(filters)) return false;
  return types.some(isResidentialPropertyType) || !types.some(isCommercialPropertyType);
}

function clearBedroomFilters(filters) {
  if (!filters) return filters;
  filters.bedrooms = null;
  filters.bedroomsMin = null;
  filters.bedroomsAny = false;
  filters.bedroomsResolved = false;
  return filters;
}

function clearBudgetFilters(filters) {
  if (!filters) return filters;
  filters.budgetMin = null;
  filters.budgetMax = null;
  filters.budgetProvided = false;
  return filters;
}

function isRentalPurpose(purpose) {
  return normalizePurpose(purpose) === 'Rent';
}

function bedroomsCompatibleWithTypes(filters = {}) {
  // Studio (bedrooms = 0) is valid on residential/unknown types. Only commercial
  // searches drop the bedroom filter.
  return !searchTypesAreCommercial(filters);
}

function searchCategory(filters = {}) {
  if (searchTypesAreCommercial(filters)) return 'commercial';
  if (typesFromFilters(filters).some(isResidentialPropertyType)) return 'residential';
  return 'unknown';
}

function isPropertyCategoryChange(previous = {}, next = {}) {
  const from = searchCategory(previous);
  const to = searchCategory(next);
  if (from === 'unknown' || to === 'unknown') return false;
  return from !== to;
}

function isExplicitListingPurpose(text) {
  return !!parsePurposeFromMessage(text) || isPurposeChipReply(text);
}

function clearPurposeFilters(filters) {
  if (!filters) return filters;
  filters.purpose = null;
  return filters;
}

function normalizeSearchProfileAfterPatch(previousProfile, patch, { explicitPurpose: _explicitPurpose = false } = {}) {
  const prev = copySearchFilters(previousProfile || emptySearchFilters());
  const incoming = patch && typeof patch === 'object' ? patch : {};
  const next = copySearchFilters({
    ...prev,
    ...incoming,
  });
  if (incoming.types !== undefined || incoming.type !== undefined) {
    applyTypesToFilters(next, typesFromFilters(incoming.types !== undefined ? incoming : next));
  }

  if (!bedroomsCompatibleWithTypes(next)) {
    clearBedroomFilters(next);
  }

  const prevPurpose = normalizePurpose(prev.purpose);
  const nextPurpose = normalizePurpose(next.purpose);

  if (prevPurpose && nextPurpose && prevPurpose !== nextPurpose) {
    if (isRentalPurpose(prevPurpose) !== isRentalPurpose(nextPurpose)) {
      clearBudgetFilters(next);
    }
  }

  return next;
}

function getRequiredSearchFields(profileOrFilters = {}) {
  const filters = profileOrFilters.lastSearchFilters
    ? copySearchFilters(profileOrFilters.lastSearchFilters)
    : copySearchFilters(profileOrFilters);
  const required = ['intent', 'propertyType'];
  if (requiresBedroomsForSearch(filters)) required.push('bedrooms');
  if (!filters.locationAny) required.push('location');
  return required;
}

function getMissingSearchFields(state = {}) {
  const filters = state.lastSearchFilters
    ? copySearchFilters(state.lastSearchFilters)
    : copySearchFilters(state);
  const missing = [];
  for (const field of getRequiredSearchFields(filters)) {
    if (field === 'intent' && !normalizePurpose(filters.purpose)) missing.push('intent');
    if (field === 'propertyType' && !typesFromFilters(filters).length) missing.push('propertyType');
    if (field === 'bedrooms' && !isBedroomsResolved(filters)) missing.push('bedrooms');
    if (field === 'location' && !filters.locationAny && !String(filters.location || '').trim()) {
      missing.push('location');
    }
  }
  return missing;
}

function parsePropertyTypesFromMessage(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const lower = raw.toLowerCase();
  const found = [];
  for (const entry of PROPERTY_TYPE_MAP) {
    if (entry.patterns.test(lower)) found.push(entry.canonical);
  }
  const other = parseOtherCustomType(raw);
  if (other) found.push(other);
  return uniqueTypes(found);
}

function mergePropertyTypes(current = [], incoming = [], message = '') {
  const cur = uniqueTypes(current);
  const next = uniqueTypes(incoming);
  if (!next.length) return cur;
  if (next.length > 1) return next;
  if (!cur.length) return next;
  const raw = String(message || '').trim();
  if (/\b(also|as well|too)\b/i.test(raw)) return uniqueTypes([...cur, ...next]);
  if (/\b(and|or)\b|,/.test(raw) && parsePropertyTypesFromMessage(raw).length > 1) {
    return uniqueTypes([...cur, ...next]);
  }
  // A single newly mentioned type is a replacement patch, not an append.
  return next;
}

function isShowMoreRequest(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return false;
  if (/\btell\s+me\s+more\b/.test(raw) || /\bmore\s+details\b/.test(raw) || /\bthe\s+(first|second|third)\b/.test(raw)) {
    return false;
  }
  if (/^see similar( properties)?$/.test(raw)) return true;
  if (
    /^(show(\s+me)?\s+more(\s+(properties|listings|options|results|please))?|more(\s+(properties|listings|options|results|please))?|see\s+more(\s+(properties|listings|options|results))?|another(\s+(ones?|properties|listings|options))?|next(\s+(page|batch|set|ones?))?)$/i.test(
      raw
    )
  ) {
    return true;
  }
  return /\b(show|see|give)\s+(me\s+)?more(\s+(properties|listings|options|results))?\b/.test(raw);
}

function hasActiveListingSearch(profile = {}) {
  if (isListingIntent(profile.intent)) return true;
  if (normalizePurpose(profile.purpose || profile.lastSearchFilters?.purpose)) return true;
  return false;
}

function hasInProgressListingSearch(profile = {}) {
  const last = profile.lastSearchFilters || emptySearchFilters();
  const awaiting = profile.slotFlow?.awaiting;
  return (
    isBedroomsResolved(last) ||
    typesFromFilters(last).length > 0 ||
    !!String(last.location || '').trim() ||
    last.locationAny === true ||
    LISTING_SLOT_AWAITING.has(awaiting)
  );
}

/** True when a listing intent must wipe prior filters (menu starter), not merge. */
function shouldResetOnListingIntent(message, profile = {}, explicitIntent = null) {
  const requestedIntent = normalizeIntentValue(explicitIntent);
  const detected = requestedIntent || parseConversationIntent(message);
  if (!detected || !isListingIntent(detected)) return false;
  if (isExplicitIntentStarter(message)) return true;
  if (hasInProgressListingSearch(profile) || isPurposeChipReply(message)) return false;
  return !!requestedIntent;
}

function filtersFromRequestBody(body = {}) {
  const typeRaw = body.property_type ?? body.propertyType ?? body.type;
  const typesRaw = body.property_types ?? body.propertyTypes ?? body.types;
  const custom = body.custom_property_type ?? body.customPropertyType ?? body.otherType ?? body.other_type;
  const incoming = [];
  if (typesRaw) incoming.push(...splitTypeTokens(typesRaw));
  if (typeRaw && !/^other$/i.test(String(typeRaw).trim())) incoming.push(...splitTypeTokens(typeRaw));
  if (typeRaw && /^other$/i.test(String(typeRaw).trim()) && custom) incoming.push(custom);
  if (custom && !incoming.length) incoming.push(custom);
  return uniqueTypes(incoming);
}

/**
 * True when the user asked for a different area without naming a real community.
 * "another locations", "somewhere else", "a different area" are not searchable places.
 */
function isUnspecifiedLocationPhrase(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return false;
  if (/\bsomewhere\s+(else|new|different)\b/.test(raw)) return true;
  return /\b((?:a|an|some)\s+)?(another|different|other|new)\s+(location|locations|area|areas|place|places|community|communities)\b/.test(
    raw
  );
}

/**
 * True when the visitor wants no area/community restriction.
 * "any location", "anywhere", "any area is fine", "anywhere in Dubai" clear the location filter.
 * Distinct from isUnspecifiedLocationPhrase, which asks for a replacement area.
 */
function isUnrestrictedLocationPhrase(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return false;
  if (/\bany\s+budget\b/.test(raw) && !/\bany\s+(location|locations|area|areas|place|places|community|communities)\b/.test(raw)) {
    if (!/\banywhere\b/.test(raw)) return false;
  }
  if (/\banywhere\s+near\b/.test(raw)) return false;
  if (/\banywhere(\s+in\s+dubai)?\b/.test(raw)) return true;
  if (/\b(any|all)\s+(location|locations|area|areas|place|places|community|communities)\b/.test(raw)) return true;
  if (/\b(location|area|community)\s+(doesn'?t|does\s+not)\s+matter\b/.test(raw)) return true;
  if (/\b(doesn'?t|does\s+not)\s+matter\s+where\b/.test(raw)) return true;
  if (/\bno\s+(specific|particular|preferred)\s+(location|area|community)\b/.test(raw)) return true;
  if (/\bno\s+preference\s+(on|for|about)\s+(the\s+)?(location|area|community|where)\b/.test(raw)) return true;
  if (/\b(all\s+over\s+dubai|across\s+dubai|dubai[\s-]*wide)\b/.test(raw)) return true;
  if (/\bwherever(\s+(in\s+dubai|is\s+fine|you\s+(have|can)))\b/.test(raw)) return true;
  if (/^(anywhere|all areas|all locations)$/.test(raw)) return true;
  if (/\bany\s+area\s+is\s+fine\b/.test(raw)) return true;
  return false;
}

function sanitizeSearchLocation(value) {
  const loc = String(value || '').trim();
  if (!loc) return null;
  if (isUnrestrictedLocationPhrase(loc) || isUnspecifiedLocationPhrase(loc) || isNonPlaceLocationToken(loc)) {
    return null;
  }
  return loc;
}

function hasLocationConstraint(filters = {}) {
  if (filters.locationAny === true) return false;
  const loc = sanitizeSearchLocation(filters.location);
  return !!loc;
}

function describeLocationClause(filters = {}, { fallback = '' } = {}) {
  if (!hasLocationConstraint(filters)) return fallback ? ` ${fallback}` : '';
  const loc = String(filters.location || '').trim();
  return loc ? ` in ${loc}` : fallback ? ` ${fallback}` : '';
}

function applyUnrestrictedLocation(filters) {
  if (!filters) return filters;
  filters.location = null;
  filters.locationAny = true;
  return filters;
}

/** Words that look like "in X" but are not Dubai communities. */
function isNonPlaceLocationToken(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return true;
  if (
    /^(any|all|anywhere|wherever|somewhere)$/i.test(raw) ||
    /^(any|all)\s+(location|locations|area|areas|place|places|community|communities)$/i.test(raw)
  ) {
    return true;
  }
  if (
    /^(summer|winter|spring|autumn|fall|general|cash|aed|dirhams?|call|person|question|advance|full|part|total|future|past|present|dubai\s+property)$/i.test(
      raw
    )
  ) {
    return true;
  }
  if (/^(january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(raw)) {
    return true;
  }
  return false;
}

/**
 * Blog / FAQ / guide / company topics — must use search_content, not listing search or sell chips.
 */
function isServicesCatalogQuestion(text) {
  return /\b(what\s+(?:type\s+of\s+)?services?\b|services?\s+(?:do\s+you|you\s+(?:offer|provide)|are\s+you\s+providing)|what\s+do\s+you\s+(?:offer|provide))\b/i.test(
    String(text || '')
  );
}

function isContentKnowledgeTopic(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase();
  if (!raw) return false;
  if (/\b(show|find|search)\s+(me\s+)?(villas?|apartments?|townhouses?|properties|homes?|listings?)\b/.test(raw)) {
    return false;
  }
  // Catalog "what services…" (even with a portfolio mention) is content, not PM lead capture
  if (isServicesCatalogQuestion(raw)) return true;
  // Property-management lead flow owns these — not blog Q&A.
  if (isMultiPropertyServiceQuery(raw) || matchesServiceInquiryPhrase(raw)) return false;
  return /\b(golden\s+visa|investor\s+visa|visa\s+eligib|buying\s+costs?|cost\s+of\s+buying|cost\s+to\s+buy|costs?\s+involved|transfer\s+fee|dld|mortgage|service\s+charge|rera|freehold|leasehold|flexi\s*rent|flexible\s+rent|payment\s+plans?|financ(?:e|ing|ial)?|payable\s+options?|installments?|roi|invest(?:ing|ment|or)?|summer|winter|spring|autumn|season|prepare|tips?|advice|faq|area\s+guide|tell\s+me\s+about|what\s+is|what\s+are|what\s+should\s+i\s+know|before\s+(?:renting|buying|leasing)|what'?s\s+(?:it\s+like|the\s+latest)|how\s+(?:can|do|to|does|much)|need\s+to\s+know|can\s+i\s+sell|before\s+completion|transaction|market\s+(?:stats?|data|overview)|quarter\s*[1234]|q\s*[1234]|blog|article|posts?|living\s+in|office\s+hours|book\s+(?:a\s+)?viewing|services?\s+(?:do\s+you|you\s+offer|offered|does)|do\s+you\s+(?:offer|help|provide)|company|founded|founder|years?\s+(?:in\s+)?(?:business|operation)|who\s+(?:founded|are\s+you|is\s+rocky)|areas?\s+(?:do\s+you\s+)?cover|contact\s+(?:us|for))\b/.test(
    raw
  );
}

function wantsDifferentLocation(text) {
  return isUnspecifiedLocationPhrase(text);
}

function firstPropertyTypeIn(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return null;
  for (const entry of PROPERTY_TYPE_MAP) {
    if (entry.patterns.test(lower)) return entry.canonical;
  }
  return null;
}

/**
 * Prefer the type after a change-intent verb so "this is apartment i need villa"
 * resolves to Villa, not Apartment.
 */
function parseDesiredPropertyType(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return null;
  const afterIntent = raw.match(
    /\b(?:need|want|prefer|would\s+like|'d\s+like|show(?:\s+me)?|give\s+me|find(?:\s+me)?|search(?:\s+for)?|change(?:\s+it)?(?:\s+to)?|switch(?:\s+to)?|looking\s+for|instead)\b(.*)$/i
  );
  return firstPropertyTypeIn(afterIntent ? afterIntent[1] : '') || firstPropertyTypeIn(raw);
}

function matchKnownAreaAlias(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  for (const row of SELL_AREA_ALIASES) {
    if (row.match.test(raw)) return row.canonical;
  }
  return null;
}

function locationStopSuffix() {
  return '(?:for\\s+sale|for\\s+rent|to\\s+buy|to\\s+rent|to\\s+lease|to\\s+purchase|under\\s+construction|off[\\s-]*plan|for|with|under|below|up\\s+to|at|max|budget)';
}

/**
 * Extracts a location from patterns like "in Dubai Hills", "in Arabian Ranches",
 * "try Dubai Marina", or a known community alias. Never returns a vague
 * phrase such as "another location".
 */
function parseLocationFromMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (isUnspecifiedLocationPhrase(raw) || isUnrestrictedLocationPhrase(raw)) return null;
  if (isPropertyUiAction(raw)) return null;

  const inPattern = new RegExp(
    `\\bin\\s+([A-Za-z0-9][A-Za-z0-9 '-]+?)(?:\\s+${locationStopSuffix()}|$)`,
    'i'
  );
  const m = raw.match(inPattern);
  if (m) {
    const loc = m[1].trim();
    if (
      loc &&
      !isUnspecifiedLocationPhrase(loc) &&
      !isUnrestrictedLocationPhrase(loc) &&
      !isNonPlaceLocationToken(loc)
    ) {
      if (!isNonPlaceLocationToken(loc.split(/\s+/)[0])) {
        const alias = matchKnownAreaAlias(loc);
        return alias || loc;
      }
    }
  }

  const tryMatch = raw.match(
    /^(?:try|switch\s+to|how\s+about|what\s+about)\s+(.+)$/i
  );
  if (tryMatch) {
    const rest = tryMatch[1].trim().replace(/[.!?]+$/g, '');
    if (parseBedroomChoice(rest) || parseBudgetFromMessage(rest)) return null;
    const restHead = rest.split(/\s+in\s+/i)[0].trim();
    if (normalizePropertyType(restHead) && rest.split(/\s+/).length <= 3) return null;
    const alias = matchKnownAreaAlias(rest);
    if (alias) return alias;
    if (
      rest &&
      !isUnspecifiedLocationPhrase(rest) &&
      !isUnrestrictedLocationPhrase(rest) &&
      !isNonPlaceLocationToken(rest) &&
      /^[A-Za-z0-9][A-Za-z0-9 '.-]{1,80}$/.test(rest) &&
      rest.split(/\s+/).length <= 6
    ) {
      return rest.replace(/\b(please|instead)\b/gi, '').replace(/\s+/g, ' ').trim();
    }
  }

  return matchKnownAreaAlias(raw);
}

/**
 * Accept a standalone place name when the bot is asking which area to search.
 */
function parseLocationReply(text) {
  const named = parseLocationFromMessage(text);
  if (named) return named;
  const raw = String(text || '')
    .trim()
    .replace(/[.!?]/g, '');
  if (
    !raw ||
    isUnspecifiedLocationPhrase(raw) ||
    isUnrestrictedLocationPhrase(raw) ||
    isGeneralKnowledgeQuery(raw)
  ) {
    return null;
  }
  if (isVagueConfirm(raw)) return null;
  if (parsePurposeFromMessage(raw)) return null;
  if (parseBedroomChoice(raw)) return null;
  if (parsePropertyTypeChange(raw)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9 '.-]{1,80}$/.test(raw)) return null;
  if (firstPropertyTypeIn(raw) && raw.split(/\s+/).length <= 2 && !/\b(dubai|jumeirah|marina|hills|south|palm|bay|circle|village)\b/i.test(raw)) {
    return null;
  }
  return raw;
}

/**
 * Returns the canonical property type string if the message is clearly expressing
 * a desire to CHANGE or SET the property type (not just mentioning the word in passing).
 * Returns null when the message is too vague or is just a bedroom/purpose reply.
 */
function parsePropertyTypeChange(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/[.!?]/g, '').trim();

  if (isVagueConfirm(raw)) return null;

  const types = parsePropertyTypesFromMessage(raw);
  if (!types.length) return null;

  // Explicit change-intent patterns — must appear before the type noun
  const changePrefix =
    /\b(i\s+(need|want|prefer|would\s+like|('d\s+like)|am\s+looking\s+for)|looking\s+for|show\s+(me\s+)?(the\s+)?|give\s+me|find\s+me|search\s+(for\s+)?|change\s+(it\s+)?(to\s+)?|switch\s+(to\s+)?|actually\s+(i\s+(want|prefer|need)|show)|not\s+(villas?|apartments?|townhouses?|penthouses?)[\s,]+|instead[\s,]+show|show.*instead|\binstead\b)\b/;

  if (!changePrefix.test(lower)) return null;

  return parseDesiredPropertyType(raw) || types[0];
}

function isBedroomSkip(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return false;
  return /^(any|skip|none|no preference|doesn'?t matter|does not matter|don'?t care|whatever|just show( me)?( properties| listings| options)?|show me( anyway)?|all|no limit|no restriction|any number|n\/?a)$/.test(
    raw
  );
}

function indefiniteArticle(word) {
  return /^[aeiou]/i.test(String(word || '').trim()) ? 'an' : 'a';
}

function purposeOptionsForFilters(filters = {}) {
  if (searchTypesAreCommercial(filters)) return COMMERCIAL_PURPOSE_OPTIONS.slice();
  return PURPOSE_OPTIONS.slice();
}

function purposeClarificationReply(filters = {}) {
  if (searchTypesAreCommercial(filters)) {
    const type = describeTypeSingular(filters).toLowerCase();
    const loc = String(filters.location || '').trim();
    if (type && type !== 'property' && loc) {
      return `Are you looking to buy or rent ${indefiniteArticle(type)} ${type} in ${loc}?`;
    }
    return 'Are you looking to buy or rent this commercial property?';
  }
  return 'Are you looking to buy, rent, or explore off-plan properties?';
}

function bedroomsClarificationReply() {
  return 'How many bedrooms are you looking for?';
}

function propertyTypeClarificationReply() {
  return 'What type of property are you looking for?';
}

function locationClarificationReply() {
  return 'Which area or community are you interested in?';
}

const LOCATION_QUICK_REPLIES = [
  { label: 'Dubai Marina', value: 'Dubai Marina' },
  { label: 'Jumeirah Village Circle', value: 'Jumeirah Village Circle' },
  { label: 'Business Bay', value: 'Business Bay' },
  { label: 'Dubai South', value: 'Dubai South' },
  { label: 'Dubai Media City', value: 'Dubai Media City' },
  { label: 'Any', value: 'ANY' },
];

function budgetClarificationReply(filters = {}) {
  if (isRentalPurpose(filters.purpose)) return 'What is your rental budget?';
  return 'What is your budget?';
}

const SEARCH_ACK_OPENERS = ['Perfect', 'Great', 'Got it', 'Sure', 'Absolutely'];

function searchAckOpener(filters = {}) {
  const key = `${filters.purpose || ''}|${typesFromFilters(filters).join(',')}|${filters.bedrooms ?? ''}|${filters.location || ''}`;
  let n = 0;
  for (let i = 0; i < key.length; i += 1) n = (n + key.charCodeAt(i) * (i + 1)) % SEARCH_ACK_OPENERS.length;
  return SEARCH_ACK_OPENERS[n];
}

function describeLookingForPhrase(filters = {}) {
  const type = describeTypeSingular(filters).toLowerCase();
  const n = isBedroomsSet(filters.bedrooms) ? Number(filters.bedrooms) : null;
  const min = isBedroomsSet(filters.bedroomsMin) ? Number(filters.bedroomsMin) : null;
  let noun;
  if (n === 0) noun = `a studio ${type}`;
  else if (Number.isFinite(n)) noun = `a ${n}-bedroom ${type}`;
  else if (Number.isFinite(min)) noun = `a ${min}+ bedroom ${type}`;
  else {
    const article = /^[aeiou]/i.test(type) ? 'an' : 'a';
    noun = `${article} ${type}`;
  }
  const purpose = normalizePurpose(filters.purpose);
  const verb = purpose === 'Rent' ? 'to rent' : purpose === 'Off-plan' ? 'off-plan' : purpose === 'Buy' ? 'to buy' : '';
  const loc = hasLocationConstraint(filters) ? ` in ${String(filters.location).trim()}` : '';
  return `${noun}${verb ? ` ${verb}` : ''}${loc}`.replace(/\s+/g, ' ').trim();
}

function hasEnoughToDescribe(filters = {}) {
  const hasType = typesFromFilters(filters).length > 0;
  const hasLoc = hasLocationConstraint(filters);
  const hasBeds = isBedroomsResolved(filters);
  const hasPurpose = !!normalizePurpose(filters.purpose);
  return (hasType && hasLoc) || (hasType && hasBeds && hasPurpose) || (hasLoc && hasBeds && hasPurpose);
}

function coreSearchChanged(previous = {}, next = {}) {
  const prevPurpose = normalizePurpose(previous.purpose);
  const nextPurpose = normalizePurpose(next.purpose);
  if (prevPurpose && nextPurpose && prevPurpose !== nextPurpose) return true;
  const prevType = typesFromFilters(previous).join('|').toLowerCase();
  const nextType = typesFromFilters(next).join('|').toLowerCase();
  if (prevType && nextType && prevType !== nextType) return true;
  const prevBeds = isBedroomsSet(previous.bedrooms) ? Number(previous.bedrooms) : previous.bedroomsAny ? 'any' : null;
  const nextBeds = isBedroomsSet(next.bedrooms) ? Number(next.bedrooms) : next.bedroomsAny ? 'any' : null;
  if (prevBeds != null && nextBeds != null && prevBeds !== nextBeds) return true;
  const prevLoc = hasLocationConstraint(previous) ? String(previous.location).trim().toLowerCase() : '';
  const nextLoc = hasLocationConstraint(next) ? String(next.location).trim().toLowerCase() : '';
  if (prevLoc && nextLoc && prevLoc !== nextLoc) return true;
  return false;
}

function keepSearchLabel(filters = {}) {
  const n = isBedroomsSet(filters.bedrooms) ? Number(filters.bedrooms) : null;
  const purpose = normalizePurpose(filters.purpose);
  const kind = purpose === 'Rent' ? 'rental' : purpose === 'Off-plan' ? 'off-plan' : 'purchase';
  if (n === 0) return `studio ${kind}`;
  if (Number.isFinite(n)) return `${n}-bedroom ${kind}`;
  return kind;
}

function budgetKeepAcknowledgement(filters = {}) {
  if (filters.budgetProvided && budgetNumber(filters.budgetMin) == null && budgetNumber(filters.budgetMax) == null) {
    return "Great — I'll keep the search open to any budget.";
  }
  const max = budgetNumber(filters.budgetMax);
  const min = budgetNumber(filters.budgetMin);
  if (max != null && min == null) return `Great — I'll keep the search below ${formatAed(max)}.`;
  if (min != null && max == null) return `Great — I'll keep the search from ${formatAed(min)}.`;
  if (min != null && max != null) {
    return `Great — I'll keep the search within ${formatAed(min)}–${formatAed(max).replace(/^AED\s/, '')}.`;
  }
  return '';
}

function isBudgetOnlyFollowUp(previous = {}, next = {}, message = '') {
  if (parseEmptyResultChoice(message)?.budget) return false;
  if (isShowMoreRequest(message)) return false;
  if (coreSearchChanged(previous, next)) return false;
  if (isStandaloneAnyBudgetReply(message)) return true;
  const prevMin = budgetNumber(previous.budgetMin);
  const prevMax = budgetNumber(previous.budgetMax);
  const nextMin = budgetNumber(next.budgetMin);
  const nextMax = budgetNumber(next.budgetMax);
  const rangeChanged = prevMin !== nextMin || prevMax !== nextMax;
  const answered = isBudgetProvided(next) && (!isBudgetProvided(previous) || rangeChanged);
  return answered && !!parseBudgetFromMessage(message, { requireBudgetContext: false });
}

function buildRefinementAcknowledgement(previous = {}, next = {}) {
  const prevLoc = hasLocationConstraint(previous) ? String(previous.location).trim() : '';
  const nextLoc = hasLocationConstraint(next) ? String(next.location).trim() : '';
  const locChanged = prevLoc && nextLoc && prevLoc.toLowerCase() !== nextLoc.toLowerCase();
  const prevBeds = isBedroomsSet(previous.bedrooms) ? Number(previous.bedrooms) : null;
  const nextBeds = isBedroomsSet(next.bedrooms) ? Number(next.bedrooms) : null;
  const bedsChanged = prevBeds != null && nextBeds != null && prevBeds !== nextBeds;
  const prevType = typesFromFilters(previous)[0] || '';
  const nextType = typesFromFilters(next)[0] || '';
  const typeChanged = prevType && nextType && prevType.toLowerCase() !== nextType.toLowerCase();
  const purposeChanged =
    !!normalizePurpose(previous.purpose) &&
    !!normalizePurpose(next.purpose) &&
    normalizePurpose(previous.purpose) !== normalizePurpose(next.purpose);

  if (locChanged && !bedsChanged && !typeChanged && !purposeChanged) {
    return `Sure — I'll keep your ${keepSearchLabel(previous)} search and switch the location to ${nextLoc}.`;
  }
  if (bedsChanged && !locChanged && !typeChanged && !purposeChanged) {
    if (nextBeds === 0) {
      const keep = [nextLoc, normalizePurpose(next.purpose) === 'Rent' ? 'rent' : 'buy'].filter(Boolean).join(' + ');
      return `Got it — I'll switch this to studio apartments and keep ${keep}.`;
    }
    return `Sure — I'll update this to ${nextBeds}-bedroom and keep the rest of your search.`;
  }
  if (typeChanged && !locChanged && !purposeChanged) {
    return `Sure — I'll switch this to ${String(nextType).toLowerCase()}s and keep the rest of your search.`;
  }
  if (purposeChanged && !locChanged && !bedsChanged && !typeChanged) {
    if (normalizePurpose(next.purpose) === 'Off-plan') {
      return "Sure — I'll switch this to off-plan and keep the rest of your search.";
    }
    if (normalizePurpose(next.purpose) === 'Rent') {
      if (Number.isFinite(nextBeds) && nextBeds === 0) {
        return "Sure — I'll switch to ready rental properties and keep your studio preference.";
      }
      return "Sure — I'll switch to ready rental properties and keep the rest of your search.";
    }
    if (normalizePurpose(previous.purpose) === 'Off-plan') {
      return "Sure — I'll switch this to ready properties for sale and keep the rest of your search.";
    }
    return "Sure — I'll switch this to a purchase search and keep the rest of your search.";
  }
  const looking = describeLookingForPhrase(next);
  if (!looking) return '';
  return `${searchAckOpener(next)} — you're looking for ${looking}.`;
}

function joinAckAndQuestion(acknowledgement, question) {
  const ack = String(acknowledgement || '').trim();
  const q = String(question || '').trim();
  if (ack && q) return `${ack}\n\n${q}`;
  return ack || q;
}

function buildSearchAcknowledgement(next = {}, { previous = {}, message = '' } = {}) {
  if (isShowMoreRequest(message)) return '';
  if (parseEmptyResultChoice(message)?.budget) return '';
  if (isBudgetOnlyFollowUp(previous, next, message)) {
    return budgetKeepAcknowledgement(next);
  }
  if (hasEnoughToDescribe(previous) && coreSearchChanged(previous, next) && hasEnoughToDescribe(next)) {
    return buildRefinementAcknowledgement(previous, next);
  }
  if (!hasEnoughToDescribe(next)) return '';
  if (hasEnoughToDescribe(previous) && !coreSearchChanged(previous, next)) return '';
  return `${searchAckOpener(next)} — you're looking for ${describeLookingForPhrase(next)}.`;
}

function isBudgetProvided(filters = {}) {
  if (filters.budgetProvided === true) return true;
  if (filters.budgetMin != null && filters.budgetMin !== '') return true;
  if (filters.budgetMax != null && filters.budgetMax !== '') return true;
  return false;
}

function budgetOptionsForPurpose(purpose) {
  if (normalizePurpose(purpose) === 'Rent') return RENT_BUDGET_OPTIONS.slice();
  return BUY_BUDGET_OPTIONS.slice();
}

function nextMissingListingSlot(filters = {}) {
  return getMissingSearchFields(filters)[0] || null;
}

function listingSlotQuestion(slot, filters = {}) {
  if (slot === 'intent') {
    return {
      reply: purposeClarificationReply(filters),
      options: purposeOptionsForFilters(filters),
      awaiting: 'purpose',
    };
  }
  if (slot === 'bedrooms') {
    return {
      reply: bedroomsClarificationReply(),
      options: BEDROOM_OPTIONS.slice(),
      awaiting: 'bedrooms',
    };
  }
  if (slot === 'propertyType') {
    return {
      reply: propertyTypeClarificationReply(),
      options: PROPERTY_TYPE_OPTIONS.slice(),
      awaiting: 'propertyType',
    };
  }
  if (slot === 'location') {
    return {
      reply: locationClarificationReply(),
      options: LOCATION_QUICK_REPLIES.map((item) => item.label),
      quickReplies: LOCATION_QUICK_REPLIES.map((item) => ({ ...item })),
      inputType: 'location',
      awaiting: 'location',
    };
  }
  if (slot === 'budget') {
    return {
      reply: budgetClarificationReply(filters),
      options: budgetOptionsForPurpose(filters.purpose),
      awaiting: 'budget',
    };
  }
  return null;
}

const LISTING_SLOT_AWAITING = new Set([
  'purpose',
  'bedrooms',
  'propertyType',
  'location',
  'budget',
  'listingIntake',
]);

function isExplicitSearchReset(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return false;
  if (/^(new search|start over|start again|reset search)$/.test(raw)) return true;
  return /\b(start a new (property )?search|new property search|reset (my |the )?search|clear (my |the )?search)\b/.test(
    raw
  );
}

function qualifyListingSearch(message, profile = {}) {
  if (isPropertyUiAction(message)) return null;
  if (parseSellIntent(message) || isServiceInquiryMessage(message)) return null;
  if (isExplicitSearchReset(message)) {
    const next = applyMessageToSearchFilters(emptySearchFilters(), message);
    const missing = nextMissingListingSlot(next);
    const question = missing ? listingSlotQuestion(missing, next) : null;
    const patch = {
      purpose: next.purpose || null,
      intent: purposeToIntent(next.purpose) || null,
      preferredAreas: next.location ? [next.location] : [],
      bedrooms: requiresBedroomsForSearch(next) ? next.bedrooms ?? next.bedroomsMin ?? null : null,
      lastSearchFilters: next,
      slotFlow: question
        ? { awaiting: question.awaiting, alternatives: null }
        : { awaiting: null, alternatives: null },
      resetShownPropertyIds: true,
      lastPropertyCards: [],
      shownPropertyIds: [],
      budget: { min: next.budgetMin ?? null, max: next.budgetMax ?? null },
    };
    if (missing) {
      return {
        type: 'clarify',
        profilePatch: patch,
        reply: question.reply,
        options: question.options,
        inputType: question.inputType || null,
        quickReplies: question.quickReplies || null,
        missing,
      };
    }
    return { type: 'continue', profilePatch: patch, missing: null };
  }

  const awaiting = profile.slotFlow?.awaiting;
  if (
    ['sell', 'pmNeed', 'pmProperty', 'serviceContact', 'serviceLocation', 'sellServiceLocation', 'viewingContact', 'viewingTime', 'viewingProperty'].includes(
      awaiting
    )
  ) {
    return null;
  }
  if (
    ['emptyResults', 'alternatives', 'nearbyArea'].includes(awaiting) &&
    (parseEmptyResultChoice(message)?.askType || parseEmptyResultChoice(message)?.askBedrooms)
  ) {
    return null;
  }

  const listingAwaiting = LISTING_SLOT_AWAITING.has(awaiting);
  const hasListingContext =
    isListingIntent(profile.intent) ||
    !!profile.purpose ||
    !!profile.lastSearchFilters?.purpose ||
    listingAwaiting;

  if (shouldSkipPropertySearch(message) && !listingAwaiting) return null;

  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  if (!last.purpose) {
    last.purpose = profile.purpose || intentToPurpose(profile.intent) || null;
  }
  const next = applyMessageToSearchFilters(last, message, { awaiting });
  if (!next.purpose && !isExplicitListingPurpose(message)) {
    next.purpose = last.purpose || profile.purpose || intentToPurpose(profile.intent) || null;
  }

  const extracted =
    JSON.stringify(copySearchFilters(last)) !== JSON.stringify(copySearchFilters(next)) ||
    !!parsePurposeFromMessage(message) ||
    listingAwaiting ||
    isListingFollowUp(message) ||
    isAmbiguousListingQuery(message) ||
    !!parseConversationIntent(message);

  if (!extracted && !hasListingContext) return null;
  if (
    !extracted &&
    hasListingContext &&
    !listingAwaiting &&
    !isVagueConfirm(message) &&
    !isListingFollowUp(message)
  ) {
    return null;
  }

  const emptyChoice = parseEmptyResultChoice(message);
  if ((hasListingContext || extracted) && emptyChoice?.budget) {
    next.budgetProvided = false;
    next.budgetMin = null;
    next.budgetMax = null;
    const budgetQuestion = listingSlotQuestion('budget', next);
    return {
      type: 'clarify',
      missing: 'budget',
      profilePatch: {
        purpose: next.purpose || profile.purpose,
        intent: purposeToIntent(next.purpose) || profile.intent,
        preferredAreas: next.location ? [next.location] : undefined,
        bedrooms: next.bedrooms ?? next.bedroomsMin ?? profile.bedrooms,
        lastSearchFilters: next,
        slotFlow: { awaiting: 'budget', alternatives: null },
      },
      reply: budgetQuestion.reply,
      options: budgetQuestion.options,
    };
  }
  if ((hasListingContext || extracted) && emptyChoice?.askType) {
    return {
      type: 'clarify',
      missing: 'propertyType',
      profilePatch: {
        purpose: next.purpose || null,
        intent: purposeToIntent(next.purpose) || null,
        lastSearchFilters: next,
        slotFlow: { awaiting: 'propertyType', alternatives: null },
      },
      reply: 'What type of property would you like instead?',
      options: PROPERTY_TYPE_CHANGE_OPTIONS.slice(),
    };
  }
  if ((hasListingContext || extracted) && emptyChoice?.nearby) {
    return {
      type: 'clarify',
      missing: 'location',
      profilePatch: {
        purpose: next.purpose || profile.purpose,
        intent: purposeToIntent(next.purpose) || profile.intent,
        lastSearchFilters: next,
        slotFlow: { awaiting: 'nearbyArea', alternatives: null },
      },
      reply: 'Which nearby area should I try?',
      options: nearbyAreaOptions(next.location),
    };
  }

  const missing = nextMissingListingSlot(next);
  const question = missing ? listingSlotQuestion(missing, next) : null;
  const patch = {
    purpose: next.purpose || null,
    intent: purposeToIntent(next.purpose) || null,
    preferredAreas: next.location ? [next.location] : undefined,
    bedrooms: requiresBedroomsForSearch(next)
      ? next.bedrooms ?? next.bedroomsMin ?? null
      : null,
    lastSearchFilters: next,
    slotFlow: question
      ? { awaiting: question.awaiting, alternatives: null }
      : { awaiting: null, alternatives: null },
  };
  if (isBudgetProvided(next)) {
    patch.budget = { min: next.budgetMin ?? null, max: next.budgetMax ?? null };
  } else {
    patch.budget = { min: null, max: null };
  }
  Object.assign(patch, listingSearchResetPatch(last, next));
  console.log(
    'LISTING_PROFILE_STATE',
    JSON.stringify({
      userMessage: String(message || ''),
      intent: patch.intent,
      purpose: next.purpose || null,
      budgetProvided: next.budgetProvided === true,
      pendingSlot: patch.slotFlow?.awaiting || null,
      missing: missing || null,
    })
  );
  if (missing) {
    const ack = buildSearchAcknowledgement(next, { previous: last, message });
    return {
      type: 'clarify',
      profilePatch: patch,
      reply: joinAckAndQuestion(ack, question.reply),
      options: question.options,
      inputType: question.inputType || null,
      quickReplies: question.quickReplies || null,
      missing,
    };
  }
  return { type: 'continue', profilePatch: patch, missing: null };
}

function bedroomClarificationFields() {
  return {
    requiresClarification: true,
    options: BEDROOM_OPTIONS,
    select: PURPOSE_SELECT,
  };
}

function isProvidedText(value) {
  if (value === undefined || value === null) return false;
  return String(value).trim() !== '';
}

function textsDiffer(a, b) {
  return String(a).trim().toLowerCase() !== String(b).trim().toLowerCase();
}

function coalesceFilter(incoming, fallback) {
  if (incoming === undefined || incoming === null || incoming === '') return fallback ?? null;
  return incoming;
}

function resolveEffectiveFilters(filters = {}, lastSearchFilters = {}) {
  const last = lastSearchFilters || {};
  const incomingLocation = sanitizeSearchLocation(filters.location);
  const locationProvided = isProvidedText(incomingLocation);
  const lastLocationSet = isProvidedText(last.location);
  const incomingTypes = typesFromFilters(filters);
  const lastTypes = typesFromFilters(last);
  const preservedTypes = lastTypes.length ? lastTypes : incomingTypes;
  const locationChanged = locationProvided && lastLocationSet && textsDiffer(incomingLocation, last.location);
  const incomingAny = filters.locationAny === true || isUnrestrictedLocationPhrase(filters.location);

  const merged = {
    location: incomingAny
      ? null
      : locationChanged
        ? coalesceFilter(incomingLocation, null)
        : coalesceFilter(incomingLocation, last.location),
    locationAny: incomingAny || (!locationProvided && last.locationAny === true),
    bedrooms: last.bedrooms ?? null,
    bedroomsMin: last.bedroomsMin ?? null,
    bedroomsAny: last.bedroomsAny === true,
    bedroomsResolved: isBedroomsResolved(last),
    budgetMin: last.budgetMin ?? null,
    budgetMax: last.budgetMax ?? null,
    budgetProvided: last.budgetProvided === true,
    furnished: coalesceFilter(filters.furnished, last.furnished),
    purpose: last.purpose || null,
  };
  if (locationProvided) merged.locationAny = false;
  applyTypesToFilters(merged, preservedTypes);
  return normalizeSearchProfileAfterPatch(last, merged);
}

function isAmbiguousListingQuery(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return false;
  if (isPropertyUiAction(raw)) return false;
  if (parseSellIntent(raw)) return false;
  if (parsePurposeFromMessage(raw)) return false;
  if (parseBedroomChoice(raw)) return false;
  // Property-type change phrases are refinements, not ambiguous new queries
  if (parsePropertyTypeChange(raw)) return false;
  return /\b(show|find|search|looking|apartments?|villas?|townhouses?|properties|homes?|listings?)\b/.test(raw);
}

function isMultiPropertyServiceQuery(text) {
  return /\b(\d+\s+properties|\d+\s+villas?|\d+\s+apartments?|multiple\s+properties|several\s+properties|portfolio|my\s+properties|all\s+my\s+properties)\b/i.test(
    String(text || '')
  );
}

function matchesServiceInquiryPhrase(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  // Seasonal / how-to blog questions ("manage property in summer") are content, not PM lead flow.
  if (/\b(summer|winter|spring|autumn|season|prepare|tips?|proof|heat|ac\b|air.?con)\b/i.test(raw)) {
    return false;
  }
  // Catalog / FAQ style ("what services…", "do you help with PM") → search_content, not lead capture.
  if (
    /\b(what\s+(?:type\s+of\s+)?services?\b|what\s+does\b|do\s+you\s+(?:offer|help|provide)|tell\s+me\s+about|include[sd]?|offering)\b/i.test(
      raw
    ) &&
    !/\b(manage\s+my|i\s+need\s+(?:you\s+to\s+)?manage|sign\s+me\s+up|i\s+want\s+(?:pm|property\s+management))\b/i.test(
      raw
    )
  ) {
    return false;
  }
  if (/^property\s+management$/i.test(raw)) return true;
  return /\b(management\s+services?|rent\s+collection|tenant\s+screening|landlord\s+services?|maintain(?:ing)?\s+my\s+propert(?:y|ies)|manage\s+(?:my\s+|these\s+|your\s+|this\s+|our\s+|the\s+)?propert(?:y|ies)|someone\s+to\s+manage|can\s+you\s+manage|i\s+need\s+(?:someone\s+to\s+)?(?:you\s+to\s+)?manage|i\s+need\s+property\s+management|property\s+management\s+for\s+my)\b/i.test(
    raw
  );
}

function isListingFollowUp(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (isPropertyUiAction(raw)) return false;
  if (parseSellIntent(raw) || isSellCta(raw)) return false;
  if (isContentKnowledgeTopic(raw)) return false;
  if (isMultiPropertyServiceQuery(raw) || matchesServiceInquiryPhrase(raw)) return false;
  if (parsePurposeFromMessage(raw)) return true;
  if (isShowMoreRequest(raw)) return true;
  if (parsePropertyTypeChange(raw)) return true;
  if (parsePropertyTypesFromMessage(raw).length > 1) return true;
  if (wantsDifferentLocation(raw)) return true;
  if (isUnrestrictedLocationPhrase(raw)) return true;
  if (parseEmptyResultChoice(raw)) return true;
  if (isAmbiguousListingQuery(raw)) return true;
  if (parseLocationFromMessage(raw)) return true;
  if (parseBudgetFromMessage(raw)) return true;
  const bed = parseBedroomChoice(raw);
  if (bed && String(raw).trim().length < 48) return true;
  return false;
}

function isCurrentListingReference(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  return /\b(this property|this unit|this listing|this one|book this|view this|similar to this|like this (one|property|unit))\b/i.test(
    raw
  );
}

function isGeneralKnowledgeQuery(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase();
  if (!raw) return false;
  if (isServiceInquiryMessage(raw)) return false;
  if (isContentKnowledgeTopic(raw)) return true;
  if (isListingFollowUp(raw)) return false;
  return /\b(property\s+management|tell\s+me\s+about|what\s+is|what\s+are|how\s+do(?:es)?|explain|need\s+to\s+know\s+about)\b/.test(
    raw
  );
}

/** Service / PM questions after a sell flow — may need same vs different location. */
function isSellServiceTransitionQuery(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (parseSellIntent(raw) || isSellCta(raw)) return false;
  if (parsePurposeFromMessage(raw)) return false;
  return matchesServiceInquiryPhrase(raw) || isMultiPropertyServiceQuery(raw);
}

const SELL_SERVICE_LOCATION_OPTIONS = ['Same property', 'Different location'];

function parseSellServiceLocationChoice(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (/^same\s+(property|location|area)\b|^same\s*—|^same\b/.test(raw)) return 'same';
  if (/^different\s+(property|location|area)\b|^different\s*—|^different\b|^other\s+(area|location)\b/.test(raw)) {
    return 'different';
  }
  return null;
}

function sellServiceLocationReply(listing = {}, inquiry = {}) {
  const typeLabel = listing.type ? String(listing.type).toLowerCase() : 'property';
  const loc = listing.location || inquiry.referenceLocation || 'that area';
  if (inquiry.propertyNote) {
    return `You mentioned ${inquiry.propertyNote}. Should we focus on ${loc}, or do you need management across different areas?`;
  }
  return `Are you asking about this for your ${loc} ${typeLabel}, or for properties in a different area?`;
}

function emptyServiceInquiry() {
  return {
    intent: null,
    need: null,
    locationScope: null,
    referenceLocation: null,
    propertyNote: null,
    propertyType: null,
    bedrooms: null,
    name: null,
    email: null,
    phone: null,
    whatsapp: null,
  };
}

function copyServiceInquiry(inquiry = {}) {
  return {
    intent: inquiry.intent || null,
    need: inquiry.need || null,
    locationScope: inquiry.locationScope || null,
    referenceLocation: inquiry.referenceLocation || null,
    propertyNote: inquiry.propertyNote || null,
    propertyType: inquiry.propertyType || null,
    bedrooms: inquiry.bedrooms ?? null,
    name: inquiry.name || null,
    email: inquiry.email || null,
    phone: inquiry.phone || null,
    whatsapp: inquiry.whatsapp || null,
  };
}

function parsePropertyPortfolioNote(text) {
  const raw = String(text || '');
  const countMatch = raw.match(/\b(\d+)\s+(properties|villas|apartments|units)\b/i);
  if (countMatch) return `${countMatch[1]} ${countMatch[2].toLowerCase()}`;
  if (isMultiPropertyServiceQuery(raw)) return 'multiple properties';
  return null;
}

function seedServiceInquiry(current = {}, sellListing = {}, history = [], message = '') {
  const prior = copyServiceInquiry(current);
  const fromHistory = contactFromHistory(history);
  const fromSell = sellListing || {};
  const parsed = parseSellListingDetails(message, {});
  return {
    intent: 'property_management',
    need: prior.need || parsePmNeedChoice(message),
    locationScope: prior.locationScope || null,
    referenceLocation:
      prior.referenceLocation || parsed.location || fromSell.location || null,
    propertyNote: prior.propertyNote || parsePropertyPortfolioNote(message) || null,
    propertyType: prior.propertyType || parsed.type || null,
    bedrooms: prior.bedrooms ?? parsed.bedrooms ?? null,
    name: prior.name || fromSell.name || fromHistory.name || null,
    email: prior.email || fromSell.email || fromHistory.email || null,
    phone: prior.phone || fromSell.phone || fromHistory.phone || null,
    whatsapp: prior.whatsapp || fromHistory.whatsapp || null,
  };
}

function parseServiceContactDetails(text, current = {}) {
  const raw = String(text || '').trim();
  if (/\b(same\s+(number|phone|whatsapp|no)|use\s+(the\s+)?same)\b/i.test(raw)) {
    const phone = current.phone || current.whatsapp || null;
    return {
      ...current,
      phone,
      whatsapp: current.whatsapp || phone,
    };
  }
  const parsed = parseContactDetails(text, current);
  let phone = parsed.phone || current.phone || null;
  let whatsapp = parsed.whatsapp || current.whatsapp || null;
  // Bare digits while collecting contact — accept as WhatsApp and phone (7+ digits)
  const bare = raw.match(/^((?:\+|00)?\d[\d\s\-()]{5,18}\d|\d{7,15})$/);
  if (bare) {
    const num = bare[1].replace(/\s+/g, ' ').trim();
    whatsapp = whatsapp || num;
    phone = phone || num;
  }
  return {
    ...current,
    name: parsed.name || current.name || null,
    email: parsed.email || current.email || null,
    phone,
    whatsapp,
  };
}

function missingServiceContactFields(inquiry = {}) {
  const missing = [];
  if (!inquiry.name) missing.push('name');
  if (!inquiry.phone && !inquiry.whatsapp) {
    missing.push('phone and whatsapp');
  } else {
    if (!inquiry.whatsapp) missing.push('whatsapp');
    if (!inquiry.phone) missing.push('phone');
  }
  return missing;
}

function hasServiceContact(inquiry = {}) {
  return !!(inquiry.name && (inquiry.phone || inquiry.whatsapp));
}

function serviceContactPromptBlock() {
  return `Please share your details in one message:

name: Your name
email: (optional)
whatsapp: Your WhatsApp number
phone: Your phone number`;
}

function propertyManagementIntroReply(inquiry = {}) {
  let intro =
    'Rocky Real Estate offers full property management — rent collection, maintenance coordination, tenant screening, inspections, and financial reporting.';
  if (inquiry.propertyNote) {
    intro += ` We can help with ${inquiry.propertyNote}.`;
  } else if (inquiry.locationScope === 'same' && inquiry.referenceLocation) {
    intro += ` We can help manage your property in ${inquiry.referenceLocation}.`;
  } else if (inquiry.locationScope === 'different') {
    intro += ' We manage properties across Dubai and can tailor a package to your portfolio.';
  }
  return intro;
}

function serviceContactReply(inquiry = {}) {
  const missing = missingServiceContactFields(inquiry);
  if (missing.length === 0) {
    const loc = inquiry.referenceLocation ? ` in ${inquiry.referenceLocation}` : '';
    return `Thanks — I have your details${loc}. Our property management team will reach out shortly.`;
  }
  const intro = propertyManagementIntroReply(inquiry);
  if (missing.includes('name') && missing.includes('phone and whatsapp')) {
    return `${intro}\n\n${serviceContactPromptBlock()}`;
  }
  if (missing.includes('name')) {
    return `${intro}\n\nWhat name should our team use when they contact you?`;
  }
  if (missing.includes('phone and whatsapp')) {
    return `${intro}\n\nCan you provide your WhatsApp number and phone number?`;
  }
  if (missing.length === 1 && missing[0] === 'whatsapp') {
    return 'Can you provide your WhatsApp number?';
  }
  if (missing.includes('whatsapp')) {
    return `${intro}\n\nCan you provide your WhatsApp number?`;
  }
  if (missing.includes('phone')) {
    return `${intro}\n\nCan you provide your phone number?`;
  }
  return `${intro}\n\n${serviceContactPromptBlock()}`;
}

function buildServiceLeadIntent(inquiry = {}) {
  const parts = ['Property management'];
  if (inquiry.propertyNote) parts.push(inquiry.propertyNote);
  if (inquiry.locationScope === 'same' && inquiry.referenceLocation) {
    parts.push(`same area — ${inquiry.referenceLocation}`);
  } else if (inquiry.locationScope === 'different') {
    parts.push('different areas');
  } else if (inquiry.referenceLocation) {
    parts.push(inquiry.referenceLocation);
  }
  return parts.join(' - ');
}

function shouldCaptureServiceLead(inquiry = {}) {
  return inquiry.intent === 'property_management' && hasServiceContact(inquiry);
}

function isServiceInquiryMessage(text) {
  // "what services do you provide" (incl. with a portfolio mention) → content, not lead capture
  if (isServicesCatalogQuestion(text)) return false;
  return matchesServiceInquiryPhrase(text) || isMultiPropertyServiceQuery(text);
}

function parsePmNeedChoice(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return null;
  if (/^full property management$/.test(raw) || /\bfull(\s+property)?\s+management\b/.test(raw)) {
    return 'full';
  }
  if (/\btenant\b/.test(raw)) return 'tenant';
  if (/\brent\s+collection\b/.test(raw)) return 'rent_collection';
  if (/\bmaintenance\b/.test(raw)) return 'maintenance';
  if (/\binspect/.test(raw)) return 'inspections';
  return null;
}

function pmNeedLabel(need) {
  if (need === 'full') return 'full property management';
  if (need === 'tenant') return 'tenant management';
  if (need === 'rent_collection') return 'rent collection';
  if (need === 'maintenance') return 'maintenance';
  if (need === 'inspections') return 'inspections';
  return 'property management';
}

function pmNeedReply() {
  return 'Are you looking for full property management for a property you own, or do you need help with a specific service such as tenant management, rent collection, maintenance, or inspections?';
}

function pmPropertyReply(inquiry = {}) {
  const need = pmNeedLabel(inquiry.need);
  if (inquiry.propertyType && !inquiry.referenceLocation) {
    return `Understood — ${need} for a ${String(inquiry.propertyType).toLowerCase()}. Which area or community is the property in?`;
  }
  if (!inquiry.propertyType && inquiry.referenceLocation) {
    return `Understood — ${need} in ${inquiry.referenceLocation}. What type of property is it — apartment, villa, townhouse, or another type?`;
  }
  return `Understood — ${need}. What type of property should we manage, and which area or community is it in?`;
}

function hasPmPropertyContext(inquiry = {}) {
  return !!(inquiry.referenceLocation || inquiry.propertyType || inquiry.propertyNote);
}

function applyPmPropertyDetails(message, inquiry = {}) {
  const next = copyServiceInquiry(inquiry);
  const parsed = parseSellListingDetails(message, {
    type: next.propertyType,
    location: next.referenceLocation,
    bedrooms: next.bedrooms,
  });
  if (parsed.type) next.propertyType = parsed.type;
  if (parsed.location) next.referenceLocation = parsed.location;
  if (parsed.bedrooms != null) next.bedrooms = parsed.bedrooms;
  const note = parsePropertyPortfolioNote(message);
  if (note) next.propertyNote = note;
  next.intent = 'property_management';
  return next;
}

function parseFurnishedFromMessage(text) {
  const raw = String(text || '').toLowerCase();
  if (!raw) return null;
  if (/\bunfurnished\b/.test(raw)) return 'Unfurnished';
  if (/\b(semi[-\s]?furnished|part(?:ly)?[-\s]?furnished)\b/.test(raw)) return 'Semi-furnished';
  if (/\bfurnished\b/.test(raw)) return 'Furnished';
  return null;
}

function isStandaloneAnyBudgetReply(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  return /^(any|any budget|no budget|no limit|no budget limit|no budget restriction)$/i.test(raw);
}

function shouldTreatMessageAsAnyBudget(filters = {}, message, awaiting) {
  const raw = String(message || '').trim();
  if (!isStandaloneAnyBudgetReply(raw)) return false;
  if (awaiting === 'budget' || /^any budget$/i.test(raw)) return true;
  if (['location', 'nearbyArea', 'bedrooms', 'propertyType', 'purpose'].includes(awaiting)) {
    return false;
  }
  return (
    !isBudgetProvided(filters) &&
    !!normalizePurpose(filters.purpose) &&
    (!!String(filters.location || '').trim() || filters.locationAny === true)
  );
}

function listingSearchResetPatch(previous = {}, next = {}) {
  const prevPurpose = normalizePurpose(previous.purpose);
  const nextPurpose = normalizePurpose(next.purpose);
  const purposeChanged = !!prevPurpose && !!nextPurpose && prevPurpose !== nextPurpose;
  const locationChanged =
    !!previous.location &&
    !!next.location &&
    previous.location.trim().toLowerCase() !== next.location.trim().toLowerCase();
  const locationCleared = !!previous.location && !next.location;
  const prevTypes = typesFromFilters(previous).join('|').toLowerCase();
  const nextTypes = typesFromFilters(next).join('|').toLowerCase();
  const typeChanged = prevTypes !== nextTypes;
  const bedroomsChanged =
    (previous.bedrooms ?? null) !== (next.bedrooms ?? null) ||
    (previous.bedroomsMin ?? null) !== (next.bedroomsMin ?? null) ||
    !!previous.bedroomsAny !== !!next.bedroomsAny;
  const budgetChanged =
    (previous.budgetMin ?? null) !== (next.budgetMin ?? null) ||
    (previous.budgetMax ?? null) !== (next.budgetMax ?? null) ||
    !!previous.budgetProvided !== !!next.budgetProvided;
  const furnishedChanged = (previous.furnished || null) !== (next.furnished || null);
  if (
    !purposeChanged &&
    !locationChanged &&
    !locationCleared &&
    !typeChanged &&
    !bedroomsChanged &&
    !budgetChanged &&
    !furnishedChanged
  ) {
    return {};
  }
  return {
    resetShownPropertyIds: true,
    lastPropertyCards: [],
    shownPropertyIds: [],
  };
}

function searchTypesEqual(a = [], b = []) {
  return uniqueTypes(a).join('|').toLowerCase() === uniqueTypes(b).join('|').toLowerCase();
}

function extractSearchPatch(message, previous = {}, { awaiting } = {}) {
  const changes = {};
  const raw = String(message || '').trim();
  if (!raw) return changes;

  if (shouldTreatMessageAsAnyBudget(previous, message, awaiting)) {
    changes.budget = { any: true };
    const purposeOnly = parsePurposeFromMessage(message, previous);
    if (purposeOnly) changes.purpose = purposeOnly;
    return changes;
  }

  const types = parsePropertyTypesFromMessage(message);
  const awaitingLocation = awaiting === 'location' || awaiting === 'nearbyArea';
  const standaloneAnyLocation =
    awaitingLocation && /^(any|all|anywhere|skip|no preference)$/i.test(raw.replace(/[.!?]/g, ''));
  const unrestrictedLocation = isUnrestrictedLocationPhrase(raw) || standaloneAnyLocation;
  let location = unrestrictedLocation ? null : parseLocationFromMessage(message);
  if (!unrestrictedLocation && !location && awaitingLocation) {
    location = parseLocationReply(message);
  }
  const skipBedsForLocationAny =
    unrestrictedLocation && !/\b(studio|bed|br|bhk|bedroom)s?\b/i.test(raw);
  const skipBedsForAnyReply = awaiting !== 'bedrooms' && isStandaloneAnyBudgetReply(raw);
  const skipLocationForAnyReply =
    skipBedsForAnyReply && awaiting !== 'location' && awaiting !== 'nearbyArea';
  if (skipLocationForAnyReply) location = null;
  const beds = skipBedsForLocationAny || skipBedsForAnyReply ? null : parseBedroomChoice(message);
  const budget = parseBudgetFromMessage(message, { requireBudgetContext: awaiting === 'budget' });
  const furnished = parseFurnishedFromMessage(message);
  const purpose = parsePurposeFromMessage(message, previous);

  if (types.length) {
    const current = typesFromFilters(previous);
    const merged = mergePropertyTypes(current, types, message);
    if (!current.length || !searchTypesEqual(current, merged)) {
      changes.types = types;
    }
  }
  if (unrestrictedLocation) {
    changes.locationAny = true;
  } else if (location) {
    changes.location = location;
  }
  if (beds) changes.bedrooms = beds;
  if (budget) changes.budget = budget;
  if (furnished) changes.furnished = furnished;
  if (purpose) changes.purpose = purpose;
  return changes;
}

function mergeSearchPatch(previous, patch, message = '') {
  const next = copySearchFilters(previous);
  const changes = patch && typeof patch === 'object' ? patch : {};
  if (changes.types) {
    applyTypesToFilters(next, mergePropertyTypes(typesFromFilters(next), changes.types, message));
  }
  if (changes.locationAny === true) {
    applyUnrestrictedLocation(next);
  } else if (Object.prototype.hasOwnProperty.call(changes, 'location')) {
    next.location = changes.location;
    next.locationAny = false;
  }
  if (changes.bedrooms) {
    applyBedroomChoice(next, changes.bedrooms);
    if (changes.bedrooms.exact === 0 && !searchTypesAreCommercial(next)) {
      const currentTypes = typesFromFilters(next);
      if (!currentTypes.length || currentTypes.every((t) => /apartment|studio|flat/i.test(String(t || '')))) {
        applyTypesToFilters(next, ['Apartment']);
      }
    }
  }
  if (changes.budget) applyBudgetChoice(next, changes.budget);
  if (changes.furnished) next.furnished = changes.furnished;
  if (changes.purpose) next.purpose = changes.purpose;
  return next;
}

function applyMessageToSearchFilters(filters, message, { awaiting } = {}) {
  const previous = copySearchFilters(filters);
  const patch = extractSearchPatch(message, previous, { awaiting });
  const next = mergeSearchPatch(previous, patch, message);
  return normalizeSearchProfileAfterPatch(previous, next, {
    explicitPurpose: !!patch.purpose || isPurposeChipReply(message),
  });
}

function listingIntakeReply(intent) {
  if (intent === CONVERSATION_INTENTS.RENT) {
    return 'What type of property would you like to rent — apartment, villa, townhouse, or another type — and which area are you interested in? If you have a bedroom count or furnishing preference, you can include those too.';
  }
  if (intent === CONVERSATION_INTENTS.OFF_PLAN) {
    return 'Which area are you considering for an off-plan property? If you have a preferred property type, bedroom count, budget, or developer, you can include those too.';
  }
  return 'What type of property are you looking to buy — apartment, villa, townhouse, penthouse, or another type — and which area are you interested in?';
}

function needsListingIntake(filters = {}) {
  return !filters.location && !filters.locationAny && !typesFromFilters(filters).length;
}

function parseConversationIntent(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (isServiceInquiryMessage(raw)) return CONVERSATION_INTENTS.PROPERTY_MANAGEMENT;
  if (parseSellIntent(raw) || /^(sell my property|sell property)$/i.test(raw)) {
    return CONVERSATION_INTENTS.SELL_PROPERTY;
  }
  const purpose = parsePurposeFromMessage(raw);
  if (purpose) return purposeToIntent(purpose);
  if (isExplicitIntentStarter(raw)) {
    const lower = raw.toLowerCase();
    if (/\brent/.test(lower)) return CONVERSATION_INTENTS.RENT;
    if (/off/.test(lower)) return CONVERSATION_INTENTS.OFF_PLAN;
    if (/\bsell/.test(lower)) return CONVERSATION_INTENTS.SELL_PROPERTY;
    if (/management/.test(lower)) return CONVERSATION_INTENTS.PROPERTY_MANAGEMENT;
    if (/\bbuy/.test(lower)) return CONVERSATION_INTENTS.BUY;
  }
  return null;
}

function currentConversationIntent(profile = {}) {
  return (
    normalizeIntentValue(profile.intent) ||
    purposeToIntent(profile.purpose || profile.lastSearchFilters?.purpose) ||
    (profile.sellListing?.intent === 'sell' ? CONVERSATION_INTENTS.SELL_PROPERTY : null) ||
    (profile.serviceInquiry?.intent === 'property_management'
      ? CONVERSATION_INTENTS.PROPERTY_MANAGEMENT
      : null)
  );
}

function startFreshIntent(intent, message, currentProfile = {}) {
  const profile = {
    preferredAreas: [],
    budget: { min: null, max: null },
    bedrooms: null,
    purpose: intentToPurpose(intent),
    intent,
    lastPropertyCards: [],
    shownPropertyIds: [],
    lastSearchFilters: emptySearchFilters(),
    slotFlow: { awaiting: null, alternatives: null },
    sellListing: emptySellListing(),
    serviceInquiry: emptyServiceInquiry(),
    viewingRequest: emptyViewingRequest(),
    leadCaptured: !!currentProfile.leadCaptured,
  };

  if (isListingIntent(intent)) {
    profile.lastSearchFilters.purpose = profile.purpose;
    profile.lastSearchFilters = applyMessageToSearchFilters(profile.lastSearchFilters, message);
    profile.lastSearchFilters.purpose = profile.purpose;
    if (profile.lastSearchFilters.location) {
      profile.preferredAreas = [profile.lastSearchFilters.location];
    }
    if (profile.lastSearchFilters.bedrooms != null) {
      profile.bedrooms = profile.lastSearchFilters.bedrooms;
    } else if (profile.lastSearchFilters.bedroomsMin != null) {
      profile.bedrooms = profile.lastSearchFilters.bedroomsMin;
    }
    const missing = nextMissingListingSlot(profile.lastSearchFilters);
    if (missing) {
      const q = listingSlotQuestion(missing, profile.lastSearchFilters);
      profile.slotFlow = { awaiting: q.awaiting, alternatives: null };
    }
    return profile;
  }

  if (intent === CONVERSATION_INTENTS.SELL_PROPERTY) {
    profile.sellListing = advanceSellListing(message, { intent: 'sell' }, []);
    profile.slotFlow = { awaiting: 'sell', alternatives: null };
    return profile;
  }

  if (intent === CONVERSATION_INTENTS.PROPERTY_MANAGEMENT) {
    const inquiry = seedServiceInquiry({}, {}, [], isExplicitIntentStarter(message) ? '' : message);
    inquiry.intent = 'property_management';
    if (isExplicitIntentStarter(message)) {
      inquiry.need = null;
    }
    profile.serviceInquiry = inquiry;
    if (!inquiry.need) {
      profile.slotFlow = { awaiting: 'pmNeed', alternatives: null };
    } else if (!hasPmPropertyContext(inquiry)) {
      profile.slotFlow = { awaiting: 'pmProperty', alternatives: null };
    } else {
      profile.slotFlow = { awaiting: 'serviceContact', alternatives: null };
    }
    return profile;
  }

  return profile;
}

function listingStartReply(intent, profile = {}, message = '') {
  if (intent === CONVERSATION_INTENTS.SELL_PROPERTY) {
    return sellClarificationReply(profile.sellListing || {}, message);
  }
  if (intent === CONVERSATION_INTENTS.PROPERTY_MANAGEMENT) {
    const inquiry = profile.serviceInquiry || {};
    if (!inquiry.need) return pmNeedReply();
    if (!hasPmPropertyContext(inquiry)) return pmPropertyReply(inquiry);
    return serviceContactReply(inquiry);
  }
  const missing = nextMissingListingSlot(profile.lastSearchFilters || {});
  if (!missing) return null;
  return listingSlotQuestion(missing, profile.lastSearchFilters || {}).reply;
}

function listingStartOptions(intent, profile = {}, message = '') {
  if (intent === CONVERSATION_INTENTS.SELL_PROPERTY) {
    return sellFlowOptions(profile.sellListing || {}, message) || undefined;
  }
  if (intent === CONVERSATION_INTENTS.PROPERTY_MANAGEMENT) {
    const awaiting = profile.slotFlow?.awaiting;
    if (awaiting === 'pmNeed') return PM_NEED_OPTIONS;
    return undefined;
  }
  const missing = nextMissingListingSlot(profile.lastSearchFilters || {});
  if (!missing) return undefined;
  return listingSlotQuestion(missing, profile.lastSearchFilters || {}).options;
}

/** True when this turn is not a listing follow-up and must not reuse last search filters. */
function shouldSkipPropertySearch(text) {
  if (!String(text || '').trim()) return false;
  if (parseSellIntent(text) || isSellCta(text)) return true;
  if (isListingFollowUp(text) || isVagueConfirm(text)) return false;
  return isGeneralKnowledgeQuery(text);
}

function trustedPurpose({ lastSearchFilters = {}, userMessage, slotFlow, intent, effectiveFilters } = {}) {
  if (parseSellIntent(userMessage) || isServiceInquiryMessage(userMessage)) return null;

  const fromMessage = parsePurposeFromMessage(userMessage, lastSearchFilters);
  if (fromMessage) return fromMessage;

  const next = effectiveFilters || lastSearchFilters;
  if (
    searchTypesAreCommercial(next) &&
    !normalizePurpose(next.purpose) &&
    !normalizePurpose(lastSearchFilters?.purpose)
  ) {
    return null;
  }

  // Current-turn overlay / persisted filters win over a stale conversation intent.
  const locked =
    normalizePurpose(next.purpose) ||
    normalizePurpose(lastSearchFilters?.purpose) ||
    intentToPurpose(intent);
  if (!locked) return null;

  if (slotFlow?.awaiting === 'bedrooms' || slotFlow?.awaiting === 'listingIntake') return locked;
  if (parseBedroomChoice(userMessage)) return locked;
  if (parsePropertyTypeChange(userMessage)) return locked;

  return locked;
}

function purposeClarificationFields() {
  return {
    requiresClarification: true,
    options: PURPOSE_OPTIONS,
    select: PURPOSE_SELECT,
  };
}

function profilePatchFromPropertyFilters(filters) {
  const patch = {};
  if (filters.location) patch.preferredAreas = [String(filters.location).trim()];
  if (filters.bedrooms !== undefined && filters.bedrooms !== null && filters.bedrooms !== '') {
    const n = Number(filters.bedrooms);
    if (Number.isFinite(n)) patch.bedrooms = n;
  }
  if (isBedroomsSet(filters.bedroomsMin)) {
    patch.bedrooms = filters.bedroomsMin;
  }
  const min = filters.budgetMin !== undefined && filters.budgetMin !== '' ? Number(filters.budgetMin) : null;
  const max = filters.budgetMax !== undefined && filters.budgetMax !== '' ? Number(filters.budgetMax) : null;
  if (Number.isFinite(min) || Number.isFinite(max)) {
    patch.budget = {
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
    };
  }
  const purpose = normalizePurpose(filters.purpose);
  if (purpose) {
    patch.purpose = purpose;
    patch.intent = purposeToIntent(purpose);
  } else {
    patch.purpose = null;
    patch.intent = null;
  }
  return patch;
}

function listingQueryOpts(filters, search) {
  const queryFilters = {};
  if (requiresBedroomsForSearch(filters) && !filters.bedroomsAny) {
    if (isBedroomsSet(filters.bedroomsMin)) {
      queryFilters.bedroomsMin = filters.bedroomsMin;
    } else if (isBedroomsSet(filters.bedrooms)) {
      queryFilters.bedrooms = Number(filters.bedrooms);
    }
  }
  if (filters.budgetMin !== undefined && filters.budgetMin !== null && filters.budgetMin !== '') {
    queryFilters.priceMin = filters.budgetMin;
  }
  if (filters.budgetMax !== undefined && filters.budgetMax !== null && filters.budgetMax !== '') {
    queryFilters.priceMax = filters.budgetMax;
  }
  const types = typesFromFilters(filters);
  if (types.length) queryFilters.propertyType = types;
  if (filters.furnished) queryFilters.furnished = filters.furnished;
  if (Array.isArray(filters.excludeRefNos) && filters.excludeRefNos.length) {
    queryFilters.excludeRefNos = uniqueIdList(filters.excludeRefNos);
  }
  return { page: 1, limit: PROPERTY_LIMIT, search, filters: queryFilters };
}

async function fetchByPurpose(purpose, opts) {
  const requested = normalizePurpose(purpose);
  console.log(
    'PROPERTY_DB_QUERY',
    JSON.stringify({
      purpose: requested,
      propertyPurpose: requested === 'Off-plan' ? undefined : requested,
      offPlan: requested === 'Off-plan' ? 'Yes' : requested === 'Buy' || requested === 'Rent' ? 'No' : undefined,
      search: opts?.search || null,
      filters: opts?.filters || {},
    })
  );
  if (requested === 'Rent') {
    const filters = { ...(opts.filters || {}), offPlan: 'No' };
    return propertyDbService.fetchRentProperties({ ...opts, filters });
  }
  if (requested === 'Off-plan') return propertyDbService.fetchOffPlanProperties(opts);
  if (requested === 'Buy') {
    const filters = { ...(opts.filters || {}), offPlan: 'No' };
    return propertyDbService.fetchBuyProperties({ ...opts, filters });
  }
  return { properties: [], total: 0 };
}

function dedupePropertyCards(cards = []) {
  const seen = new Set();
  const out = [];
  for (const card of cards || []) {
    const id = String(card?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(card);
  }
  return out;
}

function resolveMatchingTotal(result = {}, { previewLimited = true } = {}) {
  const candidates = [result.total, result.totalCount, result.pagination?.total, result.meta?.total];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (!previewLimited && Array.isArray(result.properties)) return result.properties.length;
  return null;
}

async function fetchPropertyCards(filters, search) {
  const opts = listingQueryOpts(filters, search);
  const requested = normalizePurpose(filters.purpose);
  if (!requested) {
    return { propertyCards: [], usedPurpose: null, total: 0, remainingAfterExclude: 0 };
  }
  const exclude = uniqueIdList(filters.excludeRefNos || []);
  const unfilteredOpts = {
    ...opts,
    filters: { ...(opts.filters || {}), excludeRefNos: undefined },
  };
  delete unfilteredOpts.filters.excludeRefNos;

  const unfiltered = exclude.length
    ? await fetchByPurpose(requested, unfilteredOpts)
    : null;
  const result = await fetchByPurpose(requested, opts);
  const remainingAfterExclude = resolveMatchingTotal(result, { previewLimited: true }) ?? 0;
  const total = exclude.length
    ? resolveMatchingTotal(unfiltered, { previewLimited: true }) ?? remainingAfterExclude
    : remainingAfterExclude;
  return {
    propertyCards: dedupePropertyCards((result.properties || []).map(toPropertyCard)),
    usedPurpose: requested,
    total,
    remainingAfterExclude,
  };
}

function searchPaginationMeta({
  total = 0,
  remainingAfterExclude = 0,
  returnedCount = 0,
  shownCount = 0,
} = {}) {
  const remaining = Math.max(0, (Number(remainingAfterExclude) || 0) - (Number(returnedCount) || 0));
  return {
    total: Number(total) || 0,
    returnedCount: Number(returnedCount) || 0,
    shownCount: Number(shownCount) || 0,
    remaining,
    hasMore: remaining > 0,
    nextCursor: remaining > 0 ? 'shownPropertyIds' : null,
  };
}

function attachSearchPagination(result, pagination = {}) {
  if (!result) return result;
  result.hasMore = !!pagination.hasMore;
  result.total = pagination.total ?? 0;
  result.returnedCount = pagination.returnedCount ?? 0;
  result.remaining = pagination.remaining ?? 0;
  result.nextCursor = pagination.hasMore ? pagination.nextCursor || 'shownPropertyIds' : null;
  if (result.modelPayload && typeof result.modelPayload === 'object') {
    result.modelPayload.total = result.total;
    result.modelPayload.returnedCount = result.returnedCount;
    result.modelPayload.remaining = result.remaining;
    result.modelPayload.hasMore = result.hasMore;
    result.modelPayload.nextCursor = result.nextCursor;
  }
  return result;
}

function propertySearchResult(propertyCards, filters, extraPayload = {}, viewAllMatching = null) {
  return {
    propertyCards,
    sources: [],
    leadCaptured: false,
    profilePatch: profilePatchFromPropertyFilters(filters),
    viewAllMatching,
    modelPayload: {
      count: Number.isFinite(Number(extraPayload.total)) ? Number(extraPayload.total) : undefined,
      previewCount: propertyCards.length,
      properties: propertyCards.map((card) => ({
        id: card.id,
        title: card.title,
        price: card.price,
        beds: card.beds,
        baths: card.baths,
        area: card.area,
        listingUrl: card.listingUrl,
      })),
      ...extraPayload,
    },
  };
}

function missingSlotResult(slot, effectiveFilters, { previous, message } = {}) {
  const question = listingSlotQuestion(slot, effectiveFilters);
  const flag =
    slot === 'intent'
      ? 'needsPurpose'
      : slot === 'bedrooms'
        ? 'needsBedrooms'
        : slot === 'propertyType'
          ? 'needsPropertyType'
          : slot === 'location'
            ? 'needsLocation'
            : 'needsBudget';
  const ack = buildSearchAcknowledgement(effectiveFilters, { previous, message });
  return {
    propertyCards: [],
    sources: [],
    leadCaptured: false,
    profilePatch: {
      ...profilePatchFromPropertyFilters(effectiveFilters),
      lastSearchFilters: effectiveFilters,
      slotFlow: { awaiting: question.awaiting, alternatives: null },
    },
    viewAllMatching: null,
    effectiveFilters,
    [flag]: true,
    clarificationReply: joinAckAndQuestion(ack, question.reply),
    options: question.options,
    inputType: question.inputType || null,
    quickReplies: question.quickReplies || null,
    requiresClarification: true,
    select: PURPOSE_SELECT,
    modelPayload: {
      count: 0,
      [flag]: true,
      missingSlot: slot,
      requestedLocation: (effectiveFilters.location || '').toString().trim() || null,
      instruction:
        'A required listing field is missing. Do not invent listings. The server will ask exactly one clarification question. Do not invent bedrooms or budget.',
    },
  };
}

function purposeMissingResult(effectiveFilters) {
  return missingSlotResult('intent', effectiveFilters);
}

function bedroomsMissingResult(effectiveFilters) {
  return missingSlotResult('bedrooms', effectiveFilters);
}

function emptyResultsClarificationFields() {
  return {
    requiresClarification: true,
    select: PURPOSE_SELECT,
  };
}

function purposeCountFilters(purpose, queryFilters = {}) {
  const next = { ...queryFilters };
  if (purpose === 'Buy' || purpose === 'Rent') next.offPlan = 'No';
  if (purpose === 'Off-plan') next.offPlan = 'Yes';
  return next;
}

function dropNearbyIfEmpty(options = [], nearbyInventory = []) {
  const hasNearby = (nearbyInventory || []).some((row) => Number(row?.count) > 0);
  if (hasNearby) return options;
  return options.filter((opt) => opt !== 'Nearby areas');
}

/** Quick count-only query — returns 0 or positive integer. Does not change search filters. */
async function countByFilters(filters, search) {
  const purpose = normalizePurpose(filters.purpose);
  if (!purpose) return 0;
  const opts = listingQueryOpts(filters, search);
  const forced = forcedFromPurpose(purpose);
  const queryFilters = purposeCountFilters(purpose, opts.filters);
  try {
    const counted = await propertyDbService.countProperties({
      search: opts.search || search || '',
      filters: queryFilters,
      forced,
    });
    if (Number(counted) > 0) return Number(counted);
  } catch (err) {
    console.error('countProperties failed:', err);
  }
  try {
    const result = await fetchByPurpose(purpose, { ...opts, page: 1, limit: 1 });
    return Number(result.total) || (result.properties || []).length || 0;
  } catch (err) {
    console.error('countByFilters failed:', err);
    return 0;
  }
}

function forcedFromPurpose(purpose) {
  if (purpose === 'Rent') return { propertyPurpose: 'Rent', offPlan: 'No' };
  if (purpose === 'Off-plan') return { offPlan: 'Yes' };
  if (purpose === 'Buy') return { propertyPurpose: 'Buy', offPlan: 'No' };
  return null;
}

async function probeAlternativeInventory(filters = {}, { currentTotal = 0 } = {}) {
  const purpose = normalizePurpose(filters.purpose);
  const loc = hasLocationConstraint(filters) ? String(filters.location).trim() : '';
  const n = Number(currentTotal);
  const total = Number.isFinite(n) ? n : 0;
  const counts = { readyBuyCount: 0, rentCount: 0, offPlanCount: 0 };
  if (purpose === 'Buy') {
    counts.readyBuyCount = total;
    const offPlanFilters = copySearchFilters(filters);
    offPlanFilters.purpose = 'Off-plan';
    const opts = listingQueryOpts(offPlanFilters, loc);
    try {
      counts.offPlanCount =
        Number(
          await propertyDbService.countProperties({
            search: opts.search || loc,
            filters: purposeCountFilters('Off-plan', opts.filters),
            forced: forcedFromPurpose('Off-plan'),
          })
        ) || 0;
    } catch (err) {
      console.error('probeAlternativeInventory failed:', err);
      counts.offPlanCount = 0;
    }
  } else if (purpose === 'Rent') {
    counts.rentCount = total;
  } else if (purpose === 'Off-plan') {
    counts.offPlanCount = total;
  }
  return counts;
}

async function getSegmentMarketStats(filters = {}, { excludeRefNos = [], ignoreBudget = false } = {}) {
  const purpose = normalizePurpose(filters.purpose);
  const forced = forcedFromPurpose(purpose);
  if (!forced) {
    return { minimumPrice: null, averagePrice: null, maximumPrice: null, totalAvailable: 0 };
  }
  const query = copySearchFilters(filters);
  if (ignoreBudget) {
    query.budgetMin = null;
    query.budgetMax = null;
  }
  delete query.excludeRefNos;
  const opts = listingQueryOpts(query, (filters.location || '').toString().trim());
  const queryFilters = purposeCountFilters(purpose, { ...(opts.filters || {}) });
  if (ignoreBudget) {
    delete queryFilters.priceMin;
    delete queryFilters.priceMax;
  }
  delete queryFilters.excludeRefNos;
  const exclude = uniqueIdList(excludeRefNos);
  if (exclude.length) queryFilters.excludeRefNos = exclude;

  try {
    return await propertyDbService.getPropertyMarketStats({
      search: opts.search,
      filters: queryFilters,
      forced,
    });
  } catch (err) {
    console.error('getSegmentMarketStats failed:', err);
    return { minimumPrice: null, averagePrice: null, maximumPrice: null, totalAvailable: 0 };
  }
}

function purposePhrase(filters = {}) {
  const purpose = normalizePurpose(filters.purpose);
  if (purpose === 'Rent') return 'for rent';
  if (purpose === 'Off-plan') return 'off-plan';
  return 'for sale';
}

function describeBedsAndType(filters = {}, { plural = false } = {}) {
  const beds = describeBedroomPhrase(filters).trim();
  const type = plural ? describeTypePhrase(filters, 2) : describeTypeSingular(filters).toLowerCase();
  if (beds) return `${beds} ${type}`.replace(/\s+/g, ' ').trim();
  return type;
}

function budgetTooLowReply(filters = {}, stats = {}) {
  const lines = [exactNoMatchLine(filters)];
  const unconstrained = unconstrainedBudgetLine(stats.totalAvailable, filters);
  if (unconstrained) lines.push(unconstrained);
  return lines.join('\n\n');
}

function budgetTooLowOptions(filters = {}) {
  const opts = ['Any budget'];
  const complement = complementaryBudgetChip(filters);
  if (complement) opts.push(complement);
  opts.push(...bedroomFallbackOptions(filters).filter((opt) => opt !== 'Change bedrooms'));
  if (hasLocationConstraint(filters) && !opts.includes('Nearby areas')) opts.push('Nearby areas');
  return opts.filter((opt, i, arr) => arr.indexOf(opt) === i);
}

function noInventoryReply(filters = {}) {
  const area = describeLocationClause(filters);
  const segment = describeBedsAndType(filters, { plural: true });
  const purposeBit = purposePhrase(filters);
  return `I couldn't find currently available ${segment} ${purposeBit}${area}.\n\n${searchBroadenReply(filters)}`;
}

function noInventoryOptions(filters = {}) {
  const opts = [...nearbyFallbackOptions(filters)];
  if (requiresBedroomsForSearch(filters)) opts.push('Change bedrooms');
  opts.push('Property type');
  if (!requiresBedroomsForSearch(filters)) opts.push('Change budget');
  return opts;
}

function userBudgetBelowSegmentMin(filters = {}, stats = {}) {
  const userMax = Number(filters.budgetMax);
  const min = Number(stats.minimumPrice);
  return Number.isFinite(userMax) && Number.isFinite(min) && userMax < min && (stats.totalAvailable || 0) > 0;
}

/**
 * Alternative types to try when the requested type has no results.
 * Ordered by typical availability in Dubai.
 */
const ALTERNATIVE_TYPES = {
  Apartment: ['Villa', 'Townhouse'],
  Villa: ['Apartment', 'Townhouse'],
  Townhouse: ['Villa', 'Apartment'],
  Penthouse: ['Apartment', 'Villa'],
  Duplex: ['Apartment', 'Townhouse'],
  default: ['Apartment', 'Villa'],
};

function alternativeTypesFor(currentType) {
  const key = Object.keys(ALTERNATIVE_TYPES).find(
    (k) => k.toLowerCase() === String(currentType || '').toLowerCase()
  );
  return key ? ALTERNATIVE_TYPES[key] : ALTERNATIVE_TYPES.default;
}

/** Adjacent bedroom counts to try. */
function adjacentBedroomCounts(filters) {
  const adj = [];
  const n = Number(filters.bedrooms);
  const min = Number(filters.bedroomsMin);
  if (filters.bedroomsAny) return [];
  if (min >= 4) {
    adj.push({ exact: 3, label: 'Try 3 BR' });
  } else if (Number.isFinite(n)) {
    if (n > 0) adj.push({ exact: n - 1, label: n - 1 === 0 ? 'Try Studio' : `Try ${n - 1} BR` });
    if (n < 5) adj.push({ exact: n + 1, label: n + 1 >= 4 ? 'Try 4+ BR' : `Try ${n + 1} BR` });
  }
  return adj;
}

function pluraliseType(type) {
  const t = String(type || '').trim();
  if (!t) return t;
  if (t.toLowerCase().endsWith('s')) return t;   // already plural
  if (t.toLowerCase() === 'studio') return 'Studios';
  return `${t}s`;
}

/**
 * Chip label helpers — must round-trip through parseAlternativeChip().
 * Format: "<N> BR <Type> in <Area>" | "<Type> in <Area>" | "<N> BR <Type>" |
 *         "<N> BR in <Area>" | "Try <N> BR" | "Try Studio"
 */
function nearbyAreaChipLabel(area, filters) {
  const bedsPhrase = describeBedroomPhrase(filters).trim();
  const type = pluraliseType((filters.type || '').trim());
  if (bedsPhrase && type) return `${capitalise(bedsPhrase)} ${type} in ${area}`;
  if (type) return `${type} in ${area}`;
  if (bedsPhrase) return `${capitalise(bedsPhrase)} in ${area}`;
  return area;
}

function altTypeChipLabel(altType, filters) {
  const bedsPhrase = describeBedroomPhrase(filters).trim();
  const plural = pluraliseType(altType);
  if (bedsPhrase) return `${capitalise(bedsPhrase)} ${plural}`;
  return plural;
}

function capitalise(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

/**
 * Parse a chip label (or typed equivalent) back into a filter patch.
 * Returns { location?, type?, bedrooms? } for the attributes that change,
 * or null if the text isn't recognised.
 */
function parseAlternativeChip(text, currentFilters = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // "Try N BR" / "Try Studio" / "Try 4+ BR" — bedroom change only
  const tryBr = raw.match(/^try\s+(.+)$/i);
  if (tryBr) {
    const choice = parseBedroomChoice(tryBr[1]);
    if (choice) return { bedroomChoice: choice };
  }

  // Typed "what about villas" / "show me villas" → property type change
  const typeChange = parsePropertyTypeChange(raw);
  if (typeChange) return { type: typeChange };

  // "N BR <Type> in <Area>" — e.g. "2 BR Villas in Arabian Ranches"
  const fullMatch = raw.match(/^(\d+\+?\s*(?:br|bedroom)s?|studio)\s+(\w+)\s+in\s+(.+)$/i);
  if (fullMatch) {
    const bedsChoice = parseBedroomChoice(fullMatch[1]);
    const altType = normalizePropertyType(fullMatch[2]);
    const area = fullMatch[3].trim();
    const patch = {};
    if (bedsChoice) patch.bedroomChoice = bedsChoice;
    if (altType) patch.type = altType;
    if (area) patch.location = area;
    if (Object.keys(patch).length) return patch;
  }

  // "<Type> in <Area>" — e.g. "Apartments in Arabian Ranches"
  const typeInArea = raw.match(/^(\w+)\s+in\s+(.+)$/i);
  if (typeInArea) {
    const altType = normalizePropertyType(typeInArea[1]);
    const area = typeInArea[2].trim();
    if (altType && area) return { type: altType, location: area };
    if (area) return { location: area };
  }

  // "<N> BR <Type>" — e.g. "2 BR Villas" (type + same location)
  const bedsType = raw.match(/^(\d+\+?\s*(?:br|bedroom)s?|studio)\s+(\w+)$/i);
  if (bedsType) {
    const bedsChoice = parseBedroomChoice(bedsType[1]);
    const altType = normalizePropertyType(bedsType[2]);
    const patch = {};
    if (bedsChoice) patch.bedroomChoice = bedsChoice;
    if (altType) patch.type = altType;
    if (Object.keys(patch).length) return patch;
  }

  // "<N> BR in <Area>"
  const bedsInArea = raw.match(/^(\d+\+?\s*(?:br|bedroom)s?|studio)\s+in\s+(.+)$/i);
  if (bedsInArea) {
    const bedsChoice = parseBedroomChoice(bedsInArea[1]);
    const area = bedsInArea[2].trim();
    const patch = {};
    if (bedsChoice) patch.bedroomChoice = bedsChoice;
    if (area) patch.location = area;
    if (Object.keys(patch).length) return patch;
  }

  // Known area name (from nearby map)
  const nearbyList = nearbyAreaOptions(currentFilters.location);
  if (nearbyList.some((a) => a.toLowerCase() === raw.toLowerCase())) {
    return { location: nearbyList.find((a) => a.toLowerCase() === raw.toLowerCase()) };
  }

  // General bedroom mention — e.g. "what about 1 bedroom", "show me 3 bedrooms", "try 2"
  const bedsGeneral = parseBedroomChoice(raw);
  if (bedsGeneral && !bedsGeneral.any) return { bedroomChoice: bedsGeneral };

  return null;
}

/**
 * Probe all alternative categories (A/B/C) in parallel and return only those
 * with confirmed > 0 inventory.  Returns an array of { label, patch } entries
 * capped at MAX_ALT_CHIPS.
 *
 * When `nearbyOnly` is true (location has zero inventory for purpose+type at any
 * bedroom count), only nearby-area chips are offered — never bedroom Try-N chips.
 */
const MAX_ALT_CHIPS = 4;

async function locationHasInventoryForPurposeType(effectiveFilters) {
  const location = (effectiveFilters.location || '').toString().trim();
  if (!location || !effectiveFilters.purpose) return false;
  const anyBedFilters = {
    ...effectiveFilters,
    bedrooms: null,
    bedroomsMin: null,
    bedroomsAny: true,
    bedroomsResolved: true,
  };
  return (await countByFilters(anyBedFilters, location)) > 0;
}

async function buildNearbyAreaChips(effectiveFilters) {
  const location = (effectiveFilters.location || '').trim();
  const nearbyAreas = nearbyAreaOptions(location);
  const probed = await Promise.all(
    nearbyAreas.slice(0, 4).map(async (area) => {
      const testFilters = {
        ...effectiveFilters,
        location: area,
        bedrooms: null,
        bedroomsMin: null,
        bedroomsAny: true,
        bedroomsResolved: true,
      };
      const count = await countByFilters(testFilters, area);
      return { label: area, patch: { location: area }, count };
    })
  );
  return probed
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_ALT_CHIPS)
    .map((c) => ({ label: c.label, patch: c.patch }));
}

async function buildAlternativeChips(effectiveFilters, { nearbyOnly = false } = {}) {
  if (nearbyOnly) {
    return buildNearbyAreaChips(effectiveFilters);
  }

  const purpose = effectiveFilters.purpose;
  const location = (effectiveFilters.location || '').trim();
  const type = effectiveFilters.type || null;

  const candidates = [];

  // A — nearby areas with same type + same bedrooms
  if (hasLocationConstraint(effectiveFilters)) {
    const nearbyAreas = nearbyAreaOptions(location);
    for (const area of nearbyAreas.slice(0, 3)) {
      candidates.push({
        label: nearbyAreaChipLabel(area, effectiveFilters),
        patch: { location: area },
        priority: 1,
      });
    }
  }

  // B — same location + alternative property types
  const altTypes = alternativeTypesFor(type).slice(0, 2);
  for (const altType of altTypes) {
    candidates.push({
      label: altTypeChipLabel(altType, effectiveFilters),
      patch: { type: altType },
      priority: 2,
    });
  }

  // C — adjacent bedroom counts at same location + same type
  if (requiresBedroomsForSearch(effectiveFilters)) {
    const adjBeds = adjacentBedroomCounts(effectiveFilters);
    for (const adj of adjBeds) {
      candidates.push({
        label: adj.label,
        patch: { bedroomChoice: { exact: adj.exact } },
        priority: 3,
      });
    }
  }

  // Probe each candidate concurrently
  const probed = await Promise.all(
    candidates.map(async (cand) => {
      const testFilters = { ...effectiveFilters };
      if (cand.patch.location) testFilters.location = cand.patch.location;
      if (cand.patch.type) testFilters.type = cand.patch.type;
      if (cand.patch.bedroomChoice) {
        const tmpFilters = { ...testFilters };
        applyBedroomChoice(tmpFilters, cand.patch.bedroomChoice);
        testFilters.bedrooms = tmpFilters.bedrooms;
        testFilters.bedroomsMin = tmpFilters.bedroomsMin;
        testFilters.bedroomsAny = tmpFilters.bedroomsAny;
        testFilters.bedroomsResolved = true;
      }
      const search = (testFilters.location || '').toString().trim();
      const count = await countByFilters({ ...testFilters, purpose }, search);
      return { ...cand, count };
    })
  );

  const hits = probed
    .filter((c) => c.count > 0)
    .sort((a, b) => a.priority - b.priority || b.count - a.count);

  return hits.slice(0, MAX_ALT_CHIPS).map((c) => ({ label: c.label, patch: c.patch }));
}

function canonicalSearchState(filters = {}) {
  const types = typesFromFilters(filters);
  const listingMode = listingModeFromFilters(filters);
  const minPrice = filters.budgetMin ?? null;
  const maxPrice = filters.budgetMax ?? null;
  return {
    listingMode,
    intent: purposeToIntent(filters.purpose) || null,
    purpose: normalizePurpose(filters.purpose) || null,
    category: searchCategory(filters),
    propertyType: types[0] || filters.type || null,
    propertyTypes: types,
    bedrooms: isBedroomsSet(filters.bedrooms)
      ? Number(filters.bedrooms)
      : filters.bedroomsAny
        ? 'any'
        : isBedroomsSet(filters.bedroomsMin)
          ? Number(filters.bedroomsMin)
          : null,
    location: hasLocationConstraint(filters) ? String(filters.location).trim() : null,
    minPrice,
    maxPrice,
    minBudget: minPrice,
    maxBudget: maxPrice,
    budgetProvided: isBudgetProvided(filters),
    furnishing: filters.furnished || null,
  };
}

function sanitizeMarketStats(stats = {}, purpose) {
  const out = {};
  if (Number.isFinite(Number(stats.minimumPrice))) out.minPrice = Number(stats.minimumPrice);
  if (Number.isFinite(Number(stats.averagePrice))) out.averagePrice = Number(stats.averagePrice);
  if (Number.isFinite(Number(stats.medianPrice))) out.medianPrice = Number(stats.medianPrice);
  if (Number.isFinite(Number(stats.maximumPrice))) out.maxPrice = Number(stats.maximumPrice);
  if (Number.isFinite(Number(stats.averagePricePerSqft))) {
    out.averagePricePerSqft = Number(stats.averagePricePerSqft);
  }
  if (Number.isFinite(Number(stats.totalAvailable))) out.matchingCount = Number(stats.totalAvailable);
  if ((stats.readyCount || 0) > 0) out.readyCount = stats.readyCount;
  if ((stats.offPlanCount || 0) > 0) out.offPlanCount = stats.offPlanCount;
  if (normalizePurpose(purpose) === 'Rent') {
    if (out.minPrice != null) out.minAnnualRent = out.minPrice;
    if (out.averagePrice != null) out.averageAnnualRent = out.averagePrice;
    if (out.medianPrice != null) out.medianAnnualRent = out.medianPrice;
  }
  return out;
}

function bedroomCountLabel(n, typeWord = 'apartments') {
  if (n === 0) return `studio ${typeWord}`;
  if (n === 1) return `one-bedroom ${typeWord}`;
  if (n === 2) return `two-bedroom ${typeWord}`;
  if (n === 3) return `three-bedroom ${typeWord}`;
  if (n >= 4) return `${n}-bedroom ${typeWord}`;
  return typeWord;
}

function searchChangeSummary(previous = {}, next = {}) {
  const changes = [];
  const prevLoc = String(previous.location || '').trim();
  const nextLoc = String(next.location || '').trim();
  if (prevLoc && nextLoc && prevLoc.toLowerCase() !== nextLoc.toLowerCase()) {
    changes.push(`switching the location to ${nextLoc}`);
  }
  const prevBeds = previous.bedrooms;
  const nextBeds = next.bedrooms;
  if (isBedroomsSet(prevBeds) && isBedroomsSet(nextBeds) && Number(prevBeds) !== Number(nextBeds)) {
    changes.push(
      Number(nextBeds) === 0
        ? 'switching this to studio apartments'
        : `updating the search to ${Number(nextBeds)} bedrooms`
    );
  }
  const prevType = String(typesFromFilters(previous)[0] || '').toLowerCase();
  const nextType = String(typesFromFilters(next)[0] || '').toLowerCase();
  if (prevType && nextType && prevType !== nextType) {
    changes.push(`looking at ${nextType}s instead`);
  }
  const prevPurpose = normalizePurpose(previous.purpose);
  const nextPurpose = normalizePurpose(next.purpose);
  if (prevPurpose && nextPurpose && prevPurpose !== nextPurpose) {
    changes.push(`keeping the rest of your search as ${nextPurpose === 'Rent' ? 'rent' : nextPurpose === 'Off-plan' ? 'off-plan' : 'purchase'}`);
  }
  return changes;
}

function formatListingBrief(card, index) {
  const lines = [];
  const title = card.title || card.id || `Listing ${index}`;
  const loc = card.location ? ` — ${card.location}` : '';
  lines.push(`${index}. ${title}${loc}`);
  const spec = [];
  if (card.beds === 0 || card.beds === '0') spec.push('Studio');
  else if (card.beds !== '' && card.beds != null) spec.push(`${card.beds} beds`);
  if (card.baths !== '' && card.baths != null) spec.push(`${card.baths} baths`);
  if (card.area) spec.push(card.area);
  if (spec.length) lines.push(`   ${spec.join(' · ')}`);
  if (card.price) {
    const raw = String(card.price).trim();
    const n = Number(String(raw).replace(/,/g, '').replace(/[^\d.]/g, ''));
    const formatted = /aed/i.test(raw)
      ? raw
      : Number.isFinite(n) && n >= 1000
        ? formatAed(n)
        : raw;
    lines.push(`   ${formatted}`);
  }
  const tags = [card.completionStatus, card.furnished, ...(card.features || [])]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  if (tags.length) lines.push(`   ${tags.slice(0, 4).join(' · ')}`);
  if (card.listingUrl) lines.push(`   View listing: ${card.listingUrl}`);
  return lines.join('\n');
}

function compactMarketSnapshot(stats = {}, purpose) {
  const snapshot = {};
  const rent = normalizePurpose(purpose) === 'Rent';
  if (rent) {
    if (stats.minAnnualRent != null) snapshot.minPrice = stats.minAnnualRent;
    else if (stats.minPrice != null) snapshot.minPrice = stats.minPrice;
    if (stats.averageAnnualRent != null) snapshot.averagePrice = stats.averageAnnualRent;
    else if (stats.averagePrice != null) snapshot.averagePrice = stats.averagePrice;
  } else {
    if (stats.minPrice != null) snapshot.minPrice = stats.minPrice;
    if (stats.averagePrice != null) snapshot.averagePrice = stats.averagePrice;
  }
  return snapshot;
}

function formatSearchSnapshotLines(stats = {}, filters = {}, { scope = 'filtered' } = {}) {
  const snapshot = compactMarketSnapshot(stats, filters.purpose);
  const lines = [];
  const purpose = normalizePurpose(filters.purpose);
  if (snapshot.minPrice != null) {
    lines.push(
      purpose === 'Buy'
        ? `• Ready properties start from ${formatAed(snapshot.minPrice)}`
        : `• Prices start from ${formatAed(snapshot.minPrice)}`
    );
  }
  if (snapshot.averagePrice != null) {
    lines.push(`• Average asking price is around ${formatAed(snapshot.averagePrice)}`);
  }
  if (!lines.length) return [];
  const loc = hasLocationConstraint(filters) ? String(filters.location).trim() : '';
  let heading = loc ? `${loc} market snapshot:` : 'Market snapshot:';
  if (scope === 'overall') {
    const mode =
      purpose === 'Off-plan' ? 'off-plan ' : purpose === 'Buy' ? 'ready ' : purpose === 'Rent' ? 'rental ' : '';
    heading = loc ? `Overall ${loc} ${mode}market snapshot:` : 'Overall market snapshot:';
  }
  return [heading, ...lines];
}

function matchingCountSummary(count, filters = {}) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return '';
  const purpose = normalizePurpose(filters.purpose);
  if (purpose === 'Buy') {
    return `I found ${n} ready ${n === 1 ? 'property' : 'properties'} for sale.`;
  }
  const loc = hasLocationConstraint(filters) ? String(filters.location).trim() : '';
  const area = loc ? ` in ${loc}` : '';
  const segment = describeBedsAndType(filters, { plural: n !== 1 });
  if (purpose === 'Off-plan') {
    return `I found ${n} off-plan ${segment}${area}.`.replace(/\s+/g, ' ').trim();
  }
  if (purpose === 'Rent') {
    return `I found ${n} ${segment} for rent${area}.`.replace(/\s+/g, ' ').trim();
  }
  return `I found ${n} matching ${n === 1 ? 'property' : 'properties'}.`;
}

function alternativeInventoryLine(ctx = {}) {
  const purpose = normalizePurpose(ctx.filters?.purpose);
  const offPlanCount = Number(ctx.inventoryCounts?.offPlanCount);
  if (purpose !== 'Buy' || !Number.isFinite(offPlanCount) || offPlanCount <= 0) return '';
  const loc = hasLocationConstraint(ctx.filters) ? String(ctx.filters.location).trim() : '';
  const where = loc ? ` in ${loc}` : '';
  return `There are also ${offPlanCount} off-plan option${offPlanCount === 1 ? '' : 's'}${where} if you'd like to explore them.`;
}

function exploreOffPlanChip(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `Explore ${n} off-plan ${n === 1 ? 'property' : 'properties'}`;
}

function withOffPlanExploreOption(options = [], ctx = {}) {
  const purpose = normalizePurpose(ctx.filters?.purpose);
  const chip = purpose === 'Buy' ? exploreOffPlanChip(ctx.inventoryCounts?.offPlanCount) : null;
  if (!chip) return options;
  return [chip, ...options.filter((opt) => opt !== chip)];
}

function refinementPromptFor(filters = {}, outcome) {
  if (outcome === SEARCH_OUTCOME.MATCHES_FOUND && !isBudgetProvided(filters)) {
    return 'Would you like to narrow these by budget?';
  }
  return '';
}

function buildSearchPresentation(ctx = {}) {
  const filters = ctx.filters || {};
  const count = ctx.exactMatchCount;
  const scope = ctx.marketStatsScope || (ctx.outcome === SEARCH_OUTCOME.MATCHES_FOUND ? 'filtered' : null);
  const snapshotSource =
    scope === 'overall' ? ctx.overallMarketStats || {} : ctx.marketStats || {};
  const snapshot = compactMarketSnapshot(snapshotSource, filters.purpose);
  const viewAll =
    ctx.outcome === SEARCH_OUTCOME.MATCHES_FOUND ? buildViewAllMatching(Number(count) || 0, filters) : null;
  const offPlanCount = Number(ctx.inventoryCounts?.offPlanCount);
  return {
    acknowledgement: String(ctx.acknowledgement || '').trim() || null,
    resultSummary:
      ctx.outcome === SEARCH_OUTCOME.MATCHES_FOUND ? matchingCountSummary(count, filters) || null : null,
    matchingCount: ctx.outcome === SEARCH_OUTCOME.MATCHES_FOUND && Number.isFinite(Number(count))
      ? Number(count)
      : null,
    inventoryCounts: ctx.inventoryCounts || null,
    alternativeInventory:
      normalizePurpose(filters.purpose) === 'Buy' && Number.isFinite(offPlanCount) && offPlanCount > 0
        ? { offPlan: { count: offPlanCount } }
        : null,
    marketSnapshot: scope === 'filtered' && Object.keys(snapshot).length ? snapshot : null,
    overallMarketSnapshot: scope === 'overall' && Object.keys(snapshot).length ? snapshot : null,
    marketStatsScope: scope,
    viewAll: viewAll
      ? { label: String(viewAll.label || '').replace(/\s*→\s*$/, ''), url: viewAll.url }
      : null,
    refinementPrompt: refinementPromptFor(filters, ctx.outcome) || null,
  };
}

function stripExposedUrlsFromReply(text) {
  return String(text || '')
    .replace(/See all properties:\s*https?:\/\/\S+/gi, '')
    .replace(/View listing:\s*https?:\/\/\S+/gi, '')
    .replace(/https?:\/\/[^\s)]+/g, '')
    .replace(/^[ \t]*(?:View all|See all|Browse all)[^\n]*→?[ \t]*$/gim, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function llmSafeSearchContext(context) {
  if (!context || typeof context !== 'object') return context;
  const { searchUrl, exactListings, ...rest } = context;
  const presentation = context.presentation || buildSearchPresentation(context) || {};
  const { viewAll, ...safePresentation } = presentation;
  return {
    ...rest,
    presentation: Object.keys(safePresentation).length ? safePresentation : null,
  };
}

function composeSearchReply(ctx = {}) {
  const filters = ctx.filters || {};
  const area = describeLocationClause(filters);
  const segment = describeBedsAndType(filters, { plural: true });
  const purposeBit = purposePhrase(filters);
  const lines = [];
  const ack = String(ctx.acknowledgement || '').trim();
  const changes = Array.isArray(ctx.changes) ? ctx.changes : [];
  if (ack) {
    lines.push(ack);
  } else if (changes.length) {
    lines.push(`Sure — ${changes[0]}${changes.length > 1 ? ` and ${changes.slice(1).join(', ')}` : ''}.`);
  }

  if (ctx.outcome === SEARCH_OUTCOME.MATCHES_FOUND) {
    const count = Number(ctx.exactMatchCount);
    if (!/you're looking for/i.test(ack)) {
      lines.push(`Here are ${segment} ${purposeBit}${area}.`.replace(/\s+/g, ' ').trim());
    }
    const summary = matchingCountSummary(count, filters);
    if (summary) lines.push(summary);
    const alternative = alternativeInventoryLine(ctx);
    if (alternative) lines.push(alternative);
    const snapshot = formatSearchSnapshotLines(ctx.marketStats || {}, filters, { scope: 'filtered' });
    if (snapshot.length) lines.push(snapshot.join('\n'));
    const refine = refinementPromptFor(filters, ctx.outcome);
    if (refine) lines.push(refine);
    return stripExposedUrlsFromReply(lines.filter(Boolean).join('\n\n').replace(/\n\n+/g, '\n\n'));
  }

  const loc = String(filters.location || '').trim();
  if (ctx.outcome === SEARCH_OUTCOME.BUDGET_TOO_LOW) {
    lines.push(exactNoMatchLine(filters));
    const unconstrained = unconstrainedBudgetLine(ctx.unconstrainedMatchCount, filters);
    if (unconstrained) lines.push(unconstrained);
  } else if (ctx.outcome === SEARCH_OUTCOME.EXACT_RESULTS_EXHAUSTED) {
    const budgetBit = describeBudgetRange(filters);
    lines.push(
      `There aren't any more ${segment}${area}${budgetBit ? ` ${budgetBit}` : ''} right now.`
        .replace(/\s+/g, ' ')
        .trim()
    );
  } else {
    lines.push(exactNoMatchLine(filters));
  }

  const alternative = alternativeInventoryLine(ctx);
  if (alternative) lines.push(alternative);

  const alts = ctx.sameAreaAlternatives || {};
  const byBeds = Array.isArray(alts.byBedrooms) ? alts.byBedrooms.filter((item) => item.count > 0) : [];
  if (ctx.outcome !== SEARCH_OUTCOME.BUDGET_TOO_LOW && byBeds.length) {
    lines.push('The closest alternatives in this area are:');
    byBeds.slice(0, 4).forEach((item) => {
      lines.push(`- ${item.count} ${item.label}`);
    });
  }

  const nearby = Array.isArray(ctx.nearbyInventory) ? ctx.nearbyInventory.filter((item) => item.count > 0) : [];
  if (nearby.length) {
    lines.push(`If you'd like to keep this search, nearby areas with current inventory include:`);
    nearby.slice(0, 3).forEach((item) => {
      const extra =
        item.readyCount && item.offPlanCount
          ? ` — ${item.readyCount} ready, ${item.offPlanCount} off-plan`
          : ` — ${item.count} ${item.count === 1 ? 'property' : 'properties'}`;
      lines.push(`- ${item.name}${extra}`);
    });
  }

  if (ctx.outcome === SEARCH_OUTCOME.BUDGET_TOO_LOW) {
    const overall = formatSearchSnapshotLines(ctx.overallMarketStats || {}, filters, { scope: 'overall' });
    if (overall.length) lines.push(overall.join('\n'));
  } else if (ctx.outcome === SEARCH_OUTCOME.EXACT_RESULTS_EXHAUSTED) {
    const market = formatSearchSnapshotLines(ctx.marketStats || {}, filters, { scope: 'filtered' });
    if (market.length) lines.push(market.join('\n'));
  }

  return stripExposedUrlsFromReply(lines.filter(Boolean).join('\n\n').replace(/\n\n+/g, '\n\n'));
}

function situationActionChips(ctx = {}) {
  const filters = ctx.filters || {};
  const opts = [];
  const nearby = Array.isArray(ctx.nearbyInventory) ? ctx.nearbyInventory.filter((item) => item.count > 0) : [];
  const residential = requiresBedroomsForSearch(filters);
  if (ctx.outcome === SEARCH_OUTCOME.MATCHES_FOUND) {
    opts.push('Change budget');
    if (residential) opts.push('Change bedrooms');
    if (nearby.length) opts.push('Nearby areas');
    return opts;
  }
  if (residential) opts.push('Change bedrooms');
  opts.push('Change budget');
  opts.push('Property type');
  if (nearby.length) opts.push('Nearby areas');
  return opts.filter((v, i, arr) => arr.indexOf(v) === i);
}

async function probeSameAreaBedroomCounts(filters = {}) {
  if (!requiresBedroomsForSearch(filters) || !hasLocationConstraint(filters)) return [];
  const typeWord = describeTypePhrase(filters, 2);
  const current = isBedroomsSet(filters.bedrooms) ? Number(filters.bedrooms) : null;
  const candidates = [0, 1, 2, 3, 4].filter((n) => n !== current);
  const rows = await Promise.all(
    candidates.map(async (n) => {
      const test = copySearchFilters(filters);
      applyBedroomChoice(test, n === 4 ? { min: 4 } : { exact: n });
      const count = await countByFilters(test, test.location);
      return { bedrooms: n, count, label: bedroomCountLabel(n, typeWord) };
    })
  );
  return rows.filter((row) => row.count > 0).sort((a, b) => b.count - a.count);
}

async function probeSameAreaTypeTotal(filters = {}) {
  if (!hasLocationConstraint(filters)) return 0;
  const anyBeds = copySearchFilters(filters);
  anyBeds.bedrooms = null;
  anyBeds.bedroomsMin = null;
  anyBeds.bedroomsAny = true;
  anyBeds.bedroomsResolved = true;
  anyBeds.budgetMin = null;
  anyBeds.budgetMax = null;
  return countByFilters(anyBeds, anyBeds.location);
}

async function probeNearbyInventory(filters = {}) {
  if (!hasLocationConstraint(filters)) return [];
  const areas = nearbyAreaOptions(filters.location);
  const probed = await Promise.all(
    areas.slice(0, 4).map(async (name) => {
      const exact = copySearchFilters(filters);
      exact.location = name;
      const count = await countByFilters(exact, name);
      return { name, count, readyCount: 0, offPlanCount: 0 };
    })
  );
  return probed.filter((row) => row.count > 0).sort((a, b) => b.count - a.count).slice(0, 3);
}

async function buildSearchResponseContext(effectiveFilters, {
  outcome,
  propertyCards = [],
  total = 0,
  previousFilters = {},
  stats = null,
  overallStats = null,
  unconstrainedMatchCount = null,
  marketStatsScope = null,
  userMessage = '',
} = {}) {
  const searchState = canonicalSearchState(effectiveFilters);
  const searchUrl = buildListingSearchUrl(effectiveFilters);
  const changes = searchChangeSummary(previousFilters, effectiveFilters);
  const acknowledgement = buildSearchAcknowledgement(effectiveFilters, {
    previous: previousFilters,
    message: userMessage,
  });
  let marketStats = sanitizeMarketStats(stats || {}, effectiveFilters.purpose);
  let overallMarketStats = sanitizeMarketStats(overallStats || {}, effectiveFilters.purpose);
  let scope = marketStatsScope;
  let unconstrainedCount = Number.isFinite(Number(unconstrainedMatchCount))
    ? Number(unconstrainedMatchCount)
    : null;

  if (outcome === SEARCH_OUTCOME.MATCHES_FOUND) {
    if (!stats) {
      try {
        marketStats = sanitizeMarketStats(await getSegmentMarketStats(effectiveFilters), effectiveFilters.purpose);
      } catch {
        marketStats = {};
      }
    }
    scope = scope || 'filtered';
    const [nearbyInventory, inventoryCounts] = await Promise.all([
      probeNearbyInventory(effectiveFilters),
      probeAlternativeInventory(effectiveFilters, { currentTotal: total }),
    ]);
    const context = {
      outcome,
      searchState,
      filters: copySearchFilters(effectiveFilters),
      changes,
      acknowledgement,
      exactMatchCount: Number.isFinite(Number(total)) ? Number(total) : 0,
      exactListings: propertyCards.slice(0, 3),
      marketStats,
      overallMarketStats,
      marketStatsScope: scope,
      unconstrainedMatchCount: unconstrainedCount,
      nearbyInventory,
      inventoryCounts,
      sameAreaAlternatives: {},
      searchUrl,
    };
    context.presentation = buildSearchPresentation(context);
    return context;
  }

  if (!stats && outcome !== SEARCH_OUTCOME.BUDGET_TOO_LOW) {
    try {
      marketStats = sanitizeMarketStats(await getSegmentMarketStats(effectiveFilters), effectiveFilters.purpose);
    } catch {
      marketStats = {};
    }
  }
  if (outcome === SEARCH_OUTCOME.BUDGET_TOO_LOW) {
    marketStats = {};
    if (!overallStats) {
      try {
        overallMarketStats = sanitizeMarketStats(
          await getSegmentMarketStats(effectiveFilters, { ignoreBudget: true }),
          effectiveFilters.purpose
        );
      } catch {
        overallMarketStats = {};
      }
    }
    if (unconstrainedCount == null) {
      unconstrainedCount = Number(overallMarketStats.matchingCount) || 0;
    }
    scope = 'overall';
  }

  const [byBedrooms, totalInArea, nearbyInventory, inventoryCounts] = await Promise.all([
    probeSameAreaBedroomCounts(effectiveFilters),
    probeSameAreaTypeTotal(effectiveFilters),
    probeNearbyInventory(effectiveFilters),
    probeAlternativeInventory(effectiveFilters, { currentTotal: 0 }),
  ]);

  const context = {
    outcome,
    searchState,
    filters: copySearchFilters(effectiveFilters),
    changes,
    acknowledgement,
    exactMatchCount: 0,
    exactListings: [],
    marketStats,
    overallMarketStats,
    marketStatsScope: scope,
    unconstrainedMatchCount: unconstrainedCount,
    sameAreaAlternatives: { totalInArea, byBedrooms },
    nearbyInventory,
    inventoryCounts,
    searchUrl,
  };
  context.presentation = buildSearchPresentation(context);
  return context;
}

async function emptyResultsResult(effectiveFilters, { previousFilters = {}, userMessage = '' } = {}) {
  const location = (effectiveFilters.location || '').toString().trim();
  const hasBudgetCap =
    budgetNumber(effectiveFilters.budgetMax) != null || budgetNumber(effectiveFilters.budgetMin) != null;
  const unconstrainedStats = hasBudgetCap
    ? await getSegmentMarketStats(effectiveFilters, { ignoreBudget: true })
    : null;
  const budgetTooLow = hasBudgetCap && (unconstrainedStats?.totalAvailable || 0) > 0;
  const outcome = budgetTooLow ? SEARCH_OUTCOME.BUDGET_TOO_LOW : SEARCH_OUTCOME.NO_INVENTORY;
  const context = await buildSearchResponseContext(effectiveFilters, {
    outcome,
    previousFilters,
    stats: undefined,
    overallStats: unconstrainedStats || undefined,
    unconstrainedMatchCount: unconstrainedStats?.totalAvailable ?? null,
    marketStatsScope: budgetTooLow ? 'overall' : null,
    userMessage,
  });
  const locationEmpty = !!location && (context.sameAreaAlternatives?.totalInArea || 0) === 0;
  const alternatives = await buildAlternativeChips(effectiveFilters, { nearbyOnly: locationEmpty });
  const reply = composeSearchReply(context);
  let options;
  let slotAwaiting = 'emptyResults';
  if (budgetTooLow) {
    options = budgetTooLowOptions(effectiveFilters);
  } else if (alternatives.length > 0) {
    options = alternatives.map((a) => a.label);
    slotAwaiting = 'alternatives';
  } else {
    options = situationActionChips(context);
    if (!options.length) options = dropNearbyIfEmpty(noInventoryOptions(effectiveFilters), context.nearbyInventory);
  }

  const result = {
    propertyCards: [],
    sources: [],
    leadCaptured: false,
    profilePatch: {
      ...profilePatchFromPropertyFilters(effectiveFilters),
      lastSearchFilters: effectiveFilters,
      slotFlow: { awaiting: slotAwaiting, alternatives: alternatives.length ? JSON.stringify(alternatives) : null },
    },
    viewAllMatching: null,
    effectiveFilters,
    needsEmptyResults: true,
    searchOutcome: outcome,
    intent: purposeToIntent(effectiveFilters.purpose),
    inventoryCounts: context.inventoryCounts || null,
    alternativeInventory: (context.presentation || buildSearchPresentation(context))?.alternativeInventory || null,
    marketStats: context.marketStats || null,
    overallMarketStats: context.overallMarketStats || null,
    marketStatsScope: context.marketStatsScope || null,
    searchState: context.searchState || null,
    resultCount: 0,
    responseContext: context,
    presentation: buildSearchPresentation(context),
    clarificationReply: reply,
    options: withOffPlanExploreOption(
      options.length > 0 ? options : dropNearbyIfEmpty(noInventoryOptions(effectiveFilters), context.nearbyInventory),
      context
    ),
    ...emptyResultsClarificationFields(),
    modelPayload: {
      count: 0,
      needsEmptyResults: true,
      searchOutcome: outcome,
      requestedLocation: location || null,
      locationEmpty,
      responseContext: llmSafeSearchContext(context),
      instruction:
        'Use only responseContext for factual claims. exactMatchCount / resultCount is the filtered query total — never invent counts. If marketStatsScope is overall, those prices are across all budgets for the same listing mode, location, type, and bedrooms. Do not invent listings, prices, inventory counts, ROI, nearby locations, or amenities. Rephrase naturally from this structured data. Never print raw URLs.',
    },
  };
  result.suggestedActions = result.options || [];
  return result;
}

async function exhaustedResultsResult(effectiveFilters, { shownCount = 0, excludeRefNos = [] } = {}) {
  const hasBudgetCap =
    Number.isFinite(Number(effectiveFilters.budgetMax)) || Number.isFinite(Number(effectiveFilters.budgetMin));
  const stats = await getSegmentMarketStats(effectiveFilters, { excludeRefNos });
  const additionalInventory = (stats.totalAvailable || 0) > 0;
  const budgetIsLimiter =
    hasBudgetCap &&
    additionalInventory &&
    Number.isFinite(Number(stats.minimumPrice)) &&
    Number.isFinite(Number(effectiveFilters.budgetMax)) &&
    Number(stats.minimumPrice) > Number(effectiveFilters.budgetMax);
  const outcome =
    additionalInventory && hasBudgetCap ? SEARCH_OUTCOME.EXACT_RESULTS_EXHAUSTED : SEARCH_OUTCOME.NO_SEGMENT_INVENTORY;
  const context = await buildSearchResponseContext(effectiveFilters, { outcome, stats });
  const reply =
    outcome === SEARCH_OUTCOME.EXACT_RESULTS_EXHAUSTED
      ? composeSearchReply(context)
      : noAdditionalSegmentReply(effectiveFilters);
  const options = dropNearbyIfEmpty(
    outcome === SEARCH_OUTCOME.EXACT_RESULTS_EXHAUSTED
      ? exactResultsExhaustedOptions(effectiveFilters)
      : noAdditionalSegmentOptions(effectiveFilters),
    context.nearbyInventory
  );

  return {
    propertyCards: [],
    sources: [],
    leadCaptured: false,
    profilePatch: {
      ...profilePatchFromPropertyFilters(effectiveFilters),
      lastSearchFilters: effectiveFilters,
      slotFlow: { awaiting: 'emptyResults', alternatives: null },
    },
    viewAllMatching: null,
    effectiveFilters,
    needsEmptyResults: true,
    searchOutcome: outcome,
    searchState: context.searchState || null,
    resultCount: 0,
    marketStats: stats,
    marketStatsScope: context.marketStatsScope || 'filtered',
    suggestedActions: options,
    responseContext: context,
    presentation: context.presentation || buildSearchPresentation(context),
    clarificationReply: reply,
    options,
    ...emptyResultsClarificationFields(),
    modelPayload: {
      count: 0,
      needsEmptyResults: true,
      exhausted: true,
      budgetIsLimiter,
      searchOutcome: outcome,
      shownCount,
      marketStats: stats,
      responseContext: llmSafeSearchContext(context),
      instruction:
        'Use only responseContext for factual claims. Do not invent listings, prices, inventory counts, ROI, nearby locations, or amenities. Never print raw URLs.',
    },
  };
}

async function searchProperties(
  filters = {},
  { lastSearchFilters, slotFlow, userMessage, intent, shownPropertyIds = [], previousSearch } = {}
) {
  const lockedIntent = normalizeIntentValue(intent);
  const showMore = isShowMoreRequest(userMessage);
  if (shouldSkipPropertySearch(userMessage) && !showMore) {
    return {
      propertyCards: [],
      sources: [],
      leadCaptured: false,
      profilePatch: {},
      viewAllMatching: null,
      modelPayload: {
        skipped: true,
        count: 0,
        instruction:
          'The visitor asked a general question, not for listings. Do not reuse lastSearchFilters. Call search_content if needed and answer the question. Do not write a no-results property message.',
      },
    };
  }
  if (isPropertyUiAction(userMessage) && !showMore) {
    return {
      propertyCards: [],
      sources: [],
      leadCaptured: false,
      profilePatch: {},
      viewAllMatching: null,
      modelPayload: {
        skipped: true,
        count: 0,
        instruction:
          'The visitor tapped a listing UI action. Do not restart Buy/Rent/bedroom questions. Do not call search_properties again unless they ask to change filters.',
      },
    };
  }
  if (
    slotFlow?.awaiting === 'sell' ||
    slotFlow?.awaiting === 'pmNeed' ||
    slotFlow?.awaiting === 'pmProperty' ||
    slotFlow?.awaiting === 'serviceContact' ||
    slotFlow?.awaiting === 'serviceLocation' ||
    lockedIntent === CONVERSATION_INTENTS.SELL_PROPERTY ||
    lockedIntent === CONVERSATION_INTENTS.PROPERTY_MANAGEMENT
  ) {
    return {
      propertyCards: [],
      sources: [],
      leadCaptured: false,
      profilePatch: {},
      viewAllMatching: null,
      modelPayload: {
        skipped: true,
        count: 0,
        instruction:
          'The visitor asked a general question, not for listings. Do not reuse lastSearchFilters. Call search_content if needed and answer the question. Do not write a no-results property message.',
      },
    };
  }

  const effectiveFilters = resolveEffectiveFilters(filters, lastSearchFilters);
  clearUntrustedBedrooms(effectiveFilters);

  if (!showMore) {
    const overlaid = applyMessageToSearchFilters(effectiveFilters, userMessage, {
      awaiting: slotFlow?.awaiting,
    });
    Object.assign(effectiveFilters, overlaid);
  }

  const purpose = trustedPurpose({
    lastSearchFilters,
    userMessage,
    slotFlow,
    intent: lockedIntent,
    effectiveFilters,
  });
  if (purpose) {
    effectiveFilters.purpose = purpose;
  }

  const resetShown = !!listingSearchResetPatch(lastSearchFilters, effectiveFilters).resetShownPropertyIds;

  const excludeIds = resetShown ? [] : uniqueIdList(shownPropertyIds);
  effectiveFilters.excludeRefNos = excludeIds;

  console.log(
    'PROPERTY_SEARCH_STATE',
    JSON.stringify({
      rawText: userMessage || '',
      previous: {
        location: lastSearchFilters?.location || null,
        locationAny: !!lastSearchFilters?.locationAny,
        type: lastSearchFilters?.type || null,
        purpose: lastSearchFilters?.purpose || null,
        bedrooms: lastSearchFilters?.bedrooms ?? null,
      },
      normalized: {
        location: effectiveFilters.location || null,
        locationAny: !!effectiveFilters.locationAny,
        type: effectiveFilters.type || null,
        types: typesFromFilters(effectiveFilters),
        purpose: purpose || effectiveFilters.purpose || null,
        category: searchCategory(effectiveFilters),
      },
      showMore,
      excludeCount: excludeIds.length,
    })
  );

  const missing = nextMissingListingSlot(effectiveFilters);
  const waitingOnBudget =
    !isBudgetProvided(effectiveFilters) &&
    (slotFlow?.awaiting === 'budget' || parseEmptyResultChoice(userMessage)?.budget);
  if (missing) {
    return missingSlotResult(missing, effectiveFilters, {
      previous: previousSearch || lastSearchFilters,
      message: userMessage,
    });
  }
  if (waitingOnBudget) {
    return missingSlotResult('budget', effectiveFilters, {
      previous: previousSearch || lastSearchFilters,
      message: userMessage,
    });
  }

  const search = hasLocationConstraint(effectiveFilters)
    ? String(effectiveFilters.location).trim()
    : '';
  console.log(
    'search_properties executing:',
    JSON.stringify({
      purpose,
      location: search || null,
      locationAny: !!effectiveFilters.locationAny,
      type: effectiveFilters.type || null,
      types: typesFromFilters(effectiveFilters),
      bedrooms: effectiveFilters.bedrooms ?? null,
      bedroomsMin: effectiveFilters.bedroomsMin ?? null,
      bedroomsAny: !!effectiveFilters.bedroomsAny,
      budgetMin: effectiveFilters.budgetMin ?? null,
      budgetMax: effectiveFilters.budgetMax ?? null,
      excludeCount: excludeIds.length,
    })
  );
  const { propertyCards, usedPurpose, total, remainingAfterExclude } = await fetchPropertyCards(
    effectiveFilters,
    search
  );
  effectiveFilters.purpose = usedPurpose;
  delete effectiveFilters.excludeRefNos;

  const pagination = searchPaginationMeta({
    total,
    remainingAfterExclude,
    returnedCount: propertyCards.length,
    shownCount: excludeIds.length,
  });
  console.log(
    'PROPERTY_SEARCH_RESULTS',
    JSON.stringify({
      filters: {
        location: search || null,
        type: effectiveFilters.type || null,
        purpose: usedPurpose || null,
      },
      returned: propertyCards.length,
      total: pagination.total,
      remaining: pagination.remaining,
      hasMore: pagination.hasMore,
    })
  );

  if (propertyCards.length === 0) {
    if (excludeIds.length && total > 0) {
      const exhausted = await exhaustedResultsResult(effectiveFilters, {
        shownCount: excludeIds.length,
        excludeRefNos: excludeIds,
      });
      console.log(
        'PROPERTY_SEARCH_ACTIONS',
        JSON.stringify({
          propertyType: effectiveFilters.type || null,
          category: searchCategory(effectiveFilters),
          actions: exhausted.options || [],
        })
      );
      return attachSearchPagination(exhausted, {
        total,
        returnedCount: 0,
        remaining: 0,
        hasMore: false,
        shownCount: excludeIds.length,
      });
    }
    const empty = await emptyResultsResult(effectiveFilters, {
      previousFilters: previousSearch || lastSearchFilters,
      userMessage,
    });
    console.log(
      'PROPERTY_SEARCH_ACTIONS',
      JSON.stringify({
        propertyType: effectiveFilters.type || null,
        category: searchCategory(effectiveFilters),
        actions: empty.options || [],
      })
    );
    return attachSearchPagination(empty, {
      total,
      returnedCount: 0,
      remaining: 0,
      hasMore: false,
      shownCount: excludeIds.length,
    });
  }

  const extraPayload = {
    requestedLocation: search || null,
    total: pagination.total,
    remaining: pagination.remaining,
    returnedCount: pagination.returnedCount,
    hasMore: pagination.hasMore,
    nextCursor: pagination.nextCursor,
  };
  const result = propertySearchResult(
    propertyCards,
    effectiveFilters,
    extraPayload,
    buildViewAllMatching(total, effectiveFilters)
  );
  result.effectiveFilters = effectiveFilters;
  result.searchOutcome = SEARCH_OUTCOME.MATCHES_FOUND;
  const canonicalFilters = copySearchFilters(effectiveFilters);
  canonicalFilters.purpose = usedPurpose || effectiveFilters.purpose;
  result.profilePatch = {
    ...(result.profilePatch || {}),
    lastSearchFilters: effectiveFilters,
    lastPropertyCards: propertyCards,
    shownPropertyIds: propertyCards.map((card) => card.id).filter(Boolean),
    resetShownPropertyIds: resetShown,
    slotFlow: { awaiting: null },
  };
  const context = await buildSearchResponseContext(canonicalFilters, {
    outcome: SEARCH_OUTCOME.MATCHES_FOUND,
    propertyCards,
    total,
    previousFilters: previousSearch || lastSearchFilters,
    userMessage,
  });
  effectiveFilters.location = canonicalFilters.location;
  effectiveFilters.locationAny = canonicalFilters.locationAny;
  result.responseContext = context;
  result.presentation = buildSearchPresentation(context);
  result.intent = purposeToIntent(effectiveFilters.purpose);
  result.searchState = context.searchState || null;
  result.resultCount = Number.isFinite(Number(total)) ? Number(total) : 0;
  result.marketStats = context.marketStats || null;
  result.marketStatsScope = context.marketStatsScope || 'filtered';
  result.inventoryCounts = context.inventoryCounts || null;
  result.alternativeInventory = result.presentation?.alternativeInventory || null;
  result.replyOverride =
    showMore && excludeIds.length > 0
      ? foundListingsReply(effectiveFilters, total, {
          isShowMore: true,
          newCount: propertyCards.length,
        })
      : composeSearchReply(context);
  const opts = withOffPlanExploreOption(
    !isBudgetProvided(effectiveFilters) && !showMore
      ? budgetOptionsForPurpose(effectiveFilters.purpose)
      : moreMatchesOptions(effectiveFilters, {
          hasMore: pagination.hasMore,
          nearbyCount: (context.nearbyInventory || []).length,
        }),
    context
  );
  if (opts.length) {
    result.options = opts;
    result.requiresClarification = true;
    result.select = PURPOSE_SELECT;
  }
  result.suggestedActions = result.options || [];
  result.modelPayload = {
    ...(result.modelPayload || {}),
    searchOutcome: SEARCH_OUTCOME.MATCHES_FOUND,
    responseContext: llmSafeSearchContext(context),
    presentation: result.presentation,
    instruction:
      'Authoritative structured search data. Write a concise natural reply using ONLY acknowledgement, resultSummary, alternativeInventory, and marketSnapshot min/average. resultCount / exactMatchCount is the filtered database total for the current listingMode only — never add off-plan into a READY_BUY total and never invent counts. Do not write a View all / See all / Browse all line — that is a separate UI action. Do not list individual properties, amenities, beds, baths, or listing links — those are property cards. Do not invent prices or counts. Do not re-ask known filters. Never print URLs.',
  };
  attachSearchPagination(result, pagination);
  console.log(
    'PROPERTY_SEARCH_ACTIONS',
    JSON.stringify({
      propertyType: effectiveFilters.type || null,
      category: searchCategory(effectiveFilters),
      actions: result.options || [],
      hasMore: result.hasMore,
    })
  );
  return result;
}

async function embedQuery(query) {
  const openai = getOpenAI();
  const model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  const response = await openai.embeddings.create({ model, input: query });
  return response.data[0].embedding;
}

async function searchContent({ query }) {
  const q = (query || '').toString().trim();
  if (!q) {
    return {
      propertyCards: [],
      sources: [],
      leadCaptured: false,
      profilePatch: {},
      modelPayload: { count: 0, chunks: [], error: 'query is required' },
    };
  }

  const queryVector = await embedQuery(q);
  const rows = await ChatbotKnowledge.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: 'embedding',
        queryVector,
        numCandidates: 80,
        limit: CONTENT_LIMIT,
      },
    },
    {
      $addFields: {
        score: { $meta: 'vectorSearchScore' },
      },
    },
    {
      $match: {
        sourceType: { $ne: 'property' },
        score: { $gte: VECTOR_MIN_SCORE },
      },
    },
    {
      $project: {
        _id: 0,
        sourceType: 1,
        title: 1,
        url: 1,
        content: 1,
        score: 1,
      },
    },
  ]);

  const ranked = rankRelatedContentSources(
    rows.map((row) => ({
      title: row.title,
      url: row.url,
      sourceType: row.sourceType,
    }))
  );

  const shortChunks = rows.map((row) => ({
    sourceType: row.sourceType,
    title: row.title,
    url: row.url,
    // Keep only a short excerpt so the model cannot dump a long blog into the reply.
    content: String(row.content || '').replace(/\s+/g, ' ').trim().slice(0, 420),
  }));

  return {
    propertyCards: [],
    sources: ranked,
    leadCaptured: false,
    profilePatch: {},
    modelPayload: {
      count: rows.length,
      chunks: shortChunks,
      instruction:
        "CRITICAL: Reply in AT MOST 2 short sentences (about 40 words total). Use only the key fact from the chunks that answers the visitor's LATEST question — do not drift into a previous topic from earlier in the chat. Do NOT write \"General guidance\". Do NOT expand, lecture, or list every detail. No bullet lists. Do not include URLs — related pages are buttons. End with one short question such as \"Would you like more details?\"",
    },
  };
}

function looksCollected(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  const lower = v.toLowerCase();
  if (['n/a', 'na', 'unknown', 'none', '-', '--', 'null', 'undefined'].includes(lower)) return false;
  if (lower.includes('example')) return false;
  return true;
}

async function captureLead({ name, phone, email, intent, whatsapp, emailOptional, phoneOptional }, sessionId, { leadAlreadyCaptured } = {}) {
  const contactPhone = looksCollected(phone) ? phone : whatsapp;
  const hasEmail = looksCollected(email);
  const hasPhone = looksCollected(contactPhone);
  const hasContactMethod = hasPhone || hasEmail;
  const hasFullDetails =
    looksCollected(name) &&
    looksCollected(intent) &&
    hasContactMethod &&
    (emailOptional || hasEmail) &&
    (phoneOptional || hasPhone);

  if (leadAlreadyCaptured) {
    return {
      propertyCards: [],
      sources: [],
      leadCaptured: true,
      profilePatch: { leadCaptured: true },
      modelPayload: { ok: true, alreadyCaptured: true },
    };
  }

  if (!hasFullDetails) {
    return {
      propertyCards: [],
      sources: [],
      leadCaptured: false,
      profilePatch: {},
      modelPayload: {
        ok: false,
        error: 'Missing real contact details. Ask the visitor for name, phone, and email — do not invent them.',
      },
    };
  }

  try {
    const lead = await Lead.create({
      name: String(name).trim(),
      phone: hasPhone ? String(contactPhone).trim() : '',
      email: hasEmail ? String(email).trim().toLowerCase() : '',
      intent: String(intent).trim(),
      sessionId,
    });

    return {
      propertyCards: [],
      sources: [],
      leadCaptured: true,
      profilePatch: { leadCaptured: true },
      modelPayload: { ok: true, id: String(lead._id) },
    };
  } catch (err) {
    console.error('captureLead failed:', err);
    return {
      propertyCards: [],
      sources: [],
      leadCaptured: false,
      profilePatch: {},
      modelPayload: {
        ok: false,
        error: 'Lead capture failed. Do not claim the request was routed or that an agent will contact the visitor.',
      },
    };
  }
}

async function executeTool(
  name,
  args,
  { sessionId, lastSearchFilters, leadAlreadyCaptured, slotFlow, userMessage, intent, shownPropertyIds, previousSearch } = {}
) {
  if (name === 'search_properties') {
    return searchProperties(args || {}, {
      lastSearchFilters,
      slotFlow,
      userMessage,
      intent,
      shownPropertyIds,
      previousSearch,
    });
  }
  if (name === 'search_content') return searchContent(args || {});
  if (name === 'capture_lead') {
    const argsCopy = { ...(args || {}) };
    const emailOptional = !!argsCopy.emailOptional;
    const phoneOptional = !!argsCopy.phoneOptional;
    delete argsCopy.emailOptional;
    delete argsCopy.phoneOptional;
    return captureLead({ ...argsCopy, emailOptional, phoneOptional }, sessionId, { leadAlreadyCaptured });
  }
  return {
    propertyCards: [],
    sources: [],
    leadCaptured: false,
    profilePatch: {},
    modelPayload: { error: `Unknown tool: ${name}` },
    viewAllMatching: null,
  };
}

module.exports = {
  TOOL_DEFINITIONS,
  executeTool,
  PURPOSE_OPTIONS,
  COMMERCIAL_PURPOSE_OPTIONS,
  PURPOSE_SELECT,
  BEDROOM_OPTIONS,
  PROPERTY_TYPE_OPTIONS,
  BUY_BUDGET_OPTIONS,
  RENT_BUDGET_OPTIONS,
  SELL_OPTIONS,
  SELL_TYPE_OPTIONS,
  SELL_SERVICE_LOCATION_OPTIONS,
  PM_NEED_OPTIONS,
  CONVERSATION_INTENTS,
  LISTING_MODES,
  emptySearchFilters,
  copySearchFilters,
  emptyViewingRequest,
  copyViewingRequest,
  emptyServiceInquiry,
  copyServiceInquiry,
  seedServiceInquiry,
  parseServiceContactDetails,
  serviceContactReply,
  propertyManagementIntroReply,
  serviceContactPromptBlock,
  buildServiceLeadIntent,
  shouldCaptureServiceLead,
  hasServiceContact,
  isServiceInquiryMessage,
  matchesServiceInquiryPhrase,
  parsePmNeedChoice,
  pmNeedReply,
  pmPropertyReply,
  hasPmPropertyContext,
  applyPmPropertyDetails,
  parseConversationIntent,
  currentConversationIntent,
  isExplicitIntentStarter,
  isPurposeChipReply,
  isListingIntent,
  purposeToIntent,
  intentToPurpose,
  normalizeIntentValue,
  startFreshIntent,
  listingStartReply,
  listingStartOptions,
  listingIntakeReply,
  needsListingIntake,
  applyMessageToSearchFilters,
  extractSearchPatch,
  mergeSearchPatch,
  isExplicitSearchReset,
  isCurrentListingReference,
  buildListingSearchUrl,
  composeSearchReply,
  stripExposedUrlsFromReply,
  toPropertyCard,
  viewAllCtaLabel,
  buildSearchPresentation,
  canonicalSearchState,
  listingModeFromPurpose,
  listingModeFromFilters,
  buildSearchAcknowledgement,
  joinAckAndQuestion,
  describeLookingForPhrase,
  parsePropertyTypesFromMessage,
  parseOtherCustomType,
  mergePropertyTypes,
  typesFromFilters,
  applyTypesToFilters,
  isResidentialPropertyType,
  isCommercialPropertyType,
  requiresBedroomsForSearch,
  normalizeSearchProfileAfterPatch,
  getRequiredSearchFields,
  getMissingSearchFields,
  isPropertyCategoryChange,
  purposeOptionsForFilters,
  isShowMoreRequest,
  hasActiveListingSearch,
  hasInProgressListingSearch,
  shouldResetOnListingIntent,
  filtersFromRequestBody,
  uniqueIdList,
  listingQueryOpts,
  resolveEffectiveFilters,
  parseFurnishedFromMessage,
  parseOccupancyFromMessage,
  parseSellIntent,
  isSellCta,
  isAlreadySharedDetails,
  parseSellListingDetails,
  sellClarificationReply,
  sellFlowOptions,
  isSellServiceTransitionQuery,
  isMultiPropertyServiceQuery,
  parseSellServiceLocationChoice,
  sellServiceLocationReply,
  advanceSellListing,
  emptySellListing,
  copySellListing,
  parseContactDetails,
  parseViewingContactDetails,
  viewingMissingContactFields,
  isBookViewingAction,
  isBookViewingRequest,
  isViewingClosePhrase,
  isListingSearchOverride,
  parseViewingPreference,
  applyViewingRequestFlow,
  finalizeViewingCapture,
  viewingSuccessReply,
  viewingFailureReply,
  viewingCompleteOptions,
  viewingCloseReply,
  viewingContactPrompt,
  logViewingDebug,
  VIEWING_TIME_OPTIONS,
  VIEWING_NEUTRAL_OPTIONS,
  VIEWING_WEEKEND_OPTIONS,
  resolveSelectedViewingProperty,
  buildViewingLeadIntent,
  missingSellContactFields,
  hasSellContact,
  buildSellLeadIntent,
  shouldCaptureSellLead,
  persistSellListing,
  normalizePurpose,
  parsePurposeFromMessage,
  parseBedroomsFromMessage,
  parseBedroomChoice,
  applyBedroomChoice,
  isBedroomsSet,
  isBedroomsResolved,
  isBedroomSkip,
  isAmbiguousListingQuery,
  isListingFollowUp,
  isGeneralKnowledgeQuery,
  isContentKnowledgeTopic,
  isNonPlaceLocationToken,
  shouldSkipPropertySearch,
  isVagueConfirm,
  normalizePropertyType,
  parseLocationFromMessage,
  parseLocationReply,
  wantsDifferentLocation,
  isUnrestrictedLocationPhrase,
  hasLocationConstraint,
  locationClarificationReply,
  parseDesiredPropertyType,
  parsePropertyTypeChange,
  parseAlternativeChip,
  parseBudgetFromMessage,
  applyBudgetChoice,
  parseEmptyResultChoice,
  emptyResultOptions,
  emptyResultsReply,
  locationEmptyNearbyReply,
  nearbyAreaOptions,
  matchesNamedOption,
  foundListingsReply,
  purposeClarificationReply,
  bedroomsClarificationReply,
  rankRelatedContentSources,
  isHomepageUrl,
  isPropertyUiAction,
  SEARCH_OUTCOME,
  formatAed,
  budgetTooLowReply,
  budgetTooLowOptions,
  noInventoryReply,
  noInventoryOptions,
  getSegmentMarketStats,
  nextMissingListingSlot,
  isBudgetProvided,
  listingSlotQuestion,
  listingSearchResetPatch,
  qualifyListingSearch,
  BUY_BUDGET_OPTIONS,
  RENT_BUDGET_OPTIONS,
  PROPERTY_TYPE_OPTIONS,
  budgetClarificationReply,
  propertyTypeClarificationReply,
  moreMatchesOptions,
  exactResultsExhaustedOptions,
  exactResultsExhaustedReply,
  noAdditionalSegmentOptions,
  noAdditionalSegmentReply,
  noMoreExactOptions: exactResultsExhaustedOptions,
  noMoreExactMatchesReply: exactResultsExhaustedReply,
};
