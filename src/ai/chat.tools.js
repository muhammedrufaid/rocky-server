const OpenAI = require('openai');
const propertyDbService = require('../services/propertyDbService');
const { Lead, ChatbotKnowledge } = require('./chat.models');

const VECTOR_INDEX_NAME = process.env.CHATBOT_VECTOR_INDEX || 'chatbot_knowledge_vector_index';
const VECTOR_MIN_SCORE = Number(process.env.CHAT_VECTOR_MIN_SCORE) || 0.75;
const CONTENT_LIMIT = 3;
const PROPERTY_LIMIT = 6;

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_properties',
      description:
        'Search live Rocky listings. Use for buy, rent, or off-plan requests and when offering matching properties. purpose is Buy, Rent, or Off-plan — never guess it. Omit purpose only when lastSearchFilters.purpose / the visitor profile already has one (the server merges it). If purpose is not known, still call this tool WITHOUT purpose so the server can show a single-select Buy / Rent / Off-plan prompt — do not write that question yourself and do not ask about bedrooms in that turn. NEVER invent bedrooms or budget. Only pass bedrooms or budgetMin/budgetMax if the visitor actually stated them in this conversation. The server ignores guessed bedroom counts and guessed budgets. Do not call this again with a nearby area after count 0 — the server offers explicit chips. Never claim listings exist unless this tool returned at least one result.',
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
            description: 'Property type (Apartment, Villa, Townhouse, Office, etc.).',
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
        'Search Rocky website content (blogs, area guides, FAQs, services). Use for company, area, process, and service questions. Do not use this for live listing prices or availability.',
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
  const q = (filters.location || '').toString().trim();
  if (q) params.set('q', q);
  if (filters.type) params.set('type', String(filters.type).trim());
  if (filters.bedrooms !== undefined && filters.bedrooms !== null && filters.bedrooms !== '') {
    params.set('beds', String(filters.bedrooms));
  }
  if (filters.budgetMin !== undefined && filters.budgetMin !== null && filters.budgetMin !== '') {
    params.set('min', String(filters.budgetMin));
  }
  if (filters.budgetMax !== undefined && filters.budgetMax !== null && filters.budgetMax !== '') {
    params.set('max', String(filters.budgetMax));
  }
  const qs = params.toString().replace(/\+/g, '%20');
  return `${frontendBase()}/properties/${path}${qs ? `?${qs}` : ''}`;
}

function buildViewAllMatching(total, filters) {
  if (!Number.isFinite(total) || total <= PROPERTY_LIMIT) return null;
  return {
    total,
    url: buildListingSearchUrl(filters),
    label: `View all ${total} matching properties`,
  };
}

function toPropertyCard(property) {
  const size = (property.propertySize || '').toString().trim();
  const unit = (property.propertySizeUnit || '').toString().trim();
  return {
    id: property.propertyRefNo,
    title: property.propertyTitle || '',
    price: property.price || '',
    beds: property.bedrooms || '',
    baths: property.bathrooms || '',
    area: [size, unit].filter(Boolean).join(' '),
    imageUrl: Array.isArray(property.images) && property.images[0] ? property.images[0] : '',
    listingUrl: buildListingUrl(property),
  };
}

const PURPOSE_OPTIONS = ['Buy', 'Rent', 'Off-plan'];
const PURPOSE_SELECT = 'single';
const BEDROOM_OPTIONS = ['Studio', '1 BR', '2 BR', '3 BR', '4+ BR', 'Any'];

function normalizePurpose(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase();
  if (v === 'rent' || v === 'rental' || v === 'lease') return 'Rent';
  if (v === 'buy' || v === 'sale' || v === 'sell' || v === 'purchase') return 'Buy';
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

function parsePurposeFromMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const exact = normalizePurpose(raw);
  if (exact) return exact;

  const lower = raw.toLowerCase().replace(/[.!?]/g, '').trim();
  const collapsed = lower.replace(/[\s_-]+/g, '');
  if (collapsed === 'offplan' || collapsed === 'offplanproperties') return 'Off-plan';
  if (/off[\s-_]*plan/.test(lower)) return 'Off-plan';

  if (
    /^(i\s+(want\s+to\s+|would\s+like\s+to\s+)?|i'?d\s+like\s+to\s+|looking\s+to\s+|looking\s+for\s+)?(buy|purchase|sale|sell)\b/.test(
      lower
    ) &&
    !/\brent\b|\blease\b|off[\s-_]*plan/.test(lower)
  ) {
    return 'Buy';
  }
  if (
    /^(i\s+(want\s+to\s+|would\s+like\s+to\s+)?|i'?d\s+like\s+to\s+|looking\s+to\s+|looking\s+for\s+)?(rent|rental|lease)\b/.test(
      lower
    ) &&
    !/\bbuy\b|\bpurchase\b|off[\s-_]*plan/.test(lower)
  ) {
    return 'Rent';
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
  if (filters.bedroomsResolved === true || filters.bedroomsAny === true) return filters;
  filters.bedrooms = null;
  filters.bedroomsMin = null;
  filters.bedroomsAny = false;
  filters.bedroomsResolved = false;
  return filters;
}

function applyBudgetChoice(filters, choice) {
  if (!filters || !choice) return filters;
  if (choice.any) {
    filters.budgetMin = null;
    filters.budgetMax = null;
    return filters;
  }
  if (choice.budgetMin != null) filters.budgetMin = choice.budgetMin;
  if (choice.budgetMax != null) filters.budgetMax = choice.budgetMax;
  return filters;
}

function parseBudgetFromMessage(text, { requireBudgetContext = false } = {}) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/,/g, '');
  if (!raw) return null;

  if (/^(any|skip|none|no preference|doesn'?t matter|no limit|no budget)$/.test(raw)) {
    return requireBudgetContext ? { any: true } : null;
  }

  const bedroomLike = parseBedroomChoice(raw);
  const mentionsMoney = /(budget|aed|million|thousand|\bm\b|\bk\b|dirham)/.test(raw);
  if (bedroomLike && !mentionsMoney) return null;

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
  if (n == null && (under || mentionsMoney || requireBudgetContext)) {
    const plain = raw.match(/\b(\d{4,9})\b/);
    if (plain) n = Number(plain[1]);
  }

  if (!Number.isFinite(n) || n <= 0) return null;
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
  const n = Number(filters.bedrooms);
  if (n === 0) return 'studio ';
  if (Number.isFinite(n)) return `${n}-bedroom `;
  return '';
}

function describeTypePhrase(filters = {}) {
  const t = String(filters.type || '').trim();
  if (!t) return 'properties';
  const lower = t.toLowerCase();
  if (lower.endsWith('s')) return lower;
  return `${lower}s`;
}

function foundListingsReply(filters = {}, total = 0) {
  const loc = (filters.location || '').toString().trim();
  const beds = describeBedroomPhrase(filters);
  const type = describeTypePhrase(filters);
  const count = Number.isFinite(Number(total)) ? Number(total) : 0;
  let purposeBit = 'for sale';
  if (filters.purpose === 'Rent') purposeBit = 'to rent';
  if (filters.purpose === 'Off-plan') purposeBit = 'off-plan';
  const area = loc ? ` in ${loc}` : '';
  const purposeSuffix = filters.purpose === 'Off-plan' ? '' : ` ${purposeBit}`;
  return `I found ${count} ${beds}${type}${area}${purposeSuffix}. Would you like the details?`
    .replace(/\s+/g, ' ')
    .trim();
}

function emptyResultsReply(filters = {}) {
  const loc = (filters.location || 'that area').toString().trim() || 'that area';
  return `I couldn't find matching ${describeBedroomPhrase(filters)}${describeTypePhrase(filters)} in ${loc}.`;
}

function emptyResultOptions(filters = {}) {
  const opts = [];
  const n = Number(filters.bedrooms);
  const min = Number(filters.bedroomsMin);
  if (min >= 4 || n >= 4) opts.push('Try 3 BR');
  else if (n === 3) opts.push('Try 2 BR');
  else if (n === 2) opts.push('Try 1 BR');
  else if (n === 1) opts.push('Try Studio');
  opts.push('Nearby areas', 'Change budget');
  return opts;
}

const NEARBY_AREA_MAP = [
  { match: /dubai hills/i, areas: ['Arabian Ranches', 'Town Square', 'The Springs'] },
  { match: /dubai south|dwc/i, areas: ['Dubai Investment Park', 'Jebel Ali', 'Discovery Gardens'] },
  { match: /marina/i, areas: ['JBR', 'Palm Jumeirah'] },
  { match: /downtown/i, areas: ['Business Bay', 'DIFC'] },
  { match: /jvc|jumeirah village circle/i, areas: ['JVT', 'Dubai Sports City'] },
  { match: /arabian ranches/i, areas: ['Dubai Hills', 'Mudon', 'Town Square'] },
  { match: /palm jumeirah/i, areas: ['Dubai Marina', 'JBR'] },
  { match: /business bay/i, areas: ['Downtown Dubai', 'DIFC'] },
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
  if (/^change budget$/i.test(raw)) return { budget: true };
  const tryBr = raw.match(/^try\s+(.+)$/i);
  if (tryBr) {
    const choice = parseBedroomChoice(tryBr[1]);
    if (choice) return { bedrooms: choice };
  }
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

  const wordBed = raw.match(/\b(one|two|three|four|five|six)\s*-?\s*(bed|br|bedroom)s?\b/);
  if (wordBed) return { exact: words[wordBed[1]] };

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 12) return { exact: n };
  }

  const numbered = raw.match(/\b(\d+)\s*-?\s*(bed|br|bedroom)s?\b/);
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
  { canonical: 'Apartment', patterns: /\b(apartment|apartments|flat|flats|condo|condos|unit|units)\b/ },
  { canonical: 'Villa', patterns: /\b(villa|villas)\b/ },
  { canonical: 'Townhouse', patterns: /\b(townhouse|townhouses|town house|town houses)\b/ },
  { canonical: 'Penthouse', patterns: /\b(penthouse|penthouses)\b/ },
  { canonical: 'Duplex', patterns: /\b(duplex|duplexes)\b/ },
  { canonical: 'Studio', patterns: /\b(studio apartment|studio unit)\b/ },
  { canonical: 'Office', patterns: /\b(office|offices|commercial)\b/ },
];

function normalizePropertyType(raw) {
  const lower = String(raw || '').trim().toLowerCase();
  for (const entry of PROPERTY_TYPE_MAP) {
    if (entry.patterns.test(lower)) return entry.canonical;
  }
  return null;
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

  // Reject pure bedroom/purpose/vague-confirm phrases that happen to contain a type word
  if (parseBedroomChoice(raw)) return null;
  if (parsePurposeFromMessage(raw)) return null;
  if (isVagueConfirm(raw)) return null;

  // Explicit change-intent patterns — must appear before the type noun
  const changePrefix =
    /\b(i\s+(need|want|prefer|would\s+like|('d\s+like)|am\s+looking\s+for)|show\s+(me\s+)?(the\s+)?|give\s+me|find\s+me|search\s+(for\s+)?|change\s+(it\s+)?(to\s+)?|switch\s+(to\s+)?|actually\s+(i\s+(want|prefer|need)|show)|not\s+(villas?|apartments?|townhouses?|penthouses?)[\s,]+|instead[\s,]+show|show.*instead)\b/;

  if (!changePrefix.test(lower)) return null;

  for (const entry of PROPERTY_TYPE_MAP) {
    if (entry.patterns.test(lower)) return entry.canonical;
  }
  return null;
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

function purposeClarificationReply() {
  return 'What are you looking for?';
}

function bedroomsClarificationReply() {
  return 'How many bedrooms?';
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
  const locationProvided = isProvidedText(filters.location);
  const lastLocationSet = isProvidedText(last.location);
  const typeProvided = isProvidedText(filters.type);
  const lastTypeSet = isProvidedText(last.type);

  // A location change is a full new-intent reset (purpose/bedrooms unknown for the new location).
  const locationChanged = locationProvided && lastLocationSet && textsDiffer(filters.location, last.location);

  // A type-only change (same or no location, different type) preserves purpose/bedrooms/budget.
  const typeOnlyChanged =
    !locationChanged &&
    typeProvided &&
    lastTypeSet &&
    textsDiffer(filters.type, last.type);

  if (locationChanged) {
    return {
      location: coalesceFilter(filters.location, null),
      type: coalesceFilter(filters.type, null),
      bedrooms: null,
      bedroomsMin: null,
      bedroomsAny: false,
      bedroomsResolved: false,
      budgetMin: null,
      budgetMax: null,
      purpose: null,
    };
  }

  if (typeOnlyChanged) {
    return {
      location: coalesceFilter(filters.location, last.location),
      type: coalesceFilter(filters.type, null),
      bedrooms: last.bedrooms ?? null,
      bedroomsMin: last.bedroomsMin ?? null,
      bedroomsAny: last.bedroomsAny === true,
      bedroomsResolved: last.bedroomsResolved === true,
      budgetMin: last.budgetMin ?? null,
      budgetMax: last.budgetMax ?? null,
      purpose: last.purpose || null,
    };
  }

  return {
    location: coalesceFilter(filters.location, last.location),
    type: coalesceFilter(filters.type, last.type),
    bedrooms: last.bedrooms ?? null,
    bedroomsMin: last.bedroomsMin ?? null,
    bedroomsAny: last.bedroomsAny === true,
    bedroomsResolved: last.bedroomsResolved === true,
    budgetMin: last.budgetMin ?? null,
    budgetMax: last.budgetMax ?? null,
    purpose: last.purpose || null,
  };
}

function isAmbiguousListingQuery(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return false;
  if (parsePurposeFromMessage(raw)) return false;
  if (parseBedroomChoice(raw)) return false;
  // Property-type change phrases are refinements, not ambiguous new queries
  if (parsePropertyTypeChange(raw)) return false;
  return /\b(show|find|search|looking|apartments?|villas?|townhouses?|properties|homes?|listings?)\b/.test(raw);
}

function trustedPurpose({ lastSearchFilters = {}, userMessage, slotFlow } = {}) {
  const fromMessage = parsePurposeFromMessage(userMessage);
  if (fromMessage) return fromMessage;

  const lastPurpose = normalizePurpose(lastSearchFilters?.purpose);
  if (!lastPurpose) return null;

  if (slotFlow?.awaiting === 'bedrooms') return lastPurpose;
  if (parseBedroomChoice(userMessage)) return lastPurpose;
  // Property-type change is a refinement — keep stored purpose
  if (parsePropertyTypeChange(userMessage)) return lastPurpose;

  if (isAmbiguousListingQuery(userMessage)) return null;

  return lastPurpose;
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
  if (purpose) patch.purpose = purpose;
  return patch;
}

function listingQueryOpts(filters, search) {
  const queryFilters = {};
  if (!filters.bedroomsAny) {
    if (isBedroomsSet(filters.bedroomsMin)) {
      queryFilters.bedroomsMin = filters.bedroomsMin;
    } else if (filters.bedrooms !== undefined && filters.bedrooms !== null && filters.bedrooms !== '') {
      queryFilters.bedrooms = filters.bedrooms;
    }
  }
  if (filters.budgetMin !== undefined && filters.budgetMin !== null && filters.budgetMin !== '') {
    queryFilters.priceMin = filters.budgetMin;
  }
  if (filters.budgetMax !== undefined && filters.budgetMax !== null && filters.budgetMax !== '') {
    queryFilters.priceMax = filters.budgetMax;
  }
  if (filters.type) queryFilters.propertyType = filters.type;
  return { page: 1, limit: PROPERTY_LIMIT, search, filters: queryFilters };
}

async function fetchByPurpose(purpose, opts) {
  if (purpose === 'Rent') return propertyDbService.fetchRentProperties(opts);
  if (purpose === 'Off-plan') return propertyDbService.fetchOffPlanProperties(opts);
  if (purpose === 'Buy') return propertyDbService.fetchBuyProperties(opts);
  return { properties: [], total: 0 };
}

async function fetchPropertyCards(filters, search) {
  const opts = listingQueryOpts(filters, search);
  const requested = normalizePurpose(filters.purpose);
  if (!requested) {
    return { propertyCards: [], usedPurpose: null, total: 0 };
  }
  let result = await fetchByPurpose(requested, opts);
  let usedPurpose = requested;

  // If the model infers Rent and that inventory is empty, retry Buy with the same
  // location/beds/type/budget filters. Explicit Buy / Off-plan searches are unchanged.
  if (!(result.properties || []).length && requested === 'Rent') {
    const buyResult = await fetchByPurpose('Buy', opts);
    if ((buyResult.properties || []).length) {
      result = buyResult;
      usedPurpose = 'Buy';
    }
  }

  return {
    propertyCards: (result.properties || []).map(toPropertyCard),
    usedPurpose,
    total: result.total || 0,
  };
}

function propertySearchResult(propertyCards, filters, extraPayload = {}, viewAllMatching = null) {
  return {
    propertyCards,
    sources: [],
    leadCaptured: false,
    profilePatch: profilePatchFromPropertyFilters(filters),
    viewAllMatching,
    modelPayload: {
      count: propertyCards.length,
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

function purposeMissingResult(effectiveFilters) {
  return {
    propertyCards: [],
    sources: [],
    leadCaptured: false,
    profilePatch: {
      ...profilePatchFromPropertyFilters(effectiveFilters),
      slotFlow: { awaiting: 'purpose' },
    },
    viewAllMatching: null,
    effectiveFilters,
    needsPurpose: true,
    clarificationReply: purposeClarificationReply(),
    ...purposeClarificationFields(),
    modelPayload: {
      count: 0,
      needsPurpose: true,
      requestedLocation: (effectiveFilters.location || '').toString().trim() || null,
      instruction:
        'purpose is missing. Do not invent listings or assume Buy. The server will ask a single-select Buy / Rent / Off-plan question. Do not ask about bedrooms in this turn.',
    },
  };
}

function bedroomsMissingResult(effectiveFilters) {
  const location = (effectiveFilters.location || '').toString().trim();
  return {
    propertyCards: [],
    sources: [],
    leadCaptured: false,
    profilePatch: {
      ...profilePatchFromPropertyFilters(effectiveFilters),
      slotFlow: { awaiting: 'bedrooms' },
    },
    viewAllMatching: null,
    effectiveFilters,
    needsBedrooms: true,
    clarificationReply: bedroomsClarificationReply(),
    ...bedroomClarificationFields(),
    modelPayload: {
      count: 0,
      needsBedrooms: true,
      requestedLocation: location || null,
      instruction:
        'purpose is saved. Do not invent listings, bedroom defaults, or budgets. The server will ask how many bedrooms with chips. Do not write a bedroom question, do not suggest 2+ as a default, and do not ask about budget.',
    },
  };
}

function emptyResultsClarificationFields() {
  return {
    requiresClarification: true,
    select: PURPOSE_SELECT,
  };
}

function emptyResultsResult(effectiveFilters) {
  const location = (effectiveFilters.location || '').toString().trim();
  const options = emptyResultOptions(effectiveFilters);
  return {
    propertyCards: [],
    sources: [],
    leadCaptured: false,
    profilePatch: {
      ...profilePatchFromPropertyFilters(effectiveFilters),
      lastSearchFilters: effectiveFilters,
      slotFlow: { awaiting: 'emptyResults' },
    },
    viewAllMatching: null,
    effectiveFilters,
    needsEmptyResults: true,
    clarificationReply: emptyResultsReply(effectiveFilters),
    options,
    ...emptyResultsClarificationFields(),
    modelPayload: {
      count: 0,
      needsEmptyResults: true,
      requestedLocation: location || null,
      instruction:
        'No listings matched. Do not invent a budget, do not widen location, and do not claim nearby areas have results. The server will show explicit chips. Do not write a follow-up question.',
    },
  };
}

async function searchProperties(
  filters = {},
  { lastSearchFilters, slotFlow, userMessage } = {}
) {
  const effectiveFilters = resolveEffectiveFilters(filters, lastSearchFilters);
  clearUntrustedBedrooms(effectiveFilters);

  const bedChoice = parseBedroomChoice(userMessage);
  if (bedChoice) applyBedroomChoice(effectiveFilters, bedChoice);

  const budgetChoice = parseBudgetFromMessage(userMessage, {
    requireBudgetContext: slotFlow?.awaiting === 'budget',
  });
  if (budgetChoice) applyBudgetChoice(effectiveFilters, budgetChoice);

  const purpose = trustedPurpose({ lastSearchFilters, userMessage, slotFlow });
  effectiveFilters.purpose = purpose;

  console.log(
    'search_properties purpose gate:',
    JSON.stringify({
      toolPurpose: filters.purpose ?? null,
      trustedPurpose: purpose,
      lastPurpose: lastSearchFilters?.purpose ?? null,
      fromMessage: parsePurposeFromMessage(userMessage),
      toolBedrooms: filters.bedrooms ?? null,
      trustedBedrooms: effectiveFilters.bedrooms ?? null,
      bedroomsResolved: !!effectiveFilters.bedroomsResolved,
      toolBudgetMax: filters.budgetMax ?? null,
      trustedBudgetMax: effectiveFilters.budgetMax ?? null,
    })
  );

  if (!purpose) {
    return purposeMissingResult(effectiveFilters);
  }

  if (!isBedroomsResolved(effectiveFilters)) {
    return bedroomsMissingResult(effectiveFilters);
  }

  const search = (effectiveFilters.location || '').toString().trim();
  console.log(
    'search_properties executing:',
    JSON.stringify({
      purpose,
      location: search || null,
      type: effectiveFilters.type || null,
      bedrooms: effectiveFilters.bedrooms ?? null,
      bedroomsMin: effectiveFilters.bedroomsMin ?? null,
      bedroomsAny: !!effectiveFilters.bedroomsAny,
      budgetMin: effectiveFilters.budgetMin ?? null,
      budgetMax: effectiveFilters.budgetMax ?? null,
    })
  );
  const { propertyCards, usedPurpose, total } = await fetchPropertyCards(effectiveFilters, search);
  effectiveFilters.purpose = usedPurpose;

  if (propertyCards.length === 0) {
    return emptyResultsResult(effectiveFilters);
  }

  const extraPayload = {
    requestedLocation: search || null,
    total,
  };
  const result = propertySearchResult(
    propertyCards,
    effectiveFilters,
    extraPayload,
    buildViewAllMatching(total, effectiveFilters)
  );
  result.effectiveFilters = effectiveFilters;
  result.profilePatch = {
    ...(result.profilePatch || {}),
    slotFlow: { awaiting: null },
  };
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
        numCandidates: 50,
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

  const seen = new Set();
  const sources = [];
  for (const row of rows) {
    const key = row.url || row.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sources.push({ title: row.title, url: row.url });
  }

  return {
    propertyCards: [],
    sources,
    leadCaptured: false,
    profilePatch: {},
    modelPayload: {
      count: rows.length,
      chunks: rows.map((row) => ({
        sourceType: row.sourceType,
        title: row.title,
        url: row.url,
        content: row.content,
      })),
    },
  };
}

function looksCollected(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  const lower = v.toLowerCase();
  if (['n/a', 'na', 'unknown', 'none', 'test', 'asdf'].includes(lower)) return false;
  if (lower.includes('example')) return false;
  return true;
}

async function captureLead({ name, phone, email, intent }, sessionId, { leadAlreadyCaptured } = {}) {
  const hasFullDetails =
    looksCollected(name) && looksCollected(phone) && looksCollected(email) && looksCollected(intent);

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

  const lead = await Lead.create({
    name: String(name).trim(),
    phone: String(phone).trim(),
    email: String(email).trim().toLowerCase(),
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
}

async function executeTool(
  name,
  args,
  { sessionId, lastSearchFilters, leadAlreadyCaptured, slotFlow, userMessage } = {}
) {
  if (name === 'search_properties') {
    return searchProperties(args || {}, {
      lastSearchFilters,
      slotFlow,
      userMessage,
    });
  }
  if (name === 'search_content') return searchContent(args || {});
  if (name === 'capture_lead') {
    return captureLead(args || {}, sessionId, { leadAlreadyCaptured });
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
  PURPOSE_SELECT,
  BEDROOM_OPTIONS,
  normalizePurpose,
  parsePurposeFromMessage,
  parseBedroomsFromMessage,
  parseBedroomChoice,
  applyBedroomChoice,
  isBedroomsSet,
  isBedroomsResolved,
  isBedroomSkip,
  isAmbiguousListingQuery,
  isVagueConfirm,
  normalizePropertyType,
  parsePropertyTypeChange,
  parseBudgetFromMessage,
  applyBudgetChoice,
  parseEmptyResultChoice,
  emptyResultOptions,
  emptyResultsReply,
  nearbyAreaOptions,
  matchesNamedOption,
  foundListingsReply,
  purposeClarificationReply,
  bedroomsClarificationReply,
};
