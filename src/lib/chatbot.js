const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const Faq = require('../models/Faq');
const AreaGuide = require('../models/AreaGuide');
const Service = require('../models/Service');
const Blog = require('../models/Blog');
const TeamMember = require('../models/TeamMember');
const ChatbotChunk = require('../models/ChatbotChunk');
const ChatSession = require('../models/ChatSession');
const Property = require('../models/Property');
const ChatbotLead = require('../models/ChatbotLead');
const { CHATBOT_SUB_SOURCE } = ChatbotLead;
const { sendToZapier } = require('../services/zapierService');
const { buildCommonPipeline, CATEGORY_MATCH, propertyCategory } = require('../services/propertyDbService');

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
  const [faqs, areas, knowledge, services, blogs, team] = await Promise.all([
    Faq.find({ isActive: true }).lean(),
    AreaGuide.find({ isActive: true }).lean(),
    ChatbotKnowledge ? ChatbotKnowledge.find({}).lean() : [],
    Service.find({ isActive: true }).select('title description overview subservices').lean(),
    Blog.find({ isActive: true }).select('title category description content faqs').lean(),
    // Only leadership roles are indexed (filtered below); contact details and admin flags never are.
    TeamMember.find({ isActive: true }).select('name designation department').sort({ order: 1 }).lean(),
  ]);

  const chunks = [];
  const add = (source, doc, title, head, body, maxChars) => {
    splitText(head, body, maxChars).forEach((text) => chunks.push({ source, refId: doc._id, title, text }));
  };

  faqs.forEach((f) => add('faq', f, f.question, `Q: ${f.question}\nA: `, f.answer));
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
  team
    .filter((m) => leadershipRoleOf(m.designation))
    .forEach((m) =>
      add('team', m, m.name, `${COMPANY} team member: ${m.name}\n`, `Designation: ${m.designation}\nDepartment: ${m.department}`)
    );

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

const loadChunks = async () => {
  if (!chunkCache) chunkCache = await ChatbotChunk.find({}).lean();
  return chunkCache;
};

const retrieve = async (query, k = 4) => {
  await loadChunks();
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

// ---------- Team ----------

const COMPANY = 'Rocky Real Estate';
const chunkField = (text, label) => (String(text).match(new RegExp(`^${label}: (.*)$`, 'm')) || [])[1] || '';

// Read from the indexed team chunks so answers refresh together with retrieval after a reindex.
const teamRoster = async () =>
  (await loadChunks())
    .filter((c) => c.source === 'team')
    .map((c) => ({
      name: chunkField(c.text, `${COMPANY} team member`),
      designation: chunkField(c.text, 'Designation'),
      department: chunkField(c.text, 'Department'),
    }))
    .filter((m) => m.name && leadershipRoleOf(m.designation));

// The chatbot only shares these leadership roles; other staff are never indexed or answered.
const LEADERSHIP_ROLES = ['Founder', 'Director', 'CEO', 'General Manager', 'Head of Operations'];
// Wording -> role, most specific first. Owner and Founder are the same role for Rocky; every other role is distinct.
// Managing Director, Chairman and Partner are recognised only so they are never read as "Director" or answered by guessing.
const ROLE_WORDS = [
  ['Managing Director', /\bmanaging directors?\b/i],
  ['General Manager', /\b(general managers?|gm)\b/i],
  ['Head of Operations', /\b(head of operations|operations head)\b/i],
  ['CEO', /\b(ceos?|chief executive( officer)?)\b/i],
  ['Founder', /\b(founders?|founded|owners?|owns)\b/i],
  ['Chairman', /\bchair(man|woman|person)?\b/i],
  ['Partner', /\bpartners?\b/i],
  ['Director', /\bdirectors?\b/i],
];
const normalizeLeadershipRole = (text) => ROLE_WORDS.find(([, re]) => re.test(text))?.[0] || null;
// Exact designation -> leadership role, so "Director of Marketing" or "Head of Property Management" never count.
const LEADERSHIP_DESIGNATIONS = {
  founder: 'Founder',
  owner: 'Founder',
  director: 'Director',
  ceo: 'CEO',
  'chief executive officer': 'CEO',
  'general manager': 'General Manager',
  gm: 'General Manager',
  'head of operations': 'Head of Operations',
  'operations head': 'Head of Operations',
};
const leadershipRoleOf = (designation) => LEADERSHIP_DESIGNATIONS[String(designation || '').trim().toLowerCase()] || null;

const TEAM_ASK_RE = /\b(who|whom|who's|name of|names of|tell me about)\b/i;
const NOT_TEAM_RE = /\b(apartments?|villas?|propert(y|ies)(?! management)|units?|buildings?|listings?|flats?|landlords?|towers?|townhouses?|penthouses?|developers?|plots?)\b/i;
// Other staff roles and departments: answered with LEADERSHIP_ONLY_TEXT, never looked up.
const OTHER_STAFF_RE = /\b(receptionists?|designers?|coordinators?|accountants?|photographers?|videographers?|editors?|telesales|sales|marketing|finance|crm|hr|recruit\w*|secretar(y|ies)|assistants?|executives?|team leaders?|consultants?|agents?|brokers?|staff|employees?|managers?|head of|department|team)\b/i;
const LEADERSHIP_ONLY_TEXT = `I can only share details of ${COMPANY}'s leadership team: ${LEADERSHIP_ROLES.slice(0, -1).join(', ')} and ${LEADERSHIP_ROLES.slice(-1)}.`;

const LEADERSHIP_TOPIC_CONTEXT = [
  `CURRENT TOPIC: ${COMPANY} leadership. The latest message is a follow-up on that topic.`,
  '- Answer it using only the leadership list and KNOWLEDGE (name, designation, department). If the detail asked for is not there, say so briefly.',
  '- Do NOT ask property questions (buy/rent, area, budget, bedrooms, furnishing) and do NOT offer a property search.',
].join('\n');

const isLeadershipQuery = (text) => TEAM_ASK_RE.test(text) && !NOT_TEAM_RE.test(text);
const withArticle = (label) => `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`;
const memberLines = (members) => members.map((m) => `- ${m.name} — ${m.designation}`).join('\n');
const normDept = (s) => String(s).toLowerCase().replace(/\b(the|department|dept|team)\b/g, ' ').replace(/\s+/g, ' ').trim();

const roleAnswer = (role, roster) => {
  const matches = roster.filter((m) => leadershipRoleOf(m.designation) === role);
  if (!matches.length) return `I don't have ${withArticle(role)} listed in the current ${COMPANY} team information.`;
  if (matches.length === 1) return `The ${role} of ${COMPANY} is ${matches[0].name}.`;
  return `${COMPANY} currently lists:\n${memberLines(matches)}`;
};

const departmentAnswer = (text, roster) => {
  const asked = text.match(
    /\b(?:who|whom|people|members|staff|everyone|anyone)\b[^?]*?\b(?:in|on|of|from)\s+(?:the\s+)?([a-z&' ]+?)\s*[?.!]*$/i
  );
  if (!asked) return null;
  const term = normDept(asked[1]);
  if (!term) return null;

  const exact = [...new Set(roster.map((m) => m.department).filter(Boolean))].find((d) => normDept(d) === term);
  return exact ? `The ${exact} department currently includes:\n${memberLines(roster.filter((m) => m.department === exact))}` : null;
};

const personAnswer = (text, roster) => {
  const asked = text.match(/^\s*(?:who is|who's|tell me about|do you know)\s+(.+?)\s*[?.!]*$/i);
  if (!asked) return null;
  const wanted = asked[1].toLowerCase().replace(/\s+/g, ' ').trim();
  const single = !wanted.includes(' ') && wanted.length >= 3;
  const matches = roster.filter((m) => {
    const name = m.name.toLowerCase();
    return name === wanted || (single && name.split(/\s+/).includes(wanted));
  });
  if (!matches.length) return null;
  if (matches.length > 1) return `${COMPANY} currently lists:\n${memberLines(matches)}`;
  const [m] = matches;
  return `${m.name} is listed as ${m.designation}${m.department ? ` in the ${m.department} department` : ''}.`;
};

// Deterministic answers for leadership role / department / person questions; null when the message isn't one.
const teamAnswer = async (text) => {
  if (!isLeadershipQuery(text)) return null;
  const roster = await teamRoster();
  if (!roster.length) return null;
  const role = normalizeLeadershipRole(text);
  if (role) return roleAnswer(role, roster);
  return departmentAnswer(text, roster) || personAnswer(text, roster) || (OTHER_STAFF_RE.test(text) ? LEADERSHIP_ONLY_TEXT : null);
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

// Website routes per listing category (relative, so links stay on the current origin).
const CATEGORY_PATHS = { rent: '/properties/rent/in-dubai', buy: '/properties/buy/in-dubai', 'off-plan': '/off-plan-properties/in-dubai' };
const CATEGORIES = Object.keys(CATEGORY_PATHS);
// "rent" | "buy" | "off-plan" from a purpose/category value; null when unknown.
const toCategory = (value) => {
  const v = String(value || '').toLowerCase().replace(/[\s_-]/g, '');
  if (v === 'rent') return 'rent';
  if (v === 'buy') return 'buy';
  return v === 'offplan' ? 'off-plan' : null;
};

const propertyUrl = (p) =>
  p.propertyRefNo ? `${CATEGORY_PATHS[propertyCategory(p)]}/${encodeURIComponent(p.propertyRefNo)}` : null;

const formatProperty = (p) => ({
  propertyRefNo: p.propertyRefNo,
  category: propertyCategory(p),
  path: propertyUrl(p),
  title: p.propertyTitle,
  purpose: p.propertyPurpose,
  type: p.propertyType,
  bedrooms: p.bedrooms === '0' ? 'Studio' : p.bedrooms,
  priceAED: p.priceNum,
  rentFrequency: p.rentFrequency || null,
  location: [p.towerName, p.subLocality, p.locality].filter(Boolean).join(', '),
  image: p.images?.[0] || null,
  url: propertyUrl(p),
});

// Same query as the buy/rent listing pages, so a View All URL built from these args shows the same total.
// Area terms are what the listing page derives from the URL slug ("dubai-marina" -> "dubai marina").
const FURNISHED_VALUES = { furnished: 'Yes', unfurnished: 'No', 'partly furnished': 'Partly' };

const findProperties = async ({ purpose, location, type, bedrooms, furnishing, min_price, max_price } = {}, limit = 6) => {
  const search = (Array.isArray(location) ? location : [location]).filter(Boolean).map((l) => areaSlug([l]).replace(/-/g, ' '));
  const hasBeds = bedrooms !== undefined && bedrooms !== null && bedrooms !== '';
  const filters = {
    propertyType: type || undefined,
    priceMin: Number(min_price) > 0 ? Number(min_price) : undefined,
    priceMax: Number(max_price) > 0 ? Number(max_price) : undefined,
    beds: hasBeds ? parseInt(bedrooms, 10) || 0 : undefined,
    furnished: FURNISHED_VALUES[furnishing],
  };
  const forced = CATEGORY_MATCH[toCategory(purpose)] || {};

  const [result] = await Property.aggregate([
    ...buildCommonPipeline({ search, filters, forced }),
    { $addFields: { priceNum: toNumber('price') } },
    { $sort: { priceNum: 1 } },
    { $facet: { items: [{ $limit: limit }], meta: [{ $count: 'total' }] } },
  ]);

  const items = result.items.map(formatProperty);
  return { items, total: result.meta[0]?.total || 0, startingPrice: items[0]?.priceAED || null };
};

const searchProperties = async (args = {}) => (await findProperties(args)).items;

const LEAD_CONTEXT_FIELDS = [
  ['purpose', 'Purpose'],
  ['location', 'Location'],
  ['propertyType', 'Property Type'],
  ['budget', 'Budget'],
  ['bedrooms', 'Bedrooms'],
  ['timeline', 'Timeline'],
  ['notes', 'Notes'],
];
const INTEREST_FIELDS = [
  ['interest', 'Interest'],
  ['selectedPropertyRefNo', 'Property Ref'],
  ['selectedPropertyTitle', 'Property'],
  ['selectedLocation', 'Property Location'],
];

const fieldLines = (fields, args) =>
  fields
    .filter(([key]) => args[key] !== undefined && args[key] !== null && String(args[key]).trim())
    .map(([key, label]) => `${label}: ${String(args[key]).trim()}`);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

// One lead per session: a later viewing request or email is added to the existing lead.
const updateLead = async (sessionId, { email, ...interest } = {}) => {
  const lead = await ChatbotLead.findOne({ sessionId });
  if (!lead) return null;
  if (email && EMAIL_RE.test(email) && !lead.email) lead.email = email;
  if (interest.interest || interest.selectedPropertyRefNo || interest.selectedLocation) {
    const lines = fieldLines(INTEREST_FIELDS, { interest: 'Book a Viewing', ...interest });
    const key = interest.selectedPropertyRefNo ? `Property Ref: ${interest.selectedPropertyRefNo}` : lines.join('\n');
    if (!lead.message.includes(key)) lead.message = [lead.message, lines.join('\n')].filter(Boolean).join('\n\n');
  }
  if (lead.isModified()) await lead.save();
  return lead;
};

const saveLead = async (args = {}, sessionId) => {
  const name = String(args.name || '').trim();
  const rawPhone = String(args.phone || '').trim();
  if (!name || !rawPhone) return { ok: false, error: 'name and phone are required' };
  const phoneMatch = rawPhone.match(PHONE_RE);
  if (!phoneMatch) return { ok: false, error: INVALID_PHONE_TEXT };
  const phone = normalizePhone(phoneMatch[0]);

  const existing = await ChatbotLead.findOne({ sessionId }).select('_id').lean();
  if (existing) {
    const { interest, selectedPropertyRefNo, selectedPropertyTitle, selectedLocation, email } = args;
    await updateLead(sessionId, { email, interest, selectedPropertyRefNo, selectedPropertyTitle, selectedLocation });
    return { ok: true, alreadySaved: true, leadId: String(existing._id) };
  }

  const value = (key) => (args[key] === undefined || args[key] === null ? '' : String(args[key]).trim());
  const message = [...fieldLines(LEAD_CONTEXT_FIELDS, args), ...fieldLines(INTEREST_FIELDS, args)].join('\n');

  const lead = await ChatbotLead.create({
    subSource: CHATBOT_SUB_SOURCE,
    fullName: name,
    email: EMAIL_RE.test(value('email')) ? value('email') : '',
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
          purpose: { type: 'string', enum: ['rent', 'buy', 'off-plan'] },
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
          phone: { type: 'string', description: 'Phone or WhatsApp number with country code, e.g. +447911123456' },
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
  purpose: 'whether they want to buy, rent, or explore off-plan properties',
  location: 'which area they prefer',
  budget: 'their budget in AED',
  bedrooms: 'how many bedrooms they need',
  timeline: 'when they plan to move or buy',
};
const OFFER_TEXT = 'Want me to have an agent send you more options or arrange a viewing?';
const OFFER_RE = /have an agent|arrange a viewing/i;
const CONTACT_REQUEST_TEXT = "Please share your name and phone number with country code. You can also include your email if you'd like.";
const MISSING_NAME_TEXT = "What's your name?";
const INVALID_PHONE_TEXT = 'Please enter a valid phone number, including your country code.';
const CONTACT_PROMPTS = [CONTACT_REQUEST_TEXT, MISSING_NAME_TEXT, INVALID_PHONE_TEXT];
const isContactPrompt = (text) => CONTACT_PROMPTS.includes(text);
const EMAIL_FIND_RE = /[^\s@,;:<>()]+@[^\s@,;:<>()]+\.[a-z]{2,}/i;
// Anything that looks like a typed number ("+" and digits, or 6+ digit characters), checked only when a phone is expected.
const PHONE_ATTEMPT_RE = /\+[\d\s().-]*\d|\d[\d\s().-]{4,}\d/;
const NEXT_QUESTION = {
  purpose: 'Are you looking to buy or rent?',
  location: 'Which area do you prefer?',
  budget: "What's your budget in AED?",
  bedrooms: 'How many bedrooms do you need?',
};
const CHEAPER_RE = /\b(cheaper|lower budget|lower price|more affordable|less expensive)\b/i;
const REFINE_RE = /\b(bigger|larger|more options|other options)\b/i;
const DECLINE_RE = /^\s*(no|nope|nah)\b|no thanks|not now|not interested|maybe later|i'?m good/i;
const SHOW_ME_RE = /^\s*(show\b|that'?s (fine|ok|okay)\b|fine\b)/i;
const TOO_EXPENSIVE_RE = /too (expensive|high|much)|out of (my )?budget/i;
const FALLBACK_DECLINE_TEXT = 'No problem. I can help you look in another area or adjust the property type. Which would you prefer?';
const ACCEPT_RE = /^\s*(yes|yeah|yep|sure|ok|okay|please|please do|go ahead|of course|sounds good|definitely|why not)\b/i;
const AGENT_REQUEST_RE = /\b(call me|contact me|talk to an? agent|speak (to|with) an? agent|(arrange|book|schedule) a viewing)\b/i;
const LOCATION_FIXES = [[/\bDubai Lake Towers\b/gi, 'Jumeirah Lake Towers'], [/\bDubai Village Circle\b/gi, 'Jumeirah Village Circle']];
const CONTACT_ASK_RE = /\b(agent|viewing|your name|phone|whatsapp|e-?mail|contact (details|number))\b/i;
// Valid phone: "+" and country code, 8–15 digits in total (E.164), with optional spaces, hyphens, dots or parentheses.
const PHONE_RE = /(?<![\d+])\+[1-9](?:[\s().-]*\d){7,14}(?![\d])/;
const NAME_STOPWORDS = new Set([
  'looking', 'interested', 'just', 'here', 'trying', 'planning', 'searching', 'not', 'from', 'in', 'a', 'an', 'the',
  'ok', 'fine', 'good', 'call', 'me', 'contact', 'reach', 'my', 'number', 'is', 'on', 'at', 'phone', 'mobile', 'whatsapp',
]);
const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const PROPERTY_TYPES = [
  [/\b(apartments?|flats?)\b/, 'Apartment'],
  [/\bvillas?\b/, 'Villa'],
  [/\btown ?houses?\b/, 'Townhouse'],
  // Only with property context, so "where is your office?" is not a search.
  [/\boffice (space|unit)s?\b|\boffices\b|\b(rent|buy|lease)\w* an? office\b/, 'Office'],
  [/\b(shop|retail) (space|unit)s?\b|\b(rent|buy|lease)\w* an? shop\b/, 'Shop'],
];
// Area recommendation requests ("best areas for families", "areas near metro", "where should a family live?"). Checked
// before location matching, so these sentences are never typo-corrected into an area name.
const RECOMMEND_RE = new RegExp(
  [
    /\b(best|top|popular|recommend\w*|good|ideal|suitable|affordable|cheap\w*|quiet|safe|luxury|waterfront|investment|family|family[- ]friendly)\b[^?]*\b(areas?|communit(y|ies)|neighbou?rhoods?|locations?|places to live)\b/.source,
    /\b(areas?|communit(y|ies)|neighbou?rhoods?)\b[^?]*\b(best|popular|recommend\w*|ideal|good|famil(y|ies)|kids|children|schools?|metro|beach|waterfront|villas?)\b/.source,
    /\bgood places? to live\b/.source,
    /\bwhere should (i|we|a family|my family|families) (live|stay|buy|rent|invest)\b/.source,
  ].join('|'),
  'i'
);
// "Is Arjan good for families?" / "Tell me about JVC": a question about one known area, not a recommendation request.
const AREA_INFO_RE = /^\s*(is|are|does|do|how('?s| is| about)|what('?s| is| about)|tell me about)\b/i;
const VIEWING_RE = /\b(arrange|book|schedule)\b[^.?!]*\bviewing\b/i;
const VIEWING_CONFIRM_TEXT = "Thanks — I'll pass your viewing request to the team.";
const NEARBY_AREAS = require('../constants/nearbyAreas.json');
const PREVIEW_LIMIT = 3;
const MAX_NEARBY_AREAS = 2;
const MAX_RECOMMENDATIONS = 3;
const CATEGORY_QUESTION = 'Which category would you like to explore?';
const categoryQuestion = (location) => `Would you like to buy, rent, or explore off-plan properties in ${location}?`;

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
    // "Dubai Hills" -> "Dubai Hills Estate" as an exact alias, so it is never fuzzy-matched to DAMAC Hills or The Hills.
    const withoutEstate = canonical.match(/^(.{3,}?)\s+Estate$/i);
    if (withoutEstate && !names.has(withoutEstate[1])) names.set(withoutEstate[1], canonical);
  });
  const entries = [...names.entries()]
    .filter(([label]) => label.length >= 3 && label.toLowerCase() !== 'dubai')
    .map(([label, canonical]) => [label, canonical, new RegExp(`\\b${escapeRegex(label)}\\b`, 'i')]);
  // "in springs" -> "The Springs". Without "The" the name must follow a place word, so "sea views" or "lush greens" don't match.
  names.forEach((canonical, label) => {
    const bare = label.match(/^the\s+(.{3,})$/i);
    if (bare && !names.has(bare[1])) entries.push([bare[1], canonical, new RegExp(`\\b(?:in|at|near|around|about|for)\\s+${escapeRegex(bare[1])}\\b`, 'i')]);
  });
  locationCache = entries.sort((a, b) => b[0].length - a[0].length);
  return locationCache;
};

// Edit distance where swapping two neighbouring letters counts as one edit ("buisness" -> "business").
const editDistance = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
};

const compact = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const PLACE_WORDS = new Set(['in', 'at', 'near', 'around', 'about']);
// Never part of a place name: a candidate cannot start with one and stops before one.
const NOT_PLACE_WORDS = new Set([
  'a', 'an', 'my', 'our', 'your', 'this', 'that', 'for', 'with', 'and', 'or', 'me', 'us', 'family', 'families',
  'rent', 'rental', 'rentals', 'renting', 'buy', 'buying', 'sale',
  'apartment', 'apartments', 'flat', 'flats', 'villa', 'villas', 'townhouse', 'townhouses', 'studio', 'bedroom', 'bedrooms',
  'property', 'properties', 'listing', 'listings', 'budget', 'under', 'below', 'furnished', 'unfurnished', 'yes', 'no', 'ok',
  'okay', 'sure', 'thanks', 'please', 'hello', 'hi', 'offplan', 'off', 'plan', 'next', 'month', 'year',
  // Recommendation wording ("best areas for families") is never read as a misspelled area.
  'best', 'top', 'good', 'popular', 'affordable', 'cheap', 'cheapest', 'investment', 'area', 'areas', 'community', 'communities',
  'neighborhood', 'neighborhoods', 'neighbourhood', 'neighbourhoods', 'place', 'places', 'live', 'school', 'schools', 'metro',
  'waterfront', 'kids', 'children',
]);

// Typo-tolerant match against known location names, used only when no exact name matched. Candidates are the words right
// after "in/at/near/…", or the whole message when it is just a few words (a reply to the area question).
// Returns { canonical, confident } or null.
const fuzzyLocation = (text, locations) => {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const starts = words.flatMap((w, i) => (PLACE_WORDS.has(w) ? [i + 1] : []));
  if (words.length <= 4) starts.push(...words.map((_, i) => i));
  let best = null;
  for (const start of new Set(starts)) {
    if (!words[start] || NOT_PLACE_WORDS.has(words[start]) || /\d/.test(words[start])) continue;
    for (let n = 1; n <= 4 && start + n <= words.length; n += 1) {
      if (NOT_PLACE_WORDS.has(words[start + n - 1]) || /\d/.test(words[start + n - 1])) break;
      const candidate = words.slice(start, start + n).join('');
      if (candidate.length < 4) continue;
      for (const [label, canonical] of locations) {
        const target = compact(label);
        if (target.length < 5 || Math.abs(target.length - candidate.length) > 3) continue;
        const distance = editDistance(candidate, target);
        if (!best || distance / target.length < best.score) best = { canonical, distance, length: target.length, score: distance / target.length, candidate, target };
      }
    }
  }
  if (!best) return null;
  const { distance, length, candidate, target } = best;
  const confident = distance === 0 || (distance === 1 && length >= 6) || (distance === 2 && length >= 9);
  const possible = distance <= 3 && best.score <= 0.4 && candidate[0] === target[0];
  if (confident) return { canonical: best.canonical, confident: true };
  return possible ? { canonical: best.canonical, confident: false } : null;
};

// "any area", "all Dubai", "any other locations", "anywhere in Dubai": always means no area restriction.
const ANY_LOCATION_RE =
  /\b(anywhere|any ?where|any (other )?(areas?|locations?|communit(y|ies)|neighbou?rhoods?)|all (areas|locations|communities|(of |over )?dubai)|(across|whole|entire) (of )?dubai|no (location|area) preference)\b/i;
// Generic answers that only mean "no area restriction" when we just asked for the area.
const NO_PREFERENCE_RE = /^\s*(no preference|(it )?(doesn'?t|does not|don'?t) matter|i don'?t mind|anything is fine)\b/i;
const CONFIRM_RE = /^\s*(yes|yeah|yep|sure|ok|okay|fine|it'?s fine|its fine|that'?s fine|that works|sounds good)\b/i;

// Which search fields a question asks about: used to read bare answers ("1", "800,000") and to block repeated questions.
const FIELD_QUESTION_RES = {
  purpose: /\b(buy(ing)?|rent(ing)?|off[- ]?plan)\b[^?]*\bor\b/i,
  location: /\b(areas?|locations?|communit(y|ies)|neighbou?rhoods?|where)\b/i,
  budget: /\bbudget\b/i,
  bedrooms: /\b(bedrooms?|studio)\b/i,
  furnishing: /\bfurnish/i,
  propertyType: /\b(property type|type of property|apartment or (a )?villa|villa or (an )?apartment)\b/i,
};
const questionFields = (question) => Object.keys(FIELD_QUESTION_RES).filter((f) => FIELD_QUESTION_RES[f].test(question));
const lastQuestionOf = (text) => String(text || '').split(/(?<=[.!?])\s+/).filter((s) => s.includes('?')).pop() || '';

const isAllDubaiPhrase = (text, { areaAsked = false } = {}) =>
  !text.includes('?') && (ANY_LOCATION_RE.test(text) || (areaAsked && NO_PREFERENCE_RE.test(text)));

const bedroomValue = (word) => (word === 'studio' ? '0' : String(WORD_NUMBERS[word] || word));

// Bare replies to the question just asked: "800,000" to a budget question, "1" to a bedrooms question, and
// "it's fine" to "... or is 1 bedroom fine?".
const answerToQuestion = (text, question, noPhone) => {
  const found = {};
  const fields = questionFields(question);
  const t = text.toLowerCase();
  if (fields.includes('budget')) {
    const amount = noPhone.match(/\b(\d{1,3}(?:,\d{3})+|\d{4,})\b/);
    if (amount) found.budget = amount[1].replace(/,/g, '');
  }
  // A message that is only "1" / "two" / "studio" can only be a bedroom count, unless we just asked for the budget.
  const bare = t.match(/^\s*(\d|one|two|three|four|five|six|studio)\s*[.!]?\s*$/);
  const offered = question.toLowerCase().match(/\bis (?:a )?(\d|one|two|three|four|five|six|studio)[- ]?(?:bed(?:room)?s?)? (?:fine|ok|okay)\b/);
  if (bare && !fields.includes('budget')) found.bedrooms = bedroomValue(bare[1]);
  else if (fields.includes('bedrooms') && offered && CONFIRM_RE.test(t)) found.bedrooms = bedroomValue(offered[1]);
  return found;
};

const extractQualification = (text, locations, { fuzzy = true, lastQuestion = '' } = {}) => {
  const areaAsked = questionFields(lastQuestion).includes('location');
  const t = text.toLowerCase();
  const found = {};
  const rent = /\b(rent|rents|renting|rentals?|lease|leasing|per (year|month|annum)|yearly|monthly)\b/.test(t);
  const buy = /\b(buy|buying|purchase|purchasing|invest|investing|for sale)\b/.test(t);
  const sell = /\b(sell|selling)\b/.test(t);
  if (/\boff[- ]?plan\b/.test(t)) found.purpose = 'off-plan';
  else if (rent + buy + sell === 1) found.purpose = rent ? 'rent' : buy ? 'buy' : 'sell';

  // Checked before any area matching, so "any areas" is never read as an area name or typo.
  const location = locations.find(([, , re]) => re.test(text));
  if (isAllDubaiPhrase(text, { areaAsked })) found.locationFlexible = true;
  else if (location) found.location = location[1];
  else if (fuzzy && !PHONE_ATTEMPT_RE.test(text) && !EMAIL_FIND_RE.test(text)) {
    const close = fuzzyLocation(text, locations);
    if (close?.confident) found.location = close.canonical;
    else if (close) found.locationSuggestion = close.canonical;
  }

  const type = PROPERTY_TYPES.find(([re]) => re.test(t));
  if (type) found.propertyType = type[1];

  // 'any' clears the furnishing requirement ("furnished doesn't matter", "any furnishing").
  if (/\bany furnishing\b|\bfurnish\w* (doesn'?t|does not|won'?t) matter\b|\bfurnished or (not|unfurnished)\b|\beither furnished or\b/.test(t)) found.furnishing = 'any';
  else if (/\b(unfurnished|not furnished)\b/.test(t)) found.furnishing = 'unfurnished';
  else if (/\b(semi|partly|partially)[- ]?furnished\b/.test(t)) found.furnishing = 'partly furnished';
  else if (/\bfurnished\b/.test(t)) found.furnishing = 'furnished';

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
  else if (/\b(any|no|flexible|open) (budget|price)\b|\bbudget (doesn'?t|does not|won'?t|isn'?t|is not) (matter|an issue|a problem)\b|\bno (price |budget )?limit\b|\bshow me anything\b/.test(t)) {
    found.budgetFlexible = true;
  }
  const answered = answerToQuestion(text, lastQuestion, noPhone);
  if (!found.budget && !found.budgetFlexible && answered.budget) found.budget = answered.budget;
  if (found.bedrooms === undefined && answered.bedrooms !== undefined) found.bedrooms = answered.bedrooms;

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

// Purpose, budget and bedrooms only come from the user's own words; model-chosen search args may be guesses.
const rememberSearchCriteria = (qualification, args = {}) => {
  if (!qualification.location && !qualification.locationFlexible && args.location) qualification.location = String(args.location);
};

const searchArgsFromState = (q) => {
  const args = { purpose: q.purpose, location: q.location, type: q.propertyType, bedrooms: q.bedrooms, furnishing: q.furnishing, max_price: Number(q.budget) || undefined };
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

// "+1 (202) 555-0123" -> "+12025550123"
const normalizePhone = (raw) => `+${raw.replace(/\D/g, '')}`;

// Contact details in one message. A bare name is only accepted when we just asked for it; a typed number that
// isn't a valid phone sets `phoneError` when a phone is expected or the message is just "name, number".
const extractContact = (text, { expectingName = false, expectingPhone = false } = {}) => {
  const found = {};
  const email = text.match(EMAIL_FIND_RE);
  if (email) found.email = email[0].toLowerCase();
  const rest = text.replace(EMAIL_FIND_RE, ' ');

  const phone = rest.match(PHONE_RE);
  if (phone) found.phone = normalizePhone(phone[0]);
  const nameThenNumber = /^\s*[a-z][a-z' -]{0,40}[\s,;:–-]+[+(]?[\d\s().-]+[\s,;.]*$/i.test(rest);
  if (!phone && PHONE_ATTEMPT_RE.test(rest) && (expectingPhone || nameThenNumber)) found.phoneError = INVALID_PHONE_TEXT;

  const withPhone = detectContact(rest);
  const introduced = rest.match(/\b(?:my name is|my name's|name is|name:)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)/i);
  const name = withPhone?.name || (introduced && !NAME_STOPWORDS.has(introduced[1].split(/\s+/)[0].toLowerCase()) ? introduced[1] : '');
  if (name) found.name = name;
  else if (expectingName || (nameThenNumber && found.phoneError)) {
    const loose = looseName(rest);
    if (loose) found.name = loose;
  }
  return found;
};

// One combined request, then only the missing required field. Email is optional and never asked. Null when the lead can be saved.
const nextContactQuestion = (contact) => {
  if (!contact.name && !contact.phone) return CONTACT_REQUEST_TEXT;
  if (!contact.name) return MISSING_NAME_TEXT;
  if (!contact.phone) return INVALID_PHONE_TEXT;
  return null;
};

// ---------- Property recommendations ----------

const priceText = (amount, purpose, frequency) => {
  const period = purpose === 'rent' ? `/${String(frequency || 'Yearly').toLowerCase() === 'yearly' ? 'year' : String(frequency).toLowerCase()}` : '';
  return `AED ${Number(amount).toLocaleString('en-US')}${period}`;
};

const BED_WORDS = ['studio', 'one', 'two', 'three', 'four', 'five', 'six'];
const bedsLabel = (bedrooms, words = false) => {
  if (bedrooms === undefined || bedrooms === null || bedrooms === '') return '';
  if (String(bedrooms) === '0') return 'studio';
  return `${words ? BED_WORDS[bedrooms] || bedrooms : bedrooms}-bedroom`;
};

// "a 4-bedroom apartment for rent in Dubai Marina within AED 250,000/year" or, with a count, "two-bedroom apartments for rent ..."
const describeCriteria = (q, { location = q.location, bedrooms = q.bedrooms, maxPrice = q.budget, plural = false, priceWord = 'under' } = {}) => {
  let noun = q.propertyType ? q.propertyType.toLowerCase() : q.purpose === 'rent' ? 'rental' : 'property';
  if (plural) noun = { property: 'properties', retail: 'retail units' }[noun] || `${noun}s`;
  const forWhat = q.purpose === 'rent' ? ' for rent' : q.purpose === 'buy' ? ' for sale' : '';
  const suffix = noun.startsWith('rental') ? '' : forWhat;
  // location '' means the caller wants no area wording at all.
  const where = location ? ` in ${location}` : q.locationFlexible && location !== '' ? ' across Dubai' : '';
  const price = Number(maxPrice) ? ` ${priceWord} ${priceText(maxPrice, q.purpose)}` : '';
  const offPlan = q.purpose === 'off-plan' ? 'off-plan' : '';
  const text = `${[bedsLabel(bedrooms, plural), q.furnishing, offPlan, noun].filter(Boolean).join(' ')}${suffix}${where}${price}`;
  return plural ? text : `${/^[aeiou]/i.test(text) ? 'an' : 'a'} ${text}`;
};

// Same pluralization as the chat popup (utils/propertyLabels pluralizeNoun).
const pluralize = (count, noun) => {
  if (count === 1) return noun;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  return /(s|x|z|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`;
};

const COUNT_LINES = [
  ['rent', (n, noun) => `${n} ${pluralize(n, noun)} available to rent`],
  ['buy', (n, noun) => `${n} ${pluralize(n, noun)} available to buy`],
  ['offPlan', (n, noun) => `${n} off-plan ${pluralize(n, noun)}`],
];
const COUNT_KEYS = { rent: 'rent', buy: 'buy', 'off-plan': 'offPlan' };

// Rent / buy / off-plan totals for the same filters (each listing is in exactly one category).
const countByCategory = async (q) => {
  const totals = await Promise.all(CATEGORIES.map((category) => findProperties(searchArgsFromState({ ...q, purpose: category }), 1)));
  return Object.fromEntries(CATEGORIES.map((category, i) => [COUNT_KEYS[category], totals[i].total]));
};

const describeCounts = (counts, propertyType) => {
  const noun = propertyType ? propertyType.toLowerCase() : 'property';
  const lines = COUNT_LINES.filter(([key]) => counts[key] > 0).map(([key, line]) => `• ${line(counts[key], noun)}`);
  return `We have the following ${pluralize(2, noun)} matching your search:\n\n${lines.join('\n')}\n\n${CATEGORY_QUESTION}`;
};

const areaSlug = (locations) =>
  locations.map((l) => l.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).filter(Boolean).join('-or-');

// Same query format as the website's PropertySearchBar: ?search=<area-slug>&type=&max=&beds=
const listingUrl = ({ purpose, locations = [], propertyType, bedrooms, maxPrice }) => {
  const params = new URLSearchParams();
  const slug = areaSlug(locations);
  if (slug) params.set('search', slug);
  if (propertyType) params.set('type', propertyType);
  if (Number(maxPrice)) params.set('max', String(Number(maxPrice)));
  if (bedrooms !== undefined && bedrooms !== null && bedrooms !== '') params.set('beds', String(bedrooms));
  const query = params.toString().replace(/\+/g, '%20');
  return `${CATEGORY_PATHS[toCategory(purpose)] || CATEGORY_PATHS.buy}${query ? `?${query}` : ''}`;
};

const bedroomAlternatives = (bedrooms) => {
  const n = Number(bedrooms);
  if (bedrooms === undefined || bedrooms === null || bedrooms === '' || !Number.isFinite(n)) return [];
  return [n - 1, n + 1].filter((b) => b >= 0 && b <= 6).map(String);
};

// Checks each nearby area with the same criteria; only areas with real inventory are kept.
const searchAreas = async (args, areas) => {
  const groups = [];
  for (const location of areas) {
    const found = await findProperties({ ...args, location }, PREVIEW_LIMIT);
    if (found.total) groups.push({ location, bedrooms: args.bedrooms, ...found });
    if (groups.length === MAX_NEARBY_AREAS) break;
  }
  return groups;
};

const RESIDENTIAL_TYPES = ['Apartment', 'Villa', 'Townhouse'];
const COMMERCIAL_TYPES = ['Office', 'Shop', 'Retail', 'Showroom'];
const MAX_SAME_AREA_ALTERNATIVES = 5;

// Same area, one requirement changed at a time (bedrooms, property type, furnishing or category), with real counts and
// lowest prices. The budget is not applied here; a price above it is flagged instead. Never changes the saved criteria.
const sameAreaAlternatives = async (q) => {
  const base = { ...q, budget: undefined };
  const options = bedroomAlternatives(q.bedrooms).map((bedrooms) => ({ difference: 'bedrooms', changes: { bedrooms } }));
  if (q.propertyType) {
    const family = COMMERCIAL_TYPES.includes(q.propertyType) ? COMMERCIAL_TYPES : RESIDENTIAL_TYPES;
    family.filter((t) => t !== q.propertyType).forEach((propertyType) => options.push({ difference: 'propertyType', changes: { propertyType } }));
  }
  // Other furnishing levels are only reported separately; they never count as matches.
  if (q.furnishing) {
    Object.keys(FURNISHED_VALUES).filter((f) => f !== q.furnishing).forEach((furnishing) => options.push({ difference: 'furnishing', changes: { furnishing } }));
  }
  CATEGORIES.filter((c) => c !== q.purpose).forEach((purpose) => options.push({ difference: 'purpose', changes: { purpose } }));

  const results = await Promise.all(options.map(({ changes }) => findProperties(searchArgsFromState({ ...base, ...changes }), 1)));
  return options
    .flatMap(({ difference, changes }, i) => {
      const { total, startingPrice, items } = results[i];
      if (!total) return [];
      const alt = { ...base, ...changes };
      return [{
        location: q.location,
        purpose: alt.purpose,
        propertyType: alt.propertyType || null,
        bedrooms: alt.bedrooms ?? null,
        furnishing: alt.furnishing || null,
        count: total,
        startingPrice,
        priceFrequency: alt.purpose === 'rent' ? items[0].rentFrequency || 'Yearly' : null,
        difference,
        aboveBudget: difference !== 'purpose' && Number(q.budget) > 0 && startingPrice > Number(q.budget),
      }];
    })
    .slice(0, MAX_SAME_AREA_ALTERNATIVES);
};

const nearbyAlternative = (q, g) => ({
  location: g.location,
  purpose: q.purpose,
  propertyType: q.propertyType || null,
  bedrooms: q.bedrooms ?? null,
  count: g.total,
  startingPrice: g.startingPrice,
  priceFrequency: q.purpose === 'rent' ? g.items[0]?.rentFrequency || 'Yearly' : null,
  difference: 'location',
});

// 1. exact match  2. same criteria without the budget (price only)  3. same-area alternatives (summary only)
// 4. nearby areas with the original criteria. Without an area: exact match, then closest bedroom counts.
const searchWithFallback = async (q, maxPrice = q.budget) => {
  const args = searchArgsFromState({ ...q, budget: maxPrice });
  const nearby = (q.location && NEARBY_AREAS[q.location]) || [];

  const exact = await findProperties(args, PREVIEW_LIMIT);
  if (exact.total) return { stage: 'exact', nearby, groups: [{ location: q.location, bedrooms: args.bedrooms, ...exact }] };

  if (!q.location) {
    for (const bedrooms of bedroomAlternatives(q.bedrooms)) {
      const found = await findProperties({ ...args, bedrooms }, PREVIEW_LIMIT);
      if (found.total) return { stage: 'bedroom', nearby, groups: [{ location: q.location, bedrooms, ...found }] };
    }
    return { stage: 'none', nearby, groups: [] };
  }

  if (Number(maxPrice)) {
    const lowest = await findProperties(searchArgsFromState({ ...q, budget: undefined }), 1);
    if (lowest.total) return { stage: 'overBudget', nearby, groups: [], lowestPrice: lowest.startingPrice, rentFrequency: lowest.items[0].rentFrequency };
  }

  const [sameArea, nearbyGroups] = await Promise.all([sameAreaAlternatives(q), searchAreas(args, nearby)]);
  const alternatives = { sameArea, nearby: nearbyGroups.map((g) => nearbyAlternative(q, g)) };
  if (sameArea.length) return { stage: 'alternatives', nearby, groups: [], alternatives };
  if (nearbyGroups.length) return { stage: 'nearby', nearby, groups: nearbyGroups, alternatives };
  return { stage: 'none', nearby, groups: [] };
};

// "Jumeirah Lake Towers has 3-bedroom options starting from AED 180,000/year (2 listings)"
const groupPhrase = (q, g, qualifier = bedsLabel(g.bedrooms) || 'matching') => {
  const where = g.location || 'Dubai';
  const price = priceText(g.startingPrice, q.purpose, g.items[0]?.rentFrequency);
  return g.total === 1
    ? `${where} has a ${qualifier} option at ${price}`
    : `${where} has ${qualifier} options starting from ${price} (${g.total} listings)`;
};

const listingCount = (n) => `${n} listing${n === 1 ? '' : 's'}`;
const bedsText = (b) => (String(b) === '0' ? 'studio' : `${b} bedroom${String(b) === '1' ? '' : 's'}`);

// "Townhouses for rent: 1 listing from AED 260,000/year (same area, townhouse instead of apartment)"
const alternativeLine = (q, a) => {
  const label = describeCriteria({ ...q, purpose: a.purpose, propertyType: a.propertyType, bedrooms: a.bedrooms, furnishing: a.furnishing }, { plural: true, location: '', maxPrice: null });
  const changed = {
    bedrooms: () => `same area and type, ${bedsText(a.bedrooms)} instead of ${bedsText(q.bedrooms)}`,
    propertyType: () => `same area, ${String(a.propertyType).toLowerCase()} instead of ${String(q.propertyType).toLowerCase()}`,
    furnishing: () => `same area and type, ${a.furnishing} instead of ${q.furnishing}`,
    purpose: () => `same area, ${a.purpose} instead of ${q.purpose}`,
  }[a.difference]();
  const price = priceText(a.startingPrice, a.purpose, a.priceFrequency);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${listingCount(a.count)} from ${price} (${changed}${a.aboveBudget ? ', above your budget' : ''})`;
};

const joinPhrases = (phrases) => (phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}` : phrases[0]);

// Deterministic, precise wording: says exactly which criteria were not met and what changed.
const describeResults = async (q, result, maxPrice, { cheaper = false } = {}) => {
  const wanted = describeCriteria(q, { maxPrice, priceWord: 'within' });
  const missed = `I couldn't find ${cheaper ? wanted.replace(/^an? /, 'a cheaper ') : wanted}`;
  const [first] = result.groups;
  const total = result.groups.reduce((sum, g) => sum + g.total, 0);

  if (result.stage === 'exact') {
    const price = priceText(first.startingPrice, q.purpose, first.items[0]?.rentFrequency);
    return total === 1
      ? `I found ${describeCriteria(q, { maxPrice })}, priced at ${price}.`
      : `I found ${total} ${describeCriteria(q, { maxPrice, plural: true })}, starting from ${price}.`;
  }
  if (result.stage === 'overBudget') {
    const price = priceText(result.lowestPrice, q.purpose, result.rentFrequency);
    return `I couldn't find any ${describeCriteria(q, { maxPrice, plural: true, priceWord: 'within' })}. The lowest available option currently starts from ${price}. Would you like to see listings from ${price}?`;
  }
  if (result.stage === 'alternatives') {
    const { sameArea, nearby } = result.alternatives;
    const matching = sameArea.filter((a) => a.difference !== 'furnishing');
    const otherFurnishing = sameArea.filter((a) => a.difference === 'furnishing');
    const lines = (alts) => alts.map((a) => `• ${alternativeLine(q, a)}`).join('\n');
    const nearbyLines = nearby.map((a) => `• ${a.location}: ${listingCount(a.count)} from ${priceText(a.startingPrice, a.purpose, a.priceFrequency)}`);
    const nearbyTitle = q.furnishing ? `Nearby ${q.furnishing} options:` : "If you'd rather keep the same requirements, nearby options include:";
    const question = otherFurnishing.length
      ? `Would you like to ${matching.length || nearbyLines.length ? `see the ${q.furnishing} options above, or ` : ''}consider ${otherFurnishing.map((a) => a.furnishing).join(' or ')} properties in ${q.location}?`
      : 'Would you like to see one of these?';
    return [
      `${missed}.`,
      matching.length ? `In ${q.location}, I found:\n${lines(matching)}` : '',
      nearbyLines.length ? `${nearbyTitle}\n${nearbyLines.join('\n')}` : '',
      otherFurnishing.length ? `Not ${q.furnishing}, but available in ${q.location}:\n${lines(otherFurnishing)}` : '',
      question,
    ].filter(Boolean).join('\n\n');
  }
  if (result.stage === 'nearby') {
    return `${missed}. Nearby, ${joinPhrases(result.groups.map((g) => groupPhrase(q, g, 'matching')))}.`;
  }
  if (result.stage === 'bedroom') {
    return `${missed}, but ${groupPhrase(q, first)}.`;
  }
  let context = '';
  if (q.location && !cheaper) {
    const inArea = await findProperties({ purpose: q.purpose, location: q.location }, 1);
    if (inArea.total) {
      const kind = { rent: 'rental', buy: 'sale', 'off-plan': 'off-plan' }[q.purpose];
      context = ` ${q.location} currently has ${inArea.total} ${kind} listing${inArea.total === 1 ? '' : 's'}, but none match all of these criteria.`;
    }
  }
  if (Number(maxPrice) && q.location && !cheaper) {
    // Nothing matches at any price, so there is no higher price to offer.
    return `I couldn't find any ${describeCriteria(q, { plural: true, maxPrice: null })} right now.${context} Would you like to try a nearby area or adjust the property type or bedrooms?`;
  }
  return `${missed}.${context} Would you like to adjust the budget or try another area?`;
};

// Preview cards + View All metadata for the frontend.
const buildPropertyResult = async (q, groups, maxPrice) => {
  let total = groups.reduce((sum, g) => sum + g.total, 0);
  if (!total) return { properties: [], propertyResult: null, uiActions: [] };
  const properties = groups
    .flatMap((g) => g.items)
    .sort((a, b) => a.priceAED - b.priceAED)
    .slice(0, PREVIEW_LIMIT);
  const locations = groups.map((g) => g.location).filter(Boolean);
  const bedrooms = groups[0].bedrooms;
  // Several areas: count the union once (a listing can match two area terms), like the listing page does.
  if (locations.length > 1) {
    total = (await findProperties({ ...searchArgsFromState({ ...q, location: undefined, bedrooms, budget: maxPrice }), location: locations }, 1)).total;
  }
  const filters = Object.fromEntries(
    Object.entries({ purpose: q.purpose, locations, propertyType: q.propertyType, bedrooms, furnishing: q.furnishing, maxPrice: Number(maxPrice) || undefined }).filter(
      ([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)
    )
  );
  const viewAllUrl = listingUrl({ purpose: q.purpose, locations, propertyType: q.propertyType, bedrooms, maxPrice });
  // The listing pages have no furnishing filter, so their count would not match a furnishing-filtered total.
  const showViewAll = total > PREVIEW_LIMIT && !q.furnishing;
  return {
    properties,
    propertyResult: { total, showViewAll, location: locations.join(', ') || 'Dubai', purpose: q.purpose, category: q.purpose, filters, viewAllUrl },
    uiActions: showViewAll ? [{ type: 'view_all', label: 'View All Properties', url: viewAllUrl }] : [],
  };
};

// Highlights for the card, skipping any already used in the reply's area summary.
const pickReason = (guide, message, summary = '') => {
  const stems = (message.toLowerCase().match(/[a-z]{4,}/g) || []).map((w) => w.slice(0, 5));
  const highlights = (guide.keyHighlights || []).map((h) => h.title).filter((h) => !summary.includes(h));
  const relevant = highlights.filter((h) => stems.some((s) => h.toLowerCase().includes(s)));
  return [...new Set([...relevant, ...highlights])].slice(0, 2).join('; ');
};

const FAMILY_QUERY_RE = /\b(famil(y|ies)|kids|children|schools?)\b/i;
const FAMILY_TERMS = [
  [/\b(famil\w*|child\w*|kids?|schools?|nurser\w*)\b/gi, 2],
  [/\b(parks?|playgrounds?|green|gated|suburban|trails?|lakes?)\b/gi, 1],
];
const wordCount = (s) => String(s).split(/\s+/).filter(Boolean).length;
// How relevant a sentence is to the request: family terms for family questions, otherwise the request's own words.
const relevanceScorer = (message) => {
  if (FAMILY_QUERY_RE.test(message)) return (text) => FAMILY_TERMS.reduce((n, [re, w]) => n + (String(text).match(re) || []).length * w, 0);
  const stems = (message.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !NOT_PLACE_WORDS.has(w)).map((w) => w.slice(0, 5));
  return (text) => stems.filter((s) => String(text).toLowerCase().includes(s)).length;
};

// One short line about an area, taken only from its guide: the most relevant short sentence of `about`, else the most
// relevant highlights, else the opening sentence or first highlights as a neutral summary.
const areaSummary = (guide, score) => {
  const sentences = String(guide.about || '').split(/(?<=[.!?])\s+/).filter((s) => wordCount(s) <= 20);
  const titles = (guide.keyHighlights || []).map((h) => h.title);
  const ranked = (items) => items.map((text) => [text, score(text)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([text]) => text);
  // Up to two highlights, kept within about 20 words.
  const joinTitles = (list) =>
    list.slice(0, 2).filter((t, i) => i === 0 || wordCount(`${list[0]} ${t}`) <= 20).map((t) => `${t.replace(/[.\s]+$/, '')}.`).join(' ');

  const [bestSentence] = ranked(sentences);
  if (bestSentence) return bestSentence;
  const bestTitles = ranked(titles);
  if (bestTitles.length) return joinTitles(bestTitles);
  return sentences[0] || joinTitles(titles);
};

const AREA_CHOICE_QUESTION = 'Which of these areas would you like to explore?';
const describeRecommendations = (message, recommendations) =>
  [
    `Here are a few ${FAMILY_QUERY_RE.test(message) ? 'family-friendly ' : ''}areas worth exploring:`,
    recommendations.map((r) => `• ${r.area}${r.summary ? ` — ${r.summary}` : ''}`).join('\n'),
    AREA_CHOICE_QUESTION,
  ].join('\n\n');

// Areas from the area-guide knowledge, kept only when they have matching listings right now.
// `near` is an area named in the request ("best family areas near JVC"): its own guide, if any, is listed first.
const recommendAreas = async (message, q, near = '') => {
  // Wide k so area guides aren't crowded out by blogs/FAQs; hits stay ordered by relevance.
  const hits = await retrieve(message, 40);
  const titles = [...new Set([near, ...hits.filter((h) => h.source === 'area').map((h) => h.title)].filter(Boolean))];
  if (!titles.length) return [];
  const guides = await AreaGuide.find({ isActive: true, title: { $in: titles } }).select('title slug path about keyHighlights listingsSearch').lean();
  const purposes = CATEGORIES.includes(q.purpose) ? [q.purpose] : CATEGORIES;
  const score = relevanceScorer(message);

  const recommendations = [];
  for (const title of titles) {
    const guide = guides.find((g) => g.title === title);
    if (!guide) continue;
    const location = guide.listingsSearch?.length ? guide.listingsSearch : guide.title;
    const prices = [];
    let total = 0;
    for (const purpose of purposes) {
      const found = await findProperties({ purpose, location, type: q.propertyType, bedrooms: q.bedrooms, max_price: Number(q.budget) || undefined }, 1);
      if (!found.total) continue;
      total += found.total;
      prices.push({ purpose, startingPrice: found.startingPrice, rentFrequency: found.items[0].rentFrequency, total: found.total });
    }
    if (!total) continue;
    const primary = [...prices].sort((a, b) => b.total - a.total)[0];
    const categories = Object.fromEntries(
      CATEGORIES.map((category) => {
        const p = prices.find((x) => x.purpose === category);
        return [COUNT_KEYS[category], { count: p ? p.total : 0, startingPrice: p ? p.startingPrice : null }];
      })
    );
    const summary = areaSummary(guide, score);
    recommendations.push({
      area: guide.title,
      summary,
      reason: pickReason(guide, message, summary),
      // The card count sits next to viewAllUrl, which lists one purpose.
      total: primary.total,
      startingPrices: prices,
      categories,
      areaGuideUrl: guide.path || `/area-guides/${guide.slug}`,
      viewAllUrl: listingUrl({ purpose: primary.purpose, locations: [].concat(location), propertyType: q.propertyType, bedrooms: q.bedrooms, maxPrice: q.budget }),
    });
    if (recommendations.length === MAX_RECOMMENDATIONS) break;
  }
  return recommendations;
};

const resolveViewingInterest = async (action, q) => {
  const ref = String(action?.propertyRefNo || '').trim();
  const property = ref ? await Property.findOne({ propertyRefNo: ref }).select('propertyRefNo propertyTitle locality').lean() : null;
  const location = property?.locality?.replace(/\s*\([^)]*\)/, '').trim() || String(action?.location || '').trim() || q.location || '';
  return Object.fromEntries(
    Object.entries({ selectedPropertyRefNo: property?.propertyRefNo, selectedPropertyTitle: property?.propertyTitle, selectedLocation: location }).filter(([, v]) => v)
  );
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

const buildStateContext = (state) => {
  const q = state.qualification;
  const c = state.contact;
  const contactClosed = state.leadSaved || state.leadOfferDeclined;
  const nextContactField = state.leadSaved ? 'none' : !c.name ? 'name' : !c.phone ? 'phone' : 'none';
  const lines = [
    ...QUALIFICATION_FIELDS.map((field) => {
      if (field === 'budget' && !q.budget && q.budgetFlexible) return 'budget: any (no limit, never ask)';
      if (field === 'location' && !q.location && q.locationFlexible) return 'location: anywhere in Dubai (no preference, never ask)';
      return `${field}: ${q[field] || 'unknown'}`;
    }),
    `propertyType: ${q.propertyType || 'any'}`,
    `furnishing: ${q.furnishing || 'any'}`,
    `leadOfferShown: ${state.leadOfferShown}`,
    `leadOfferDeclined: ${state.leadOfferDeclined}`,
    `leadSaved: ${state.leadSaved}`,
  ];
  const contactLines = [`name: ${c.name || 'missing'}`, `phone: ${c.phone || 'missing'}`, `email: ${c.email || 'not given (optional, never ask)'}`];

  const steps = [];
  if (q.purpose && q.purpose !== 'sell' && (locationKnown(q) || q.budget || q.bedrooms)) {
    steps.push('If search results are provided, summarize them briefly. Only call search_properties again if the user asked for something different.');
  }
  const missing = QUALIFICATION_FIELDS.find((field) => !fieldKnown(q, field));
  steps.push(
    missing
      ? `Ask at most ONE question; if it is a qualifying question ask ONLY ${QUESTION_FOR[missing]}. Never ask about known fields.`
      : 'Ask at most ONE question. All qualification details are known.'
  );
  steps.push('Do NOT offer an agent or viewing and do NOT ask for name, phone, email or contact details; the system collects them.');
  if (contactClosed) steps.push('The lead is closed for this session (saved or declined).');

  return [
    `SESSION STATE (authoritative; never ask for values that are known):\n${lines.join('\n')}`,
    `CONTACT STATE:\n${contactLines.join('\n')}`,
    `NEXT REQUIRED CONTACT FIELD: ${nextContactField} (asked by the system, never by you)`,
    `NEXT STEP:\n- ${steps.join('\n- ')}`,
  ].join('\n\n');
};

// Drops the question sentences for which shouldDrop(sentence) is true.
const dropQuestions = (reply, shouldDrop) => {
  const cleaned = reply
    .split('\n')
    .map((line) => line.split(/(?<=[.!?])\s+/).filter((s) => !(s.includes('?') && shouldDrop(s))).join(' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || 'Happy to keep helping. What would you like to see next?';
};
const stripContactAsks = (reply) => dropQuestions(reply, (s) => CONTACT_ASK_RE.test(s));
// Deterministic duplicate guard: a model question about any field already in the session state is removed.
const dropKnownQuestions = (reply, q) => dropQuestions(reply, (s) => questionFields(s).some((f) => fieldKnown(q, f)));

const SEARCH_FIELDS = ['purpose', 'location', 'locationFlexible', 'propertyType', 'budget', 'budgetFlexible', 'bedrooms', 'furnishing'];
// "any budget" / "any area" count as answers, so those questions are never asked again.
const budgetKnown = (q) => Boolean(q.budget || q.budgetFlexible);
const locationKnown = (q) => Boolean(q.location || q.locationFlexible);
const fieldKnown = (q, field) => (field === 'budget' ? budgetKnown(q) : field === 'location' ? locationKnown(q) : Boolean(q[field]));
// The user answered our qualifying question with something that sets no value ("it's fine", "ok"): search with what is known.
const answeredOurQuestion = (message, lastQuestion, q) =>
  !message.includes('?') && message.trim().split(/\s+/).length <= 6 && questionFields(lastQuestion).some((f) => !fieldKnown(q, f));
const SEARCH_PROMISE_RE = /\b(i'?ll|i will|let me|i can|i'?m going to)\s+(search|look|find|check|broaden)\b/i;

// "I want to buy an apartment in Dubai Hills" during a furnished rental search in Arjan: the purpose is restated with an area
// or type and conflicts with a stored value, so it starts a new search. A bare "buy" or "Dubai Marina" still refines the current one.
const detectNewPropertySearch = (extracted, q) =>
  Boolean(extracted.purpose && (extracted.location || extracted.propertyType)) &&
  ['purpose', 'location', 'propertyType'].some((f) => extracted[f] && q[f] && extracted[f] !== q[f]);

// A new search keeps only what the new message states (merged afterwards); old furnishing, bedrooms, budget etc. are dropped.
const resetSearchFilters = (q) => SEARCH_FIELDS.forEach((f) => delete q[f]);

const hasViewingInterest = (state) => Object.keys(state.viewingInterest).length > 0;

// Saves (or updates) the session's single lead from the collected contact state; returns the confirmation.
const completeLead = async (state, sessionId) => {
  const interest = hasViewingInterest(state) ? { interest: 'Book a Viewing', ...state.viewingInterest } : {};
  const result = await saveLead({ ...state.qualification, ...interest, ...state.contact }, sessionId);
  if (!result.ok) return null;
  state.leadSaved = true;
  return interest.interest
    ? `Thanks, ${state.contact.name}. I'll pass your viewing request to the team.`
    : `Thanks, ${state.contact.name}. An agent will contact you shortly.`;
};

// Viewing requests are explicit contact actions, so they are allowed even after a generic decline.
const requestViewing = async (state, sessionId) => {
  if (state.leadSaved || (await ChatbotLead.exists({ sessionId }))) {
    await updateLead(sessionId, { email: state.contact.email, ...state.viewingInterest });
    state.leadSaved = true;
    return VIEWING_CONFIRM_TEXT;
  }
  return nextContactQuestion(state.contact) || (await completeLead(state, sessionId)) || FALLBACK_REPLY;
};

const chat = async ({ sessionId, message, action }) => {
  const session = await ChatSession.findOne({ sessionId }).lean();
  const history = (session?.messages || []).slice(-HISTORY_LIMIT).map(({ role, content }) => ({ role, content }));
  const state = {
    qualification: { ...(session?.qualification || {}) },
    viewingInterest: { ...(session?.viewingInterest || {}) },
    contact: { ...(session?.contact || {}) },
    budgetFallback: { ...(session?.budgetFallback || {}) },
    locationSuggestion: session?.locationSuggestion || '',
    currentTopic: session?.currentTopic || '',
    leadOfferShown: Boolean(session?.leadOfferShown),
    leadOfferDeclined: Boolean(session?.leadOfferDeclined),
    leadSaved: Boolean(session?.leadSaved),
  };

  let reply = FALLBACK_REPLY;
  let properties = [];
  let propertyResult = null;
  let propertyCounts = null;
  let recommendations = [];
  let uiActions = [];
  let alternatives = null;
  let savedName = '';
  let confirmation = '';
  let criteriaChanged = false;
  let criteriaGiven = false; // the message states a search field, even one already known (e.g. "rent" again)
  let enforce = false; // true when the reply still needs lead/question guardrails
  let propertyTurn = false; // the soft agent offer only follows a property search
  let modelReply = false; // the reply was worded by the model, so repeated qualification questions are removed
  try {
    const q = state.qualification;
    const isViewingClick = action?.type === 'book_viewing';
    // A higher-price offer only applies to the very next reply.
    const fallbackPending = Boolean(state.budgetFallback.pending);
    state.budgetFallback.pending = false;
    // "Did you mean Jebel Ali?" is answered on the very next reply.
    const pendingLocation = state.locationSuggestion;
    state.locationSuggestion = '';
    const pastMessages = session?.messages || [];
    const lastAssistant = [...pastMessages].reverse().find((m) => m.role === 'assistant')?.content || '';
    const lastQuestion = lastQuestionOf(lastAssistant);
    // Company team questions are answered from the team records only and never touch search or contact state.
    const teamReply = isViewingClick ? null : await teamAnswer(message);

    // Intent before location matching: a recommendation request is never typo-corrected into an area name.
    const recommendIntent = !isViewingClick && !teamReply && RECOMMEND_RE.test(message);
    let areaQuestion = false; // "Is Arjan good for families?": answered from knowledge, no search or category question
    let nearArea = ''; // "best family areas near JVC": the named area is context for the recommendations, not a search

    // 1. Qualification (skipped for button clicks so a property title can't change the criteria)
    let extracted = {};
    let locationSuggestion = '';
    if (!isViewingClick && !teamReply) {
      // No typo matching on replies to the contact prompt, so a name like "Arjun" is never read as an area.
      extracted = extractQualification(message, await getKnownLocations(), {
        fuzzy: !isContactPrompt(lastAssistant) && !recommendIntent,
        lastQuestion,
      });
      areaQuestion = Boolean(extracted.location) && AREA_INFO_RE.test(message);
      if (recommendIntent && !areaQuestion && extracted.location) {
        nearArea = extracted.location;
        delete extracted.location;
      }
      if (!extracted.location && pendingLocation && ACCEPT_RE.test(message)) extracted.location = pendingLocation;
      ({ locationSuggestion = '' } = extracted);
      delete extracted.locationSuggestion;
      // "No, Dubai Hills" after "Did you mean DAMAC Hills?": never offer the rejected suggestion again.
      if (locationSuggestion === pendingLocation) locationSuggestion = '';
      if (!extracted.furnishing && /\beither\b/i.test(message) && /furnish/i.test(lastAssistant)) extracted.furnishing = 'any';
      // Furnishing is a rental attribute: "furnished apartment" means rent unless a purpose is already known.
      if (extracted.furnishing && extracted.furnishing !== 'any' && !extracted.purpose && !q.purpose) extracted.purpose = 'rent';
      criteriaChanged = SEARCH_FIELDS.some((f) => extracted[f] && extracted[f] !== q[f]);
      criteriaGiven = !message.includes('?') && SEARCH_FIELDS.some((f) => extracted[f]);
      if (detectNewPropertySearch(extracted, q)) resetSearchFilters(q);
      if (extracted.budget) delete q.budgetFlexible;
      if (extracted.budgetFlexible) delete q.budget;
      if (extracted.location) delete q.locationFlexible;
      if (extracted.locationFlexible) delete q.location;
      Object.assign(q, extracted);
      if (!q.purpose) delete q.purpose;
      if (q.furnishing === 'any') delete q.furnishing;
    }

    // 2. Offer acceptance / decline / viewing requests
    const offerPending = state.leadOfferShown && !state.leadOfferDeclined && !state.leadSaved && OFFER_RE.test(lastAssistant);
    const awaitingContact = !state.leadSaved && isContactPrompt(lastAssistant);
    const typedViewing = !isViewingClick && VIEWING_RE.test(message);
    if (!isViewingClick && !state.leadSaved && (/just (browsing|looking)/i.test(message) || (offerPending && DECLINE_RE.test(message) && !extracted.budgetFlexible))) {
      state.leadOfferDeclined = true;
    }
    const acceptedOffer =
      !isViewingClick && !state.leadSaved && !awaitingContact && ((offerPending && ACCEPT_RE.test(message)) || AGENT_REQUEST_RE.test(message));
    if (isViewingClick) state.viewingInterest = await resolveViewingInterest(action, q);
    else if (typedViewing) state.viewingInterest = await resolveViewingInterest({}, q);

    // 3. Contact details: merged into the session's contact state; known fields are never cleared
    const contact = state.contact;
    let found = {};
    if (!isViewingClick && !teamReply) {
      found = extractContact(message, {
        expectingName: awaitingContact && !contact.name,
        expectingPhone: awaitingContact && !contact.phone && !extracted.budget,
      });
      if (state.leadSaved) {
        // Once the lead exists, only a volunteered email is still added to it.
        if (found.email && !contact.email) {
          contact.email = found.email;
          await updateLead(sessionId, { email: found.email });
        }
        found = {};
      }
    }
    const { phoneError, ...details } = found;
    Object.assign(contact, details);

    // 4. Lead capture: name + valid phone save the lead immediately; email is optional and never asked
    let contactReply = '';
    const volunteered = Boolean(details.name && (details.phone || phoneError));
    const wantsContact = acceptedOffer || volunteered || (awaitingContact && Object.keys(found).length > 0);
    if (!state.leadSaved && !isViewingClick && !teamReply && wantsContact) {
      if (phoneError && !contact.phone) {
        contactReply = phoneError;
      } else if (nextContactQuestion(contact)) {
        contactReply = nextContactQuestion(contact);
      } else {
        confirmation = (await completeLead(state, sessionId)) || '';
        if (confirmation) {
          savedName = contact.name;
          reply = confirmation;
        }
      }
    }

    const wantsAreas = recommendIntent && !areaQuestion;
    if (wantsAreas) recommendations = await recommendAreas(message, q, nearArea);

    // A leadership question opens that topic; it stays open for follow-ups ("yes I need to know") until the user
    // clearly returns to property (search criteria, area recommendations, viewing or contact).
    if (teamReply) state.currentTopic = 'leadership';
    else if (criteriaGiven || criteriaChanged || locationSuggestion || isViewingClick || typedViewing || wantsAreas || wantsContact) {
      state.currentTopic = '';
    }

    if (isViewingClick || (typedViewing && state.leadSaved && !savedName)) {
      reply = await requestViewing(state, sessionId);
    } else if (teamReply) {
      reply = teamReply;
    } else if (contactReply) {
      reply = contactReply;
    } else if (savedName && !criteriaChanged) {
      // confirmation already set above
    } else if (locationSuggestion) {
      // Close to a known area but not certain: confirm before storing it; other details from the message are kept.
      state.locationSuggestion = locationSuggestion;
      reply = `Did you mean ${locationSuggestion}?`;
    } else if (fallbackPending && !criteriaChanged && (DECLINE_RE.test(message) || TOO_EXPENSIVE_RE.test(message))) {
      reply = FALLBACK_DECLINE_TEXT;
    } else if (fallbackPending && !criteriaChanged && (ACCEPT_RE.test(message) || SHOW_ME_RE.test(message))) {
      // Same criteria without the old ceiling, starting from the lowest real price that was offered.
      const open = { ...q, budget: undefined };
      const found = await findProperties({ ...searchArgsFromState(open), min_price: state.budgetFallback.suggestedMinPrice }, PREVIEW_LIMIT);
      const groups = found.total ? [{ location: q.location, bedrooms: q.bedrooms, ...found }] : [];
      reply = await describeResults(open, { stage: found.total ? 'exact' : 'none', nearby: [], groups });
      ({ properties, propertyResult, uiActions } = await buildPropertyResult(open, groups));
      enforce = true;
      propertyTurn = true;
    } else if (recommendations.length) {
      reply = describeRecommendations(message, recommendations);
    } else if (
      criteriaChanged && !locationKnown(q) && !q.budget && !q.bedrooms && q.purpose && !lastAssistant.endsWith(CATEGORY_QUESTION) &&
      message.split(/\s+/).length <= 6 && !message.includes('?')
    ) {
      const goal = { rent: 'a rental', buy: 'a property to buy', 'off-plan': 'an off-plan property' }[q.purpose] || 'the right buyer';
      reply = `Great, let's find you ${goal}. ${NEXT_QUESTION.location}`;
    } else {
      // 5. Property search: requested area first, then deterministic fallbacks
      const hasCriteria = Boolean(locationKnown(q) || q.budget || q.bedrooms || q.propertyType);
      let broad = false;
      // Purpose is never inferred: an area without a category gets the category question and no search.
      if (areaQuestion) {
        // Only an area guide may describe an area (the model answers below); without one, real listing counts replace a guess.
        if (!(await AreaGuide.exists({ isActive: true, title: q.location }))) {
          broad = true;
          const counts = await countByCategory({ location: q.location });
          const available = COUNT_LINES.filter(([key]) => counts[key] > 0).map(([key, line]) => line(counts[key], 'property'));
          reply = `I don't have detailed area information for ${q.location} yet${available.length ? `, but it currently has ${joinPhrases(available)}` : ''}. ${categoryQuestion(q.location)}`;
        }
      } else if (!q.purpose && q.location && (criteriaChanged || criteriaGiven)) {
        broad = true;
        reply = categoryQuestion(q.location);
      } else if (criteriaChanged && !q.purpose && hasCriteria) {
        // No area and no category yet: real rent / buy / off-plan counts, then the user picks a category.
        const counts = await countByCategory(q);
        broad = true;
        if (CATEGORIES.some((category) => counts[COUNT_KEYS[category]] > 0)) {
          propertyCounts = counts;
          reply = describeCounts(counts, q.propertyType);
          const filters = { propertyType: q.propertyType, bedrooms: q.bedrooms, maxPrice: Number(q.budget) || undefined };
          propertyResult = {
            showViewAll: false,
            location: 'Dubai',
            filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== '')),
          };
        } else {
          reply = `I couldn't find any ${describeCriteria(q, { plural: true, priceWord: 'within' })}. Would you like to adjust the budget or try another area?`;
        }
      }
      const canSearch = !broad && CATEGORIES.includes(q.purpose) && hasCriteria;
      const cheaper = canSearch && CHEAPER_RE.test(message);
      // The backend, not the model, decides to search: whenever the state is searchable and this message set a criterion
      // or answered our last qualifying question.
      const searchNow =
        !areaQuestion && (cheaper || (canSearch && (criteriaChanged || criteriaGiven || answeredOurQuestion(message, lastQuestion, q))));

      const runSearch = async () => {
        let maxPrice = q.budget;
        let result;
        if (cheaper) {
          const current = Number(q.budget) || 0;
          if (current) maxPrice = String(Math.floor((current * 0.8) / 1000) * 1000);
          const found = await findProperties(searchArgsFromState({ ...q, budget: maxPrice }), PREVIEW_LIMIT);
          result = { stage: found.total ? 'exact' : 'none', nearby: [], groups: found.total ? [{ location: q.location, bedrooms: q.bedrooms, ...found }] : [] };
        } else {
          result = await searchWithFallback(q);
        }
        reply = await describeResults(q, result, maxPrice, { cheaper });
        alternatives = result.alternatives || null;
        if (result.stage === 'overBudget') {
          // Only the price is offered; listings are shown after the user agrees.
          state.budgetFallback = { pending: true, originalMaxPrice: Number(maxPrice), suggestedMinPrice: result.lowestPrice };
        } else {
          ({ properties, propertyResult, uiActions } = await buildPropertyResult(q, result.groups, maxPrice));
          if (cheaper && result.groups.length) q.budget = maxPrice;
          // A no-results reply already ends with its own next-step question.
          enforce = result.groups.length > 0;
          propertyTurn = enforce;
        }
      };

      if (broad) {
        // reply set above from the category counts
      } else if (searchNow) {
        await runSearch();
      } else {
        // 6. General questions: knowledge + model wording
        // A leadership follow-up is answered on that topic; the stored property state must not steer it back to a search.
        const onLeadership = state.currentTopic === 'leadership';
        const forceRefineSearch = !onLeadership && canSearch && REFINE_RE.test(message);
        const hits = await retrieve(message, 4);
        let knowledge = hits.length
          ? hits.map((h, i) => `[${i + 1}] (${h.source}) ${h.title}\n${h.text}`).join('\n\n')
          : 'No relevant knowledge found.';
        if (onLeadership) {
          const leaders = (await teamRoster()).map((m) => `- ${m.name} — ${m.designation} (${m.department})`).join('\n');
          knowledge = `${COMPANY} leadership:\n${leaders}\n\n${knowledge}`;
        }
        const messages = [
          { role: 'system', content: `${RULES}\n\nKNOWLEDGE (use only this for company/area facts):\n${knowledge}` },
          ...history,
          { role: 'user', content: message },
          { role: 'system', content: onLeadership ? LEADERSHIP_TOPIC_CONTEXT : buildStateContext(state) },
        ];

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
          let toolChoice = onLeadership || round === MAX_TOOL_ROUNDS ? 'none' : 'auto';
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
              modelReply = true;
            }
            break;
          }

          messages.push(msg);
          for (const call of msg.tool_calls) {
            let result;
            try {
              let args = JSON.parse(call.function.arguments || '{}');
              // Furnishing only changes when the user says so; model-chosen values are replaced by the stored one.
              if (call.function.name === 'search_properties') args = { ...args, furnishing: state.qualification.furnishing };
              result = await runTool(call.function.name, args, sessionId);
              if (call.function.name === 'search_properties') {
                properties = result.slice(0, PREVIEW_LIMIT);
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
        // "I'll search across Dubai..." without results is never sent: the search runs now instead.
        if (!onLeadership && canSearch && !properties.length && SEARCH_PROMISE_RE.test(reply)) {
          modelReply = false;
          await runSearch();
        }
      }
    }
  } catch (error) {
    console.error('[Chatbot] Chat failed:', error.message);
  }

  // 7. Guardrails over wording: the offer and next question come from state, never from the model.
  if (enforce) {
    const q = state.qualification;
    LOCATION_FIXES.forEach(([pattern, fixed]) => {
      reply = reply.replace(pattern, fixed);
    });
    reply = stripContactAsks(reply);
    if (modelReply) reply = dropKnownQuestions(reply, q);
    const missing = ['purpose', 'location', 'budget', 'bedrooms'].find((f) => !fieldKnown(q, f));
    if (propertyTurn && q.purpose && locationKnown(q) && budgetKnown(q) && !state.leadOfferShown && !state.leadOfferDeclined && !state.leadSaved) {
      reply = withQuestion(reply, OFFER_TEXT);
      state.leadOfferShown = true;
    } else if ((criteriaChanged || propertyTurn) && missing) {
      let question = NEXT_QUESTION[missing];
      if (missing === 'purpose' && q.location) question = categoryQuestion(q.location);
      if (missing === 'budget' && q.purpose === 'rent') question = "What's your yearly budget in AED?";
      reply = withQuestion(reply, question);
    } else {
      reply = limitToOneQuestion(reply);
    }
  }
  if (confirmation && !/agent will contact|viewing request/i.test(reply)) reply = `${confirmation}\n\n${reply}`;

  const now = new Date();
  await ChatSession.findOneAndUpdate(
    { sessionId },
    {
      $set: {
        qualification: state.qualification,
        contact: state.contact,
        viewingInterest: state.viewingInterest,
        budgetFallback: state.budgetFallback,
        locationSuggestion: state.locationSuggestion,
        currentTopic: state.currentTopic,
        leadOfferShown: state.leadOfferShown,
        leadOfferDeclined: state.leadOfferDeclined,
        leadSaved: state.leadSaved,
      },
      $push: { messages: { $each: [{ role: 'user', content: message, at: now }, { role: 'assistant', content: reply, at: now }] } },
    },
    { upsert: true }
  );

  return { reply, properties, propertyResult, propertyCounts, recommendations, uiActions, alternatives };
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
