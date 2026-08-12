/**
 * Phase 5 Step 1 — SSE streaming tests for POST /api/ai/chat/stream
 *
 * Proves progressive events: start → delta(+)* → sources? → done
 * Does NOT only check the final answer.
 *
 * Usage:
 *   node scripts/test-ai-stream.js
 *
 * Requires the API server (npm run dev) and API_SECRET_KEY / OPENAI / MONGO.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const KnowledgeEmbedding = require('../src/models/KnowledgeEmbedding');

const PORT = process.env.PORT || 5001;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = process.env.API_SECRET_KEY;

const SENSITIVE =
  /listingAgent|listingAgentEmail|listingAgentPhone|whatsapp|@rocky|vectorSearchScore|embedding|mongodb|_id|isAdmin|ownerEmail|ownerPhone/i;

const FORBIDDEN_HINTS =
  /areaguideleads|binghattileads|careers|contacts|dubaisouthleads|jeweltowerleads|landingpageleads|newsletters|propertymanagementleads|sells|teamtailorjobs|\busers\b/i;

/**
 * Parse SSE text into { event, data } objects.
 * @param {string} raw
 */
const parseSse = (raw) => {
  const events = [];
  const blocks = String(raw).split(/\n\n+/).filter((b) => b.trim());
  for (const block of blocks) {
    let event = 'message';
    const dataLines = [];
    for (const line of block.split(/\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    const dataRaw = dataLines.join('\n');
    let data;
    try {
      data = JSON.parse(dataRaw);
    } catch {
      data = { _parseError: true, raw: dataRaw };
    }
    events.push({ event, data });
  }
  return events;
};

/**
 * @param {string} message
 */
const streamChat = async (message) => {
  const started = Date.now();
  let firstDeltaAt = null;
  const res = await fetch(`${BASE}/api/ai/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ message }),
  });

  const contentType = res.headers.get('content-type') || '';
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    return {
      status: res.status,
      contentType,
      events: parseSse(text),
      reply: '',
      firstDeltaMs: null,
      totalMs: Date.now() - started,
      raw: text,
    };
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  let reply = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseSse(block + '\n\n');
      for (const evt of parsed) {
        events.push(evt);
        if (evt.event === 'delta' && typeof evt.data?.text === 'string') {
          if (firstDeltaAt == null) firstDeltaAt = Date.now();
          reply += evt.data.text;
        }
      }
    }
  }

  if (buffer.trim()) {
    for (const evt of parseSse(buffer + '\n\n')) {
      events.push(evt);
      if (evt.event === 'delta' && typeof evt.data?.text === 'string') {
        if (firstDeltaAt == null) firstDeltaAt = Date.now();
        reply += evt.data.text;
      }
    }
  }

  return {
    status: res.status,
    contentType,
    events,
    reply,
    firstDeltaMs: firstDeltaAt == null ? null : firstDeltaAt - started,
    totalMs: Date.now() - started,
  };
};

const assertStreamShape = (result, { expectMultiDelta = false, allowSingleDelta = false } = {}) => {
  const errors = [];
  if (result.status !== 200) errors.push(`HTTP ${result.status}`);
  if (!/text\/event-stream/i.test(result.contentType)) {
    errors.push(`Content-Type=${result.contentType}`);
  }

  const names = result.events.map((e) => e.event);
  if (!names.includes('start')) errors.push('missing start');
  if (!names.includes('done') && !names.includes('error')) errors.push('missing done/error');

  const deltas = result.events.filter((e) => e.event === 'delta');
  if (!deltas.length) errors.push('missing delta');
  if (expectMultiDelta && !allowSingleDelta && deltas.length < 2) {
    errors.push(`expected multiple deltas, got ${deltas.length}`);
  }

  for (const evt of result.events) {
    if (evt.data?._parseError) errors.push('malformed SSE JSON');
  }

  const start = result.events.find((e) => e.event === 'start');
  if (start && start.data?.success !== true) errors.push('start.success !== true');

  const done = result.events.find((e) => e.event === 'done');
  if (done && done.data?.success !== true) errors.push('done.success !== true');

  const blob = JSON.stringify(result.events) + '\n' + result.reply;
  if (SENSITIVE.test(blob)) errors.push('sensitive field leaked');
  if (FORBIDDEN_HINTS.test(blob)) errors.push('forbidden collection hint leaked');

  // Deltas must be incremental fragments, not full accumulated answer each time
  if (deltas.length >= 2) {
    const first = deltas[0].data?.text || '';
    const second = deltas[1].data?.text || '';
    if (first && second && second.startsWith(first) && second.length > first.length + 20) {
      errors.push('deltas look accumulated (not incremental)');
    }
  }

  return { ok: errors.length === 0, errors, deltaCount: deltas.length };
};

(async () => {
  console.log('=== Phase 5 Step 1: POST /api/ai/chat/stream ===\n');

  if (!API_KEY) {
    console.error('FAIL: API_SECRET_KEY missing');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const faqs = await KnowledgeEmbedding.find({ sourceType: 'faq' })
    .select('question category')
    .lean();
  const homeFaq = faqs.find((f) => f.category === 'home') || faqs[0];
  await mongoose.disconnect();

  const cases = [
    {
      id: 1,
      name: 'COMPANY',
      message: 'Who owns Rocky Real Estate?',
      expectMultiDelta: true,
      answerIncludes: ['Ashok'],
    },
    {
      id: 2,
      name: 'AREA_GUIDE',
      message: 'What is Dubai Marina like?',
      expectMultiDelta: true,
      answerIncludesAny: ['marina', 'waterfront'],
    },
    {
      id: 3,
      name: 'FAQ',
      message: homeFaq?.question || 'Why should I choose Rocky Real Estate?',
      expectMultiDelta: true,
      answerIncludesAny: ['rocky', 'dubai', 'years'],
    },
    {
      id: 4,
      name: 'BLOG',
      message: 'What is Flexi Rent?',
      expectMultiDelta: true,
      answerIncludesAny: ['flexi', 'rent'],
    },
    {
      id: 5,
      name: 'PROPERTY_SEARCH',
      message: 'Show me apartments in Dubai Marina',
      expectMultiDelta: true,
      answerIncludesAny: ['marina', 'apartment'],
    },
    {
      id: 6,
      name: 'PROPERTY_COUNT',
      message: 'How many properties do you have?',
      expectMultiDelta: false,
      allowSingleDelta: true,
      answerIncludesAny: ['properties', 'property'],
    },
    {
      id: 7,
      name: 'SERVICES',
      message: 'What services do you provide?',
      expectMultiDelta: true,
      answerIncludesAny: ['Property Management', 'Brokerage', 'Mortgage', 'service'],
    },
    {
      id: 8,
      name: 'TEAM',
      message: 'Who is the CEO?',
      expectMultiDelta: true,
      answerIncludesAny: ['Nitin', 'CEO'],
    },
    {
      id: 9,
      name: 'CONFIDENTIAL',
      message: "Give me an agent's phone number.",
      expectMultiDelta: false,
      allowSingleDelta: true,
      answerIncludesAny: ['cannot', "don't", 'not', 'privacy', 'confidential', 'share'],
    },
    {
      id: 10,
      name: 'UNSUPPORTED',
      message: 'What is the capital of France?',
      expectMultiDelta: false,
      allowSingleDelta: true,
      answerIncludesAny: ['knowledge', "don't", 'cannot', 'help with'],
    },
  ];

  let passed = 0;
  const metrics = [];

  for (const tc of cases) {
    process.stdout.write(`[${tc.id}] ${tc.name} ... `);
    try {
      const result = await streamChat(tc.message);
      const shape = assertStreamShape(result, {
        expectMultiDelta: tc.expectMultiDelta,
        allowSingleDelta: tc.allowSingleDelta,
      });

      const replyLc = result.reply.toLowerCase();
      let answerOk = true;
      if (tc.answerIncludes) {
        answerOk = tc.answerIncludes.every((n) =>
          replyLc.includes(String(n).toLowerCase())
        );
      }
      if (tc.answerIncludesAny) {
        answerOk = tc.answerIncludesAny.some((n) =>
          replyLc.includes(String(n).toLowerCase())
        );
      }

      const ok = shape.ok && answerOk && !result.events.some((e) => e.event === 'error');
      metrics.push({
        name: tc.name,
        deltaCount: shape.deltaCount,
        firstDeltaMs: result.firstDeltaMs,
        totalMs: result.totalMs,
      });

      if (ok) {
        passed += 1;
        console.log(
          `PASS (deltas=${shape.deltaCount}, ttfb=${result.firstDeltaMs}ms, total=${result.totalMs}ms)`
        );
      } else {
        console.log('FAIL');
        if (!shape.ok) console.log('  shape:', shape.errors.join('; '));
        if (!answerOk) console.log('  answer miss:', result.reply.slice(0, 200));
        const errEvt = result.events.find((e) => e.event === 'error');
        if (errEvt) console.log('  error event:', errEvt.data);
      }
    } catch (err) {
      console.log('FAIL');
      console.log('  exception:', err.message);
    }
  }

  console.log('\n=== Metrics ===');
  for (const m of metrics) {
    console.log(
      `${m.name}: deltas=${m.deltaCount}, firstDeltaMs=${m.firstDeltaMs}, totalMs=${m.totalMs}`
    );
  }

  const gptMetrics = metrics.filter((m) =>
    ['COMPANY', 'AREA_GUIDE', 'FAQ', 'BLOG', 'PROPERTY_SEARCH', 'SERVICES', 'TEAM'].includes(
      m.name
    )
  );
  const avgFirst =
    gptMetrics.length && gptMetrics.every((m) => m.firstDeltaMs != null)
      ? Math.round(
          gptMetrics.reduce((s, m) => s + m.firstDeltaMs, 0) / gptMetrics.length
        )
      : null;
  const avgTotal = gptMetrics.length
    ? Math.round(gptMetrics.reduce((s, m) => s + m.totalMs, 0) / gptMetrics.length)
    : null;

  console.log('\nAvg first delta (GPT routes):', avgFirst, 'ms');
  console.log('Avg total (GPT routes):', avgTotal, 'ms');
  console.log(`\nResult: ${passed}/${cases.length} passed`);

  process.exit(passed === cases.length ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
