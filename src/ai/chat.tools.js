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
        'Search live Rocky listings. Use for buy/rent requests and when offering matching properties. Pass every filter you know. If count is 0 for the requested area, call this again once with a nearby comparable area before replying. Never claim listings exist unless this tool returned at least one result.',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'Area, community, tower, or city (e.g. Dubai Marina, JVC, Business Bay).',
          },
          bedrooms: {
            type: 'number',
            description: 'Bedroom count. Use 0 for studio.',
          },
          budgetMin: { type: 'number', description: 'Minimum price in AED.' },
          budgetMax: { type: 'number', description: 'Maximum price in AED.' },
          type: {
            type: 'string',
            description: 'Property type (Apartment, Villa, Townhouse, Office, etc.).',
          },
          purpose: {
            type: 'string',
            description: 'Buy or Rent.',
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

function normalizePurpose(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase();
  if (v === 'rent' || v === 'rental' || v === 'lease') return 'Rent';
  if (v === 'buy' || v === 'sale' || v === 'sell') return 'Buy';
  return null;
}

function profilePatchFromPropertyFilters(filters) {
  const patch = {};
  if (filters.location) patch.preferredAreas = [String(filters.location).trim()];
  if (filters.bedrooms !== undefined && filters.bedrooms !== null && filters.bedrooms !== '') {
    const n = Number(filters.bedrooms);
    if (Number.isFinite(n)) patch.bedrooms = n;
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
  if (filters.bedrooms !== undefined && filters.bedrooms !== null && filters.bedrooms !== '') {
    queryFilters.bedrooms = filters.bedrooms;
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

async function fetchPropertyCards(filters, search) {
  const opts = listingQueryOpts(filters, search);
  const purpose = normalizePurpose(filters.purpose);
  let result;
  if (purpose === 'Buy') result = await propertyDbService.fetchBuyProperties(opts);
  else if (purpose === 'Rent') result = await propertyDbService.fetchRentProperties(opts);
  else result = await propertyDbService.fetchAllProperties(opts);
  return (result.properties || []).map(toPropertyCard);
}

function propertySearchResult(propertyCards, filters, extraPayload = {}) {
  return {
    propertyCards,
    sources: [],
    leadCaptured: false,
    profilePatch: profilePatchFromPropertyFilters(filters),
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

async function searchProperties(filters = {}, { previousPropertySearchEmpty } = {}) {
  const search = (filters.location || '').toString().trim();
  const propertyCards = await fetchPropertyCards(filters, search);
  const extraPayload = {
    requestedLocation: search || null,
  };
  if (propertyCards.length === 0 && previousPropertySearchEmpty) {
    extraPayload.bothEmpty = true;
  }
  return propertySearchResult(propertyCards, filters, extraPayload);
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

async function captureLead({ name, phone, email, intent }, sessionId) {
  if (!looksCollected(name) || !looksCollected(phone) || !looksCollected(email) || !looksCollected(intent)) {
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
    profilePatch: {},
    modelPayload: { ok: true, id: String(lead._id) },
  };
}

async function executeTool(name, args, { sessionId, previousPropertySearchEmpty } = {}) {
  if (name === 'search_properties') {
    return searchProperties(args || {}, { previousPropertySearchEmpty });
  }
  if (name === 'search_content') return searchContent(args || {});
  if (name === 'capture_lead') return captureLead(args || {}, sessionId);
  return {
    propertyCards: [],
    sources: [],
    leadCaptured: false,
    profilePatch: {},
    modelPayload: { error: `Unknown tool: ${name}` },
  };
}

module.exports = {
  TOOL_DEFINITIONS,
  executeTool,
};
