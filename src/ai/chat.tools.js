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
        'Search Rocky website content (blogs, area guides, FAQs, services, company info). Use for Golden Visa, flexi rent / flexible payment plans, buying costs, property management overview, company facts, process, eligibility, and any question that might be answered on our site. Do not use this for live listing prices or availability. After results, write MAXIMUM 2 short sentences with the single key fact only — never paste or expand the chunks.',
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
  if (/\b(i\s+(need|want|have|'d like|would like)\s+to\s+sell|sell(ing)?\s+(my|our)|list(ing)?\s+(my|our)|market\s+(my|our))\b/.test(raw)) {
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
  const phoneMatch =
    labeledPhone || (!labeledWhatsapp ? raw.match(/(?:\+|00)?\d[\d\s\-()]{7,14}\d/) : null);
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
  const fromPropertyHistory = propertyFromHistory(history);
  const last = lastSearchFilters || {};
  return {
    intent: 'sell',
    type: prior.type || last.type || fromPropertyHistory.type || null,
    location: prior.location || last.location || fromPropertyHistory.location || null,
    bedrooms: prior.bedrooms ?? last.bedrooms ?? fromPropertyHistory.bedrooms ?? null,
    priceNote: prior.priceNote || fromPropertyHistory.priceNote || null,
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
];

function parseSellLocation(text) {
  for (const row of SELL_AREA_ALIASES) {
    if (row.match.test(text || '')) return row.canonical;
  }
  const named = parseLocationFromMessage(text);
  if (named && !isUnspecifiedLocationPhrase(named) && !/^(call|amount|discuss|later)$/i.test(named)) {
    return named;
  }
  return null;
}

function parseSellPriceNote(text) {
  const raw = String(text || '').toLowerCase();
  if (/\b(discuss|on\s+the\s+call|in\s+(a\s+)?call|later|negotiable|tbd|not\s+sure)\b/.test(raw)) {
    return 'discuss';
  }
  const budget = parseBudgetFromMessage(text);
  if (budget?.budgetMax) return String(budget.budgetMax);
  return null;
}

function parseSellListingDetails(text, current = {}) {
  const type = parseDesiredPropertyType(text) || normalizePropertyType(text) || current.type || null;
  const location = parseSellLocation(text) || current.location || null;
  const priceNote = parseSellPriceNote(text) || current.priceNote || null;
  const beds = parseBedroomChoice(text);
  const next = {
    ...current,
    type,
    location,
    priceNote,
    purpose: null,
  };
  if (beds && !beds.any && String(text || '').length < 80) {
    if (beds.exact != null) next.bedrooms = beds.exact;
    if (beds.min != null) next.bedroomsMin = beds.min;
  }
  return next;
}

/** Show valuation/agent chips only while the visitor still needs to choose an action. */
function sellFlowOptions(details = {}, message = '') {
  const hasProperty = !!(details.type && details.location);
  if (!hasProperty) return null;
  if (!hasSellContact(details)) return null;
  // Contact complete + CTA / "already shared" → flow finished, stop repeating chips.
  if (isSellCta(message) || isAlreadySharedDetails(message)) return null;
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
    return 'I can help you sell your property. What type is it, and which area is it in?';
  }
  if (details.type && !details.location) {
    return `I can help you sell your ${typeLabel}. Which area is it in?`;
  }
  if (!details.type && details.location) {
    return `I can help you sell your property in ${details.location}. Is it an apartment, villa, or townhouse?`;
  }
  return `I can help you sell your ${typeLabel} in ${loc}. Would you like a quick valuation or to speak with a listing agent?`;
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
  if (/off[\s-_]*plan/.test(lower)) return 'Off-plan';

  if (
    /^(i\s+(want\s+to\s+|would\s+like\s+to\s+)?|i'?d\s+like\s+to\s+|looking\s+to\s+|looking\s+for\s+)?(buy|purchase|sale)\b/.test(
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

function describeTypePhrase(filters = {}, count = 0) {
  const t = String(filters.type || '').trim();
  const n = Number(count);
  if (n === 1) return (t || 'property').toLowerCase();
  if (!t) return 'properties';
  return pluraliseType(t).toLowerCase();
}

/** Singular form, capitalised — e.g. "Villa", "Apartment", "property". */
function describeTypeSingular(filters = {}) {
  const t = String(filters.type || '').trim();
  if (!t) return 'property';
  return t; // PROPERTY_TYPE_MAP canonical values are already capitalised singular
}

function foundListingsReply(filters = {}, total = 0) {
  const loc = (filters.location || '').toString().trim();
  const beds = describeBedroomPhrase(filters);
  const count = Number.isFinite(Number(total)) ? Number(total) : 0;
  const type = describeTypePhrase(filters, count);
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
  const beds = describeBedroomPhrase(filters).trim(); // e.g. "1-bedroom" or ""
  const type = describeTypeSingular(filters);         // e.g. "Villa" or "property"
  const bedsType = beds ? `${beds} ${type.toLowerCase()}` : type.toLowerCase();
  return `I don't have a ${bedsType} available in ${loc} right now.`;
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
function isContentKnowledgeTopic(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase();
  if (!raw) return false;
  if (/\b(show|find|search)\s+(me\s+)?(villas?|apartments?|townhouses?|properties|homes?|listings?)\b/.test(raw)) {
    return false;
  }
  // Property-management lead flow owns these — not blog Q&A.
  if (isMultiPropertyServiceQuery(raw) || matchesServiceInquiryPhrase(raw)) return false;
  return /\b(golden\s+visa|investor\s+visa|visa\s+eligib|buying\s+costs?|cost\s+of\s+buying|cost\s+to\s+buy|transfer\s+fee|dld|mortgage|service\s+charge|rera|freehold|leasehold|flexi\s*rent|flexible\s+rent|payment\s+plan|payable\s+options?|installments?|roi|invest(?:ing|ment|or)?|summer|winter|spring|autumn|season|prepare|tips?|advice|faq|area\s+guide|tell\s+me\s+about|what\s+is|what\s+are|what'?s\s+(?:it\s+like|the\s+latest)|how\s+(?:can|do|to|does|much)|need\s+to\s+know|transaction|market\s+(?:stats?|data|overview)|quarter\s*[1234]|q\s*[1234]|blog|article|posts?|living\s+in|office\s+hours|book\s+(?:a\s+)?viewing|services?\s+(?:do\s+you|you\s+offer|offered|does)|do\s+you\s+(?:offer|help|provide)|company|founded|founder|years?\s+(?:in\s+)?(?:business|operation)|who\s+(?:founded|are\s+you|is\s+rocky)|areas?\s+(?:do\s+you\s+)?cover|contact\s+(?:us|for))\b/.test(
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
  return /\b(management\s+services?|rent\s+collection|tenant\s+screening|landlord\s+services?|maintain(?:ing)?\s+my\s+propert|manage\s+(?:my\s+|these\s+|your\s+|this\s+|our\s+)?propert|can\s+you\s+manage|i\s+need\s+property\s+management|property\s+management\s+for\s+my)\b/i.test(
    raw
  );
}

function isListingFollowUp(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (parseSellIntent(raw) || isSellCta(raw)) return false;
  if (isContentKnowledgeTopic(raw)) return false;
  if (isMultiPropertyServiceQuery(raw) || matchesServiceInquiryPhrase(raw)) return false;
  if (parsePurposeFromMessage(raw)) return true;
  if (parsePropertyTypeChange(raw)) return true;
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
    locationScope: null,
    referenceLocation: null,
    propertyNote: null,
    name: null,
    email: null,
    phone: null,
    whatsapp: null,
  };
}

function copyServiceInquiry(inquiry = {}) {
  return {
    intent: inquiry.intent || null,
    locationScope: inquiry.locationScope || null,
    referenceLocation: inquiry.referenceLocation || null,
    propertyNote: inquiry.propertyNote || null,
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
  return {
    intent: 'property_management',
    locationScope: prior.locationScope || null,
    referenceLocation: prior.referenceLocation || fromSell.location || null,
    propertyNote: prior.propertyNote || parsePropertyPortfolioNote(message) || null,
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
  return {
    ...current,
    name: parsed.name || current.name || null,
    email: parsed.email || current.email || null,
    phone: parsed.phone || current.phone || null,
    whatsapp: parsed.whatsapp || current.whatsapp || null,
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
  return matchesServiceInquiryPhrase(text) || isMultiPropertyServiceQuery(text);
}

/** True when this turn is not a listing follow-up and must not reuse last search filters. */
function shouldSkipPropertySearch(text) {
  if (!String(text || '').trim()) return false;
  if (parseSellIntent(text) || isSellCta(text)) return true;
  if (isListingFollowUp(text) || isVagueConfirm(text)) return false;
  return isGeneralKnowledgeQuery(text);
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
 */
const MAX_ALT_CHIPS = 4;

async function buildAlternativeChips(effectiveFilters) {
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

  const alternatives = await buildAlternativeChips(effectiveFilters);

  let reply;
  let options;
  let slotAwaiting;

  if (alternatives.length > 0) {
    const locPart = location ? ` in ${location}` : '';
    if (alternatives.length === 1) {
      // Single confirmed alternative — name it inline, avoiding location duplication
      const altLabel = alternatives[0].label;
      // If the label already contains the location, don't append it again
      const labelHasLoc = location && altLabel.toLowerCase().includes(location.toLowerCase());
      const locSuffix = labelHasLoc ? '' : (locPart ? locPart : '');
      reply = `${emptyResultsReply(effectiveFilters)} I found ${altLabel}${locSuffix} instead.`;
    } else {
      reply = `${emptyResultsReply(effectiveFilters)} Here are some options I found${locPart}:`;
    }
    options = alternatives.map((a) => a.label);
    slotAwaiting = 'alternatives';
  } else {
    // No confirmed alternatives anywhere
    reply = `${emptyResultsReply(effectiveFilters)} Let me know if you'd like to adjust the search.`;
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
      instruction:
        'No listings matched. Do not invent alternatives. The server has checked real inventory and will show chips for confirmed options. Do not write a follow-up question.',
    },
  };
}

async function searchProperties(
  filters = {},
  { lastSearchFilters, slotFlow, userMessage } = {}
) {
  if (shouldSkipPropertySearch(userMessage) || slotFlow?.awaiting === 'sell') {
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
    return emptyResultsResult(effectiveFilters);   // async — already awaited by caller
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
        'CRITICAL: Reply in AT MOST 2 short sentences (about 40 words total). Use only the key fact from the chunks (e.g. Golden Visa: commonly AED 2 million property investment for a 10-year visa; Flexi Rent: flexible payment options for tenants). Do NOT write "General guidance". Do NOT expand, lecture, or list every detail. No bullet lists. Do not include URLs — related pages are buttons. End with one short question such as "Would you like more details?"',
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
  SELL_SERVICE_LOCATION_OPTIONS,
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
  nearbyAreaOptions,
  matchesNamedOption,
  foundListingsReply,
  purposeClarificationReply,
  bedroomsClarificationReply,
  rankRelatedContentSources,
  isHomepageUrl,
};
