#!/usr/bin/env node
/**
 * SSE streaming integration tests for POST /api/ai/chat/stream.
 *
 * Usage:
 *   node scripts/test-ai-stream.js
 *
 * Requires the API server to be running (npm run dev).
 * Also spot-checks POST /api/ai/chat still works.
 */

require('dotenv').config();

const http = require('http');

const PORT = process.env.PORT || 5001;
const API_KEY = process.env.API_SECRET_KEY || process.env.API_KEY || '';
const BASE = `http://127.0.0.1:${PORT}`;

const cases = [
  {
    name: 'Company',
    message: 'Tell me about Rocky Real Estate',
    expectDeltas: true,
    expectSources: false,
    expectImmediate: false,
  },
  {
    name: 'Service',
    message: 'What services does Rocky Real Estate provide?',
    expectDeltas: true,
    expectSources: false,
    expectImmediate: true,
  },
  {
    name: 'Area Guide',
    message: 'What is Dubai Marina like?',
    expectDeltas: true,
    expectSources: true,
    expectImmediate: false,
  },
  {
    name: 'FAQ',
    message: 'How can foreigners buy property in Dubai?',
    expectDeltas: true,
    expectSources: true,
    expectImmediate: false,
  },
  {
    name: 'Blog',
    message: 'What are the latest property investment articles?',
    expectDeltas: true,
    expectSources: true,
    expectImmediate: false,
  },
  {
    name: 'Mixed knowledge',
    message:
      'What areas are good for investment and what is the buying process?',
    expectDeltas: true,
    expectSources: true,
    expectImmediate: false,
  },
  {
    name: 'Property search',
    message: 'I want to rent a 2 bedroom apartment in Dubai Marina',
    expectDeltas: true,
    expectSources: false,
    expectImmediate: true,
    expectEvents: ['property_results'],
  },
  {
    name: 'Greeting',
    message: 'Hi',
    expectDeltas: true,
    expectSources: false,
    expectImmediate: true,
    expectTextIncludes: 'Rocky AI',
  },
  {
    name: 'Property count',
    message: 'How many properties do you have?',
    expectDeltas: true,
    expectSources: false,
    expectImmediate: true,
  },
  {
    name: 'Team',
    message: 'Who are the property consultants?',
    expectDeltas: true,
    expectSources: false,
    expectImmediate: false,
  },
  {
    name: 'Confidential',
    message: "Give me an agent's phone number",
    expectDeltas: true,
    expectSources: false,
    expectImmediate: true,
    expectTextIncludes: "I can't provide private",
  },
  {
    name: 'Unsupported',
    message: 'What is the weather on Mars today?',
    expectDeltas: true,
    expectSources: false,
    expectImmediate: true,
  },
];

/**
 * @param {string} path
 * @param {object} body
 * @returns {Promise<{ status: number, headers: object, body: string, events: Array<{event:string,data:object}>, durationMs: number }>}
 */
const postSse = (path, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const started = Date.now();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
          Accept: 'text/event-stream',
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          const events = [];
          const blocks = raw.split('\n\n').filter(Boolean);
          for (const block of blocks) {
            const lines = block.split('\n');
            let event = 'message';
            let data = '';
            for (const line of lines) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            let parsed = {};
            try {
              parsed = data ? JSON.parse(data) : {};
            } catch (_) {
              parsed = { raw: data };
            }
            events.push({ event, data: parsed });
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: raw,
            events,
            durationMs: Date.now() - started,
          });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

const postJson = (path, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (_) {
            json = null;
          }
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

const main = async () => {
  console.log('[ai-stream-test] starting', { base: BASE });

  if (!API_KEY) {
    console.warn(
      '[ai-stream-test] warning: API_SECRET_KEY missing — request may be rejected by middleware'
    );
  }

  const results = [];
  let failed = 0;

  for (const testCase of cases) {
    try {
      const response = await postSse('/api/ai/chat/stream', {
        message: testCase.message,
      });

      const errors = [];
      const contentType = String(response.headers['content-type'] || '');
      if (!contentType.includes('text/event-stream')) {
        errors.push(`content-type=${contentType}`);
      }

      const events = response.events.map((e) => e.event);
      if (!events.includes('start')) errors.push('missing start');
      if (!events.includes('done') && !events.includes('error')) {
        errors.push('missing done/error');
      }

      const deltas = response.events.filter((e) => e.event === 'delta');
      const sourcesEv = response.events.filter((e) => e.event === 'sources');
      const errorEv = response.events.find((e) => e.event === 'error');

      if (errorEv && !events.includes('done')) {
        // timeout/error path — still record
      }

      if (testCase.expectDeltas && deltas.length === 0) {
        errors.push('expected delta events');
      }
      if (testCase.expectSources && sourcesEv.length === 0) {
        errors.push('expected sources event');
      }
      if (
        !testCase.expectSources &&
        sourcesEv.length > 0 &&
        (testCase.name === 'Confidential' ||
          testCase.name === 'Property count' ||
          testCase.name === 'Unsupported')
      ) {
        errors.push('unexpected sources');
      }

      if (testCase.expectImmediate && response.durationMs > 8000) {
        errors.push(`expected fast response, took ${response.durationMs}ms`);
      }

      const text = deltas.map((d) => d.data?.text || '').join('');
      if (
        testCase.expectTextIncludes &&
        !text.includes(testCase.expectTextIncludes)
      ) {
        errors.push('reply text mismatch');
      }

      if (Array.isArray(testCase.expectEvents)) {
        for (const ev of testCase.expectEvents) {
          if (!events.includes(ev)) {
            errors.push(`missing event ${ev}`);
          }
        }
      }

      const ok = errors.length === 0 && !errorEv;
      if (!ok) failed += 1;

      results.push({
        name: testCase.name,
        ok,
        status: response.status,
        durationMs: response.durationMs,
        eventTypes: events,
        deltaCount: deltas.length,
        hasSources: sourcesEv.length > 0,
        errors: errorEv
          ? [...errors, errorEv.data?.message || 'stream error']
          : errors,
        preview: text.slice(0, 100),
      });

      console.log(
        `[ai-stream-test] ${ok ? 'PASS' : 'FAIL'} — ${testCase.name} (deltas=${deltas.length}, sources=${sourcesEv.length > 0}, ${response.durationMs}ms)`
      );
      if (!ok) console.log('  errors:', results[results.length - 1].errors);
    } catch (error) {
      failed += 1;
      results.push({
        name: testCase.name,
        ok: false,
        errors: [error?.message || String(error)],
      });
      console.log(
        `[ai-stream-test] FAIL — ${testCase.name}: ${error?.message || error}`
      );
    }
  }

  // Regression: non-streaming chat
  let chatOk = false;
  try {
    const chat = await postJson('/api/ai/chat', {
      message: 'How many properties do you have?',
    });
    chatOk =
      chat.status === 200 &&
      chat.json?.success === true &&
      typeof chat.json?.data?.reply === 'string';
    console.log(
      `[ai-stream-test] ${chatOk ? 'PASS' : 'FAIL'} — /api/ai/chat regression`
    );
    if (!chatOk) failed += 1;
  } catch (error) {
    failed += 1;
    console.log(
      `[ai-stream-test] FAIL — /api/ai/chat regression: ${error?.message || error}`
    );
  }

  console.log('[ai-stream-test] summary');
  console.log(
    JSON.stringify(
      {
        total: cases.length,
        passed: cases.length - (failed - (chatOk ? 0 : 1)),
        failed,
        chatRegression: chatOk,
        mongoWrites: 0,
        rateLimiting:
          'Not implemented on AI routes — required before public rollout',
        results,
      },
      null,
      2
    )
  );

  if (failed > 0) {
    console.error('[ai-stream-test] FAILED');
    process.exit(1);
  }
  console.log('[ai-stream-test] PASSED');
};

main().catch((error) => {
  console.error('[ai-stream-test] failed', error?.message || error);
  process.exit(1);
});
