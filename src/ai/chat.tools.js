const OpenAI = require('openai');
const propertyDbService = require('../services/propertyDbService');
const { Lead } = require('./chat.models');
const ChatbotKnowledge = require('../models/ChatbotKnowledge');

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
const SELL_OPTIONS = ['Get a valuation', 'Talk to an agent'];
const SELL_TYPE_OPTIONS = ['Apartment', 'Villa', 'Townhouse', 'Penthouse'];
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

const LISTING_INTENTS = new Set([
  CONVERSATION_INTENTS.BUY,
  CONVERSATION_INTENTS.RENT,
  CONVERSATION_INTENTS.OFF_PLAN,
]);

function emptySearchFilters() {
  return {
    location: null,
    bedrooms: null,
    bedroomsMin: null,
    bedroomsAny: false,
    bedroomsResolved: false,
    budgetMin: null,
    budgetMax: null,
    type: null,
    types: [],
    purpose: null,
    furnished: null,
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
  return {
    location: filters.location || null,
    bedrooms: filters.bedrooms ?? null,
    bedroomsMin: filters.bedroomsMin ?? null,
    bedroomsAny: !!filters.bedroomsAny,
    bedroomsResolved: !!filters.bedroomsResolved,
    budgetMin: filters.budgetMin ?? null,
    budgetMax: filters.budgetMax ?? null,
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

function parseContactDetails(text, current = {}) {
  const raw = String(text || '');
  const labeledName = raw.match(/\bname\s*[:\-]\s*([A-Za-z][A-Za-z\s.'-]{1,60}?)(?=\s*(?:email|phone|tel|whatsapp|,|$))/i);
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
    name = labeledName[1].trim();
  } else {
    const nameMatch = raw.match(/\b(?:my name is|i am|i'm)\s+([A-Za-z][A-Za-z\s.'-]{1,50})/i);
    if (nameMatch) {
      name = nameMatch[1].replace(/\s+(and|my|email|phone|whatsapp).*$/i, '').trim();
    } else if (emailMatch || phoneMatch || whatsappMatch) {
      const leftover = raw
        .replace(emailMatch ? emailMatch[0] : '', ' ')
        .replace(phoneMatch ? phoneMatch[0] : '', ' ')
        .replace(whatsappMatch ? whatsappMatch[0] : '', ' ')
        .replace(/\b(?:name|email|e-?mail|phone|tel|mobile|whatsapp)\s*[:\-]?\s*/gi, ' ')
        .replace(/[,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (
        leftover &&
        leftover.split(/\s+/).length <= 4 &&
        /^[A-Za-z][A-Za-z\s.'-]+$/.test(leftover) &&
        !/\b(villa|apartment|townhouse|barsha|dubai|sell|property|valuation|agent)\b/i.test(leftover)
      ) {
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

function parsePurposeFromMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (parseSellIntent(raw)) return null;
  const exact = normalizePurpose(raw);
  if (exact) return exact;

  const lower = raw.toLowerCase().replace(/[.!?]/g, '').trim();
  const collapsed = lower.replace(/[\s_-]+/g, '');
  if (collapsed === 'offplan' || collapsed === 'offplanproperties') return 'Off-plan';
  // "Off-plan financing / articles / can I sell off-plan…" are content, not listing purpose
  if (/off[\s-_]*plan/.test(lower)) {
    if (isOffPlanInformationalQuery(lower)) return null;
    return 'Off-plan';
  }

  // Buy: start-anchored intents + mid-sentence parity with Rent ("looking to buy", "for sale", "I'm…")
  if (
    !/\brent\b|\blease\b|off[\s-_]*plan/.test(lower) &&
    (/^(i\s+(want\s+to\s+|would\s+like\s+to\s+)?|i'?d\s+like\s+to\s+|i'?m\s+(looking\s+to\s+|looking\s+for\s+)?|i\s+am\s+(looking\s+to\s+|looking\s+for\s+)?|looking\s+to\s+|looking\s+for\s+)?(buy|purchase)\b/.test(
      lower
    ) ||
      /\b((?:i(?:'| a)?m|i\s+am)\s+)?looking\s+to\s+buy\b/.test(lower) ||
      /\b((?:i(?:'| a)?m|i\s+am)\s+)?looking\s+for\s+(?:a\s+|an\s+)?(?:to\s+)?buy\b/.test(lower) ||
      /\b(?:want|would\s+like|('d\s+like))\s+to\s+buy\b/.test(lower) ||
      /\b(?:want|would\s+like|('d\s+like))\s+to\s+purchase\b/.test(lower) ||
      /\bto\s+purchase\b/.test(lower) ||
      /\bfor\s+sale\b/.test(lower))
  ) {
    return 'Buy';
  }

  // Rent: same coverage including "I'm looking to rent" / "for rent" / "apartment to rent"
  if (
    !/\bbuy\b|\bpurchase\b|\bfor\s+sale\b|off[\s-_]*plan/.test(lower) &&
    (/^(i\s+(want\s+to\s+|would\s+like\s+to\s+)?|i'?d\s+like\s+to\s+|i'?m\s+(looking\s+to\s+|looking\s+for\s+)?|i\s+am\s+(looking\s+to\s+|looking\s+for\s+)?|looking\s+to\s+|looking\s+for\s+)?(rent|rental|lease)\b/.test(
      lower
    ) ||
      /\b((?:i(?:'| a)?m|i\s+am)\s+)?looking\s+to\s+rent\b/.test(lower) ||
      /\b((?:i(?:'| a)?m|i\s+am)\s+)?looking\s+for\b.{0,60}\b(to\s+rent|for\s+rent|rental)\b/.test(lower) ||
      /\b(?:want|would\s+like|('d\s+like))\s+to\s+rent\b/.test(lower) ||
      /\bneed\s+a\b.{0,40}\b(for\s+rent|to\s+rent)\b/.test(lower) ||
      /\b(apartment|villa|townhouse|penthouse|studio|flat|property|home)\s+to\s+rent\b/.test(lower) ||
      /\bfor\s+rent\b/.test(lower) ||
      /\bto\s+rent\b/.test(lower) ||
      /\bto\s+lease\b/.test(lower))
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
  const loc = (filters.location || '').toString().trim();
  const beds = describeBedroomPhrase(filters);
  const count = Number.isFinite(Number(total)) ? Number(total) : 0;
  const shownNow = Number.isFinite(Number(newCount)) && newCount > 0 ? newCount : count;
  const type = describeTypePhrase(filters, isShowMore ? shownNow : count);
  let purposeBit = 'for sale';
  if (filters.purpose === 'Rent') purposeBit = 'to rent';
  if (filters.purpose === 'Off-plan') purposeBit = 'off-plan';
  const area = loc ? ` in ${loc}` : '';
  const purposeSuffix = filters.purpose === 'Off-plan' ? '' : ` ${purposeBit}`;
  if (isShowMore) {
    return `Here are ${shownNow} more matching ${beds}${type}${area}${purposeSuffix}.`
      .replace(/\s+/g, ' ')
      .trim();
  }
  return `I found ${count} ${beds}${type}${area}${purposeSuffix}. Would you like the details?`
    .replace(/\s+/g, ' ')
    .trim();
}

function emptyResultsReply(filters = {}) {
  const loc = (filters.location || 'that area').toString().trim() || 'that area';
  const beds = describeBedroomPhrase(filters).trim(); // e.g. "1-bedroom" or ""
  const type = describeTypeSingular(filters);         // e.g. "Villa" or "property"
  const bedsType = beds ? `${beds} ${type.toLowerCase()}` : type.toLowerCase();
  return `Looking for a ${bedsType} in ${loc} — let me check the closest options for you.`;
}

function exhaustedResultsReply(filters = {}, shownCount = 0) {
  const loc = (filters.location || '').toString().trim();
  const area = loc ? ` in ${loc}` : '';
  const type = describeTypePhrase(filters, shownCount);
  const purposeBit =
    filters.purpose === 'Rent'
      ? 'to rent'
      : filters.purpose === 'Off-plan'
        ? 'off-plan'
        : 'for sale';
  return `I've already shown the matching ${type}${area} ${purposeBit}. There aren't additional listings with these filters. Would you like to try a nearby area, a different bedroom count, another property type, or adjust the budget?`
    .replace(/\s+/g, ' ')
    .trim();
}

function replyForZeroHits(turnKind, filters = {}, shownCount = 0, extras = {}) {
  if (turnKind === SEARCH_TURN.SIMILAR) return similarEmptyReply(filters);
  if (turnKind === SEARCH_TURN.NEW_AREA) return newAreaEmptyReply(filters);
  const sameSearch =
    extras.sameSearch ??
    (turnKind === SEARCH_TURN.CONTINUATION || turnKind === SEARCH_TURN.EXHAUSTED);
  if (
    !canUseInitialEmptyResults({
      turnKind,
      sameSearch,
      executed: extras.executed,
    })
  ) {
    return exhaustedResultsReply(filters, shownCount);
  }
  return emptyResultsReply(filters);
}

function canUseInitialEmptyResults({ turnKind, sameSearch = false, executed = false } = {}) {
  if (sameSearch) return false;
  if (turnKind === SEARCH_TURN.CONTINUATION || turnKind === SEARCH_TURN.EXHAUSTED) return false;
  if (turnKind === SEARCH_TURN.PROPERTY_DETAILS) return false;
  if (turnKind === SEARCH_TURN.SIMILAR || turnKind === SEARCH_TURN.NEW_AREA) return false;
  if (executed && turnKind !== SEARCH_TURN.FILTER_UPDATE && turnKind !== SEARCH_TURN.INITIAL) {
    return false;
  }
  return turnKind === SEARCH_TURN.INITIAL || turnKind === SEARCH_TURN.FILTER_UPDATE;
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

function emptyResultOptions(filters = {}, exploredAreas = []) {
  const opts = [];
  const n = Number(filters.bedrooms);
  const min = Number(filters.bedroomsMin);
  if (min >= 4 || n >= 4) opts.push('Try 3 BR');
  else if (n === 3) opts.push('Try 2 BR');
  else if (n === 2) opts.push('Try 1 BR');
  else if (n === 1) opts.push('Try Studio');
  const nearby = nearbyAreaOptions(filters.location, exploredAreas);
  if (nearby.length) opts.push('Nearby areas');
  opts.push('Change budget');
  return opts;
}

const NEARBY_AREA_MAP = [
  { match: /\bjbr\b|jumeirah beach resid/i, areas: ['Dubai Marina', 'JLT', 'Palm Jumeirah', 'Bluewaters Island'] },
  { match: /\bjlt\b|jumeirah lake/i, areas: ['Dubai Marina', 'JBR', 'Dubai Media City', 'Palm Jumeirah'] },
  { match: /bluewaters/i, areas: ['Dubai Marina', 'JBR', 'Palm Jumeirah'] },
  { match: /dubai marina|\bmarina\b/i, areas: ['JBR', 'JLT', 'Palm Jumeirah', 'Bluewaters Island'] },
  { match: /palm jumeirah/i, areas: ['Dubai Marina', 'JBR', 'Bluewaters Island'] },
  { match: /dubai hills/i, areas: ['Arabian Ranches', 'Town Square', 'The Springs'] },
  { match: /dubai south|dwc/i, areas: ['Dubai Investment Park', 'Jebel Ali', 'Discovery Gardens'] },
  { match: /downtown/i, areas: ['Business Bay', 'DIFC', 'City Walk'] },
  { match: /jvc|jumeirah village circle/i, areas: ['JVT', 'Dubai Sports City'] },
  { match: /arabian ranches/i, areas: ['Dubai Hills', 'Mudon', 'Town Square'] },
  { match: /business bay/i, areas: ['Downtown Dubai', 'DIFC'] },
];

function uniqueAreaList(list = []) {
  return uniqueTypeList(list);
}

function nearbyAreaOptions(location, exploredAreas = []) {
  const loc = String(location || '').trim();
  if (!loc) return ['Dubai Hills', 'Arabian Ranches', 'Dubai Marina'];
  const explored = new Set(
    uniqueAreaList([loc, ...(exploredAreas || [])]).map((a) => a.toLowerCase())
  );
  let areas = [];
  for (const row of NEARBY_AREA_MAP) {
    if (row.match.test(loc)) {
      areas = row.areas.slice();
      break;
    }
  }
  const filtered = areas.filter((area) => !explored.has(String(area).trim().toLowerCase()));
  return filtered;
}

function newAreaEmptyReply(filters = {}) {
  const loc = (filters.location || 'that area').toString().trim() || 'that area';
  const beds = describeBedroomPhrase(filters).trim();
  const type = describeTypeSingular(filters);
  const bedsType = beds ? `${beds} ${type.toLowerCase()}` : type.toLowerCase();
  return `I couldn't find a matching ${bedsType} in ${loc}. Would you like to try a nearby area, a different bedroom count, or adjust the budget?`
    .replace(/\s+/g, ' ')
    .trim();
}

function similarEmptyReply(filters = {}) {
  return 'I couldn\'t find more similar properties with those criteria. Would you like to try a nearby area or adjust the budget?';
}

function widenSimilarSearchFilters(filters = {}, exploredAreas = []) {
  const next = copySearchFilters(filters);
  next.budgetMin = null;
  next.budgetMax = null;
  const similarAreas = nearbyAreaOptions(next.location, [
    ...(exploredAreas || []),
    next.location,
  ]);
  if (similarAreas[0]) next.location = similarAreas[0];
  return next;
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
  if (parsePropertyTypeChange(raw) && parsePropertyTypesFromMessage(raw).length === 1) return next;
  if (/^(apartments?|villas?|townhouses?|penthouses?|duplexes?|offices?|studios?)$/i.test(raw)) return next;
  return uniqueTypes([...cur, ...next]);
}

function isPropertyDetailRequest(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return false;
  if (/\bthe\s+(first|second|third|fourth)\b/.test(raw)) return true;
  if (/\bmore\s+details\b/.test(raw)) return true;
  if (/\btell\s+me\s+more\b/.test(raw)) return true;
  if (/\b(what are the details|show property details|property details)\b/.test(raw)) return true;
  if (/^(details|the details)$/.test(raw)) return true;
  return (
    /\b(this|that|the)\s+(property|listing|one|apartment|villa|townhouse)\b/.test(raw) &&
    /\b(tell|about|details|available|availability|price|size|bath|bed)\b/.test(raw)
  );
}

function bedroomChoiceMatches(filters = {}, choice) {
  if (!choice || !filters) return false;
  if (choice.any) return !!filters.bedroomsAny;
  if (choice.min != null) return Number(filters.bedroomsMin) === Number(choice.min);
  if (choice.exact != null && !filters.bedroomsAny) {
    return Number(filters.bedrooms) === Number(choice.exact);
  }
  return false;
}

function searchSignatureFromFilters(filters = {}) {
  const purpose = normalizePurpose(filters.purpose) || '';
  const types = typesFromFilters(filters)
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('+') || 'any';
  const loc = String(filters.location || '')
    .trim()
    .toLowerCase() || 'any';
  let beds = 'any';
  if (filters.bedroomsAny) beds = 'any';
  else if (isBedroomsSet(filters.bedroomsMin)) beds = `${filters.bedroomsMin}+ BR`;
  else if (filters.bedrooms != null && filters.bedrooms !== '') {
    const n = Number(filters.bedrooms);
    beds = n === 0 ? 'Studio' : `${n} BR`;
  }
  const budget = filters.budgetMax != null && filters.budgetMax !== '' ? String(filters.budgetMax) : '';
  const furnished = String(filters.furnished || '').trim().toLowerCase();
  return [purpose, types, loc, beds, budget, furnished].filter((part) => part !== '').join('|');
}

function locationsMatch(a, b) {
  const left = String(a || '').trim().toLowerCase();
  const right = String(b || '').trim().toLowerCase();
  if (!left || !right) return false;
  return left === right;
}

function restatesExistingSearchCriteria(message, filters = {}) {
  const raw = String(message || '').trim();
  if (!raw || isPropertyDetailRequest(raw)) return false;
  const loc = parseLocationFromMessage(raw);
  const types = parsePropertyTypesFromMessage(raw);
  const beds = parseBedroomChoice(raw);
  const purpose = parsePurposeFromMessage(raw);
  const lastTypes = typesFromFilters(filters);
  if (purpose && filters.purpose && normalizePurpose(purpose) !== normalizePurpose(filters.purpose)) {
    return false;
  }
  if (loc && filters.location && !locationsMatch(loc, filters.location)) return false;
  if (
    types.length &&
    lastTypes.length &&
    types.join('|').toLowerCase() !== lastTypes.join('|').toLowerCase()
  ) {
    return false;
  }
  if (beds && !bedroomChoiceMatches(filters, beds)) return false;
  const mentioned =
    !!(loc && filters.location) ||
    !!(types.length && lastTypes.length) ||
    !!(beds && (filters.bedrooms != null || filters.bedroomsMin != null || filters.bedroomsAny)) ||
    !!(purpose && filters.purpose);
  return mentioned;
}

function isShowMoreRequest(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return false;
  if (isPropertyDetailRequest(raw)) return false;
  if (
    /^(show(\s+me)?\s+more(\s+(properties|listings|options|results|please))?|more(\s+(properties|listings|options|results|please))?|see\s+more|another(\s+(ones?|properties|listings|options|property))?|next(\s+(page|batch|set|ones?))?|continue|keep going)$/i.test(
      raw
    )
  ) {
    return true;
  }
  if (/\bsame requirements\b/.test(raw)) return true;
  if (/\bmore\s+(properties|listings|options|results)\b/.test(raw)) return true;
  if (/\b(need|want)\s+(me\s+)?more\s+(properties|listings|options|results)\b/.test(raw)) return true;
  if (/\b(show|see|give)\s+(me\s+)?another(\s+(property|properties|listing|listings|ones?))?\b/.test(raw)) {
    return true;
  }
  if (/\banother\s+(property|properties|listing|listings)\b/.test(raw)) return true;
  return /\b(show|see|give)\s+(me\s+)?more(\s+(properties|listings|options|results))?\b/.test(raw);
}

function isSimilarPropertyRequest(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw || isPropertyDetailRequest(raw)) return false;
  if (/^see similar properties$/.test(raw) || /^similar properties$/.test(raw)) return true;
  return /\b(see|show|find)\s+(me\s+)?similar(\s+(properties|listings|ones?))?\b/.test(raw);
}

function isRestatedInventoryComment(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return false;
  if (/\b(only|just)\s+\d+\s+(listing|property|result)s?\b/.test(raw)) return true;
  return /\bno more\b|\bnothing else\b|\ball (that'?s|that is|there is)\b/.test(raw);
}

function hasExecutedListingSearch(profile = {}) {
  if (profile.searchAlreadyExecuted) return true;
  if (String(profile.lastSearchSignature || '').trim()) return true;
  if (Array.isArray(profile.shownPropertyIds) && profile.shownPropertyIds.length > 0) return true;
  if (Array.isArray(profile.lastPropertyCards) && profile.lastPropertyCards.length > 0) return true;
  return false;
}

function isSearchContinuation(message, filters = {}, { searchAlreadyExecuted = false } = {}) {
  if (isPropertyDetailRequest(message)) return false;
  if (isSimilarPropertyRequest(message)) return false;
  const cta = parseEmptyResultChoice(message);
  if (cta?.nearby || cta?.budget) return false;
  const raw = String(message || '').trim();
  if (!raw) return false;

  const loc = parseLocationFromMessage(raw);
  if (loc && filters.location && !locationsMatch(loc, filters.location)) return false;

  const types = parsePropertyTypesFromMessage(raw);
  const lastTypes = typesFromFilters(filters);
  if (
    types.length &&
    lastTypes.length &&
    types.join('|').toLowerCase() !== lastTypes.join('|').toLowerCase()
  ) {
    return false;
  }

  const beds = parseBedroomChoice(raw);
  if (beds && searchAlreadyExecuted && !bedroomChoiceMatches(filters, beds)) {
    return false;
  }

  if (isShowMoreRequest(raw)) return true;

  if (searchAlreadyExecuted && isVagueConfirm(raw)) return true;

  if (searchAlreadyExecuted && beds && bedroomChoiceMatches(filters, beds)) {
    return true;
  }

  if (searchAlreadyExecuted && loc && locationsMatch(loc, filters.location) && !beds && !types.length) {
    return (
      /\b(more|still|same|need|looking|keep)\b/i.test(raw) || isRestatedInventoryComment(raw)
    );
  }

  if (searchAlreadyExecuted && isRestatedInventoryComment(raw)) return true;
  if (searchAlreadyExecuted && /\bsame requirements\b/i.test(raw)) return true;
  if (searchAlreadyExecuted && restatesExistingSearchCriteria(raw, filters)) return true;

  return false;
}

const SEARCH_TURN = {
  INITIAL: 'initial_search',
  CONTINUATION: 'continuation',
  FILTER_UPDATE: 'filter_update',
  NEW_AREA: 'new_area_search',
  SIMILAR: 'similar_search',
  PROPERTY_DETAILS: 'property_details',
  EXHAUSTED: 'exhausted',
};

function classifyListingSearchTurn({
  userMessage,
  lastSearchFilters,
  searchAlreadyExecuted = false,
  lastSearchSignature = null,
  shownPropertyIds = [],
  lastPropertyCards = [],
} = {}) {
  const last = lastSearchFilters || {};
  const executed = hasExecutedListingSearch({
    searchAlreadyExecuted,
    lastSearchSignature,
    shownPropertyIds,
    lastPropertyCards,
  });

  if (isPropertyDetailRequest(userMessage)) return SEARCH_TURN.PROPERTY_DETAILS;
  if (isSimilarPropertyRequest(userMessage)) {
    return executed ? SEARCH_TURN.SIMILAR : SEARCH_TURN.INITIAL;
  }

  const loc = parseLocationFromMessage(userMessage);
  const bareLocation = parseLocationReply(userMessage);
  const types = parsePropertyTypesFromMessage(userMessage);
  const beds = parseBedroomChoice(userMessage);
  const purpose = parsePurposeFromMessage(userMessage);
  const lastTypes = typesFromFilters(last);

  if (
    executed &&
    purpose &&
    last.purpose &&
    normalizePurpose(purpose) !== normalizePurpose(last.purpose)
  ) {
    return SEARCH_TURN.FILTER_UPDATE;
  }
  const emptyChoice = parseEmptyResultChoice(userMessage);
  if (executed && emptyChoice?.bedrooms && !bedroomChoiceMatches(last, emptyChoice.bedrooms)) {
    return SEARCH_TURN.FILTER_UPDATE;
  }
  const budget = parseBudgetFromMessage(userMessage);
  if (
    executed &&
    budget &&
    (budget.any ||
      (budget.budgetMax != null && Number(budget.budgetMax) !== Number(last.budgetMax)) ||
      (budget.budgetMin != null && Number(budget.budgetMin) !== Number(last.budgetMin)))
  ) {
    return SEARCH_TURN.FILTER_UPDATE;
  }

  const nextLocation = loc || (!beds && !types.length ? bareLocation : null);
  if (executed && nextLocation && last.location && !locationsMatch(nextLocation, last.location)) {
    return SEARCH_TURN.NEW_AREA;
  }
  if (
    executed &&
    bareLocation &&
    !beds &&
    !types.length &&
    String(userMessage || '').trim().split(/\s+/).length <= 4 &&
    (!last.location || !locationsMatch(bareLocation, last.location))
  ) {
    return SEARCH_TURN.NEW_AREA;
  }
  if (
    executed &&
    types.length &&
    lastTypes.length &&
    types.join('|').toLowerCase() !== lastTypes.join('|').toLowerCase()
  ) {
    return SEARCH_TURN.FILTER_UPDATE;
  }
  if (executed && beds && !bedroomChoiceMatches(last, beds)) {
    return SEARCH_TURN.FILTER_UPDATE;
  }

  if (isSearchContinuation(userMessage, last, { searchAlreadyExecuted: executed })) {
    return executed ? SEARCH_TURN.CONTINUATION : SEARCH_TURN.INITIAL;
  }
  if (isShowMoreRequest(userMessage)) {
    return executed ? SEARCH_TURN.CONTINUATION : SEARCH_TURN.INITIAL;
  }
  if (executed && isVagueConfirm(userMessage)) return SEARCH_TURN.CONTINUATION;
  if (executed && restatesExistingSearchCriteria(userMessage, last)) return SEARCH_TURN.CONTINUATION;
  return executed ? SEARCH_TURN.CONTINUATION : SEARCH_TURN.INITIAL;
}

function buildSearchExecutionPlan({
  userMessage,
  lastSearchFilters,
  searchAlreadyExecuted = false,
  lastSearchSignature = null,
  shownPropertyIds = [],
  lastPropertyCards = [],
  effectiveFilters = null,
} = {}) {
  const executed = hasExecutedListingSearch({
    searchAlreadyExecuted,
    lastSearchSignature,
    shownPropertyIds,
    lastPropertyCards,
  });
  let turnKind = classifyListingSearchTurn({
    userMessage,
    lastSearchFilters,
    searchAlreadyExecuted,
    lastSearchSignature,
    shownPropertyIds,
    lastPropertyCards,
  });
  if (!executed && turnKind === SEARCH_TURN.CONTINUATION) {
    turnKind = SEARCH_TURN.INITIAL;
  }

  const signature = searchSignatureFromFilters(effectiveFilters || lastSearchFilters || {});
  const previousSignature = String(lastSearchSignature || '').trim();
  const sameSearch =
    turnKind === SEARCH_TURN.CONTINUATION ||
    (executed &&
      turnKind !== SEARCH_TURN.FILTER_UPDATE &&
      turnKind !== SEARCH_TURN.NEW_AREA &&
      turnKind !== SEARCH_TURN.SIMILAR &&
      (!previousSignature || previousSignature === signature));
  const resetShown =
    turnKind === SEARCH_TURN.FILTER_UPDATE ||
    turnKind === SEARCH_TURN.NEW_AREA ||
    (turnKind === SEARCH_TURN.INITIAL && !!previousSignature && previousSignature !== signature);
  const excludeIds = resetShown ? [] : uniqueIdList(shownPropertyIds);

  return {
    turnKind,
    signature,
    previousSignature: previousSignature || null,
    sameSearch,
    resetShown,
    excludeIds,
    executed,
  };
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

/** Words that look like "in X" but are not Dubai communities. */
function isNonPlaceLocationToken(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  if (!raw) return true;
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

/**
 * Extracts a location from patterns like "in Dubai Hills", "in Arabian Ranches".
 * Returns the location string or null if none found. Never returns a vague
 * phrase such as "another location".
 */
function parseLocationFromMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (isUnspecifiedLocationPhrase(raw)) return null;
  // Match " in <location>" — location is everything after "in" until end or a filter word
  const m = raw.match(/\bin\s+([A-Za-z0-9][A-Za-z0-9 '-]+?)(?:\s+(?:for|with|under|below|up\s+to|at|max)|$)/i);
  if (!m) return null;
  const loc = m[1].trim();
  if (!loc || isUnspecifiedLocationPhrase(loc) || isNonPlaceLocationToken(loc)) return null;
  // "in summer" / "in cash" etc. are not areas
  if (isNonPlaceLocationToken(loc.split(/\s+/)[0])) return null;
  return loc;
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
  if (!raw || isUnspecifiedLocationPhrase(raw) || isGeneralKnowledgeQuery(raw)) return null;
  if (isShowMoreRequest(raw) || isSimilarPropertyRequest(raw) || isPropertyDetailRequest(raw)) return null;
  const cta = parseEmptyResultChoice(raw);
  if (cta?.nearby || cta?.budget) return null;
  if (/^nearby areas$/i.test(raw) || /^change budget$/i.test(raw) || /^see similar properties$/i.test(raw)) {
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

function locationClarificationReply() {
  return 'Which area would you like me to search?';
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

  return parseDesiredPropertyType(raw);
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
  const incomingTypes = typesFromFilters(filters);
  const lastTypes = typesFromFilters(last);
  const preservedTypes = lastTypes.length ? lastTypes : incomingTypes;
  const locationChanged = locationProvided && lastLocationSet && textsDiffer(filters.location, last.location);

  const merged = {
    location: locationChanged
      ? coalesceFilter(filters.location, null)
      : coalesceFilter(filters.location, last.location),
    bedrooms: last.bedrooms ?? null,
    bedroomsMin: last.bedroomsMin ?? null,
    bedroomsAny: last.bedroomsAny === true,
    bedroomsResolved: last.bedroomsResolved === true,
    budgetMin: last.budgetMin ?? null,
    budgetMax: last.budgetMax ?? null,
    furnished: coalesceFilter(filters.furnished, last.furnished),
    purpose: last.purpose || null,
  };
  applyTypesToFilters(merged, preservedTypes);
  return merged;
}

function isAmbiguousListingQuery(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return false;
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
  if (isPropertyDetailRequest(raw)) return false;
  if (parseSellIntent(raw) || isSellCta(raw)) return false;
  if (isContentKnowledgeTopic(raw)) return false;
  if (isMultiPropertyServiceQuery(raw) || matchesServiceInquiryPhrase(raw)) return false;
  if (parsePurposeFromMessage(raw)) return true;
  if (isShowMoreRequest(raw)) return true;
  if (isSimilarPropertyRequest(raw)) return true;
  if (parsePropertyTypeChange(raw)) return true;
  if (parsePropertyTypesFromMessage(raw).length > 1) return true;
  if (wantsDifferentLocation(raw)) return true;
  if (parseEmptyResultChoice(raw)) return true;
  if (isAmbiguousListingQuery(raw)) return true;
  if (parseLocationFromMessage(raw)) return true;
  if (parseBudgetFromMessage(raw)) return true;
  const bed = parseBedroomChoice(raw);
  if (bed && String(raw).trim().length < 48) return true;
  return false;
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

function applyMessageToSearchFilters(filters, message) {
  const next = copySearchFilters(filters);
  const types = parsePropertyTypesFromMessage(message);
  const location = parseLocationFromMessage(message);
  const beds = parseBedroomChoice(message);
  const budget = parseBudgetFromMessage(message);
  const furnished = parseFurnishedFromMessage(message);
  const purpose = parsePurposeFromMessage(message);
  if (types.length) applyTypesToFilters(next, mergePropertyTypes(typesFromFilters(next), types, message));
  if (location) next.location = location;
  if (beds) applyBedroomChoice(next, beds);
  if (budget) applyBudgetChoice(next, budget);
  if (furnished) next.furnished = furnished;
  if (purpose) next.purpose = purpose;
  return next;
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
  return !filters.location && !typesFromFilters(filters).length;
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
    searchAlreadyExecuted: false,
    lastSearchSignature: null,
    exploredAreas: [],
    lastSearchFilters: emptySearchFilters(),
    slotFlow: { awaiting: null, alternatives: null },
    sellListing: emptySellListing(),
    serviceInquiry: emptyServiceInquiry(),
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
    if (needsListingIntake(profile.lastSearchFilters)) {
      profile.slotFlow = { awaiting: 'listingIntake', alternatives: null };
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
  if (needsListingIntake(profile.lastSearchFilters || {})) {
    return listingIntakeReply(intent);
  }
  return null;
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
  return undefined;
}

/** True when this turn is not a listing follow-up and must not reuse last search filters. */
function shouldSkipPropertySearch(text) {
  if (!String(text || '').trim()) return false;
  if (isPropertyDetailRequest(text)) return true;
  if (parseSellIntent(text) || isSellCta(text)) return true;
  if (isListingFollowUp(text) || isVagueConfirm(text)) return false;
  return isGeneralKnowledgeQuery(text);
}

function trustedPurpose({ lastSearchFilters = {}, userMessage, slotFlow, intent } = {}) {
  if (parseSellIntent(userMessage) || isServiceInquiryMessage(userMessage)) return null;

  const fromMessage = parsePurposeFromMessage(userMessage);
  if (fromMessage) return fromMessage;

  const locked = intentToPurpose(intent) || normalizePurpose(lastSearchFilters?.purpose);
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
  }
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
  const types = typesFromFilters(filters);
  if (types.length) queryFilters.propertyType = types;
  if (filters.furnished) queryFilters.furnished = filters.furnished;
  if (Array.isArray(filters.excludeRefNos) && filters.excludeRefNos.length) {
    queryFilters.excludeRefNos = uniqueIdList(filters.excludeRefNos);
  }
  return { page: 1, limit: PROPERTY_LIMIT, search, filters: queryFilters };
}

async function fetchByPurpose(purpose, opts) {
  if (purpose === 'Rent') return propertyDbService.fetchRentProperties(opts);
  if (purpose === 'Off-plan') return propertyDbService.fetchOffPlanProperties(opts);
  if (purpose === 'Buy') {
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

async function fetchPropertyCards(filters, search) {
  const opts = listingQueryOpts(filters, search);
  const requested = normalizePurpose(filters.purpose);
  if (!requested) {
    return { propertyCards: [], usedPurpose: null, total: 0, remaining: 0 };
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
  const total = exclude.length ? unfiltered.total || 0 : result.total || 0;
  return {
    propertyCards: dedupePropertyCards((result.properties || []).map(toPropertyCard)),
    usedPurpose: requested,
    total,
    remaining: result.total || 0,
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

/** Quick count-only query — returns 0 or positive integer. */
async function countByFilters(filters, search) {
  const opts = listingQueryOpts(filters, search);
  const purpose = normalizePurpose(filters.purpose);
  if (!purpose) return 0;
  try {
    const result = await fetchByPurpose(purpose, opts);
    return (result.properties || []).length > 0 ? result.total || (result.properties || []).length : 0;
  } catch {
    return 0;
  }
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
  const nearbyAreas = nearbyAreaOptions(location);
  for (const area of nearbyAreas.slice(0, 3)) {
    candidates.push({
      label: nearbyAreaChipLabel(area, effectiveFilters),
      patch: { location: area },
      priority: 1,
    });
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
  const adjBeds = adjacentBedroomCounts(effectiveFilters);
  for (const adj of adjBeds) {
    candidates.push({
      label: adj.label,
      patch: { bedroomChoice: { exact: adj.exact } },
      priority: 3,
    });
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

async function emptyResultsResult(effectiveFilters) {
  const location = (effectiveFilters.location || '').toString().trim();

  const locationHasStock = await locationHasInventoryForPurposeType(effectiveFilters);
  const locationEmpty = !!location && !locationHasStock;

  const alternatives = await buildAlternativeChips(effectiveFilters, { nearbyOnly: locationEmpty });

  let reply;
  let options;
  let slotAwaiting;

  if (locationEmpty) {
    const nearbyLabels = alternatives.map((a) => a.label);
    reply = locationEmptyNearbyReply(effectiveFilters, nearbyLabels);
    options = nearbyLabels;
    slotAwaiting = alternatives.length > 0 ? 'alternatives' : 'emptyResults';
  } else if (alternatives.length > 0) {
    const locPart = location ? ` in ${location}` : '';
    if (alternatives.length === 1) {
      const altLabel = alternatives[0].label;
      const labelHasLoc = location && altLabel.toLowerCase().includes(location.toLowerCase());
      const locSuffix = labelHasLoc ? '' : locPart || '';
      reply = `${emptyResultsReply(effectiveFilters)} I found ${altLabel}${locSuffix} instead.`;
    } else {
      reply = `${emptyResultsReply(effectiveFilters)} Here are some options I found${locPart}:`;
    }
    options = alternatives.map((a) => a.label);
    slotAwaiting = 'alternatives';
  } else {
    reply = `${emptyResultsReply(effectiveFilters)} Would you like to adjust the area, bedrooms, or budget?`;
    options = [];
    slotAwaiting = 'emptyResults';
  }

  const alternativesJson = alternatives.length > 0 ? JSON.stringify(alternatives) : null;

  return {
    propertyCards: [],
    sources: [],
    leadCaptured: false,
    profilePatch: {
      ...profilePatchFromPropertyFilters(effectiveFilters),
      lastSearchFilters: effectiveFilters,
      slotFlow: { awaiting: slotAwaiting, alternatives: alternativesJson },
    },
    viewAllMatching: null,
    effectiveFilters,
    needsEmptyResults: true,
    clarificationReply: reply,
    options: options.length > 0 ? options : undefined,
    ...(options.length > 0 ? emptyResultsClarificationFields() : {}),
    modelPayload: {
      count: 0,
      needsEmptyResults: true,
      requestedLocation: location || null,
      locationEmpty: !!locationEmpty,
      instruction:
        'No listings matched. Do not invent alternatives. The server has checked real inventory and will show chips for confirmed options. Do not write a follow-up question. Do not use "I don\'t have" / "I couldn\'t find" phrasing.',
    },
  };
}

function exhaustedResultsResult(effectiveFilters, shownCount = 0, extras = {}) {
  return {
    propertyCards: [],
    sources: [],
    leadCaptured: false,
    profilePatch: {
      ...profilePatchFromPropertyFilters(effectiveFilters),
      lastSearchFilters: effectiveFilters,
      slotFlow: { awaiting: 'emptyResults', alternatives: null },
      exploredAreas: effectiveFilters.location ? [effectiveFilters.location] : [],
    },
    viewAllMatching: null,
    effectiveFilters,
    needsEmptyResults: true,
    clarificationReply: extras.reply || exhaustedResultsReply(effectiveFilters, shownCount),
    options: extras.options || emptyResultOptions(effectiveFilters, extras.exploredAreas),
    ...emptyResultsClarificationFields(),
    modelPayload: {
      count: 0,
      needsEmptyResults: true,
      exhausted: extras.exhausted !== false,
      shownCount,
      instruction:
        extras.instruction ||
        'All matching listings for this search were already shown. Do not repeat previous property cards. Do not invent new listings. Do not write "Looking for a … let me check".',
    },
  };
}

async function searchProperties(
  filters = {},
  {
    lastSearchFilters,
    slotFlow,
    userMessage,
    intent,
    shownPropertyIds = [],
    searchAlreadyExecuted = false,
    lastSearchSignature = null,
    lastPropertyCards = [],
    exploredAreas = [],
  } = {}
) {
  const lockedIntent = normalizeIntentValue(intent);
  const executedBefore = hasExecutedListingSearch({
    searchAlreadyExecuted,
    lastSearchSignature,
    shownPropertyIds,
    lastPropertyCards,
  });
  const turnKind = classifyListingSearchTurn({
    userMessage,
    lastSearchFilters,
    searchAlreadyExecuted,
    lastSearchSignature,
    shownPropertyIds,
    lastPropertyCards,
  });

  const filterCta = parseEmptyResultChoice(userMessage);
  if (filterCta?.nearby || filterCta?.budget) {
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
          'The visitor chose a nearby-area or budget CTA. Do not rerun the previous listing search. Wait for the selected area or budget.',
      },
    };
  }

  if (
    (shouldSkipPropertySearch(userMessage) || turnKind === SEARCH_TURN.PROPERTY_DETAILS) &&
    turnKind !== SEARCH_TURN.CONTINUATION &&
    !isShowMoreRequest(userMessage)
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

  const continuation = turnKind === SEARCH_TURN.CONTINUATION;
  const showMore = continuation;
  if (!showMore) {
    const mentionedLocation =
      parseLocationFromMessage(userMessage) ||
      (turnKind === SEARCH_TURN.NEW_AREA ? parseLocationReply(userMessage) : null);
    if (mentionedLocation && (turnKind === SEARCH_TURN.NEW_AREA || !effectiveFilters.location)) {
      effectiveFilters.location = mentionedLocation;
    }

    const bedChoice = parseBedroomChoice(userMessage);
    if (bedChoice) applyBedroomChoice(effectiveFilters, bedChoice);

    const budgetChoice = parseBudgetFromMessage(userMessage, {
      requireBudgetContext: slotFlow?.awaiting === 'budget',
    });
    if (budgetChoice) applyBudgetChoice(effectiveFilters, budgetChoice);

    const furnished = parseFurnishedFromMessage(userMessage);
    if (furnished) effectiveFilters.furnished = furnished;

    const incomingTypes = uniqueTypes([
      ...typesFromFilters(filters),
      ...parsePropertyTypesFromMessage(userMessage),
    ]);
    if (incomingTypes.length) {
      applyTypesToFilters(
        effectiveFilters,
        mergePropertyTypes(typesFromFilters(effectiveFilters), incomingTypes, userMessage)
      );
    }
  }

  if (turnKind === SEARCH_TURN.SIMILAR) {
    const widened = widenSimilarSearchFilters(effectiveFilters, exploredAreas);
    effectiveFilters.budgetMin = widened.budgetMin;
    effectiveFilters.budgetMax = widened.budgetMax;
    effectiveFilters.location = widened.location;
  }

  const purpose = trustedPurpose({ lastSearchFilters, userMessage, slotFlow, intent: lockedIntent });
  effectiveFilters.purpose = purpose;

  const plan = buildSearchExecutionPlan({
    userMessage,
    lastSearchFilters,
    searchAlreadyExecuted,
    lastSearchSignature,
    shownPropertyIds,
    lastPropertyCards,
    effectiveFilters,
  });
  const { sameSearch, resetShown, excludeIds, signature, previousSignature } = plan;
  const resolvedKind = plan.turnKind;
  effectiveFilters.excludeRefNos = excludeIds;

  console.log(
    'search_properties purpose gate:',
    JSON.stringify({
      toolPurpose: filters.purpose ?? null,
      trustedPurpose: purpose,
      lastPurpose: lastSearchFilters?.purpose ?? null,
      fromMessage: parsePurposeFromMessage(userMessage),
      types: typesFromFilters(effectiveFilters),
      showMore,
      continuation,
      turnKind: resolvedKind,
      signature,
      previousSignature: previousSignature || null,
      sameSearch,
      resetShown,
      excludeCount: excludeIds.length,
      searchAlreadyExecuted: !!searchAlreadyExecuted,
      executedBefore,
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
      types: typesFromFilters(effectiveFilters),
      bedrooms: effectiveFilters.bedrooms ?? null,
      bedroomsMin: effectiveFilters.bedroomsMin ?? null,
      bedroomsAny: !!effectiveFilters.bedroomsAny,
      budgetMin: effectiveFilters.budgetMin ?? null,
      budgetMax: effectiveFilters.budgetMax ?? null,
      excludeCount: excludeIds.length,
      signature,
      sameSearch,
      turnKind: resolvedKind,
    })
  );
  const { propertyCards, usedPurpose, total, remaining } = await fetchPropertyCards(
    effectiveFilters,
    search
  );
  effectiveFilters.purpose = usedPurpose;
  delete effectiveFilters.excludeRefNos;

  const executedPatch = {
    lastSearchSignature: searchSignatureFromFilters(effectiveFilters),
    searchAlreadyExecuted: true,
    exploredAreas: uniqueAreaList([
      lastSearchFilters?.location,
      effectiveFilters.location,
    ]),
  };

  if (propertyCards.length === 0) {
    const journeyAreas = uniqueAreaList([
      ...(exploredAreas || []),
      lastSearchFilters?.location,
      effectiveFilters.location,
    ]);
    const zeroReply = replyForZeroHits(resolvedKind, effectiveFilters, excludeIds.length || shownPropertyIds.length, {
      sameSearch,
      executed: plan.executed || executedBefore,
    });
    const useInitialEmpty = canUseInitialEmptyResults({
      turnKind: resolvedKind,
      sameSearch,
      executed: plan.executed || executedBefore,
    });
    if (!useInitialEmpty) {
      const exhausted = exhaustedResultsResult(effectiveFilters, excludeIds.length || shownPropertyIds.length, {
        reply: zeroReply,
        exploredAreas: journeyAreas,
        options: emptyResultOptions(effectiveFilters, journeyAreas),
        exhausted: resolvedKind === SEARCH_TURN.CONTINUATION || resolvedKind === SEARCH_TURN.EXHAUSTED,
        instruction:
          resolvedKind === SEARCH_TURN.SIMILAR
            ? 'Similar-property search returned no new listings. Do not repeat previous cards. Do not write "Looking for a … let me check" or "I\'ve already shown the matching". Offer nearby areas or budget.'
            : resolvedKind === SEARCH_TURN.NEW_AREA
              ? 'New area search returned no listings. Do not claim these listings were already shown. Do not write "Looking for a … let me check".'
              : undefined,
      });
      exhausted.profilePatch = { ...(exhausted.profilePatch || {}), ...executedPatch };
      return exhausted;
    }
    const empty = await emptyResultsResult(effectiveFilters);
    empty.profilePatch = {
      ...(empty.profilePatch || {}),
      ...executedPatch,
    };
    return empty;
  }

  const extraPayload = {
    requestedLocation: search || null,
    total,
    remaining,
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
    lastSearchFilters: effectiveFilters,
    lastPropertyCards: propertyCards,
    shownPropertyIds: propertyCards.map((card) => card.id).filter(Boolean),
    resetShownPropertyIds: resetShown,
    slotFlow: { awaiting: null },
    ...executedPatch,
  };
  if (resolvedKind === SEARCH_TURN.SIMILAR) {
    result.replyOverride = `Here are similar ${describeBedroomPhrase(effectiveFilters)}${describeTypePhrase(effectiveFilters, propertyCards.length)}${effectiveFilters.location ? ` in ${effectiveFilters.location}` : ''} that could be a good fit.`
      .replace(/\s+/g, ' ')
      .trim();
  } else {
    result.replyOverride = foundListingsReply(effectiveFilters, total, {
      isShowMore: sameSearch || resolvedKind === SEARCH_TURN.CONTINUATION,
      newCount: propertyCards.length,
    });
  }
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
  if (['n/a', 'na', 'unknown', 'none', 'test', 'asdf'].includes(lower)) return false;
  if (lower.includes('example')) return false;
  return true;
}

async function captureLead({ name, phone, email, intent, whatsapp, emailOptional }, sessionId, { leadAlreadyCaptured } = {}) {
  const contactPhone = looksCollected(phone) ? phone : whatsapp;
  const hasEmail = looksCollected(email);
  const hasFullDetails =
    looksCollected(name) &&
    looksCollected(contactPhone) &&
    looksCollected(intent) &&
    (emailOptional || hasEmail);

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
    phone: String(contactPhone).trim(),
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
}

async function executeTool(
  name,
  args,
  {
    sessionId,
    lastSearchFilters,
    leadAlreadyCaptured,
    slotFlow,
    userMessage,
    intent,
    shownPropertyIds,
    searchAlreadyExecuted,
    lastSearchSignature,
    lastPropertyCards,
    exploredAreas,
  } = {}
) {
  if (name === 'search_properties') {
    return searchProperties(args || {}, {
      lastSearchFilters,
      slotFlow,
      userMessage,
      intent,
      shownPropertyIds,
      searchAlreadyExecuted,
      lastSearchSignature,
      lastPropertyCards,
      exploredAreas,
    });
  }
  if (name === 'search_content') return searchContent(args || {});
  if (name === 'capture_lead') {
    const argsCopy = { ...(args || {}) };
    const emailOptional = !!argsCopy.emailOptional;
    delete argsCopy.emailOptional;
    return captureLead({ ...argsCopy, emailOptional }, sessionId, { leadAlreadyCaptured });
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
  SELL_OPTIONS,
  SELL_TYPE_OPTIONS,
  SELL_SERVICE_LOCATION_OPTIONS,
  PM_NEED_OPTIONS,
  CONVERSATION_INTENTS,
  emptySearchFilters,
  copySearchFilters,
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
  parsePropertyTypesFromMessage,
  parseOtherCustomType,
  mergePropertyTypes,
  typesFromFilters,
  applyTypesToFilters,
  isShowMoreRequest,
  isSimilarPropertyRequest,
  isSearchContinuation,
  isPropertyDetailRequest,
  searchSignatureFromFilters,
  hasExecutedListingSearch,
  classifyListingSearchTurn,
  buildSearchExecutionPlan,
  SEARCH_TURN,
  canUseInitialEmptyResults,
  bedroomChoiceMatches,
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
  locationClarificationReply,
  parseDesiredPropertyType,
  parsePropertyTypeChange,
  parseAlternativeChip,
  parseBudgetFromMessage,
  applyBudgetChoice,
  parseEmptyResultChoice,
  emptyResultOptions,
  emptyResultsReply,
  exhaustedResultsReply,
  replyForZeroHits,
  locationEmptyNearbyReply,
  nearbyAreaOptions,
  newAreaEmptyReply,
  similarEmptyReply,
  widenSimilarSearchFilters,
  matchesNamedOption,
  foundListingsReply,
  purposeClarificationReply,
  bedroomsClarificationReply,
  rankRelatedContentSources,
  isHomepageUrl,
};
