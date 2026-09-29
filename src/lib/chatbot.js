const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const Faq = require('../models/Faq');
const CompanyInfo = require('../models/CompanyInfo');
const AreaGuide = require('../models/AreaGuide');
const Service = require('../models/Service');
const Blog = require('../models/Blog');
const ChatbotChunk = require('../models/ChatbotChunk');
const ChatSession = require('../models/ChatSession');
const Property = require('../models/Property');
const ChatbotLead = require('../models/ChatbotLead');
const { CHATBOT_SUB_SOURCE } = ChatbotLead;
const { sendToZapier } = require('../services/zapierService');

const RULES = fs.readFileSync(path.join(__dirname, '../constants/chatbotRules.md'), 'utf8');

// Optional: model was removed from the repo; reindex picks it up again if restored.
let ChatbotKnowledge = null;
try {
  ChatbotKnowledge = require('../models/ChatbotKnowledge');
} catch (err) {
  ChatbotKnowledge = null;
}

const MAX_CHUNK_CHARS = 800;
const LONG_CHUNK_CHARS = 900;
const SINGLE_CHUNK_MAX = 1000;
const MIN_TAIL_CHARS = 250;
const EMBED_BATCH_SIZE = 50;
const MIN_SCORE = 0.25;
const MAX_CHUNKS_PER_DOCUMENT = 2;

let openaiClient = null;
const getOpenAI = () => {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
};

let chunkCache = null;

// ---------- Embeddings ----------

const embed = async (texts) => {
  const input = Array.isArray(texts) ? texts : [texts];
  const vectors = [];
  for (let i = 0; i < input.length; i += EMBED_BATCH_SIZE) {
    const res = await getOpenAI().embeddings.create({
      model: process.env.OPENAI_EMBEDDING_MODEL,
      input: input.slice(i, i + EMBED_BATCH_SIZE),
    });
    res.data.forEach((d) => vectors.push(d.embedding));
  }
  return vectors;
};

const HTML_ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const stripHtml = (s) =>
  String(s || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (e) => HTML_ENTITIES[e])
    .replace(/\{\{DIRHAM\}\}/g, 'AED')
    .replace(/[ \t]+/g, ' ')
    .trim();

const blogBlockToText = (block) => {
  if (['paragraph', 'heading2', 'heading3'].includes(block.type)) return stripHtml(block.text);
  if (block.type === 'list') return (block.items || []).map((item) => `- ${stripHtml(item)}`).join('\n');
  if (block.type === 'table') {
    return [block.headers, ...(block.rows || [])]
      .filter((row) => Array.isArray(row) && row.length)
      .map((row) => row.map(stripHtml).join(' | '))
      .join('\n');
  }
  return '';
};

// A unit longer than room is broken by line, then by sentence, then hard-cut as a last resort.
const splitUnit = (unit, room) => {
  if (unit.length <= room) return [unit];
  if (unit.includes('\n')) return packUnits(unit.split('\n'), room, '\n');
  const sentences = unit.split(/(?<=[.!?])\s+/);
  if (sentences.length > 1) return packUnits(sentences, room, ' ');
  const cuts = [];
  for (let i = 0; i < unit.length; i += room) cuts.push(unit.slice(i, i + room));
  return cuts;
};

// Greedy packing of whole units (paragraphs/sections) into parts of at most `room` chars, no overlap.
const packUnits = (units, room, sep = '\n') => {
  const parts = [];
  let current = '';
  units.flatMap((u) => splitUnit(u, room)).forEach((u) => {
    if (current && current.length + sep.length + u.length > room) {
      parts.push(current);
      current = u;
    } else {
      current = current ? `${current}${sep}${u}` : u;
    }
  });
  if (current) parts.push(current);

  const last = parts[parts.length - 1];
  if (parts.length > 1 && last.length < MIN_TAIL_CHARS && parts[parts.length - 2].length + last.length <= room * 1.2) {
    parts[parts.length - 2] += `${sep}${parts.pop()}`;
  }
  return parts;
};

// Short documents stay as one chunk; long ones are packed by paragraph with only `head` repeated.
const splitText = (head, body, maxChars = MAX_CHUNK_CHARS) => {
  const units = (Array.isArray(body) ? body : String(body || '').split(/\n+/))
    .map((u) => String(u || '').trim())
    .filter(Boolean);
  const joined = units.join('\n');
  if (!joined) return [];
  if (head.length + joined.length <= Math.max(maxChars, SINGLE_CHUNK_MAX)) return [`${head}${joined}`];

  const room = Math.max(maxChars - head.length, 200);
  return packUnits(units, room).map((p) => `${head}${p}`);
};

const blogUnits = (blog) => {
  const units = blog.description ? [`Summary: ${stripHtml(blog.description)}`] : [];
  let pendingHeading = '';
  (blog.content || []).forEach((block) => {
    const text = blogBlockToText(block);
    if (!text) return;
    if (block.type === 'heading2' || block.type === 'heading3') {
      pendingHeading = pendingHeading ? `${pendingHeading}\n${text}` : text;
      return;
    }
    units.push(pendingHeading ? `${pendingHeading}\n${text}` : text);
    pendingHeading = '';
  });
  if (pendingHeading) units.push(pendingHeading);
  (blog.faqs || []).forEach((f) => units.push(`Q: ${stripHtml(f.question)}\nA: ${stripHtml(f.answer)}`));
  return units;
};

const buildChunks = async () => {
  const [faqs, company, areas, knowledge, services, blogs] = await Promise.all([
    Faq.find({ isActive: true }).lean(),
    CompanyInfo.find({ isActive: true }).lean(),
    AreaGuide.find({ isActive: true }).lean(),
    ChatbotKnowledge ? ChatbotKnowledge.find({}).lean() : [],
    Service.find({ isActive: true }).select('title description overview subservices').lean(),
    Blog.find({ isActive: true }).select('title category description content faqs').lean(),
  ]);

  const chunks = [];
  const add = (source, doc, title, head, body, maxChars) => {
    splitText(head, body, maxChars).forEach((text) => chunks.push({ source, refId: doc._id, title, text }));
  };

  faqs.forEach((f) => add('faq', f, f.question, `Q: ${f.question}\nA: `, f.answer));
  company.forEach((c) => add('company', c, c.topic, `Q: ${c.question}\nA: `, c.answer));
  knowledge.forEach((k) => {
    const title = k.title || k.question || 'Knowledge';
    add('knowledge', k, title, `${title}\n`, k.content || k.answer || k.text);
  });
  areas.forEach((a) => {
    const highlights = (a.keyHighlights || []).map((h) => h.title).join(', ');
    const summary = `${String(a.about || '').slice(0, 600)}${highlights ? `\nHighlights: ${highlights}` : ''}`;
    add('area', a, a.title, `Area guide: ${a.title}\n`, summary);
  });
  services.forEach((s) => {
    const subservices = (s.subservices || []).map((sub) => {
      const detail = [sub.description, ...(sub.points || [])].map(stripHtml).filter(Boolean).join(' ');
      return `- ${stripHtml(sub.title).replace(/:$/, '')}${detail ? `: ${detail}` : ''}`;
    });
    const head = `Service: ${s.title}\n\n`;
    const overview = [stripHtml(s.description), ...(s.overview || []).map(stripHtml)].filter(Boolean);
    const included = subservices.length ? `What's included:\n${subservices.join('\n')}` : '';
    const whole = [...overview, included].filter(Boolean).join('\n');

    if (head.length + whole.length <= SINGLE_CHUNK_MAX) {
      add('service', s, s.title, head, whole);
    } else {
      add('service', s, s.title, head, overview, LONG_CHUNK_CHARS);
      add('service', s, s.title, `${head}What's included:\n`, subservices, LONG_CHUNK_CHARS);
    }
  });
  if (services.length) {
    const overview = services.map((s) => `- ${s.title}: ${stripHtml(s.description)}`).join('\n');
    add('service', {}, 'All services', 'Service: All Rocky Real Estate services\n\n', overview);
  }
  blogs.forEach((b) => {
    const head = `Blog: ${b.title}\n${b.category ? `Category: ${b.category}\n` : ''}\n`;
    add('blog', b, b.title, head, blogUnits(b), LONG_CHUNK_CHARS);
  });

  return chunks;
};

const reindex = async () => {
  const built = await buildChunks();
  const seen = new Set();
  const chunks = built.filter((c) => {
    const key = `${c.source}|${c.refId || ''}|${c.text.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const vectors = chunks.length ? await embed(chunks.map((c) => c.text)) : [];
  const docs = chunks.map((c, i) => ({ ...c, embedding: vectors[i] }));

  await ChatbotChunk.deleteMany({});
  if (docs.length) await ChatbotChunk.insertMany(docs);
  chunkCache = null;

  const chunksBySource = {};
  const refIdsBySource = {};
  docs.forEach((d) => {
    chunksBySource[d.source] = (chunksBySource[d.source] || 0) + 1;
    refIdsBySource[d.source] = refIdsBySource[d.source] || new Set();
    if (d.refId) refIdsBySource[d.source].add(String(d.refId));
  });
  const documentsBySource = Object.fromEntries(
    Object.entries(refIdsBySource).map(([source, ids]) => [source, ids.size])
  );

  return {
    chunks: docs.length,
    documentsBySource,
    chunksBySource,
    duplicatesRemoved: built.length - chunks.length,
  };
};

const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

const retrieve = async (query, k = 4) => {
  if (!chunkCache) chunkCache = await ChatbotChunk.find({}).lean();
  if (!chunkCache.length) return [];

  const [queryVector] = await embed(query);
  const ranked = chunkCache
    .map((c) => ({ source: c.source, refId: c.refId, title: c.title, text: c.text, score: cosine(queryVector, c.embedding) }))
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  const perDocument = {};
  const results = [];
  for (const c of ranked) {
    const key = `${c.source}|${c.refId || c.title}`;
    if ((perDocument[key] || 0) >= MAX_CHUNKS_PER_DOCUMENT) continue;
    perDocument[key] = (perDocument[key] || 0) + 1;
    results.push(c);
    if (results.length === k) break;
  }
  return results;
};

// ---------- Chat ----------

const MAX_TOOL_ROUNDS = 3;
const HISTORY_LIMIT = 10;
const FALLBACK_REPLY =
  "Sorry, I'm having trouble right now. Please try again in a moment, or contact our team and an agent will be happy to help.";
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toNumber = (field) => ({
  $convert: { input: { $replaceAll: { input: { $ifNull: [`$${field}`, ''] }, find: ',', replacement: '' } }, to: 'double', onError: null, onNull: null },
});

const searchProperties = async ({ purpose, location, type, bedrooms, min_price, max_price } = {}) => {
  const match = {};
  if (purpose) match.propertyPurpose = String(purpose).toLowerCase() === 'rent' ? 'Rent' : 'Buy';
  if (location) {
    const re = new RegExp(escapeRegex(location), 'i');
    match.$or = ['locality', 'subLocality', 'towerName', 'city', 'propertyTitle'].map((f) => ({ [f]: re }));
  }
  if (type) match.propertyType = new RegExp(escapeRegex(type), 'i');
  if (bedrooms !== undefined && bedrooms !== null && bedrooms !== '') match.bedrooms = String(parseInt(bedrooms, 10) || 0);

  const priceMatch = { $gt: 0 };
  if (Number(min_price) > 0) priceMatch.$gte = Number(min_price);
  if (Number(max_price) > 0) priceMatch.$lte = Number(max_price);

  const rows = await Property.aggregate([
    { $match: match },
    { $addFields: { priceNum: toNumber('price') } },
    { $match: { priceNum: priceMatch } },
    { $sort: { priceNum: 1 } },
    { $limit: 6 },
  ]);

  return rows.map((p) => ({
    propertyRefNo: p.propertyRefNo,
    title: p.propertyTitle,
    purpose: p.propertyPurpose,
    type: p.propertyType,
    bedrooms: p.bedrooms === '0' ? 'Studio' : p.bedrooms,
    priceAED: p.priceNum,
    rentFrequency: p.rentFrequency || null,
    location: [p.towerName, p.subLocality, p.locality].filter(Boolean).join(', '),
    image: p.images?.[0] || null,
  }));
};

const LEAD_CONTEXT_FIELDS = [
  ['purpose', 'Purpose'],
  ['location', 'Location'],
  ['budget', 'Budget'],
  ['bedrooms', 'Bedrooms'],
  ['timeline', 'Timeline'],
  ['notes', 'Notes'],
];

const saveLead = async (args = {}, sessionId) => {
  const name = String(args.name || '').trim();
  const phone = String(args.phone || '').trim();
  if (!name || !phone) return { ok: false, error: 'name and phone are required' };

  const existing = await ChatbotLead.findOne({ sessionId }).select('_id').lean();
  if (existing) return { ok: true, alreadySaved: true, leadId: String(existing._id) };

  const value = (key) => (args[key] === undefined || args[key] === null ? '' : String(args[key]).trim());
  const message = [
    `Session ID: ${sessionId}`,
    ...LEAD_CONTEXT_FIELDS.filter(([key]) => value(key)).map(([key, label]) => `${label}: ${value(key)}`),
  ].join('\n');

  const lead = await ChatbotLead.create({
    subSource: CHATBOT_SUB_SOURCE,
    fullName: name,
    email: /^\S+@\S+\.\S+$/.test(value('email')) ? value('email') : '',
    phone,
    inquiryType: value('purpose') || 'General',
    message,
    sessionId,
  });

  try {
    await sendToZapier({
      subSource: lead.subSource,
      fullName: lead.fullName,
      email: lead.email,
      phone: lead.phone,
      inquiryType: lead.inquiryType,
      message: lead.message,
      source: CHATBOT_SUB_SOURCE,
    });
  } catch (zapierError) {
    console.error('[Zapier] Unexpected error after chatbot lead save:', zapierError.message);
  }

  return { ok: true, leadId: String(lead._id) };
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_properties',
      description: 'Search Rocky Real Estate listings. Only use results from this tool when talking about listings.',
      parameters: {
        type: 'object',
        properties: {
          purpose: { type: 'string', enum: ['rent', 'buy'] },
          location: { type: 'string', description: 'Area, community or tower, e.g. "Dubai Marina"' },
          type: { type: 'string', description: 'Apartment, Villa, Townhouse, Office, etc.' },
          bedrooms: { type: 'integer', description: '0 for studio' },
          min_price: { type: 'number', description: 'AED' },
          max_price: { type: 'number', description: 'AED (yearly rent for rentals)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_lead',
      description: 'Save a lead for an agent to follow up. Only call when the user agreed or volunteered name and phone.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string', description: 'Phone or WhatsApp number' },
          email: { type: 'string', description: 'Only if the user gave one' },
          purpose: { type: 'string', enum: ['rent', 'buy', 'sell', 'property management'] },
          location: { type: 'string' },
          budget: { type: 'string', description: 'Plain AED number, e.g. "120000"' },
          bedrooms: { type: 'string' },
          timeline: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['name', 'phone'],
      },
    },
  },
];

const runTool = async (name, args, sessionId) => {
  if (name === 'search_properties') return searchProperties(args);
  if (name === 'save_lead') return saveLead(args, sessionId);
  return { error: `Unknown tool ${name}` };
};

// ---------- Session state guardrails ----------

const QUALIFICATION_FIELDS = ['purpose', 'location', 'budget', 'bedrooms', 'timeline'];
const QUESTION_FOR = {
  purpose: 'whether they want to buy or rent',
  location: 'which area they prefer',
  budget: 'their budget in AED',
  bedrooms: 'how many bedrooms they need',
  timeline: 'when they plan to move or buy',
};
const OFFER_TEXT = 'Want me to have an agent send you more options or arrange a viewing?';
const CONTACT_REQUEST_TEXT = "Sure. What's your name and best phone or WhatsApp number?";
const OFFER_RE = /have an agent|arrange a viewing/i;
const MISSING_NAME_TEXT = 'Thanks! And what name should the agent ask for?';
const MISSING_PHONE_TEXT = "Thanks! What's the best phone or WhatsApp number to reach you?";
const CONTACT_PROMPTS = [CONTACT_REQUEST_TEXT, MISSING_NAME_TEXT, MISSING_PHONE_TEXT];
const NEXT_QUESTION = {
  purpose: 'Are you looking to buy or rent?',
  location: 'Which area do you prefer?',
  budget: "What's your budget in AED?",
  bedrooms: 'How many bedrooms do you need?',
};
const CHEAPER_RE = /\b(cheaper|lower budget|lower price|more affordable|less expensive)\b/i;
const REFINE_RE = /\b(bigger|larger|more options|other options)\b/i;
const DECLINE_RE = /^\s*(no|nope|nah)\b|no thanks|not now|not interested|maybe later|i'?m good/i;
const ACCEPT_RE = /^\s*(yes|yeah|yep|sure|ok|okay|please|please do|go ahead|of course|sounds good|definitely|why not)\b/i;
const AGENT_REQUEST_RE = /\b(call me|contact me|talk to an? agent|speak (to|with) an? agent|(arrange|book|schedule) a viewing)\b/i;
const LOCATION_FIXES = [[/\bDubai Lake Towers\b/gi, 'Jumeirah Lake Towers'], [/\bDubai Village Circle\b/gi, 'Jumeirah Village Circle']];
const CONTACT_ASK_RE = /\b(agent|viewing|your name|phone|whatsapp|contact (details|number))\b/i;
const PHONE_RE = /(?:\+?971[\s-]?|0)5\d(?:[\s-]?\d){7}|\+\d[\d\s-]{7,14}\d/;
const NAME_STOPWORDS = new Set([
  'looking', 'interested', 'just', 'here', 'trying', 'planning', 'searching', 'not', 'from', 'in', 'a', 'an', 'the',
  'ok', 'fine', 'good', 'call', 'me', 'contact', 'reach', 'my', 'number', 'is', 'on', 'at', 'phone', 'mobile', 'whatsapp',
]);
const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

let locationCache = null;
const getKnownLocations = async () => {
  if (locationCache) return locationCache;
  const [localities, areas] = await Promise.all([Property.distinct('locality'), AreaGuide.distinct('title')]);
  // [text to match, canonical name], so "JVC" resolves to "Jumeirah Village Circle".
  const names = new Map();
  [...localities, ...areas].filter(Boolean).forEach((raw) => {
    const canonical = raw.replace(/\s*\([^)]*\)/, '').trim();
    names.set(canonical, canonical);
    const alias = raw.match(/\(([^)]+)\)/);
    if (alias && !names.has(alias[1].trim())) names.set(alias[1].trim(), canonical);
  });
  locationCache = [...names.entries()]
    .filter(([label]) => label.length >= 3 && label.toLowerCase() !== 'dubai')
    .sort((a, b) => b[0].length - a[0].length);
  return locationCache;
};

const extractQualification = (text, locations) => {
  const t = text.toLowerCase();
  const found = {};
  const rent = /\b(rent|renting|rental|lease)\b/.test(t);
  const buy = /\b(buy|buying|purchase|purchasing|invest|investing)\b/.test(t);
  const sell = /\b(sell|selling)\b/.test(t);
  if (rent + buy + sell === 1) found.purpose = rent ? 'rent' : buy ? 'buy' : 'sell';

  const location = locations.find(([label]) => new RegExp(`\\b${escapeRegex(label)}\\b`, 'i').test(text));
  if (location) found.location = location[1];

  if (/\bstudio\b/.test(t)) found.bedrooms = '0';
  const beds = t.match(/\b(\d|one|two|three|four|five|six)\s*-?\s*(bed|beds|bedroom|bedrooms|br|bhk)\b/);
  if (beds) found.bedrooms = String(WORD_NUMBERS[beds[1]] || beds[1]);

  const noPhone = t.replace(new RegExp(PHONE_RE.source, 'g'), ' ');
  const short = noPhone.match(/(\d+(?:\.\d+)?)\s*(k|m|mn|million)\b/);
  const long =
    noPhone.match(/(?:aed|budget|under|below|around|up to|upto|max)\s*(?:of\s*|is\s*)?(?:aed\s*)?(\d[\d,]{3,})/) ||
    noPhone.match(/(\d[\d,]{4,})\s*(?:aed|dirhams?|per year|a year|yearly)/);
  if (short) found.budget = String(Math.round(parseFloat(short[1]) * (short[2] === 'k' ? 1000 : 1000000)));
  else if (long) found.budget = long[1].replace(/,/g, '');

  const timeline = t.match(/\b(asap|immediately|right away|this (week|month|year)|next (week|month|year)|(in|within) \d+ (days?|weeks?|months?))\b/);
  if (timeline) found.timeline = timeline[0];
  return found;
};

// Returns { name, phone } only when the message clearly contains both.
const detectContact = (text) => {
  const phoneMatch = text.match(PHONE_RE);
  if (!phoneMatch) return null;

  const introduced = text.match(/\b(?:i'?m|i am|my name is|my name's|this is|name is|name:)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)/i);
  let candidate = introduced ? introduced[1] : '';
  if (!candidate) {
    const before = text.slice(0, phoneMatch.index).replace(/[\s,;:–-]+$/, '').trim();
    if (/^[a-z][a-z' -]{1,40}$/i.test(before) && before.split(/\s+/).length <= 3) candidate = before;
  }

  const words = [];
  for (const word of candidate.split(/\s+/).filter(Boolean)) {
    if (NAME_STOPWORDS.has(word.toLowerCase())) break;
    words.push(word);
  }
  return words.length ? { name: words.join(' '), phone: phoneMatch[0].trim() } : null;
};

// Budget/bedrooms only come from the user's own words; model-chosen search args may be guesses.
const rememberSearchCriteria = (qualification, args = {}) => {
  if (!qualification.purpose && args.purpose) qualification.purpose = String(args.purpose).toLowerCase();
  if (!qualification.location && args.location) qualification.location = String(args.location);
};

const searchArgsFromState = (q) => {
  const args = { purpose: q.purpose, location: q.location, bedrooms: q.bedrooms, max_price: Number(q.budget) || undefined };
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== ''));
};

// Name from a reply to the contact prompt, e.g. "Ahmed" or "it's Ahmed Khan".
const looseName = (text) => {
  const cleaned = String(text || '')
    .replace(new RegExp(PHONE_RE.source, 'g'), ' ')
    .replace(/\b(my name is|my name's|i am|i'm|this is|it's|its|name|and|my|number|phone|whatsapp|is)\b/gi, ' ')
    .replace(/[^a-z' -]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/^[a-z][a-z'-]*( [a-z][a-z'-]*){0,2}$/i.test(cleaned)) return '';
  return NAME_STOPWORDS.has(cleaned.split(' ')[0].toLowerCase()) || ACCEPT_RE.test(cleaned) || DECLINE_RE.test(cleaned) ? '' : cleaned;
};

const describeSearch = (q, maxPrice) => {
  const beds = q.bedrooms === '0' ? 'studio ' : q.bedrooms ? `${q.bedrooms}-bedroom ` : '';
  const kind = q.purpose === 'rent' ? 'rental' : 'property for sale';
  const where = q.location ? ` in ${q.location}` : '';
  const price = maxPrice ? ` under AED ${Number(maxPrice).toLocaleString('en-US')}${q.purpose === 'rent' ? '/year' : ''}` : '';
  return `${beds}${kind}${where}${price}`;
};

const mapSentences = (reply, keep) =>
  reply
    .split('\n')
    .map((line) => line.split(/(?<=[.!?])\s+/).filter(keep).join(' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const removeQuestions = (reply) => mapSentences(reply, (s) => !s.includes('?'));
const limitToOneQuestion = (reply) => {
  const total = reply.split('\n').flatMap((line) => line.split(/(?<=[.!?])\s+/)).filter((s) => s.includes('?')).length;
  let seen = 0;
  return mapSentences(reply, (s) => !s.includes('?') || (seen += 1) === total);
};
const withQuestion = (reply, question) => [removeQuestions(reply), question].filter(Boolean).join('\n\n');

const buildStateContext = (state, { savedName }) => {
  const q = state.qualification;
  const contactClosed = state.leadSaved || state.leadOfferDeclined;
  const lines = [
    ...QUALIFICATION_FIELDS.map((field) => `${field}: ${q[field] || 'unknown'}`),
    `leadOfferShown: ${state.leadOfferShown}`,
    `leadOfferDeclined: ${state.leadOfferDeclined}`,
    `leadSaved: ${state.leadSaved}`,
  ];

  const steps = [];
  if (savedName) steps.push(`A lead was just saved for ${savedName}. Thank them and confirm an agent will contact them shortly.`);
  if (q.purpose && q.purpose !== 'sell' && (q.location || q.budget || q.bedrooms)) {
    steps.push('If search results are provided, summarize them briefly. Only call search_properties again if the user asked for something different.');
  }
  const missing = QUALIFICATION_FIELDS.find((field) => !q[field]);
  steps.push(
    missing
      ? `Ask at most ONE question; if it is a qualifying question ask ONLY ${QUESTION_FOR[missing]}. Never ask about known fields.`
      : 'Ask at most ONE question. All qualification details are known.'
  );
  steps.push('Do NOT offer an agent or viewing and do NOT ask for name, phone or contact details; the system handles that.');
  if (contactClosed) steps.push('The lead is closed for this session (saved or declined).');

  return `SESSION STATE (authoritative; never ask for values that are known):\n${lines.join('\n')}\n\nNEXT STEP:\n- ${steps.join('\n- ')}`;
};

// Drops question sentences that offer an agent or ask for contact details.
const stripContactAsks = (reply) => {
  const cleaned = reply
    .split('\n')
    .map((line) => line.split(/(?<=[.!?])\s+/).filter((s) => !(s.includes('?') && CONTACT_ASK_RE.test(s))).join(' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || 'Happy to keep helping. What would you like to see next?';
};

const chat = async ({ sessionId, message }) => {
  const session = await ChatSession.findOne({ sessionId }).lean();
  const history = (session?.messages || []).slice(-HISTORY_LIMIT).map(({ role, content }) => ({ role, content }));
  const state = {
    qualification: { ...(session?.qualification || {}) },
    leadOfferShown: Boolean(session?.leadOfferShown),
    leadOfferDeclined: Boolean(session?.leadOfferDeclined),
    leadSaved: Boolean(session?.leadSaved),
  };

  let reply = FALLBACK_REPLY;
  let properties = [];
  let savedName = '';
  let criteriaChanged = false;
  let enforce = false; // true when the reply came from the model or a search and still needs lead/question guardrails
  try {
    // 1. Qualification
    const extracted = extractQualification(message, await getKnownLocations());
    criteriaChanged = ['purpose', 'location', 'budget', 'bedrooms'].some((f) => extracted[f] && extracted[f] !== state.qualification[f]);
    Object.assign(state.qualification, extracted);
    const q = state.qualification;

    // 2. Offer acceptance / decline
    const pastMessages = session?.messages || [];
    const lastAssistant = [...pastMessages].reverse().find((m) => m.role === 'assistant')?.content || '';
    const previousUser = [...pastMessages].reverse().find((m) => m.role === 'user')?.content || '';
    const offerPending = state.leadOfferShown && !state.leadOfferDeclined && !state.leadSaved && OFFER_RE.test(lastAssistant);
    const awaitingContact = !state.leadSaved && CONTACT_PROMPTS.includes(lastAssistant);
    if (!state.leadSaved && (/just (browsing|looking)/i.test(message) || (offerPending && DECLINE_RE.test(message)))) {
      state.leadOfferDeclined = true;
    }
    const acceptedOffer =
      !state.leadSaved && !awaitingContact && ((offerPending && ACCEPT_RE.test(message)) || AGENT_REQUEST_RE.test(message));

    // 3. Contact details (volunteered, or answering the contact prompt)
    let contact = state.leadSaved ? null : detectContact(message);
    if (!contact && awaitingContact) {
      const partial = lastAssistant !== CONTACT_REQUEST_TEXT ? previousUser : '';
      const phone = (message.match(PHONE_RE) || partial.match(PHONE_RE) || [])[0] || '';
      const name = looseName(message) || looseName(partial);
      contact = { name, phone: phone.trim() };
    }

    // 4. Save lead / fixed lead-flow replies
    if (contact?.name && contact?.phone) {
      const result = await saveLead({ ...q, ...contact }, sessionId);
      if (result.ok) {
        state.leadSaved = true;
        savedName = contact.name;
        reply = `Thanks ${contact.name}. An agent will contact you shortly.`;
      }
    }

    if (acceptedOffer) {
      reply = CONTACT_REQUEST_TEXT;
    } else if (awaitingContact && !savedName && (contact?.name || contact?.phone)) {
      reply = contact.phone ? MISSING_NAME_TEXT : MISSING_PHONE_TEXT;
    } else if (savedName && !criteriaChanged) {
      // confirmation already set above
    } else if (criteriaChanged && !q.location && !q.budget && !q.bedrooms && q.purpose && message.split(/\s+/).length <= 6 && !message.includes('?')) {
      reply = `Great, let's find you ${q.purpose === 'rent' ? 'a rental' : q.purpose === 'buy' ? 'a property to buy' : 'the right buyer'}. ${NEXT_QUESTION.location}`;
    } else {
      // 5. Search when criteria changed or the user asked for cheaper
      const canSearch = ['rent', 'buy'].includes(q.purpose) && Boolean(q.location || q.budget || q.bedrooms);
      const forceRefineSearch = canSearch && !criteriaChanged && REFINE_RE.test(message);
      let injectedSearch = null;
      let noResultsText = '';

      if (canSearch && CHEAPER_RE.test(message)) {
        const current = Number(q.budget) || 0;
        const maxPrice = current ? Math.floor((current * 0.8) / 1000) * 1000 : 0;
        injectedSearch = searchArgsFromState({ ...q, budget: maxPrice ? String(maxPrice) : q.budget });
        properties = await searchProperties(injectedSearch);
        if (properties.length && maxPrice) q.budget = String(maxPrice);
        if (!properties.length) noResultsText = `I couldn't find a cheaper ${describeSearch(q, maxPrice || q.budget)}.`;
      } else if (canSearch && criteriaChanged) {
        injectedSearch = searchArgsFromState(q);
        properties = await searchProperties(injectedSearch);
        if (!properties.length) noResultsText = `I couldn't find a ${describeSearch(q, injectedSearch.max_price)}.`;
      }

      if (noResultsText) {
        reply = `${noResultsText} Would you like nearby areas or a different budget?`;
        enforce = true;
      } else {
        const hits = await retrieve(message, 4);
        const knowledge = hits.length
          ? hits.map((h, i) => `[${i + 1}] (${h.source}) ${h.title}\n${h.text}`).join('\n\n')
          : 'No relevant knowledge found.';
        const messages = [
          { role: 'system', content: `${RULES}\n\nKNOWLEDGE (use only this for company/area facts):\n${knowledge}` },
          ...history,
          { role: 'user', content: message },
          { role: 'system', content: buildStateContext(state, { savedName }) },
        ];

        if (injectedSearch) {
          messages.push(
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_state_search', type: 'function', function: { name: 'search_properties', arguments: JSON.stringify(injectedSearch) } }] },
            { role: 'tool', tool_call_id: 'call_state_search', content: JSON.stringify(properties) }
          );
        }

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
          let toolChoice = round === MAX_TOOL_ROUNDS ? 'none' : 'auto';
          if (round === 0 && forceRefineSearch) toolChoice = { type: 'function', function: { name: 'search_properties' } };

          const completion = await getOpenAI().chat.completions.create({
            model: process.env.OPENAI_CHAT_MODEL,
            reasoning_effort: process.env.OPENAI_REASONING_EFFORT,
            messages,
            tools: TOOLS,
            tool_choice: toolChoice,
          });
          const msg = completion.choices[0].message;
          if (!msg.tool_calls?.length) {
            if (msg.content?.trim()) {
              reply = msg.content.trim();
              enforce = true;
            }
            break;
          }

          messages.push(msg);
          for (const call of msg.tool_calls) {
            let result;
            try {
              const args = JSON.parse(call.function.arguments || '{}');
              result = await runTool(call.function.name, args, sessionId);
              if (call.function.name === 'search_properties') {
                properties = result;
                rememberSearchCriteria(state.qualification, args);
              }
              if (call.function.name === 'save_lead' && result.ok) state.leadSaved = true;
            } catch (toolError) {
              console.error(`[Chatbot] Tool ${call.function.name} failed:`, toolError.message);
              result = { error: 'Tool failed' };
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          }
        }
      }
    }
  } catch (error) {
    console.error('[Chatbot] Chat failed:', error.message);
  }

  // 6. Guardrails over model/search wording: the offer and next question come from state, never from the model.
  if (enforce) {
    const q = state.qualification;
    LOCATION_FIXES.forEach(([pattern, fixed]) => {
      reply = reply.replace(pattern, fixed);
    });
    reply = stripContactAsks(reply);
    const missing = ['purpose', 'location', 'budget', 'bedrooms'].find((f) => !q[f]);
    if (q.purpose && q.location && q.budget && !state.leadOfferShown && !state.leadOfferDeclined && !state.leadSaved) {
      reply = withQuestion(reply, OFFER_TEXT);
      state.leadOfferShown = true;
    } else if (criteriaChanged && missing) {
      reply = withQuestion(reply, NEXT_QUESTION[missing]);
    } else {
      reply = limitToOneQuestion(reply);
    }
    if (savedName && !/agent will contact/i.test(reply)) reply = `Thanks ${savedName}. An agent will contact you shortly.\n\n${reply}`;
  }

  const now = new Date();
  await ChatSession.findOneAndUpdate(
    { sessionId },
    {
      $set: {
        qualification: state.qualification,
        leadOfferShown: state.leadOfferShown,
        leadOfferDeclined: state.leadOfferDeclined,
        leadSaved: state.leadSaved,
      },
      $push: { messages: { $each: [{ role: 'user', content: message, at: now }, { role: 'assistant', content: reply, at: now }] } },
    },
    { upsert: true }
  );

  return { reply, properties };
};

const getHistory = async (sessionId) => {
  const session = await ChatSession.findOne({ sessionId }).lean();
  return session?.messages || [];
};

module.exports = {
  embed,
  reindex,
  retrieve,
  chat,
  getHistory,
};
