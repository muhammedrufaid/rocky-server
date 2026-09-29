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
const EMBED_BATCH_SIZE = 50;
const MIN_SCORE = 0.25;

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

// Splits body by paragraph so each chunk (head + body part) stays under MAX_CHUNK_CHARS.
const splitText = (head, body) => {
  const room = Math.max(MAX_CHUNK_CHARS - head.length, 200);
  const clean = String(body || '').trim();
  if (clean.length <= room) return [`${head}${clean}`];

  const parts = [];
  let current = '';
  clean.split(/\n+/).map((p) => p.trim()).filter(Boolean).forEach((para) => {
    for (let i = 0; i < para.length; i += room) {
      const piece = para.slice(i, i + room);
      if (current && current.length + piece.length + 1 > room) {
        parts.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n${piece}` : piece;
      }
    }
  });
  if (current) parts.push(current);
  return parts.map((p) => `${head}${p}`);
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
  const add = (source, doc, title, head, body) => {
    splitText(head, body).forEach((text) => chunks.push({ source, refId: doc._id, title, text }));
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
    const body = [
      stripHtml(s.description),
      ...(s.overview || []).map(stripHtml),
      subservices.length ? `What's included:\n${subservices.join('\n')}` : '',
    ].filter(Boolean).join('\n');
    add('service', s, s.title, `Service: ${s.title}\n\n`, body);
  });
  if (services.length) {
    const overview = services.map((s) => `- ${s.title}: ${stripHtml(s.description)}`).join('\n');
    add('service', {}, 'All services', 'Service: All Rocky Real Estate services\n\n', overview);
  }
  blogs.forEach((b) => {
    const body = [
      b.description ? `Summary: ${stripHtml(b.description)}` : '',
      ...(b.content || []).map(blogBlockToText),
      ...(b.faqs || []).map((f) => `Q: ${stripHtml(f.question)}\nA: ${stripHtml(f.answer)}`),
    ].filter(Boolean).join('\n');
    const head = `Blog: ${b.title}\n${b.category ? `Category: ${b.category}\n` : ''}\n`;
    add('blog', b, b.title, head, body);
  });

  return chunks;
};

const reindex = async () => {
  const chunks = await buildChunks();
  const vectors = chunks.length ? await embed(chunks.map((c) => c.text)) : [];
  const docs = chunks.map((c, i) => ({ ...c, embedding: vectors[i] }));

  await ChatbotChunk.deleteMany({});
  if (docs.length) await ChatbotChunk.insertMany(docs);
  chunkCache = null;

  const bySource = docs.reduce((acc, d) => ({ ...acc, [d.source]: (acc[d.source] || 0) + 1 }), {});
  return { chunks: docs.length, bySource };
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
  return chunkCache
    .map((c) => ({ source: c.source, title: c.title, text: c.text, score: cosine(queryVector, c.embedding) }))
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
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

const chat = async ({ sessionId, message }) => {
  const session = await ChatSession.findOne({ sessionId }).lean();
  const history = (session?.messages || []).slice(-HISTORY_LIMIT).map(({ role, content }) => ({ role, content }));

  let reply = FALLBACK_REPLY;
  let properties = [];
  try {
    const hits = await retrieve(message, 4);
    const knowledge = hits.length
      ? hits.map((h, i) => `[${i + 1}] (${h.source}) ${h.title}\n${h.text}`).join('\n\n')
      : 'No relevant knowledge found.';
    const messages = [
      { role: 'system', content: `${RULES}\n\nKNOWLEDGE (use only this for company/area facts):\n${knowledge}` },
      ...history,
      { role: 'user', content: message },
    ];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const completion = await getOpenAI().chat.completions.create({
        model: process.env.OPENAI_CHAT_MODEL,
        reasoning_effort: process.env.OPENAI_REASONING_EFFORT,
        messages,
        tools: TOOLS,
        tool_choice: round === MAX_TOOL_ROUNDS ? 'none' : 'auto',
      });
      const msg = completion.choices[0].message;
      if (!msg.tool_calls?.length) {
        if (msg.content?.trim()) reply = msg.content.trim();
        break;
      }

      messages.push(msg);
      for (const call of msg.tool_calls) {
        let result;
        try {
          result = await runTool(call.function.name, JSON.parse(call.function.arguments || '{}'), sessionId);
          if (call.function.name === 'search_properties') properties = result;
        } catch (toolError) {
          console.error(`[Chatbot] Tool ${call.function.name} failed:`, toolError.message);
          result = { error: 'Tool failed' };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
  } catch (error) {
    console.error('[Chatbot] Chat failed:', error.message);
  }

  const now = new Date();
  await ChatSession.findOneAndUpdate(
    { sessionId },
    { $push: { messages: { $each: [{ role: 'user', content: message, at: now }, { role: 'assistant', content: reply, at: now }] } } },
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
