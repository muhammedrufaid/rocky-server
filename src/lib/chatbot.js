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

// `mention` (e.g. ["rera"]): chunks naming every one of these words come first, even below MIN_SCORE, because a short
// term like "RERA" scores low against long texts that are about it.
const retrieve = async (query, k = 4, { mention = [] } = {}) => {
  await loadChunks();
  if (!chunkCache.length) return [];

  const [queryVector] = await embed(query);
  const mentions = (text) => mention.length > 0 && mention.every((w) => new RegExp(`\\b${escapeRegex(w)}`, 'i').test(text));
  const ranked = chunkCache
    .map((c) => ({ source: c.source, refId: c.refId, title: c.title, text: c.text, score: cosine(queryVector, c.embedding), named: mentions(c.text) }))
    .filter((c) => c.score >= MIN_SCORE || c.named)
    .sort((a, b) => b.named - a.named || b.score - a.score);

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

// ---------- Related links ----------

// Knowledge sources with their own website page; FAQs and team entries have none.
const LINKED_SOURCES = {
  blog: { model: Blog, route: '/blogs', contentType: 'blog', label: (title) => title },
  area: { model: AreaGuide, route: '/area-guides', contentType: 'area_guide', label: (title) => `${title} area guide` },
  service: { model: Service, route: '/services', contentType: 'service', label: (title) => `${title} service` },
};
// Pages a question is about score 0.55+; pages that only share a word or two with it score lower.
const MIN_LINK_SCORE = 0.55;
// A page far below the best knowledge match is a side topic, not what the answer is about.
const LINK_SCORE_MARGIN = 0.1;
const MAX_RELATED_LINKS = 2;

// A page's stored path, else its route from the slug; relative, so links stay on the current origin.
const pagePath = (doc, route) => (doc.path?.startsWith('/') ? doc.path : `${route}/${doc.slug}`);

// Website pages behind the knowledge an answer was given, most relevant first. `askedArea` is the area an area
// question named: its own guide counts even when the wording scores low ("Tell me about JVC").
const relatedLinks = async (hits, askedArea = '') => {
  const best = Math.max(0, ...hits.map((h) => h.score));
  const picked = [];
  hits.forEach((h) => {
    const relevant = (h.score >= MIN_LINK_SCORE && best - h.score <= LINK_SCORE_MARGIN) || (h.source === 'area' && h.title === askedArea);
    if (relevant && LINKED_SOURCES[h.source] && h.refId && !picked.some((p) => String(p.refId) === String(h.refId))) picked.push(h);
  });

  const links = [];
  for (const h of picked) {
    const { model, route, contentType, label } = LINKED_SOURCES[h.source];
    // Only pages that are still live: content unpublished since the last reindex is never linked.
    const doc = await model.findOne({ _id: h.refId, isActive: true }).select('title slug path').lean();
    if (doc) links.push({ type: 'related_link', label: label(doc.title), url: pagePath(doc, route), contentType });
    if (links.length === MAX_RELATED_LINKS) break;
  }
  return links;
};

// Link lines go after the answer and before its closing question, so the reply still ends with that question.
// A link the reply already names is not repeated.
const withLinkLines = (reply, links) => {
  const lines = links.filter((l) => !reply.includes(l.url)).map((l) => `Read more: ${l.label} (${l.url})`);
  if (!lines.length) return reply;
  const question = reply.endsWith('?') ? closingOffer(reply) : '';
  const answer = question ? reply.slice(0, reply.lastIndexOf(question)).trim() : reply;
  return [answer, lines.join('\n'), question].filter(Boolean).join('\n\n');
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
const SEARCH_FAILED_TEXT = "I'm unable to load live property listings right now. Please try again shortly.";
const UNVERIFIED_REPLY =
  "I can only share listings and prices from our live inventory. Tell me the area and whether you'd like to buy or rent, and I'll search it for you.";
const UNVERIFIED_FIGURES_REPLY = "I don't have verified figures for that right now. An agent can confirm the current details for you.";

// Model replies must not contain placeholder listings or AED amounts that appear nowhere in what the model was given
// (knowledge, conversation, session state, tool results). Returns why a reply was rejected, or ''.
const PLACEHOLDER_RE = /\b(sample|example|dummy|placeholder|mock)\s+(listing|property|properties|unit|home)s?\b|\bAED\s*X|\bX{1,3}(,X{3})+\b|\b(listing|property)\s+[A-C]\b/i;
const UNIT_MULTIPLIER = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };
const toAmount = (digits, unit) => Math.round(parseFloat(digits.replace(/,/g, '')) * (UNIT_MULTIPLIER[String(unit || '').toLowerCase()] || 1));
const AMOUNT = String.raw`(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|mn|m|million|bn|billion)?\b`;
const amountsIn = (text) => [...String(text).matchAll(new RegExp(AMOUNT, 'gi'))].map(([, d, u]) => toAmount(d, u));
// "AED 2–5M" gives 2,000,000 and 5,000,000: a unit after the range also applies to its first number.
const aedAmountsIn = (text) =>
  [...String(text).matchAll(new RegExp(String.raw`AED\s*${AMOUNT}(?:\s*(?:-|–|to)\s*(?:AED\s*)?${AMOUNT})?`, 'gi'))].flatMap(([, d1, u1, d2, u2]) =>
    d2 ? [toAmount(d1, u1 || u2), toAmount(d2, u2)] : [toAmount(d1, u1)]
  );
const unverifiedReplyReason = (reply, sources) => {
  if (PLACEHOLDER_RE.test(reply)) return 'placeholder listing text';
  const known = sources.flatMap(amountsIn);
  // 1% tolerance so a rounded real price ("AED 3.05 million" for 3,051,725) still counts as sourced.
  const invented = aedAmountsIn(reply).filter((n) => !known.some((k) => Math.abs(k - n) <= n * 0.01));
  return invented.length ? `AED amounts not in any source: ${invented.join(', ')}` : '';
};

const logSearch = (sessionId, args, { stage, total, properties }) =>
  console.info(
    '[Chatbot] search',
    JSON.stringify({ sessionId, args, stage, total, fallback: stage !== 'exact', ids: properties.map((p) => p.propertyRefNo) })
  );
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

// ---------- Metro proximity ----------
// Listings, buildings and stations have no coordinates, so metro proximity comes only from what a listing's own title or
// description states, and only when it names the station: "Close to Al Furjan Metro Station", "Metro station (DMCC)".
// Vague ("excellent metro connectivity") or future ("near upcoming metro") wording never counts.
const METRO_MENTION_RE = /metro/i;
const METRO_PROXIMITY_RE = /\b(near|nearby|close|walking|walk|steps|minutes?|mins?|next to|adjacent|opposite|access|ft|feet|meters?|metres?|km)\b/i;
const FUTURE_METRO_RE = /\b(upcoming|future|planned|proposed|under construction)\b/i;
// Capitalised words right before "Metro Station" ("Al Jaddaf Metro Station"), or the name in brackets after it.
const STATION_NAME_RE = /\b((?:[A-Z][\w&'-]*\s+){0,3}[A-Z][\w&'-]*)\s+Metro\s+[Ss]tation\b/;
const STATION_IN_BRACKETS_RE = /\bMetro\s+station\s*\(\s*([^)]+?)\s*\)/i;
// Sentence-start or connecting words picked up before a station name ("Near Al Furjan" -> "Al Furjan").
const NOT_STATION_WORDS_RE = /^(?:(?:near|nearby|close|to|the|access|walking|distance|located|convenient|easy|and|of|from|by|next|steps|with)\s+)+/i;
const STATED_DISTANCE_RE = /\b\d+(?:\.\d+)?\s*(?:m|meters?|metres?|km|ft|feet|mins?|minutes?)\b(?:\s+walk(?:ing)?)?/i;

const stationName = (segment) => {
  const bracketed = segment.match(STATION_IN_BRACKETS_RE);
  if (bracketed) return bracketed[1];
  const named = segment.match(STATION_NAME_RE);
  const name = named ? named[1].replace(NOT_STATION_WORDS_RE, '').trim() : '';
  return name && name.toLowerCase() !== 'dubai' ? name : '';
};

// The metro station a listing says it is close to, with the distance only when the listing states one; null otherwise.
const listingMetro = (p) => {
  const segments = `${p.propertyTitle || ''}\n${p.propertyDescription || ''}`.split(/[\n•|*]+|(?<=[.!?])\s+/);
  for (const segment of segments) {
    if (!METRO_MENTION_RE.test(segment) || FUTURE_METRO_RE.test(segment) || !METRO_PROXIMITY_RE.test(segment)) continue;
    const station = stationName(segment);
    if (station) return { station: `${station} Metro Station`, distance: segment.match(STATED_DISTANCE_RE)?.[0].toLowerCase() || null };
  }
  return null;
};

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
  building: p.towerName || '',
  district: p.subLocality || '',
  community: String(p.locality || '').replace(/\s*\([^)]*\)/, '').trim(),
  image: p.images?.[0] || null,
  url: propertyUrl(p),
  // { station, distance } as stated in the listing (see listingMetro), or null.
  metro: listingMetro(p),
});

// A card needs these real values; a listing missing any of them is dropped, never filled with defaults.
const REQUIRED_LISTING_FIELDS = ['propertyRefNo', 'title', 'category', 'location', 'path'];
const isCompleteListing = (p) => p.priceAED > 0 && REQUIRED_LISTING_FIELDS.every((f) => String(p[f] ?? '').trim());

// Same query as the buy/rent listing pages, so a View All URL built from these args shows the same total.
// Area terms are what the listing page derives from the URL slug ("dubai-marina" -> "dubai marina").
const FURNISHED_VALUES = { furnished: 'Yes', unfurnished: 'No', 'partly furnished': 'Partly' };

const findProperties = async ({ purpose, location, type, bedrooms, furnishing, amenities, near_metro, min_price, max_price } = {}, limit = 6) => {
  const search = (Array.isArray(location) ? location : [location]).filter(Boolean).map((l) => areaSlug([l]).replace(/-/g, ' '));
  // One bedroom count uses the listing-page filter; a set ("1,2,3") matches any of its counts.
  const beds = bedroomList(bedrooms);
  const filters = {
    propertyType: type || undefined,
    priceMin: Number(min_price) > 0 ? Number(min_price) : undefined,
    priceMax: Number(max_price) > 0 ? Number(max_price) : undefined,
    beds: beds.length === 1 ? parseInt(beds[0], 10) || 0 : undefined,
    furnished: FURNISHED_VALUES[furnishing],
  };
  const forced = CATEGORY_MATCH[toCategory(purpose)] || {};
  const bedroomSetMatch = beds.length > 1 ? [{ $match: { $expr: { $in: [toNumber('bedrooms'), beds.map(Number)] } } }] : [];
  // Every requested amenity must be in the listing's own feature list ("pool" matches "Shared Pool"); a listing without
  // a feature list is never counted as having one.
  const amenityMatch = amenities?.length
    ? [{ $match: { $and: amenities.map((word) => ({ features: { $regex: `\\b${escapeRegex(word)}`, $options: 'i' } })) } }]
    : [];
  // Metro proximity is checked per listing (see listingMetro), so the query only narrows to listings mentioning a metro
  // and all of them are checked before counting.
  const metroMatch = near_metro ? [{ $match: { $or: [{ propertyTitle: METRO_MENTION_RE }, { propertyDescription: METRO_MENTION_RE }] } }] : [];

  let result;
  try {
    [result] = await Property.aggregate([
      ...buildCommonPipeline({ search, filters, forced }),
      ...bedroomSetMatch,
      ...amenityMatch,
      ...metroMatch,
      { $addFields: { priceNum: toNumber('price') } },
      // A listing without a real price is never shown or counted.
      { $match: { priceNum: { $gt: 0 } } },
      { $sort: { priceNum: 1 } },
      { $facet: { items: [{ $limit: near_metro ? AREA_SCAN_LIMIT : limit }], meta: [{ $count: 'total' }] } },
    ]);
  } catch (err) {
    err.propertySearchFailed = true;
    throw err;
  }

  const formatted = result.items.map(formatProperty);
  const complete = formatted.filter(isCompleteListing);
  const skipped = formatted.length - complete.length;
  if (skipped) {
    console.warn('[Chatbot] Skipped malformed listings:', formatted.filter((p) => !isCompleteListing(p)).map((p) => p.propertyRefNo || '(no ref)'));
  }
  if (near_metro) {
    const verified = complete.filter((p) => p.metro);
    return { items: verified.slice(0, limit), total: verified.length, startingPrice: verified[0]?.priceAED || null };
  }
  const total = complete.length ? (result.meta[0]?.total || 0) - skipped : 0;
  return { items: complete.slice(0, limit), total, startingPrice: complete[0]?.priceAED || null };
};

const searchProperties = async (args = {}) => (await findProperties(args)).items;

const LEAD_CONTEXT_FIELDS = [
  ['purpose', 'Purpose'],
  ['location', 'Location'],
  ['propertyType', 'Property Type'],
  ['budget', 'Budget'],
  ['bedrooms', 'Bedrooms'],
  ['amenities', 'Amenities'],
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
// Property types as stored in Property.propertyType. Offices, shops, retail units and showrooms are offered as
// alternatives to each other; a labour camp is only ever matched exactly.
const RESIDENTIAL_TYPES = ['Apartment', 'Villa', 'Townhouse'];
const WORKSPACE_TYPES = ['Office', 'Shop', 'Retail', 'Showroom'];
const COMMERCIAL_TYPES = [...WORKSPACE_TYPES, 'Labour Camp'];
const isCommercial = (propertyType) => COMMERCIAL_TYPES.includes(propertyType);
const typeKind = (propertyType) => (isCommercial(propertyType) ? 'commercial' : 'residential');
// Which kind of property the saved search is for: 'commercial' (a commercial type), 'residential' (a home type or a
// bedroom requirement) or '' (not known yet).
const searchKind = (q) => {
  if (q.propertyType) return typeKind(q.propertyType);
  return q.bedrooms || q.bedroomsFlexible ? 'residential' : '';
};
// Bedrooms don't apply to commercial property, so they are never asked or listed as missing for it.
const fieldApplies = (q, field) => field !== 'bedrooms' || searchKind(q) !== 'commercial';
// A commercial word right after one of these is an amenity or the company's own office ("near shops", "your office",
// "head office"), not the property the user wants.
const NOT_WANTED_BEFORE = "(?<!\\b(?:near|nearby|to|and|by|your|our|the|head|main|rocky'?s) )";
const commercialTypeRe = (words) => new RegExp(`${NOT_WANTED_BEFORE}\\b(?:${words})\\b`);
// Residential types first, so "apartment near shops" stays an apartment search.
const PROPERTY_TYPES = [
  [/\b(apartments?|flats?)\b/, 'Apartment'],
  [/\bvillas?\b/, 'Villa'],
  [/\btown ?houses?\b/, 'Townhouse'],
  [commercialTypeRe('offices?(?! (?:hours?|address|location|timings?))'), 'Office'],
  [commercialTypeRe('show ?rooms?'), 'Showroom'],
  [commercialTypeRe('retail'), 'Retail'],
  [commercialTypeRe('shops?'), 'Shop'],
  [commercialTypeRe('labou?r camps?'), 'Labour Camp'],
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
// "Do you have villas in Dubai Hills?" / "Any listings in JVC?": asks about inventory, so it is a property search.
const AVAILABILITY_RE = /\b(do|does) (you|rocky( real estate)?) have\b|\bhave you got\b|\bavailab\w*|\blistings?\b|\bfor (sale|rent)\b/i;
// "What about JVC?" during a search moves the search to JVC rather than asking about the area.
const SWITCH_AREA_RE = /^\s*(what|how) about\b/i;
const VIEWING_RE = /\b(arrange|book|schedule)\b[^.?!]*\bviewing\b/i;
const VIEWING_CONFIRM_TEXT = "Thanks — I'll pass your viewing request to the team.";
const NEARBY_AREAS = require('../constants/nearbyAreas.json');
const PREVIEW_LIMIT = 3;
const MAX_NEARBY_AREAS = 3;
const MAX_RECOMMENDATIONS = 3;
const CATEGORY_QUESTION = 'Which category would you like to explore?';
const ALTERNATIVES_QUESTION = 'Would you like to see one of these?';
const categoryQuestion = (location) => `Would you like to buy, rent, or explore off-plan properties in ${location}?`;

// Choice questions the backend asks. When a reply ends with one, its key is stored as the session's pendingQuestion,
// so the next short reply ("yes", "no", "another area") is read as an answer to it rather than as a new search.
// `options` are the search fields the user can choose to change.
const CHOICE_QUESTIONS = {
  budgetOrArea: { text: 'Would you like to adjust the budget or try another area?', options: ['budget', 'location'] },
  areaTypeOrBedrooms: { text: 'Would you like to try another area or adjust the property type or bedrooms?', options: ['location', 'propertyType', 'bedrooms'] },
  areaOrType: { text: 'Would you like to try another area or a different property type?', options: ['location', 'propertyType'] },
  alternatives: { text: ALTERNATIVES_QUESTION },
  // "Would you be open to 3 bedrooms?" after the closest bedroom count was offered (see bedroomQuestion).
  bedroomOffer: { re: /Would you be open to (a studio|\d+ bedrooms?)( in one of these communities)?\?$/ },
  // Next steps after search results (see resultsNextStep) and after one property's details.
  showListings: { re: /Would you like to see (these \d+ listings|this listing)\?$/ },
  // "Which would you like to explore: Bloom Towers or Luma21?" (see pickPropertyQuestion), or the generic wording.
  pickProperty: { text: 'Which property would you like more details about?', re: /(which would you like to explore: [^?\n]+|Which property would you like more details about)\?$/i },
  propertyDetails: { text: 'Would you like more details or to arrange a viewing?' },
  viewing: { text: 'Would you like to arrange a viewing?' },
  // "Would you like me to relax the metro requirement or the pool requirement?" (see relaxQuestion).
  relaxRequirement: { re: /Would you like me to relax the [^?\n]+ requirement\?$/ },
};
// A card's name as the user sees it: the building, otherwise the district or community.
const listingName = (card) => card.building || card.district || card.community;
// Names the cards when each has its own name, so the user can answer with one ("Bloom Towers").
const pickPropertyQuestion = (cards) => {
  const names = cards.map(listingName);
  const distinct = names.every(Boolean) && new Set(names.map((n) => n.toLowerCase())).size === names.length;
  return distinct ? `Which would you like to explore: ${joinOr(names)}?` : CHOICE_QUESTIONS.pickProperty.text;
};
// The next step after a successful search, chosen from the cards the reply shows: the cards themselves when only a count
// was given, a pick when several cards are shown, details or a viewing for a single card. Never a search field question.
const resultsNextStep = (cards, total) => {
  if (!cards.length) return total === 1 ? 'Would you like to see this listing?' : `Would you like to see these ${total} listings?`;
  return cards.length > 1 ? pickPropertyQuestion(cards) : CHOICE_QUESTIONS.propertyDetails.text;
};
// Asked after listing other areas with matching listings; the reply is read as an area.
const AREA_PICK_QUESTION = 'Which of these areas would you like to try?';
const choiceQuestionIn = (reply) =>
  Object.keys(CHOICE_QUESTIONS).find((key) => {
    const { text, re } = CHOICE_QUESTIONS[key];
    return re ? re.test(reply) : reply.endsWith(text);
  }) || '';
// How the user names each option, and the single question asked once they pick it.
const REFINE_OPTIONS = {
  budget: { words: 'adjust the budget', re: /\b(budget|price|afford|spend)\b/i },
  location: { words: 'try another area', re: /\b(areas?|locations?|communit(y|ies)|neighbou?rhoods?|places?|somewhere|elsewhere)\b/i },
  propertyType: { words: 'change the property type', re: /\b(type|kind)\b/i },
  bedrooms: { words: 'change the number of bedrooms', re: /\b(bed(room)?s?|size)\b/i },
};
const refineFieldQuestion = (field, q) =>
  ({
    budget: q.purpose === 'rent' ? 'What yearly budget would you like to try, in AED?' : 'What budget would you like to try, in AED?',
    location: 'Which area would you like to try?',
    propertyType: 'Which property type would you like instead?',
    bedrooms: 'How many bedrooms would you like instead?',
  })[field];
const joinOr = (phrases) => (phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} or ${phrases[phrases.length - 1]}` : phrases[0]);

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

// Words in feature names that describe an amenity rather than name it ("Shared Pool", "Maid's Room", "Pets Allowed").
const DESCRIBING_FEATURE_WORDS = new Set(['shared', 'private', 'covered', 'built', 'children', 'central', 'area', 'room', 'service', 'allowed', 'building', 'view']);
// "Maid's" -> "maid", "Wardrobes" -> "wardrobe", "A/C" -> "ac".
const amenityWord = (word) => word.toLowerCase().replace(/'s$/, '').replace(/[^a-z]/g, '').replace(/(?<=[^s])s$/, '');
let amenityCache = null;
// Amenity words from the listings' real feature names: "Shared Pool" and "Children's Pool" -> "pool", "Balcony" ->
// "balcony". Each word maps to its reply label: the feature name when only one feature has the word ("maid" ->
// "maid's room"), otherwise the word itself ("pool"), so a reply never claims more than the listing data says.
const getKnownAmenities = async () => {
  if (amenityCache) return amenityCache;
  const byWord = new Map();
  (await Property.distinct('features')).filter(Boolean).forEach((feature) => {
    feature.split(/\s+/).map(amenityWord).filter((w) => w.length >= 3 && !DESCRIBING_FEATURE_WORDS.has(w)).forEach((w) => {
      byWord.set(w, [...new Set([...(byWord.get(w) || []), feature])]);
    });
  });
  amenityCache = new Map([...byWord].map(([word, features]) => [word, features.length === 1 ? features[0].toLowerCase() : word]));
  return amenityCache;
};
const amenityLabel = (word) => amenityCache?.get(word) || word;

// A word up to three words before the amenity that makes it a requirement: "with a swimming pool", "must have a
// balcony", "need parking".
const AMENITY_WANTED_RE = /\b(with|has|have|having|need|needs|must|want|wants|include|includes|including|plus|access to)\b(?:\s+[^\s.!?]+){0,3}\s*$/;
// Between two amenities of one list: "pool, gym and balcony".
const AMENITY_LIST_GAP_RE = /^[\s,]*(?:and|or|&|plus)?\s*(?:an?\s+|a\s+swimming\s+)?$/;
// "pool doesn't matter", "without a swimming pool", "no need for a balcony": the requirement is removed.
const AMENITY_DROPPED_BEFORE_RE = /\b(no need for|(?:do not|don'?t) need|without|forget(?: about)?|skip|relax|drop|remove)\s+(?:an?\s+|the\s+)?(?:[a-z]+\s+)?$/;
const AMENITY_DROPPED_AFTER_RE = /^\s*(?:access\s+)?(?:is\s+)?(?:(?:doesn'?t|does not|don'?t|do not|isn'?t|is not|not)\s+(?:matter|needed|necessary|required|important|a must)|optional)\b/;
// "security deposit", "water bills": a cost, not an amenity.
const NOT_AMENITY_AFTER_RE = /^\s*(deposits?|fees?|charges?|costs?|bills?)\b/;

// Amenities a message asks for or drops. A question only adds one when it asks about inventory ("Do you have studios
// with a pool?"), so "Does it have parking?" about a shown listing never changes the search.
const amenityUpdates = (text, amenities) => {
  const t = text.toLowerCase();
  const canAdd = !t.includes('?') || AVAILABILITY_RE.test(t);
  const found = [...amenities.keys()]
    .map((word) => ({ word, match: t.match(new RegExp(`\\b${word}(?:'?s|es)?\\b`)) }))
    .filter(({ match }) => match)
    .sort((a, b) => a.match.index - b.match.index);
  const wanted = [];
  const dropped = [];
  let lastWantedEnd = -1;
  found.forEach(({ word, match }) => {
    const end = match.index + match[0].length;
    const sentenceBefore = t.slice(0, match.index).split(/[.!?]/).pop();
    const after = t.slice(end);
    const listed = lastWantedEnd >= 0 && AMENITY_LIST_GAP_RE.test(t.slice(lastWantedEnd, match.index));
    if (AMENITY_DROPPED_BEFORE_RE.test(sentenceBefore) || AMENITY_DROPPED_AFTER_RE.test(after)) {
      dropped.push(word);
    } else if (canAdd && !NOT_AMENITY_AFTER_RE.test(after) && (AMENITY_WANTED_RE.test(sentenceBefore) || listed || wordCount(t) <= 4)) {
      wanted.push(word);
      lastWantedEnd = end;
    }
  });
  return { wanted, dropped };
};

// "near a metro station", "close to the metro", "walking distance to metro": the search needs metro proximity.
const METRO_WANTED_RE = /\b(near(?:by)?|close to|closer to|next to|walking distance (?:to|from|of)|walk(?:able)? to|minutes? from|access to)\s+(?:an?\s+|the\s+)?metro\b|\bmetro\s+(?:access|nearby|close by)\b/;
// "I don't need to be near the metro": anywhere before the word, not just right before it.
const METRO_NOT_NEEDED_RE = /\b(?:don'?t|do not|doesn'?t|does not|no longer)\s+(?:need|want|care|mind)\b/;

// { nearMetro: true } when a message asks for metro proximity, { nearMetroDropped: true } when it removes it ("metro
// doesn't matter", "relax the metro requirement"), {} otherwise. Same question rule as amenityUpdates.
const metroUpdate = (t) => {
  const match = t.match(/\bmetro\b/);
  if (!match) return {};
  const before = t.slice(0, match.index).split(/[.!?]/).pop();
  const after = t.slice(match.index + match[0].length).replace(/^\s+stations?\b/, '');
  if (AMENITY_DROPPED_BEFORE_RE.test(before) || AMENITY_DROPPED_AFTER_RE.test(after) || METRO_NOT_NEEDED_RE.test(before)) return { nearMetroDropped: true };
  const canAdd = !t.includes('?') || AVAILABILITY_RE.test(t);
  return canAdd && METRO_WANTED_RE.test(t) ? { nearMetro: true } : {};
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
  'office', 'offices', 'shop', 'shops', 'retail', 'showroom', 'showrooms', 'labour', 'labor', 'camp', 'camps', 'commercial',
  'property', 'properties', 'listing', 'listings', 'budget', 'under', 'below', 'furnished', 'unfurnished', 'yes', 'no', 'ok',
  'okay', 'sure', 'thanks', 'please', 'hello', 'hi', 'offplan', 'off', 'plan', 'next', 'month', 'year',
  // Recommendation wording ("best areas for families") is never read as a misspelled area.
  'best', 'top', 'good', 'popular', 'affordable', 'cheap', 'cheapest', 'investment', 'area', 'areas', 'community', 'communities',
  'neighborhood', 'neighborhoods', 'neighbourhood', 'neighbourhoods', 'place', 'places', 'live', 'school', 'schools', 'metro',
  'waterfront', 'kids', 'children',
  // Refinement wording ("another area", "any nearest areas", "something else") is never read as an area either.
  'any', 'anything', 'another', 'other', 'others', 'different', 'else', 'somewhere', 'something', 'nearby', 'nearest', 'near',
  'close', 'closest', 'surrounding', 'option', 'options', 'not', 'maybe', 'none', 'same', 'more', 'try', 'change', 'adjust',
]);
// Common reply words: a reply made only of these is never taken as a place name.
const REPLY_WORDS = new Set([
  'i', 'im', 'it', 'its', 'is', 'are', 'the', 'you', 'we', 'what', 'which', 'where', 'how', 'why', 'can', 'could', 'would',
  'show', 'tell', 'find', 'search', 'want', 'need', 'like', 'prefer', 'suggest', 'recommend', 'choose', 'pick', 'whatever',
  'idk', 'dont', 'know', 'mind', 'matter', 'fine', 'great', 'cool', 'just', 'only', 'also', 'thank', 'there', 'here', 'one',
  'cheaper', 'bigger', 'smaller', 'price', 'help', 'unsure', 'hmm',
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
  !text.includes('?') && !NEARBY_RE.test(text) && (ANY_LOCATION_RE.test(text) || (areaAsked && NO_PREFERENCE_RE.test(text)));

// "any nearest areas", "somewhere nearby", "nearby options": the user wants areas close to the current one.
const NEARBY_RE =
  /\b(near(by|est)|closest|close ?by|surrounding)\b[^?]*\b(areas?|locations?|communit(y|ies)|places?|options?|neighbou?rhoods?)\b|\b(somewhere|anything|anywhere|something|options?|areas?|communit(y|ies))\s+(near ?by|close ?by)\b|^\s*(any(thing)?\s+)?(near ?by|close ?by)\s*[?.!]?\s*$/i;

// An area we have no listings for ("Al Quoz") is unknown to the location list. When it is the answer to our area
// question, it still replaces the old area, so the search reports zero results there instead of keeping the old area.
// Each comma-separated part is checked ("Al Quoz, any budget"); a part counts only if it is 1-4 plain words and none
// is a search or reply word.
const placeFromAreaAnswer = (text) => {
  if (text.includes('?')) return '';
  const parts = text.toLowerCase().split(/,|\band\b/).map((p) => p.trim()).filter(Boolean);
  const place = parts.find((part) => {
    const words = part.split(/\s+/);
    return (
      /^[a-z][a-z' -]*$/.test(part) && words.length <= 4 && part.length >= 3 &&
      words.every((w) => !NOT_PLACE_WORDS.has(w) && !REPLY_WORDS.has(w.replace(/'/g, '')))
    );
  });
  return place ? place.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : '';
};

// The words after "in", up to a price/purpose word or the end of the sentence: "showroom in Al Quoz under 3M" -> "Al Quoz".
const NAMED_PLACE_RE = /\bin ([a-z][a-z' -]*?)\s*(?:\b(?:under|below|for|with|around|within|up to|budget|max)\b|[.,!?]|$)/i;

const bedroomValue = (word) => (word === 'studio' ? '0' : String(WORD_NUMBERS[word] || word));

// "any bedroom(s)", "bedrooms don't matter", "no bedroom preference": clears the bedroom filter.
const ANY_BEDROOMS_RE =
  /\bany (number of )?(bed(room)?s?|bhk)\b|\bbed(room)?s? (doesn'?t|does not|don'?t|do not|won'?t) matter\b|\bno bed(room)?s? preference\b|\b(flexible|open) (on|with|about) bed(room)?s?\b/i;
// Several bedroom counts: "1, 2 or 3 bedrooms", "studio or 1 bed", "2-3 bedrooms", or a bare "1 or 2 or 3".
const BED_LIST_RE =
  /\b(\d|one|two|three|four|five|six|studio)((?:\s*(?:,|\bor\b|\band\b|\/|\bto\b|-)\s*(?:\d|one|two|three|four|five|six|studio)\b)+)(?:\s*-?\s*([a-z]+))?/;
// Words that make a number list something other than bedrooms ("1 or 2 million", "2 or 3 weeks").
const NOT_BEDROOM_UNIT_RE = /^(k|m|mn|million|aed|dirhams?|days?|weeks?|months?|years?|am|pm|baths?|bathrooms?|kids|children|people|persons?)$/;
// Returns the counts as "1,2,3", or '' when the message has no bedroom set.
const bedroomSet = (text) => {
  const match = text.match(BED_LIST_RE);
  if (!match) return '';
  const [whole, , joins, next = ''] = match;
  const bedWord = /^(bed|beds|bedroom|bedrooms|br|bhk)$/.test(next);
  const isRange = /\bto\b|-/.test(joins);
  // Without the word "bedroom", only a plain "or"/comma list counts.
  if (!bedWord && (NOT_BEDROOM_UNIT_RE.test(next) || isRange || /\band\b/.test(joins))) return '';
  const values = whole.match(/\b(\d|one|two|three|four|five|six|studio)\b/g).map(bedroomValue).map(Number);
  const counts = isRange && values.length === 2 ? Array.from({ length: values[1] - values[0] + 1 }, (_, i) => values[0] + i) : values;
  return [...new Set(counts)].sort((a, b) => a - b).join(',');
};
// "1M to 2M", "between 800k and 1.2 million", "800,000 - 1,200,000": a budget range (min and max).
const BUDGET_RANGE_RE = /(\d[\d,]*(?:\.\d+)?)\s*(k|m|mn|million)?\s*(?:-|to|and)\s*(?:aed\s*)?(\d[\d,]*(?:\.\d+)?)\s*(k|m|mn|million)?\b/;
const budgetRange = (text) => {
  const match = text.match(BUDGET_RANGE_RE);
  if (!match) return null;
  const [, lowDigits, lowUnit, highDigits, highUnit] = match;
  const min = toAmount(lowDigits, lowUnit || highUnit);
  const max = toAmount(highDigits, highUnit || lowUnit);
  // Small unitless numbers ("2 to 3 bedrooms") are not prices.
  if (!(lowUnit || highUnit) && min < 1000) return null;
  return max > min ? { budgetMin: String(min), budget: String(max) } : null;
};
// A bare "any" / "doesn't matter" answers whichever field we just asked about.
const isNoPreference = (t) => !t.includes('?') && (NO_PREFERENCE_RE.test(t) || /^\s*any(thing)?\s*[.!]?\s*$/.test(t));

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

// Search updates in one message. A field the message doesn't mention is left out (no change); a value sets it; a
// <field>Flexible flag ("any budget", "any bedroom", "anywhere") clears that filter. See applySearchUpdates.
const extractQualification = (text, locations, { fuzzy = true, lastQuestion = '', amenities = new Map() } = {}) => {
  const asked = questionFields(lastQuestion);
  const areaAsked = asked.includes('location');
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
  if (areaAsked && !found.location && !found.locationFlexible && !found.locationSuggestion && !NEARBY_RE.test(text)) {
    const place = placeFromAreaAnswer(text);
    if (place) found.location = place;
  }

  const type = PROPERTY_TYPES.find(([re]) => re.test(t));
  if (type) found.propertyType = type[1];
  // "shops for rent in Deira": a place without listings or an area guide is still the area the user asked for, so the
  // search reports no results there instead of silently searching all of Dubai.
  if (found.propertyType && !found.location && !found.locationFlexible && !found.locationSuggestion) {
    const named = text.match(NAMED_PLACE_RE);
    const place = named ? placeFromAreaAnswer(named[1]) : '';
    if (place && place.toLowerCase() !== 'dubai') found.location = place;
  }

  // 'any' clears the furnishing requirement ("furnished doesn't matter", "any furnishing").
  if (/\bany furnishing\b|\bfurnish\w* (doesn'?t|does not|won'?t) matter\b|\bfurnished or (not|unfurnished)\b|\beither furnished or\b/.test(t)) found.furnishing = 'any';
  else if (/\b(unfurnished|not furnished)\b/.test(t)) found.furnishing = 'unfurnished';
  else if (/\b(semi|partly|partially)[- ]?furnished\b/.test(t)) found.furnishing = 'partly furnished';
  else if (/\bfurnished\b/.test(t)) found.furnishing = 'furnished';

  // The area's name is left out, so "Discovery Gardens" is never read as a garden.
  let amenityText = location ? text.replace(location[2], ' ') : text;
  if (found.location) amenityText = amenityText.replace(new RegExp(escapeRegex(found.location), 'ig'), ' ');
  const { wanted, dropped } = amenityUpdates(amenityText, amenities);
  if (wanted.length) found.amenities = wanted;
  if (dropped.length) found.amenitiesDropped = dropped;
  Object.assign(found, metroUpdate(amenityText.toLowerCase()));

  const noPhone = t.replace(new RegExp(PHONE_RE.source, 'g'), ' ');
  const noPreference = isNoPreference(t);

  // Bedrooms: "any bedroom" clears the filter, a set ("1 or 2 or 3") or a single count replaces the old value.
  const bedrooms = bedroomSet(noPhone);
  if (ANY_BEDROOMS_RE.test(t) || (asked.includes('bedrooms') && noPreference)) found.bedroomsFlexible = true;
  else if (bedrooms) found.bedrooms = bedrooms;
  else {
    if (/\bstudio\b/.test(t)) found.bedrooms = '0';
    const beds = t.match(/\b(\d|one|two|three|four|five|six)\s*-?\s*(bed|beds|bedroom|bedrooms|br|bhk)\b/);
    if (beds) found.bedrooms = String(WORD_NUMBERS[beds[1]] || beds[1]);
  }

  // Budget: a range sets min and max, an amount sets the max, "any budget" clears both.
  const range = budgetRange(noPhone);
  const short = noPhone.match(/(\d+(?:\.\d+)?)\s*(k|m|mn|million)\b/);
  const long =
    noPhone.match(/(?:aed|budget|under|below|around|up to|upto|max)\s*(?:of\s*|is\s*)?(?:aed\s*)?(\d[\d,]{3,})/) ||
    noPhone.match(/(\d[\d,]{4,})\s*(?:aed|dirhams?|per year|a year|yearly)/);
  if (range) Object.assign(found, range);
  else if (short) found.budget = String(Math.round(parseFloat(short[1]) * (short[2] === 'k' ? 1000 : 1000000)));
  else if (long) found.budget = long[1].replace(/,/g, '');
  else if (
    /\b(any|no|flexible|open) (budget|price)\b|\bbudget (doesn'?t|does not|won'?t|isn'?t|is not) (matter|an issue|a problem)\b|\bno (price |budget )?limit\b|\bshow me anything\b/.test(t) ||
    (asked.includes('budget') && noPreference)
  ) {
    found.budgetFlexible = true;
  }
  const answered = answerToQuestion(text, lastQuestion, noPhone);
  if (!found.budget && !found.budgetFlexible && answered.budget) found.budget = answered.budget;
  if (found.bedrooms === undefined && !found.bedroomsFlexible && answered.bedrooms !== undefined) found.bedrooms = answered.bedrooms;

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
  const args = {
    purpose: q.purpose,
    location: q.location,
    type: q.propertyType,
    bedrooms: q.bedrooms,
    furnishing: q.furnishing,
    amenities: q.amenities?.length ? q.amenities : undefined,
    near_metro: q.nearMetro || undefined,
    min_price: Number(q.budgetMin) || undefined,
    max_price: Number(q.budget) || undefined,
  };
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== ''));
};

// The model's search_properties args corrected by the session state: filters the state knows always win and cleared
// ones ("any budget", "any bedroom", "anywhere") are removed, so a search never uses stale values from the history.
// A type that isn't a stored property type (e.g. "Studio", which is a bedroom count) is dropped instead of matching nothing.
const toolSearchArgs = (args, q) => {
  const merged = { ...args, ...searchArgsFromState(q), furnishing: q.furnishing };
  const knownType = [...RESIDENTIAL_TYPES, ...COMMERCIAL_TYPES].find((t) => t.toLowerCase() === String(merged.type || '').toLowerCase());
  if (knownType) merged.type = knownType;
  else delete merged.type;
  if (q.bedroomsFlexible) delete merged.bedrooms;
  if (q.budgetFlexible) {
    delete merged.min_price;
    delete merged.max_price;
  }
  if (q.locationFlexible) delete merged.location;
  return merged;
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
// Bedrooms are stored as one count ("2") or a set ("1,2,3"); '0' is a studio.
const bedroomList = (bedrooms) => String(bedrooms ?? '').split(',').map((b) => b.trim()).filter(Boolean);
// "2-bedroom", "studio", or for a set "1, 2 or 3-bedroom".
const bedsLabel = (bedrooms, words = false) => {
  const list = bedroomList(bedrooms);
  if (!list.length) return '';
  if (list.length === 1 && list[0] === '0') return 'studio';
  const label = (b) => (b === '0' ? 'studio' : words && list.length === 1 ? BED_WORDS[b] || b : b);
  return `${joinOr(list.map(label))}-bedroom`;
};

// "a 4-bedroom apartment for rent in Dubai Marina within AED 250,000/year" or, with a count, "two-bedroom apartments for rent ..."
const describeCriteria = (q, { location = q.location, bedrooms = q.bedrooms, maxPrice = q.budget, plural = false, priceWord = 'under' } = {}) => {
  let noun = q.propertyType ? q.propertyType.toLowerCase() : q.purpose === 'rent' ? 'rental' : 'property';
  if (noun === 'retail') noun = 'retail unit';
  if (plural) noun = noun === 'property' ? 'properties' : `${noun}s`;
  const forWhat = q.purpose === 'rent' ? ' for rent' : q.purpose === 'buy' ? ' for sale' : '';
  const suffix = noun.startsWith('rental') ? '' : forWhat;
  // location '' means the caller wants no area wording at all.
  const where = location ? ` in ${location}` : q.locationFlexible && location !== '' ? ' across Dubai' : '';
  const range = Number(q.budgetMin) && String(maxPrice) === String(q.budget);
  const price = !Number(maxPrice)
    ? ''
    : range
      ? ` between ${priceText(q.budgetMin, q.purpose)} and ${priceText(maxPrice, q.purpose)}`
      : ` ${priceWord} ${priceText(maxPrice, q.purpose)}`;
  const offPlan = q.purpose === 'off-plan' ? 'off-plan' : '';
  // One count goes before the noun ("2-bedroom villas"); a set after it ("villas for sale with 1, 2 or 3 bedrooms").
  const beds = bedroomList(bedrooms);
  const bedsBefore = beds.length > 1 ? '' : bedsLabel(bedrooms, plural);
  const bedsAfter = beds.length > 1 ? ` with ${joinOr(beds.map((b) => (b === '0' ? 'studio' : b)))} bedroom${beds[beds.length - 1] === '1' ? '' : 's'}` : '';
  const amenities = q.amenities?.length ? ` with ${joinPhrases(q.amenities.map(amenityLabel))}` : '';
  const metro = q.nearMetro ? `${amenities ? ',' : ''} near a metro station` : '';
  const text = `${[bedsBefore, q.furnishing, offPlan, noun].filter(Boolean).join(' ')}${suffix}${bedsAfter}${where}${price}${amenities}${metro}`;
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
// The listing pages have no furnishing, amenity or metro filter and filter one bedroom count only.
const listingPageCanFilter = (q) => !q.furnishing && !q.amenities?.length && !q.nearMetro && bedroomList(q.bedrooms).length <= 1;

// The listing pages filter one bedroom count only, so a bedroom set is left out of the URL.
const listingUrl = ({ purpose, locations = [], propertyType, bedrooms, minPrice, maxPrice }) => {
  const params = new URLSearchParams();
  const slug = areaSlug(locations);
  if (slug) params.set('search', slug);
  if (propertyType) params.set('type', propertyType);
  if (Number(minPrice)) params.set('min', String(Number(minPrice)));
  if (Number(maxPrice)) params.set('max', String(Number(maxPrice)));
  if (bedroomList(bedrooms).length === 1) params.set('beds', String(bedrooms));
  const query = params.toString().replace(/\+/g, '%20');
  return `${CATEGORY_PATHS[toCategory(purpose)] || CATEGORY_PATHS.buy}${query ? `?${query}` : ''}`;
};

// The closest bedroom counts, one more before one fewer: 2 -> 3, 1; 3 -> 4, 2; studio (0) -> 1. A set ("1,2,3") has none.
const bedroomAlternatives = (bedrooms) => {
  const n = Number(bedrooms);
  if (bedroomList(bedrooms).length !== 1 || !Number.isFinite(n)) return [];
  return [n + 1, n - 1].filter((b) => b >= 0 && b <= 6).map(String);
};

// The same request (purpose, type, budget, furnishing and area all kept) with the closest bedroom count that has real
// listings, or null. Only a suggestion: the saved bedrooms change only when the user accepts it.
const closestBedroomMatch = async (args) => {
  for (const bedrooms of bedroomAlternatives(args.bedrooms)) {
    const found = await findProperties({ ...args, bedrooms }, AREA_SCAN_LIMIT);
    if (found.total) return { location: args.location, bedrooms, ...found };
  }
  return null;
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

// The listing-page link for a request; undefined when the page can't apply the same filters (see listingPageCanFilter),
// so a link never shows a different set of listings than the count next to it.
const listingUrlFor = (q, location, purpose = q.purpose) =>
  listingPageCanFilter(q)
    ? listingUrl({ purpose, locations: [].concat(location), propertyType: q.propertyType, bedrooms: q.bedrooms, minPrice: q.budgetMin, maxPrice: q.budget })
    : undefined;

// One area's live listings per category: count, lowest price and listing-page link, all from the same filters.
// Categories without listings are left out; null when the area has none.
const areaAvailability = async (q, location, purposes) => {
  const availability = [];
  for (const purpose of purposes) {
    const found = await findProperties({ ...searchArgsFromState({ ...q, purpose }), location }, 1);
    if (!found.total) continue;
    availability.push({
      purpose,
      total: found.total,
      startingPrice: found.startingPrice,
      rentFrequency: found.items[0].rentFrequency,
      url: listingUrlFor(q, location, purpose),
    });
  }
  if (!availability.length) return null;
  // Rent, buy and off-plan are all Property listings and each listing is in exactly one category, so they add up.
  const total = availability.reduce((sum, a) => sum + a.total, 0);
  // The card has a single "View properties" link: the category with the most listings.
  const largest = [...availability].sort((a, b) => b.total - a.total)[0];
  return { total, startingPrices: availability, viewAllUrl: largest.url };
};

// Fallback step 5: one other community with verified matching listings (every filter kept), used only when no nearby
// area has any. The scan only ranks candidates; the chosen area is searched on its own, so its count, price and link use
// exactly the same filters. The area with the most matches wins (ties by name), so "yes" later finds the same area.
const otherMatchingArea = async (q, excluded) => {
  const { items } = await findProperties(searchArgsFromState({ ...q, location: undefined }), AREA_SCAN_LIMIT);
  const counts = new Map();
  items.filter((p) => p.community && !excluded.includes(p.community)).forEach((p) => counts.set(p.community, (counts.get(p.community) || 0) + 1));
  const ranked = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
  for (const area of ranked) {
    const [group] = await searchAreas(searchArgsFromState(q), [area]);
    if (group) return group;
  }
  return null;
};

// Fallback steps 4 and 5: the same request (purpose, type, bedrooms, budget, furnishing all kept) in the areas configured
// as nearby (constants/nearbyAreas.json, closest first); only when none has a match, one other matching area.
const alternativeAreas = async (q) => {
  const nearbyNames = NEARBY_AREAS[q.location] || [];
  const nearby = await searchAreas(searchArgsFromState(q), nearbyNames);
  const other = nearby.length ? null : await otherMatchingArea(q, [q.location, ...nearbyNames]);
  return { nearby, other };
};

// A card for an area found by alternativeAreas: its count and lowest price come from the same search as the link.
const areaCard = (q, g) => {
  const url = listingUrlFor(q, g.location);
  return {
    area: g.location,
    summary: '',
    reason: '',
    total: g.total,
    startingPrices: [{ purpose: q.purpose, total: g.total, startingPrice: g.startingPrice, rentFrequency: g.items[0]?.rentFrequency, url }],
    viewAllUrl: url,
  };
};

// Text for fallback steps 4 and 5: the nearby matches, otherwise the other matching area, otherwise a clear "none".
// `wanted` keeps every filter ("two-bedroom villas for sale under AED 3,000,000"), so nothing looks silently relaxed.
const alternativeAreasText = (q, { nearby, other }) => {
  const wanted = describeCriteria(q, { plural: true, location: '' });
  // With a metro requirement, the stations named by the area's matching listings.
  const stations = (g) => [...new Set(g.items.map((p) => p.metro?.station).filter(Boolean))];
  const metro = (g) => (q.nearMetro && stations(g).length ? ` (near ${joinPhrases(stations(g))})` : '');
  const line = (g) => `• ${g.location}: ${listingCount(g.total)} from ${priceText(g.startingPrice, q.purpose, g.items[0]?.rentFrequency)}${metro(g)}`;
  if (nearby.length) return `Nearby ${wanted} matching your requirements:\n${nearby.map(line).join('\n')}`;
  const noNearby = NEARBY_AREAS[q.location] ? `I couldn't find nearby ${wanted} matching your current requirements.` : noNearbyNote(q.location);
  if (other) return `${noNearby} Another community has matching ${wanted}:\n${line(other)}`;
  return `${noNearby} I also couldn't find ${wanted} in any other community right now.`;
};

// Amenities and metro proximity count only when a listing proves them, so the search never drops them by itself.
const hasVerifiedRequirements = (q) => Boolean(q.nearMetro || q.amenities?.length);

// "Would you like me to relax the metro requirement or the pool requirement?": the user picks which verified requirement
// may go (see relaxedRequirements).
const relaxQuestion = (q) => {
  const labels = [...(q.nearMetro ? ['the metro requirement'] : []), ...(q.amenities || []).map((a) => `the ${amenityLabel(a)} requirement`)];
  return `Would you like me to relax ${joinOr(labels)}?`;
};
// What a short reply to relaxQuestion drops: "metro" / "the pool one" -> that requirement, "both" -> all of them, "yes"
// -> the only one asked about. "No" drops nothing.
const relaxedRequirements = (message, q) => {
  const t = message.toLowerCase();
  if (DECLINE_RE.test(t)) return { amenitiesDropped: [], nearMetroDropped: false };
  const onlyOne = (q.amenities?.length || 0) + (q.nearMetro ? 1 : 0) === 1;
  const all = /\b(both|all of them)\b/.test(t) || (onlyOne && ACCEPT_RE.test(t));
  return {
    amenitiesDropped: (q.amenities || []).filter((a) => all || new RegExp(`\\b${escapeRegex(a)}`).test(t)),
    nearMetroDropped: Boolean(q.nearMetro && (all || /\bmetro\b/.test(t))),
  };
};

// The next step after zero results, offering only changes that can widen the search.
const refineQuestion = (q, { budgetMatters = false } = {}) => {
  if (budgetMatters) return CHOICE_QUESTIONS.budgetOrArea.text;
  if (hasVerifiedRequirements(q)) return relaxQuestion(q);
  return bedroomList(q.bedrooms).length ? CHOICE_QUESTIONS.areaTypeOrBedrooms.text : CHOICE_QUESTIONS.areaOrType.text;
};

// "Any nearest areas?": fallback steps 4 and 5 on their own. Suggested areas are only candidates; the saved
// location changes only when the user picks one.
const describeNearby = async (q) => {
  const areas = await alternativeAreas(q);
  const groups = areas.nearby.length ? areas.nearby : [areas.other].filter(Boolean);
  const question = groups.length ? AREA_PICK_QUESTION : refineQuestion(q, { budgetMatters: Boolean(Number(q.budget)) });
  return { reply: `${alternativeAreasText(q, areas)}\n\n${question}`, cards: groups.map((g) => areaCard(q, g)) };
};

const MAX_SAME_AREA_ALTERNATIVES = 5;

// Same area, one requirement changed at a time (bedrooms, property type, furnishing or category), with real counts and
// lowest prices. The budget is not applied here; a price above it is flagged instead. Never changes the saved criteria.
// After the user declined other bedroom counts (relaxBedrooms false), those are left out.
const sameAreaAlternatives = async (q, { relaxBedrooms = true } = {}) => {
  const base = { ...q, budget: undefined };
  const options = (relaxBedrooms ? bedroomAlternatives(q.bedrooms) : []).map((bedrooms) => ({ difference: 'bedrooms', changes: { bedrooms } }));
  if (q.propertyType) {
    // Only related types: homes for homes, workspaces for workspaces (never a home for an office, or the reverse).
    const family = [RESIDENTIAL_TYPES, WORKSPACE_TYPES].find((types) => types.includes(q.propertyType)) || [];
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

// Fallback order with an area:
//   1. exact match (every filter, amenities verified in the listing's features, metro station named in the listing)
//   1b. with amenities: the same request with the amenities not verified, labelled as such ('amenityUnverified');
//       a metro requirement is still kept
// Every later step keeps the amenities and the metro requirement; only the user relaxes them (see relaxQuestion).
//   2. same request above the budget: only the lowest price is offered
//   3. closest bedroom count in the same area, every other filter kept ('bedroom')
//   4. same-area alternatives, one requirement changed at a time and labelled
//   5. nearby areas with every filter kept, closest first
//   6. one other area with verified matching listings, only when no nearby area has any
//   7. only when steps 5 and 6 found nothing: the closest bedroom count in any area (bedroomsElsewhere); skipped with
//      amenities or a metro requirement, where the user is asked which of those to relax instead (see relaxQuestion)
// Steps 4-7 are all reported together ('alternatives'); 'none' means none of them found anything.
// Without an area: exact match, then the closest bedroom count anywhere ('bedroom').
// relaxBedrooms false (the user declined another bedroom count) skips steps 3 and 7.
// Nothing here changes the saved search: suggestions are candidates until the user accepts one.
const searchWithFallback = async (q, maxPrice = q.budget, { relaxBedrooms = true } = {}) => {
  const args = searchArgsFromState({ ...q, budget: maxPrice });

  const exact = await findProperties(args, PREVIEW_LIMIT);
  const withoutAmenities = { ...args, amenities: undefined };
  if (exact.total) {
    // Listings that meet everything else but can't prove the amenities or metro proximity are reported as a count,
    // never as matches.
    const unproven = args.amenities || args.near_metro;
    const unverifiedCount = unproven ? (await findProperties({ ...withoutAmenities, near_metro: undefined }, 1)).total - exact.total : 0;
    return { stage: 'exact', groups: [{ location: q.location, bedrooms: args.bedrooms, ...exact }], unverifiedCount };
  }
  if (args.amenities) {
    const unverified = await findProperties(withoutAmenities, PREVIEW_LIMIT);
    if (unverified.total) return { stage: 'amenityUnverified', groups: [{ location: q.location, bedrooms: args.bedrooms, ...unverified }] };
  }

  if (!q.location) {
    const closer = relaxBedrooms ? await closestBedroomMatch(args) : null;
    return closer ? { stage: 'bedroom', groups: [closer] } : { stage: 'none', groups: [] };
  }

  if (Number(maxPrice)) {
    const lowest = await findProperties(searchArgsFromState({ ...q, budget: undefined }), 1);
    if (lowest.total) return { stage: 'overBudget', groups: [], lowestPrice: lowest.startingPrice, rentFrequency: lowest.items[0].rentFrequency };
  }

  const sameAreaBedrooms = relaxBedrooms ? await closestBedroomMatch(args) : null;
  if (sameAreaBedrooms) return { stage: 'bedroom', groups: [sameAreaBedrooms] };

  const [sameArea, areas] = await Promise.all([sameAreaAlternatives(q, { relaxBedrooms }), alternativeAreas({ ...q, budget: maxPrice })]);
  const noAreaMatch = !areas.nearby.length && !areas.other;
  const bedroomsElsewhere = relaxBedrooms && noAreaMatch && !hasVerifiedRequirements(q) ? await closestBedroomMatch({ ...args, location: undefined }) : null;
  const alternatives = {
    sameArea,
    nearby: areas.nearby.map((g) => nearbyAlternative(q, g)),
    other: areas.other ? nearbyAlternative(q, areas.other) : null,
  };
  const found = sameArea.length || !noAreaMatch || bedroomsElsewhere;
  // The bedroomsElsewhere listings are the cards for this reply.
  return { stage: found ? 'alternatives' : 'none', groups: bedroomsElsewhere ? [bedroomsElsewhere] : [], areas, alternatives, bedroomsElsewhere };
};

const MAX_COMMUNITY_LINES = 5;

// "• DAMAC Hills 2: 1 listing from AED 105,000/year", one line per community, cheapest first (items are sorted by price).
// Listings spell some communities differently ("Damac Hills 2"), so names are grouped ignoring case.
const communityLines = (q, g) => {
  const byCommunity = new Map();
  g.items.forEach((p) => {
    const key = p.community.toLowerCase();
    byCommunity.set(key, [...(byCommunity.get(key) || []), p]);
  });
  const lines = [...byCommunity.values()].map((listings) =>
    `• ${listings[0].community}: ${listingCount(listings.length)} from ${priceText(listings[0].priceAED, q.purpose, listings[0].rentFrequency)}`
  );
  const more = lines.length - MAX_COMMUNITY_LINES;
  return more > 0 ? [...lines.slice(0, MAX_COMMUNITY_LINES), `• and ${more} more communit${more === 1 ? 'y' : 'ies'}`] : lines;
};

// Always names the changed bedroom count: "Instead, I found 4 three-bedroom villas for rent under AED 200,000/year:".
const bedroomOfferText = (q, g, maxPrice) => {
  const offered = describeCriteria(q, { bedrooms: g.bedrooms, location: g.location || '', maxPrice, plural: g.total !== 1 });
  return `Instead, I found ${g.total === 1 ? '' : `${g.total} `}${offered}:\n${communityLines(q, g).join('\n')}`;
};

// Offers from other communities say so, since accepting one also widens the area.
const bedroomQuestion = (q, g) =>
  `Would you be open to ${String(g.bedrooms) === '0' ? 'a studio' : bedsText(g.bedrooms)}${q.location && !g.location ? ' in one of these communities' : ''}?`;

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
const capitalize = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const CATEGORY_WORDS = { rent: 'for rent', buy: 'for sale', 'off-plan': 'off-plan' };
const AREA_SCAN_LIMIT = 500;

// What a location has right now in the given categories, grouped by property type with real counts and lowest prices:
// "• Apartments for sale: 1 listing from AED 1,350,000". With a known search kind, only that kind is listed, so an
// office search never gets apartments and a home search never gets offices.
const areaInventoryLines = async (location, purposes, kind = '') => {
  const lines = [];
  for (const purpose of purposes) {
    const { items } = await findProperties({ purpose, location }, AREA_SCAN_LIMIT);
    const byType = new Map();
    items.filter((p) => !kind || typeKind(p.type) === kind).forEach((p) => byType.set(p.type, [...(byType.get(p.type) || []), p]));
    byType.forEach((listings, type) => {
      const label = describeCriteria({ purpose, propertyType: type }, { plural: true, location: '', maxPrice: null });
      lines.push(`• ${capitalize(label)}: ${listingCount(listings.length)} from ${priceText(listings[0].priceAED, purpose, listings[0].rentFrequency)}`);
    });
  }
  return lines;
};

// The same request in the areas configured as nearby (constants/nearbyAreas.json), per category. Areas without an entry
// get no nearby suggestions: closeness is never guessed.
const nearbyMatches = async (q, purposes) => {
  const nearby = NEARBY_AREAS[q.location] || [];
  const groups = [];
  for (const purpose of purposes) {
    (await searchAreas(searchArgsFromState({ ...q, purpose }), nearby)).forEach((g) => groups.push({ ...g, purpose }));
  }
  return groups;
};
const nearbyLine = (q, g) =>
  `• ${g.location}: ${describeCriteria({ ...q, purpose: g.purpose }, { plural: true, location: '', maxPrice: null })}, ${listingCount(g.total)} from ${priceText(g.startingPrice, g.purpose, g.items[0]?.rentFrequency)}`;
const noNearbyNote = (location) =>
  NEARBY_AREAS[location] ? '' : `I don't have verified nearby-area data for ${location}, so I can't say which areas are closest.`;

// "Do you have villas in Dubai Hills?" with no buy/rent/off-plan chosen yet: the exact request is checked in every
// category first. Matches are confirmed with one real listing per category; without any, the real inventory of the same
// area and the same request in nearby areas follow. Ends with the category question.
const describeAvailability = async (q) => {
  const wanted = describeCriteria(q, { plural: true });
  const byCategory = await Promise.all(CATEGORIES.map(async (purpose) => ({ purpose, ...(await findProperties(searchArgsFromState({ ...q, purpose }), 1)) })));
  const found = byCategory.filter((c) => c.total);
  if (found.length) {
    const lines = found.map((c) => `• ${listingCount(c.total)} ${CATEGORY_WORDS[c.purpose]}, from ${priceText(c.startingPrice, c.purpose, c.items[0].rentFrequency)}`);
    return { reply: [`Yes, we have ${wanted}:`, lines.join('\n'), categoryQuestion(q.location)].join('\n\n'), properties: found.map((c) => c.items[0]) };
  }
  const [inArea, nearby] = await Promise.all([areaInventoryLines(q.location, CATEGORIES, searchKind(q)), nearbyMatches(q, CATEGORIES)]);
  const reply = [
    `I couldn't find any ${wanted} right now.`,
    inArea.length ? `Other properties available in ${q.location}:\n${inArea.join('\n')}` : '',
    nearby.length
      ? `Nearby ${describeCriteria(q, { plural: true, location: '' })}:\n${nearby.map((g) => nearbyLine(q, g)).join('\n')}`
      : noNearbyNote(q.location),
    categoryQuestion(q.location),
  ].filter(Boolean).join('\n\n');
  return { reply, properties: nearby.flatMap((g) => g.items).slice(0, PREVIEW_LIMIT) };
};

// Deterministic, precise wording: says exactly which criteria were not met and what changed.
const describeResults = async (q, result, maxPrice, { cheaper = false } = {}) => {
  const wanted = describeCriteria(q, { maxPrice, priceWord: 'within' });
  const missed = `I couldn't find ${cheaper ? wanted.replace(/^an? /, 'a cheaper ') : wanted}`;
  const [first] = result.groups;
  const total = result.groups.reduce((sum, g) => sum + g.total, 0);

  const amenities = joinPhrases((q.amenities || []).map(amenityLabel));
  if (result.stage === 'exact') {
    const price = priceText(first.startingPrice, q.purpose, first.items[0]?.rentFrequency);
    const found = total === 1
      ? `I found ${describeCriteria(q, { maxPrice })}, priced at ${price}.`
      : `I found ${total} ${describeCriteria(q, { maxPrice, plural: true })}, starting from ${price}.`;
    const n = result.unverifiedCount;
    const unproven = q.nearMetro ? joinOr([...(q.amenities || []).map(amenityLabel), 'metro proximity']) : amenities;
    const unverified = n ? `${n} more ${n === 1 ? 'listing matches' : 'listings match'} your other requirements, but I couldn't verify ${unproven} for ${n === 1 ? 'it' : 'them'}.` : '';
    return [found, unverified].filter(Boolean).join('\n\n');
  }
  if (result.stage === 'amenityUnverified') {
    const others = describeCriteria({ ...q, amenities: undefined }, { maxPrice, plural: total !== 1 });
    return `I couldn't find any ${describeCriteria(q, { maxPrice, plural: true, priceWord: 'within' })} right now. ` +
      `I found ${total === 1 ? others : `${total} ${others}`}, but I couldn't verify ${amenities} for ${total === 1 ? 'it' : 'them'}.`;
  }
  if (result.stage === 'overBudget') {
    const price = priceText(result.lowestPrice, q.purpose, result.rentFrequency);
    return `I couldn't find any ${describeCriteria(q, { maxPrice, plural: true, priceWord: 'within' })}. The lowest available option currently starts from ${price}. Would you like to see listings from ${price}?`;
  }
  if (result.stage === 'bedroom') {
    const noExact = `I couldn't find any ${describeCriteria(q, { plural: true, maxPrice, priceWord: 'within' })} right now.`;
    return [noExact, bedroomOfferText(q, first, maxPrice), bedroomQuestion(q, first)].join('\n\n');
  }

  // No exact match ('alternatives' or 'none'). With an area, nothing matches at any price (a higher price would have
  // been offered), so the budget is not the problem.
  const noneAtAnyPrice = Number(maxPrice) && q.location && !cheaper;
  const noMatch = cheaper
    ? `${missed}.`
    : `I couldn't find any ${describeCriteria(q, { plural: true, maxPrice: noneAtAnyPrice ? null : maxPrice, priceWord: 'within' })}${q.budgetFlexible ? ' at any price' : ''} right now.`;
  if (!q.location || cheaper) return `${noMatch}\n\n${refineQuestion(q, { budgetMatters: Boolean(Number(maxPrice)) && !noneAtAnyPrice })}`;

  // The reply follows the fallback order: what the area has instead (step 3), the same request nearby or in another
  // verified area (steps 4-5), then one question, asked only after those results.
  const sameArea = result.alternatives?.sameArea || [];
  const areas = result.areas || { nearby: [], other: null };
  const matching = sameArea.filter((a) => a.difference !== 'furnishing');
  const otherFurnishing = sameArea.filter((a) => a.difference === 'furnishing');
  const lines = (alts) => alts.map((a) => `• ${alternativeLine(q, a)}`).join('\n');
  // Without a one-change alternative, the area's real inventory in this category is shown instead (not with amenities or
  // a metro requirement: that inventory ignores them).
  const inArea = matching.length || hasVerifiedRequirements(q) ? [] : await areaInventoryLines(q.location, [q.purpose], searchKind(q));
  const anyAlternative = matching.length || areas.nearby.length || areas.other;
  const elsewhere = result.bedroomsElsewhere;
  let question = anyAlternative ? ALTERNATIVES_QUESTION : refineQuestion(q);
  if (otherFurnishing.length) {
    question = `Would you like to ${anyAlternative ? `see the ${q.furnishing} options above, or ` : ''}consider ${otherFurnishing.map((a) => a.furnishing).join(' or ')} properties in ${q.location}?`;
  }
  // The closest bedroom count in other communities is the strongest remaining option, so its question is asked.
  if (elsewhere) question = bedroomQuestion(q, elsewhere);
  return [
    noMatch,
    matching.length ? `In ${q.location}, I found:\n${lines(matching)}` : '',
    inArea.length ? `Other ${describeCriteria({ purpose: q.purpose }, { plural: true, location: '', maxPrice: null })} in ${q.location}:\n${inArea.join('\n')}` : '',
    otherFurnishing.length ? `Not ${q.furnishing}, but available in ${q.location}:\n${lines(otherFurnishing)}` : '',
    alternativeAreasText(q, areas),
    elsewhere ? bedroomOfferText(q, elsewhere, maxPrice) : '',
    question,
  ].filter(Boolean).join('\n\n');
};

// "• Bloom Towers — JVC District 10: AED 620,000" for each card, in card order, placed after the reply's first paragraph.
// Built from the cards themselves, so the names and prices in the text are always the ones on the cards.
// With a metro requirement each line also gives the station and distance exactly as the listing states them.
const withListingLines = (reply, cards, { metro = false } = {}) => {
  if (!cards.length) return reply;
  const lines = cards.map((p) => {
    const district = p.building && p.district ? ` — ${p.district}` : '';
    const station = metro && p.metro ? ` (${p.metro.station}, ${p.metro.distance || 'distance not stated in the listing'})` : '';
    return `• ${listingName(p)}${district}: ${priceText(p.priceAED, p.category, p.rentFrequency)}${station}`;
  });
  const [first, ...rest] = reply.split('\n\n');
  return [first, lines.join('\n'), ...rest].join('\n\n');
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
    Object.entries({ purpose: q.purpose, locations, propertyType: q.propertyType, bedrooms, furnishing: q.furnishing, amenities: q.amenities, nearMetro: q.nearMetro, maxPrice: Number(maxPrice) || undefined }).filter(
      ([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)
    )
  );
  const viewAllUrl = listingUrl({ purpose: q.purpose, locations, propertyType: q.propertyType, bedrooms, minPrice: q.budgetMin, maxPrice });
  // The listing pages have no furnishing or bedroom-set filter, so their count would not match those totals.
  const showViewAll = total > PREVIEW_LIMIT && listingPageCanFilter({ ...q, bedrooms });
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

// Request words that say "recommend some areas" rather than what the areas are for.
const RECOMMEND_FILLER = new Set([
  'best', 'good', 'great', 'nice', 'popular', 'ideal', 'suitable', 'recommend', 'recommended', 'recommendation', 'recommendations',
  'area', 'areas', 'community', 'communities', 'neighborhood', 'neighborhoods', 'neighbourhood', 'neighbourhoods', 'location',
  'locations', 'place', 'places', 'live', 'living', 'where', 'should', 'which', 'what', 'some', 'most', 'dubai', 'show', 'want',
]);

// The top-ranked blog is the dedicated source when its own title/keywords cover every topic word of the request
// ("families" for "best areas for families"). Its sections headed by a known location decide the areas, in blog order.
const blogAreaPicks = async (message, hits) => {
  if (hits[0]?.source !== 'blog') return [];
  const stems = (message.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !RECOMMEND_FILLER.has(w)).map((w) => w.slice(0, 5));
  if (!stems.length) return [];
  const blog = await Blog.findById(hits[0].refId).select('title keywords content').lean();
  const topic = `${blog?.title || ''} ${(blog?.keywords || []).join(' ')}`.toLowerCase();
  if (!stems.every((s) => topic.includes(s))) return [];

  const locations = await getKnownLocations();
  const picks = [];
  let section = null;
  (blog.content || []).forEach((block) => {
    if (block.type === 'heading2') {
      const match = locations.find(([, , re]) => re.test(stripHtml(block.text)));
      section = match && !picks.some((p) => p.title === match[1]) ? { title: match[1], paragraphs: [] } : null;
      if (section) picks.push(section);
    } else if (block.type === 'heading3') {
      section = null;
    } else if (section && block.type === 'paragraph') {
      section.paragraphs.push(stripHtml(block.text));
    }
  });
  return picks.length >= 2 ? picks : [];
};

// For an area without a guide: the most relevant short sentence of its blog section intro. A long sentence is cut to its
// leading clause when that clause stands alone; sentences opening with "It"/"They" need context and are skipped.
const blogSectionSummary = (paragraphs, score) => {
  const shorten = (s) => {
    if (wordCount(s) <= 20) return s;
    const lead = s.split(/,\s/)[0];
    return wordCount(lead) >= 8 && wordCount(lead) <= 20 ? `${lead}.` : s;
  };
  const sentences = paragraphs
    .flatMap((p) => p.split(/(?<=[.!?])\s+/))
    .filter((s) => !/^(it|they)\b/i.test(s))
    .map(shorten)
    .filter((s) => wordCount(s) <= 20);
  const [best] = sentences.map((s) => [s, score(s)]).sort((a, b) => b[1] - a[1]);
  return best ? best[0] : '';
};

// Areas from a dedicated matching blog when there is one, otherwise from the area-guide knowledge; kept only when they
// have matching listings right now. `near` is an area named in the request ("best family areas near JVC"): its own
// guide, if any, is listed first.
const recommendAreas = async (message, q, near = '') => {
  // Wide k so area guides aren't crowded out by blogs/FAQs; hits stay ordered by relevance.
  const hits = await retrieve(message, 40);
  const blogPicks = await blogAreaPicks(message, hits);
  const picks = blogPicks.length ? blogPicks : hits.filter((h) => h.source === 'area').map((h) => ({ title: h.title }));
  const titles = [...new Set([near, ...picks.map((p) => p.title)].filter(Boolean))];
  if (!titles.length) return [];
  const guides = await AreaGuide.find({ isActive: true, title: { $in: titles } }).select('title slug path about keyHighlights listingsSearch').lean();
  const purposes = CATEGORIES.includes(q.purpose) ? [q.purpose] : CATEGORIES;
  const score = relevanceScorer(message);

  const recommendations = [];
  for (const title of titles) {
    const guide = guides.find((g) => g.title === title);
    const blogSection = picks.find((p) => p.title === title)?.paragraphs;
    if (!guide && !blogSection) continue;
    const location = guide?.listingsSearch?.length ? guide.listingsSearch : title;
    const availability = await areaAvailability(q, location, purposes);
    if (!availability) continue;
    const summary = guide ? areaSummary(guide, score) : blogSectionSummary(blogSection, score);
    recommendations.push({
      area: title,
      summary,
      reason: guide ? pickReason(guide, message, summary) : '',
      ...availability,
      areaGuideUrl: guide ? pagePath(guide, LINKED_SOURCES.area.route) : undefined,
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

const ORDINAL_INDEX = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, last: -1 };
const ORDINAL_ONLY_RE = /^\s*(?:the\s+)?(first|second|third|last|1st|2nd|3rd)(?:\s+(?:one|property|listing|option))?\s*[.!]?\s*$/;
const ORDINAL_NOUN_RE = /\b(first|second|third|last|1st|2nd|3rd)\s+(?:one|property|listing|option)\b/;
const CARD_NUMBER_RE = /\b(?:number|no\.?|option|property|listing|#)\s*([1-9])\b/;
const DETAILS_RE = /\b(details?|more info(rmation)?|tell me more)\b/i;
const VIEWING_WORD_RE = /\b(view(ing)?|visit|see it)\b/i;

// The cards last shown, in card order. A listing removed since then keeps its place (reference only), so "the second
// one" still points at the card the user saw.
const findShownCards = async (refs) => {
  if (!refs.length) return [];
  const docs = await Property.find({ propertyRefNo: { $in: refs } })
    .select('propertyRefNo propertyPurpose offPlan propertyTitle towerName subLocality locality')
    .lean();
  return refs.map((ref) => {
    const doc = docs.find((d) => d.propertyRefNo === ref);
    return doc ? formatProperty(doc) : { propertyRefNo: ref };
  });
};

// The shown card the user means: a reference number, a card's name ("Bloom Towers"), or "the second one", "2nd
// property", "option 3". Returns that card's reference number, or '' when the message picks none of them.
const pickShownProperty = (message, cards) => {
  const refs = cards.map((c) => c.propertyRefNo);
  const t = message.toLowerCase();
  const byRef = refs.find((ref) => t.includes(ref.toLowerCase()));
  if (byRef) return byRef;
  const byName = cards.filter((c) => listingName(c) && t.includes(listingName(c).toLowerCase()));
  if (byName.length === 1) return byName[0].propertyRefNo;
  if (refs.length < 2) return '';
  const word = t.match(ORDINAL_ONLY_RE) || t.match(ORDINAL_NOUN_RE);
  const number = t.match(CARD_NUMBER_RE);
  if (!word && !number) return '';
  const index = word ? ORDINAL_INDEX[word[1]] : Number(number[1]) - 1;
  return refs[index < 0 ? refs.length - 1 : index] || '';
};

// One listing by reference number with its real details, or null when it is gone or incomplete.
const findListing = async (ref) => {
  const doc = await Property.findOne({ propertyRefNo: ref }).lean();
  if (!doc) return null;
  const card = formatProperty({ ...doc, priceNum: Number(String(doc.price).replace(/,/g, '')) || 0 });
  if (!isCompleteListing(card)) return null;
  return { card, size: [doc.propertySize, doc.propertySizeUnit].filter(Boolean).join(' ') };
};

const listingDetailsText = ({ card, size }) => {
  const beds = card.bedrooms && !isCommercial(card.type) ? `, ${card.bedrooms === 'Studio' ? 'studio' : bedsText(card.bedrooms)}` : '';
  return [
    `Here are the details for ${card.title}:`,
    [
      `• Type: ${card.type}${beds}`,
      `• Price: ${priceText(card.priceAED, card.category, card.rentFrequency)}`,
      `• Location: ${card.location}`,
      size ? `• Size: ${size}` : '',
      card.metro ? `• Metro: ${card.metro.station}${card.metro.distance ? `, ${card.metro.distance}` : ''} (as stated in the listing)` : '',
      `• Reference: ${card.propertyRefNo}`,
    ].filter(Boolean).join('\n'),
  ].join('\n\n');
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
  const fields = QUALIFICATION_FIELDS.filter((field) => fieldApplies(q, field));
  const lines = [
    ...fields.map((field) => {
      if (field === 'budget' && !q.budget && q.budgetFlexible) return 'budget: any (no limit, never ask)';
      if (field === 'location' && !q.location && q.locationFlexible) return 'location: anywhere in Dubai (no preference, never ask)';
      if (field === 'bedrooms' && !q.bedrooms && q.bedroomsFlexible) return 'bedrooms: any (no preference, never ask)';
      return `${field}: ${q[field] || 'unknown'}`;
    }),
    `propertyType: ${q.propertyType || 'any'}${searchKind(q) === 'commercial' ? ' (commercial: bedrooms do not apply, never ask about them)' : ''}`,
    `furnishing: ${q.furnishing || 'any'}`,
    `amenities: ${q.amenities?.length ? `${q.amenities.join(', ')} (search results already include only listings whose features list them; never claim an amenity a listing's features don't list)` : 'none required'}`,
    `nearMetro: ${q.nearMetro ? "required (search results already include only listings whose own text names a nearby metro station; never name a station, distance or walking time the results don't state)" : 'not required'}`,
    `leadOfferShown: ${state.leadOfferShown}`,
    `leadOfferDeclined: ${state.leadOfferDeclined}`,
    `leadSaved: ${state.leadSaved}`,
  ];
  const contactLines = [`name: ${c.name || 'missing'}`, `phone: ${c.phone || 'missing'}`, `email: ${c.email || 'not given (optional, never ask)'}`];

  const steps = [];
  if (q.purpose && q.purpose !== 'sell' && (locationKnown(q) || q.budget || q.bedrooms)) {
    steps.push(
      'If search_properties results are provided in this turn, summarize only those. Without them, do not mention any listing or price. Only call search_properties again if the user asked for something different.'
    );
  }
  const missing = fields.find((field) => !fieldKnown(q, field));
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

const SEARCH_FIELDS = [
  'purpose', 'location', 'locationFlexible', 'propertyType', 'budget', 'budgetMin', 'budgetFlexible', 'bedrooms', 'bedroomsFlexible', 'furnishing', 'amenities', 'nearMetro',
];
// "any budget" / "any area" / "any bedroom" count as answers, so those questions are never asked again.
const budgetKnown = (q) => Boolean(q.budget || q.budgetFlexible);
const locationKnown = (q) => Boolean(q.location || q.locationFlexible);
const fieldKnown = (q, field) => Boolean(q[field] || q[`${field}Flexible`]);

// Fields that belong to one kind of property search. Moving between residential and commercial drops them, while purpose
// and area carry over: "2-bedroom villa for sale in Dubai Hills, AED 5M" + "office in Business Bay" -> office for sale in
// Business Bay, budget asked again (a home budget is not assumed to be an office budget).
const KIND_FIELDS = ['propertyType', 'bedrooms', 'bedroomsFlexible', 'furnishing', 'amenities', 'budget', 'budgetMin', 'budgetFlexible'];
// True when the message names the other kind of property: a commercial type during a home search, or a home type or a
// bedroom count during a commercial search.
const switchesSearchKind = (q, updates) => {
  const current = searchKind(q);
  let next = '';
  if (updates.propertyType) next = typeKind(updates.propertyType);
  else if (updates.bedrooms !== undefined) next = 'residential';
  return Boolean(current && next && current !== next);
};

// The one place where a message's search updates change the session state:
//   field not in `updates`      -> kept as it is
//   new value ("Al Quoz", "1,2,3") -> replaces the old value
//   <field>Flexible ("any budget")  -> clears that filter (and counts as answered)
//   amenities / amenitiesDropped    -> added to / removed from the saved amenities; the others are kept
//   nearMetro / nearMetroDropped    -> sets / clears only the metro requirement
//   other kind of property         -> see switchesSearchKind
const applySearchUpdates = (q, { amenities = [], amenitiesDropped = [], nearMetroDropped = false, ...updates }) => {
  if (switchesSearchKind(q, updates)) KIND_FIELDS.forEach((f) => delete q[f]);
  if (nearMetroDropped) delete q.nearMetro;
  const keptAmenities = (q.amenities || []).filter((a) => !amenitiesDropped.includes(a));
  q.amenities = [...new Set([...keptAmenities, ...amenities])];
  if (!q.amenities.length) delete q.amenities;
  ['location', 'budget', 'bedrooms'].forEach((field) => {
    if (updates[`${field}Flexible`]) delete q[field];
    if (updates[field] !== undefined) delete q[`${field}Flexible`];
  });
  // A new budget or "any budget" replaces the whole range, including an old minimum.
  if (updates.budget || updates.budgetFlexible) delete q.budgetMin;
  Object.assign(q, updates);
  if (!q.purpose) delete q.purpose;
  if (q.furnishing === 'any') delete q.furnishing;
};
// The user answered our qualifying question with something that sets no value ("it's fine", "ok"): search with what is known.
const answeredOurQuestion = (message, lastQuestion, q) =>
  !message.includes('?') && message.trim().split(/\s+/).length <= 6 && questionFields(lastQuestion).some((f) => !fieldKnown(q, f));
const SEARCH_PROMISE_RE =
  /\b(i'?ll|i will|let me|i can|i'?m going to)\s+(search|look|find|check|broaden|fetch|run|bring up|pull (?:\w+ )?up|show you (?:the |these |those |some |matching )?(?:options|listings|propert|results|units))/i;
// "Would you like to see them?" / "Shall I pull up these listings?" / "Want me to run the search?": an offer to show
// results, whoever worded it. "Yes" to it runs the search at once instead of promising it.
const SEARCH_OFFER_RE = /\b(see|show|view|pull up|fetch|bring up|run the search|search)\b[^?]*\?$/i;

// "I want to buy an apartment in Dubai Hills" during a furnished rental search in Arjan: the purpose is restated with an area
// or type and conflicts with a stored value, so it starts a new search. A bare "buy" or "Dubai Marina" still refines the current one.
const detectNewPropertySearch = (extracted, q) =>
  Boolean(extracted.purpose && (extracted.location || extracted.propertyType)) &&
  ['purpose', 'location', 'propertyType'].some((f) => extracted[f] && q[f] && extracted[f] !== q[f]);

// A new search keeps only what the new message states (merged afterwards); old furnishing, bedrooms, budget etc. are dropped.
const resetSearchFilters = (q) => SEARCH_FIELDS.forEach((f) => delete q[f]);

// Openers that don't change what is asked: "Okay, can a foreigner buy?", "Thanks. What is DLD?"
const LEADING_ACK_RE = /^\s*(?:(?:ok|okay|yes|yeah|sure|thanks|thank you|great|cool|alright|and|also|but|so|actually|btw|by the way|one more thing|quick question)\b[\s,.!-]*)+/i;
// A question in its own words: "Can a foreigner ...", "What is DLD?", "I'd like to know if ...".
const QUESTION_START_RE =
  /^(can|could|may|might|is|are|am|was|were|do|does|did|will|would|should|shall|must|what|what's|whats|how|why|when|who|which|where|tell me|explain|i'?d like to know|i would like to know|i want to know|i'?m (curious|wondering)|i am (curious|wondering))\b/i;
// Asks to see or compare listings: "show me", "find", "cheapest", "listings".
const LISTING_REQUEST_RE = /\b(show|find|search|list|see|view|display|pull up|bring up|looking for|look for|cheapest|most affordable|lowest priced|listings?|units)\b/i;
// "Show me the listings" / "Okay, show me those again": the saved search runs again.
const SHOW_SAVED_SEARCH_RE = /^(?:please\s+|can you\s+|could you\s+|let me\s+)?(show|see|display|pull up|bring up|list)\b/i;
// Details only a property search has. Purpose or type alone ("when buying", "off-plan") is how general questions are phrased.
const SEARCH_DETAIL_FIELDS = ['location', 'locationFlexible', 'locationSuggestion', 'bedrooms', 'bedroomsFlexible', 'budget', 'budgetMin', 'budgetFlexible', 'amenities', 'amenitiesDropped', 'nearMetro', 'nearMetroDropped'];
// Asks for listings in any wording: "show me", "is anything available", "nearby areas", "cheaper", "adjust the budget".
const asksForListings = (message) => [LISTING_REQUEST_RE, AVAILABILITY_RE, NEARBY_RE, CHEAPER_RE, REFINE_RE].some((re) => re.test(message));

// The latest message decides the turn. True for a general question ("Can a foreigner buy property in Dubai?", "What fees
// do I pay when buying?", "What is DLD?"): a question with no listing request and no area, bedrooms, budget or amenity.
// A follow-up without its own opener ("what about fees?", "and for off-plan?") counts when it names no purpose or type,
// or right after another general question; never while a refine question waits for its answer, and "what about
// renting?" during a search refines the search. A general question is answered from the knowledge base; the saved
// search is kept but nothing runs or changes it this turn.
const isGeneralQuestion = (message, extracted, { afterGeneralQuestion = false, answeringChoice = false } = {}) => {
  const text = message.replace(LEADING_ACK_RE, '');
  const ownOpener = QUESTION_START_RE.test(text) && !SWITCH_AREA_RE.test(text);
  if (!ownOpener && !message.includes('?')) return false;
  if (asksForListings(message) || SEARCH_DETAIL_FIELDS.some((f) => extracted[f])) return false;
  if (ownOpener) return true;
  if (answeringChoice) return false;
  return afterGeneralQuestion || !['purpose', 'propertyType', 'furnishing'].some((f) => extracted[f]);
};

// pendingQuestion value for the offer that ends a knowledge answer ("Would you like a brief of how DLD fees work?").
// That offer owns the next short reply, whatever property search is saved.
const KNOWLEDGE_FOLLOW_UP = 'knowledgeFollowUp';
const FOLLOW_UP_DECLINE_TEXT = "No problem. Let me know if there's anything else I can help with.";
// The answer to a knowledge offer: 'accept' ("yes", "sure", "go ahead"), 'decline' ("no", "not now") or '' when the
// message is a request of its own (a question, a listing request or any search detail), which replaces the offer.
const followUpAnswer = (message, extracted) => {
  if (message.includes('?') || asksForListings(message) || SEARCH_FIELDS.some((f) => extracted[f]) || extracted.locationSuggestion) return '';
  if (ACCEPT_RE.test(message)) return 'accept';
  if (DECLINE_RE.test(message)) return 'decline';
  return '';
};

// Words that only introduce what an offer is about ("Would you like a quick overview of how ... affects ...?").
const OFFER_FILLER_WORDS = new Set(
  ('a an and the of on in to for or with about from by at into under over how what which why when it its is are be can ' +
    'do does would you your like ' +
    'want me i we us my more quick quickly short brief briefly overview note summary summarize summarise explanation ' +
    'explain detail details general high level main key basic basics might may could should will potential possible ' +
    'point points particular such as example typical typically usually generally step steps end ' +
    'breakdown rundown know learn tell walk through specific specifically related affect affects effect effects impact ' +
    'impacts role work works apply applies rule rules regulation regulations requirement requirements agreement ' +
    'agreements property properties real estate dubai uae this that these those them they there').split(' ')
);
// "fees" -> "fee", "processes" -> "process", "process" unchanged.
const singular = (word) => word.replace(/(ss|x|ch|sh)es$/, '$1').replace(/(?<=[a-z]{2}[^s])s$/, '');
// Different words for the same subject, so "tenancy or sales" and "renting and buying" give the same key.
const OFFER_SAME_SUBJECT = [
  [/^(rent|rents|renting|rental|rentals|tenancy|tenancies|tenant|tenants|lease|leases|leasing|landlord|landlords)$/, 'renting'],
  [/^(buy|buys|buying|buyer|buyers|purchase|purchases|purchasing|sale|sales|sell|selling|seller|sellers|transaction|transactions)$/, 'buying'],
];

// The stable key of a knowledge offer: its subject words, without the wording around them. Rephrasings of one offer
// get the same key: "Would you like an overview of how RERA affects tenancy or sales?", "Want me to explain RERA's
// impact on renting and buying?" and "a quick note on RERA and tenancy/sales?" are all ["buying", "rera", "renting"].
const followUpKey = (text) => {
  const words = String(text).toLowerCase().replace(/'s\b/g, '').match(/[a-z0-9]+/g) || [];
  const subjects = words
    .filter((w) => !OFFER_FILLER_WORDS.has(w))
    .map((w) => OFFER_SAME_SUBJECT.find(([re]) => re.test(w))?.[1] || singular(w));
  return [...new Set(subjects)].sort();
};

// True when the offer adds nothing to one already explained or declined: the same key, or a key of two or more words
// that all belong to a closed offer ("RERA and sales" after "RERA's effect on tenancy and sales").
const isClosedFollowUp = (offer, closedFollowUps) => {
  const key = followUpKey(offer);
  return key.length > 0 && closedFollowUps.some((closed) => {
    const closedKey = followUpKey(closed);
    return key.join(' ') === closedKey.join(' ') || (key.length >= 2 && key.every((w) => closedKey.includes(w)));
  });
};

// The offer that ends a reply. "Would you like a quick overview?" names no subject, so the sentence before it is part
// of the offer: "I can share how RERA affects buying or renting. Would you like a quick overview?"
const closingOffer = (reply) => {
  const [question = ''] = reply.match(/[^.!?\n]*\?\s*$/) || [];
  if (followUpKey(question).length >= 2) return question.trim();
  const [withLead = question] = reply.match(/[^.!?\n]*[.!]\s+[^.!?\n]*\?\s*$/) || [];
  return withLead.trim();
};

// After a "yes", sentences that only restate the previous answer ("RERA is the Real Estate Regulatory Agency..." again)
// are removed: most of their subject words (see followUpKey) are already in that answer.
const dropRestated = (reply, previousAnswer) => {
  const said = followUpKey(previousAnswer);
  const restates = (s) => {
    const words = followUpKey(s);
    return !s.includes('?') && words.length >= 4 && words.filter((w) => said.includes(w)).length / words.length >= 0.75;
  };
  return mapSentences(reply, (s) => !restates(s)) || "Happy to help. What else would you like to know?";
};

// Explained or declined offers are remembered so they are never offered again (oldest dropped first).
const MAX_CLOSED_FOLLOW_UPS = 10;
const closeFollowUp = (state, offer) => {
  if (offer) state.closedFollowUps = [...state.closedFollowUps, offer].slice(-MAX_CLOSED_FOLLOW_UPS);
};

// Model instructions for a general-question turn: answer it, keep the saved search out of the way. After a "yes",
// `previousAnswer` is the answer it follows and `acceptedOffer` the offer it accepted, if that answer made one;
// `closedFollowUps` are offers already explained or declined.
const generalQuestionContext = (q, { acceptedOffer = '', previousAnswer = '', closedFollowUps = [] } = {}) =>
  [
    'CURRENT TURN: a general question, not a property search. Answer it directly and concisely from KNOWLEDGE; if KNOWLEDGE does not cover it, say an agent can confirm.',
    acceptedOffer &&
      `- The user said yes to your offer "${acceptedOffer}": deliver exactly that now, starting with the new information (e.g. "Sure. For ..."). KNOWLEDGE is the verified source: use every fact in it that fits the offer and add none of your own; only for a part of the offer KNOWLEDGE says nothing about, say you don't have verified details on it and an agent can confirm.`,
    !acceptedOffer && previousAnswer &&
      "- The user said yes to continue this topic: add information from KNOWLEDGE that your previous answer didn't give. If there is none, say so in one sentence and ask what else they'd like to know.",
    previousAnswer && `- Your previous answer, which must not be restated in any wording:\n"""${previousAnswer}"""`,
    '- Do NOT list or describe listings and do NOT ask for buy/rent, area, budget, bedrooms or property type.',
    q.purpose && locationKnown(q) && '- The saved property search stays paused until the user asks for listings: do not mention or offer it.',
    '- At most one short follow-up offer to explain a related point from KNOWLEDGE, only one that is genuinely new, written as the closing question ("Would you like ...?").',
    closedFollowUps.length &&
      `- Already explained or declined in this chat; never offer these again in any wording:\n${closedFollowUps.map((o) => `  - ${o}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n');

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
    pendingQuestion: session?.pendingQuestion || '',
    pendingFollowUp: session?.pendingFollowUp?.offer ? { ...session.pendingFollowUp } : null,
    closedFollowUps: session?.closedFollowUps || [],
    shownPropertyRefs: session?.shownPropertyRefs || [],
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
  let links = []; // website pages behind a knowledge answer (see relatedLinks)
  let alternatives = null;
  let savedName = '';
  let confirmation = '';
  let criteriaChanged = false;
  let criteriaGiven = false; // the message states a search field, even one already known (e.g. "rent" again)
  let startsNewSearch = false; // a new purpose/area/type, or a move between residential and commercial
  let enforce = false; // true when the reply still needs lead/question guardrails
  let propertyTurn = false; // the soft agent offer only follows a property search
  let modelReply = false; // the reply was worded by the model, so repeated qualification questions are removed
  let knowledgeAnswer = false; // the model answered a general question from knowledge (its closing offer becomes pending)
  let knowledgeQuestion = ''; // the user question a knowledge answer is about ("What is RERA?"), stored with its offer
  let deliveredOffer = ''; // the accepted knowledge offer this reply explains; closed once it is answered
  let previousAnswer = ''; // after a "yes" to a knowledge answer: that answer, which the reply must not restate
  try {
    const q = state.qualification;
    const isViewingClick = action?.type === 'book_viewing';
    // A higher-price offer only applies to the very next reply.
    const fallbackPending = Boolean(state.budgetFallback.pending);
    state.budgetFallback.pending = false;
    // "Did you mean Jebel Ali?" is answered on the very next reply.
    const pendingLocation = state.locationSuggestion;
    state.locationSuggestion = '';
    // A choice question ("adjust the budget or try another area?") is also answered on the very next reply only.
    const pendingQuestion = state.pendingQuestion;
    state.pendingQuestion = '';
    const pastMessages = session?.messages || [];
    const lastAssistant = [...pastMessages].reverse().find((m) => m.role === 'assistant')?.content || '';
    const lastQuestion = lastQuestionOf(lastAssistant);
    // The knowledge offer that question made, with the user question it followed ("Would you like a quick overview of
    // how RERA affects tenancy or sales?" after "What is RERA?"). It only applies to this reply.
    const offered = pendingQuestion === KNOWLEDGE_FOLLOW_UP ? { offer: lastQuestion, question: '', ...state.pendingFollowUp } : null;
    state.pendingFollowUp = null;
    // Company team questions are answered from the team records only and never touch search or contact state.
    const teamReply = isViewingClick ? null : await teamAnswer(message);

    // Intent before location matching: a recommendation request is never typo-corrected into an area name.
    const recommendIntent = !isViewingClick && !teamReply && RECOMMEND_RE.test(message);
    let areaQuestion = false; // "Is Arjan good for families?": answered from knowledge, no search or category question
    let nearArea = ''; // "best family areas near JVC": the named area is context for the recommendations, not a search
    let generalQuestion = false; // "Can a foreigner buy property in Dubai?": answered from knowledge, the saved search is untouched
    let askedArea = ''; // the area an area question is about
    let followUp = ''; // 'accept' / 'decline' when the message answers the knowledge offer that ended the last reply
    let relaxReply = ''; // reply to an answer to relaxQuestion that drops nothing ("no", or "yes" with several requirements)

    // 1. Qualification (skipped for button clicks so a property title can't change the criteria)
    let extracted = {};
    let locationSuggestion = '';
    if (!isViewingClick && !teamReply) {
      // No typo matching on replies to the contact prompt, so a name like "Arjun" is never read as an area.
      extracted = extractQualification(message, await getKnownLocations(), {
        fuzzy: !isContactPrompt(lastAssistant) && !recommendIntent,
        lastQuestion,
        amenities: await getKnownAmenities(),
      });
      // An area question names only the area; any other search detail or an availability question makes it a search.
      const searchDetail = SEARCH_FIELDS.some((f) => f !== 'location' && extracted[f]);
      const switchesArea = SWITCH_AREA_RE.test(message) && Boolean(q.purpose || q.propertyType);
      areaQuestion =
        Boolean(extracted.location) && AREA_INFO_RE.test(message) && !searchDetail && !AVAILABILITY_RE.test(message) && !switchesArea;
      if (areaQuestion) {
        askedArea = extracted.location;
        // Asking about an area doesn't move a search that already has one ("What about Dubai Marina?" does).
        if (q.purpose && q.location) delete extracted.location;
      }
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
      // The latest question decides what a short reply means: "yes" after a knowledge offer continues that topic, even
      // with a complete saved search. Right after a knowledge answer without an offer, "yes" / "no" stay on that topic too.
      const afterKnowledgeAnswer = pendingQuestion === KNOWLEDGE_FOLLOW_UP || (!pendingQuestion && state.currentTopic === 'general');
      if (afterKnowledgeAnswer && !recommendIntent) followUp = followUpAnswer(message, { ...extracted, locationSuggestion });
      generalQuestion = followUp === 'accept' || (!recommendIntent && isGeneralQuestion(message, { ...extracted, locationSuggestion }, {
        afterGeneralQuestion: state.currentTopic === 'general',
        answeringChoice: Boolean(CHOICE_QUESTIONS[pendingQuestion]?.options) || pendingQuestion === 'alternatives',
      }));
      // "buy" in "Can a foreigner buy property?" is not a search update: the saved search stays exactly as it was.
      if (generalQuestion) extracted = {};
      // Answer to "Would you like me to relax the metro requirement or the pool requirement?": only the requirements it
      // names are dropped. "Relax the pool" or "metro doesn't matter" are already read by extraction, and a message with
      // other search details ("1 bedroom in Al Furjan with a pool near the metro") is a new request, not an answer.
      const answersRelaxQuestion =
        pendingQuestion === 'relaxRequirement' && !generalQuestion && !message.includes('?') && !extracted.amenitiesDropped &&
        !extracted.nearMetroDropped && !SEARCH_FIELDS.some((f) => f !== 'amenities' && extracted[f]);
      if (answersRelaxQuestion) {
        const relaxed = relaxedRequirements(message, q);
        if (relaxed.amenitiesDropped.length || relaxed.nearMetroDropped) {
          delete extracted.amenities;
          delete extracted.nearMetro;
          Object.assign(extracted, relaxed);
        } else if (DECLINE_RE.test(message)) {
          relaxReply = "No problem, I'll keep your current requirements. Let me know whenever you'd like to change anything.";
        } else if (ACCEPT_RE.test(message) || CONFIRM_RE.test(message)) {
          relaxReply = `Sure — ${relaxQuestion(q).replace(/^W/, 'w')}`;
          state.pendingQuestion = pendingQuestion;
        }
      }
      const amenitiesBefore = String(q.amenities || '');
      const nearMetroBefore = Boolean(q.nearMetro);
      criteriaChanged = SEARCH_FIELDS.some((f) => f !== 'amenities' && extracted[f] && extracted[f] !== q[f]);
      criteriaGiven = !message.includes('?') && SEARCH_FIELDS.some((f) => extracted[f]);
      startsNewSearch = detectNewPropertySearch(extracted, q) || switchesSearchKind(q, extracted);
      if (detectNewPropertySearch(extracted, q)) resetSearchFilters(q);
      applySearchUpdates(q, extracted);
      if (String(q.amenities || '') !== amenitiesBefore || Boolean(q.nearMetro) !== nearMetroBefore) criteriaChanged = true;
    }

    // 2. Property picks, offer acceptance / decline / viewing requests
    // "the second one" after cards, or "yes"/"details" after "more details or to arrange a viewing?" for a single card.
    // "viewing" to that question, or "yes" to "Would you like to arrange a viewing?", is a viewing request.
    const shownRefs = state.shownPropertyRefs;
    const singleShownRef = shownRefs.length === 1 ? shownRefs[0] : '';
    const viewingAnswer =
      !isViewingClick && Boolean(singleShownRef) &&
      ((pendingQuestion === 'propertyDetails' && VIEWING_WORD_RE.test(message)) || (pendingQuestion === 'viewing' && ACCEPT_RE.test(message)));
    let pickedRef = '';
    let pickAgain = ''; // "yes" to "Which would you like to explore: A or B?" names no card, so the choice is asked again
    if (!isViewingClick && !teamReply && !criteriaChanged && !viewingAnswer && shownRefs.length) {
      const shownCards = await findShownCards(shownRefs);
      pickedRef = pickShownProperty(message, shownCards);
      const saysYes = (ACCEPT_RE.test(message) || DETAILS_RE.test(message)) && !message.includes('?');
      if (!pickedRef && pendingQuestion === 'propertyDetails' && saysYes) pickedRef = singleShownRef;
      if (!pickedRef && pendingQuestion === 'pickProperty' && saysYes && shownCards.length > 1) pickAgain = pickPropertyQuestion(shownCards);
    }
    const offerPending =
      state.leadOfferShown && !state.leadOfferDeclined && !state.leadSaved && OFFER_RE.test(lastAssistant) && pendingQuestion !== 'propertyDetails';
    const awaitingContact = !state.leadSaved && isContactPrompt(lastAssistant);
    const typedViewing = !isViewingClick && (VIEWING_RE.test(message) || viewingAnswer);
    if (!isViewingClick && !state.leadSaved && (/just (browsing|looking)/i.test(message) || (offerPending && DECLINE_RE.test(message) && !extracted.budgetFlexible))) {
      state.leadOfferDeclined = true;
    }
    const acceptedOffer =
      !isViewingClick && !state.leadSaved && !awaitingContact &&
      ((offerPending && ACCEPT_RE.test(message)) || AGENT_REQUEST_RE.test(message) || viewingAnswer);
    // A viewing request while one property is shown (e.g. after its details) is for that property.
    if (isViewingClick) state.viewingInterest = await resolveViewingInterest(action, q);
    else if (typedViewing) state.viewingInterest = await resolveViewingInterest({ propertyRefNo: singleShownRef }, q);

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
    else if (generalQuestion) state.currentTopic = 'general';
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
    } else if (followUp === 'decline') {
      // "No" to a knowledge offer only closes that offer (it is not offered again); the saved search stays paused.
      closeFollowUp(state, offered?.offer);
      reply = FOLLOW_UP_DECLINE_TEXT;
    } else if (relaxReply) {
      reply = relaxReply;
    } else if (locationSuggestion) {
      // Close to a known area but not certain: confirm before storing it; other details from the message are kept.
      state.locationSuggestion = locationSuggestion;
      reply = `Did you mean ${locationSuggestion}?`;
    } else if (fallbackPending && !criteriaChanged && !generalQuestion && (DECLINE_RE.test(message) || TOO_EXPENSIVE_RE.test(message))) {
      reply = FALLBACK_DECLINE_TEXT;
    } else if (fallbackPending && !criteriaChanged && !generalQuestion && (ACCEPT_RE.test(message) || SHOW_ME_RE.test(message))) {
      // Same criteria without the old ceiling, starting from the lowest real price that was offered.
      const open = { ...q, budget: undefined };
      const found = await findProperties({ ...searchArgsFromState(open), min_price: state.budgetFallback.suggestedMinPrice }, PREVIEW_LIMIT);
      const groups = found.total ? [{ location: q.location, bedrooms: q.bedrooms, ...found }] : [];
      reply = await describeResults(open, { stage: found.total ? 'exact' : 'none', nearby: [], groups });
      ({ properties, propertyResult, uiActions } = await buildPropertyResult(open, groups));
      reply = withListingLines(reply, properties, { metro: q.nearMetro });
      enforce = true;
      propertyTurn = true;
    } else if (pickedRef) {
      // The chosen card's real details, then the next step towards a viewing.
      const listing = await findListing(pickedRef);
      if (listing) {
        reply = `${listingDetailsText(listing)}\n\n${CHOICE_QUESTIONS.viewing.text}`;
        properties = [listing.card];
      } else {
        reply = "That listing is no longer available. Would you like me to search again with your current requirements?";
      }
    } else if (pickAgain) {
      reply = pickAgain;
    } else if (recommendations.length) {
      reply = describeRecommendations(message, recommendations);
    } else if (
      criteriaChanged && !locationKnown(q) && !q.budget && !q.bedrooms && q.purpose && !lastAssistant.endsWith(CATEGORY_QUESTION) &&
      message.split(/\s+/).length <= 6 && !message.includes('?')
    ) {
      const goal = q.purpose === 'sell' ? 'the right buyer' : describeCriteria(q);
      reply = `Great, let's find you ${goal}. ${NEXT_QUESTION.location}`;
    } else if (
      criteriaChanged && searchKind(q) === 'commercial' && CATEGORIES.includes(q.purpose) && locationKnown(q) && !budgetKnown(q) &&
      (startsNewSearch || !questionFields(lastQuestion).includes('budget'))
    ) {
      // Commercial requests are qualified before searching: type, area and purpose are known, so only the budget is asked
      // (once per search; if the user moves on without one, the search runs).
      reply = `Sure — you're looking for ${describeCriteria(q)}. ${q.purpose === 'rent' ? "What's your yearly budget in AED?" : NEXT_QUESTION.budget}`;
    } else {
      // 5. Property search: requested area first, then deterministic fallbacks
      const hasCriteria = Boolean(locationKnown(q) || q.budget || q.bedrooms || q.propertyType);
      let broad = false;
      // "Any nearest areas?" names no new area: the current request is checked in other areas.
      const nearbyRequest = !extracted.location && NEARBY_RE.test(message);
      if (nearbyRequest) {
        broad = true;
        if (!q.location) reply = 'Which area would you like me to look near?';
        else if (!CATEGORIES.includes(q.purpose)) reply = categoryQuestion(q.location);
        else ({ reply, cards: recommendations } = await describeNearby(q));
      } else if (areaQuestion) {
        // Purpose is never inferred: an area without a category gets the category question and no search.
        // Only an area guide may describe an area (the model answers below); without one, real listing counts replace a guess.
        if (!(await AreaGuide.exists({ isActive: true, title: askedArea }))) {
          broad = true;
          const counts = await countByCategory({ location: askedArea });
          const available = COUNT_LINES.filter(([key]) => counts[key] > 0).map(([key, line]) => line(counts[key], 'property'));
          reply = `I don't have detailed area information for ${askedArea} yet${available.length ? `, but it currently has ${joinPhrases(available)}` : ''}. ${categoryQuestion(askedArea)}`;
        }
      } else if (!q.purpose && q.location && (criteriaChanged || criteriaGiven)) {
        broad = true;
        // A bare area gets the category question; with a type, bedrooms or budget the real availability is shown first.
        if (q.propertyType || q.bedrooms || q.budget) ({ reply, properties } = await describeAvailability(q));
        else reply = categoryQuestion(q.location);
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
          reply = `I couldn't find any ${describeCriteria(q, { plural: true, priceWord: 'within' })}. ${refineQuestion(q, { budgetMatters: Boolean(Number(q.budget)) })}`;
        }
      }
      // "Yes" to "Would you like to see one of these?": the offered alternatives are looked up again. A single one is
      // switched to and searched; with several, the user picks one.
      const acceptedAlternatives =
        !criteriaChanged && !generalQuestion && pendingQuestion === 'alternatives' && (ACCEPT_RE.test(message) || SHOW_ME_RE.test(message));
      // A short reply to a refine question ("adjust the budget or try another area?") moves to the next step; the
      // unchanged search is not run again. A new criterion ("JVC") or a new question ("What is RERA?") skips this.
      const refineOptions = CHOICE_QUESTIONS[pendingQuestion]?.options;
      if (refineOptions && !nearbyRequest && !criteriaChanged && !generalQuestion && !message.includes('?') && !CHEAPER_RE.test(message)) {
        const chosen = refineOptions.filter((field) => REFINE_OPTIONS[field].re.test(message));
        if (chosen.length === 1) {
          broad = true;
          reply = refineFieldQuestion(chosen[0], q);
        } else if (DECLINE_RE.test(message)) {
          broad = true;
          const canOffer = !state.leadSaved && !state.leadOfferShown && !state.leadOfferDeclined;
          reply = `No problem, I'll keep your current requirements. ${canOffer ? OFFER_TEXT : "Let me know whenever you'd like to change anything."}`;
          if (canOffer) state.leadOfferShown = true;
        } else if (chosen.length > 1 || ACCEPT_RE.test(message) || CONFIRM_RE.test(message)) {
          broad = true;
          reply = `Sure — would you like to ${joinOr(refineOptions.map((field) => REFINE_OPTIONS[field].words))}?`;
          state.pendingQuestion = pendingQuestion;
        }
      }
      if (acceptedAlternatives) {
        const { alternatives: offered } = await searchWithFallback(q);
        const options = [
          ...(offered?.sameArea || []).filter((a) => a.difference !== 'furnishing'),
          ...(offered?.nearby || []),
          ...(offered?.other ? [offered.other] : []),
        ];
        if (options.length === 1) {
          const [a] = options;
          q[a.difference] = String(a[a.difference]);
        } else if (options.length > 1) {
          const labels = options.map((a) =>
            describeCriteria({ ...q, purpose: a.purpose, propertyType: a.propertyType || q.propertyType, bedrooms: a.bedrooms ?? q.bedrooms }, { plural: true, location: a.location, maxPrice: null })
          );
          broad = true;
          reply = `Which would you like to see: ${joinOr(labels)}?`;
        }
      }
      // Answer to "Would you be open to 3 bedrooms?". Yes: the offer is looked up again and its bedroom count saved (with
      // "any area" when it came from other communities). No: the requested count stays and the fallback continues without
      // other bedroom counts. "3 bedrooms is fine" or "I need 2 bedrooms" set the count through extraction as usual.
      let bedroomAnswer = '';
      if (!criteriaChanged && !generalQuestion && pendingQuestion === 'bedroomOffer' && !message.includes('?')) {
        if (ACCEPT_RE.test(message) || SHOW_ME_RE.test(message)) bedroomAnswer = 'accept';
        else if (DECLINE_RE.test(message)) bedroomAnswer = 'decline';
      }
      if (bedroomAnswer === 'accept') {
        const offer = await searchWithFallback(q);
        const offered = offer.stage === 'bedroom' ? offer.groups[0] : offer.bedroomsElsewhere;
        if (offered) applySearchUpdates(q, { bedrooms: offered.bedrooms, ...(q.location && !offered.location ? { locationFlexible: true } : {}) });
      }
      // A general question never searches, even with a complete saved search; that search waits for the user.
      const canSearch = !broad && !generalQuestion && CATEGORIES.includes(q.purpose) && hasCriteria;
      const cheaper = canSearch && CHEAPER_RE.test(message);
      // The backend, not the model, decides to search: whenever the state is searchable and this message set a criterion
      // or answered our last qualifying question (a choice question is not one: it names fields but asks for a choice).
      const answeredField = !pendingQuestion && answeredOurQuestion(message, lastQuestion, q);
      // "Yes" to "Would you like to see these 3 listings?" (or any offer to show results, see SEARCH_OFFER_RE): the saved
      // search runs now and its cards are shown. The confirmation never changes the search state.
      const resultsOffered = pendingQuestion === 'showListings' || (!pendingQuestion && SEARCH_OFFER_RE.test(lastQuestion));
      const showListings = !criteriaChanged && resultsOffered && (ACCEPT_RE.test(message) || SHOW_ME_RE.test(message));
      // "Okay, show me the listings" after another topic: the saved search runs again with every saved filter.
      const showSavedSearch = SHOW_SAVED_SEARCH_RE.test(message.replace(LEADING_ACK_RE, ''));
      const searchNow =
        !areaQuestion &&
        (cheaper || (canSearch && (criteriaChanged || criteriaGiven || acceptedAlternatives || bedroomAnswer || showListings || showSavedSearch || answeredField)));

      const runSearch = async ({ relaxBedrooms = true } = {}) => {
        state.currentTopic = '';
        let maxPrice = q.budget;
        let result;
        if (cheaper) {
          const current = Number(q.budget) || 0;
          if (current) maxPrice = String(Math.floor((current * 0.8) / 1000) * 1000);
          const found = await findProperties(searchArgsFromState({ ...q, budget: maxPrice }), PREVIEW_LIMIT);
          result = { stage: found.total ? 'exact' : 'none', nearby: [], groups: found.total ? [{ location: q.location, bedrooms: q.bedrooms, ...found }] : [] };
        } else {
          result = await searchWithFallback(q, q.budget, { relaxBedrooms });
        }
        reply = await describeResults(q, result, maxPrice, { cheaper });
        alternatives = result.alternatives || null;
        if (result.stage === 'overBudget') {
          // Only the price is offered; listings are shown after the user agrees.
          state.budgetFallback = { pending: true, originalMaxPrice: Number(maxPrice), suggestedMinPrice: result.lowestPrice };
        } else {
          // Listings shown without their amenities verified are not filtered by them, so neither is their View All link.
          const unverified = result.stage === 'amenityUnverified';
          ({ properties, propertyResult, uiActions } = await buildPropertyResult(unverified ? { ...q, amenities: undefined } : q, result.groups, maxPrice));
          if (cheaper && result.groups.length) q.budget = maxPrice;
          // Only listing results get the usual next question; fallback replies already end with their own question.
          enforce = result.stage === 'exact' || unverified;
          propertyTurn = enforce;
          if (enforce) reply = withListingLines(reply, properties, { metro: q.nearMetro });
        }
        // Areas found by the fallback (nearby or another verified area): one card each, plus a few of their real listings.
        const areaGroups = result.areas ? [...result.areas.nearby, result.areas.other].filter(Boolean) : [];
        if (areaGroups.length) {
          recommendations = areaGroups.map((g) => areaCard(q, g));
          properties = areaGroups.flatMap((g) => g.items).sort((a, b) => a.priceAED - b.priceAED).slice(0, PREVIEW_LIMIT);
        }
        const total = result.groups.reduce((sum, g) => sum + g.total, 0);
        logSearch(sessionId, searchArgsFromState({ ...q, budget: maxPrice }), { stage: result.stage, total, properties });
      };

      if (broad) {
        // reply set above from the category counts
      } else if (searchNow) {
        await runSearch({ relaxBedrooms: bedroomAnswer !== 'decline' });
        if (bedroomAnswer === 'decline') reply = `No problem, I'll keep ${bedsText(q.bedrooms)}.\n\n${reply}`;
      } else {
        // 6. General questions: knowledge + model wording
        // A leadership follow-up is answered on that topic; the stored property state must not steer it back to a search.
        const onLeadership = state.currentTopic === 'leadership';
        const forceRefineSearch = !onLeadership && canSearch && REFINE_RE.test(message);
        // "Yes" after a knowledge answer stays on the user's earlier question ("What is RERA?"). With an offer ("Would you
        // like a quick overview of how RERA affects tenancy or sales?"), knowledge is looked up for the offer, and chunks
        // naming the subject the offer shares with that question ("rera") come first.
        const acceptedOffer = followUp === 'accept' ? offered?.offer || '' : '';
        knowledgeQuestion = followUp === 'accept'
          ? offered?.question ||
            [...pastMessages].reverse().find((m) => m.role === 'user' && !(ACCEPT_RE.test(m.content) && !m.content.includes('?')))?.content || ''
          : message;
        const subject = acceptedOffer ? followUpKey(knowledgeQuestion).filter((w) => followUpKey(acceptedOffer).includes(w)) : [];
        const hits = await retrieve(`${acceptedOffer}\n${knowledgeQuestion}`.trim(), 4, { mention: subject });
        deliveredOffer = acceptedOffer;
        previousAnswer = followUp === 'accept' ? lastAssistant : '';
        let knowledge = hits.length
          ? hits.map((h, i) => `[${i + 1}] (${h.source}) ${h.title}\n${h.text}`).join('\n\n')
          : 'No relevant knowledge found.';
        if (onLeadership) {
          const leaders = (await teamRoster()).map((m) => `- ${m.name} — ${m.designation} (${m.department})`).join('\n');
          knowledge = `${COMPANY} leadership:\n${leaders}\n\n${knowledge}`;
        }
        let stateContext = buildStateContext(state);
        if (onLeadership) stateContext = LEADERSHIP_TOPIC_CONTEXT;
        else if (generalQuestion) stateContext = generalQuestionContext(state.qualification, {
          acceptedOffer,
          previousAnswer,
          closedFollowUps: state.closedFollowUps,
        });
        const messages = [
          { role: 'system', content: `${RULES}\n\nKNOWLEDGE (use only this for company/area facts):\n${knowledge}` },
          ...history,
          { role: 'user', content: message },
          { role: 'system', content: stateContext },
        ];
        // Everything the model was given; prices in its reply must come from here.
        const sources = [knowledge, message, stateContext, ...history.map((m) => m.content)];

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
          // Leadership follow-ups and general questions are answered from knowledge only, never with a listing search.
          let toolChoice = onLeadership || generalQuestion || round === MAX_TOOL_ROUNDS ? 'none' : 'auto';
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
              if (call.function.name === 'search_properties') args = toolSearchArgs(args, state.qualification);
              result = await runTool(call.function.name, args, sessionId);
              if (call.function.name === 'search_properties') {
                properties = result.slice(0, PREVIEW_LIMIT);
                propertyTurn = properties.length > 0;
                rememberSearchCriteria(state.qualification, args);
                logSearch(sessionId, args, { stage: result.length ? 'exact' : 'none', total: result.length, properties });
              }
              if (call.function.name === 'save_lead' && result.ok) state.leadSaved = true;
            } catch (toolError) {
              // A failed listing search is reported to the user as such, never left for the model to fill in.
              if (toolError.propertySearchFailed) throw toolError;
              console.error(`[Chatbot] Tool ${call.function.name} failed:`, toolError.message);
              result = { error: 'Tool failed' };
            }
            sources.push(JSON.stringify(result));
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          }
        }
        // A reply with placeholder listings or prices that appear in no source is never sent: the real search runs
        // instead, or an honest reply when there is nothing to search yet.
        const unverified = modelReply ? unverifiedReplyReason(reply, sources) : '';
        if (unverified) {
          console.warn('[Chatbot] Model reply rejected:', JSON.stringify({ sessionId, reason: unverified }));
          modelReply = false;
          properties = [];
          if (!onLeadership && canSearch) {
            await runSearch();
          } else {
            reply = generalQuestion ? UNVERIFIED_FIGURES_REPLY : UNVERIFIED_REPLY;
            enforce = false;
          }
        }
        // "I'll search across Dubai..." without results is never sent: the search runs now instead.
        if (!onLeadership && canSearch && !properties.length && SEARCH_PROMISE_RE.test(reply)) {
          modelReply = false;
          await runSearch();
        }
        if (modelReply && !onLeadership && !properties.length) links = await relatedLinks(hits, askedArea);
        knowledgeAnswer = modelReply && generalQuestion;
        if (knowledgeAnswer) closeFollowUp(state, deliveredOffer);
      }
    }
  } catch (error) {
    console.error('[Chatbot] Chat failed:', error.message);
    // Nothing partial is sent: no cards or recommendations from before the failure.
    reply = error.propertySearchFailed ? SEARCH_FAILED_TEXT : FALLBACK_REPLY;
    properties = [];
    propertyResult = null;
    propertyCounts = null;
    recommendations = [];
    uiActions = [];
    links = [];
    alternatives = null;
    enforce = false;
    knowledgeAnswer = false;
  }

  // 7. Guardrails over wording: the offer and next question come from state, never from the model.
  if (enforce) {
    const q = state.qualification;
    LOCATION_FIXES.forEach(([pattern, fixed]) => {
      reply = reply.replace(pattern, fixed);
    });
    reply = stripContactAsks(reply);
    if (modelReply) reply = dropKnownQuestions(reply, q);
    // A knowledge answer never turns into qualification ("buy, rent or off-plan?") and never offers again what was
    // already explained or declined, in any wording (see isClosedFollowUp).
    if (knowledgeAnswer) {
      reply = dropQuestions(reply, (s) => questionFields(s).includes('purpose'));
      if (previousAnswer) reply = dropRestated(reply, previousAnswer);
      const offer = reply.endsWith('?') ? closingOffer(reply) : '';
      if (offer && isClosedFollowUp(offer, state.closedFollowUps)) reply = reply.slice(0, reply.lastIndexOf(offer)).trim();
    }
    const missing = ['purpose', 'location', 'budget', 'bedrooms'].find((f) => fieldApplies(q, f) && !fieldKnown(q, f));
    // After results: a still-missing search field first; otherwise the next step for what was shown (see resultsNextStep).
    const resultTotal = propertyResult?.total || properties.length;
    if (propertyTurn && resultTotal && !missing) {
      reply = withQuestion(reply, resultsNextStep(properties, resultTotal));
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
  // The chat window shows reply text only, so the links are written into it as well as sent as actions.
  if (links.length) {
    reply = withLinkLines(reply, links);
    uiActions = [...uiActions, ...links];
  }
  // A reply ending with one of our choice questions waits for the user's answer to it on the next turn.
  if (!state.pendingQuestion) state.pendingQuestion = choiceQuestionIn(reply);
  // A knowledge answer ending with an offer waits for "yes" / "no" to that offer (see followUpAnswer).
  if (!state.pendingQuestion && knowledgeAnswer && reply.endsWith('?')) {
    state.pendingQuestion = KNOWLEDGE_FOLLOW_UP;
    state.pendingFollowUp = { offer: closingOffer(reply), question: knowledgeQuestion };
  }
  // Cards shown in this reply replace the remembered ones; a reply without cards keeps them for "the second one".
  if (properties.length) state.shownPropertyRefs = properties.map((p) => p.propertyRefNo);

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
        pendingQuestion: state.pendingQuestion,
        pendingFollowUp: state.pendingFollowUp || {},
        closedFollowUps: state.closedFollowUps,
        shownPropertyRefs: state.shownPropertyRefs,
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
