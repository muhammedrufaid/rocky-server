#!/usr/bin/env node
/**
 * AI rate-limiter tests (no OpenAI / no vector search).
 *
 * Usage:
 *   node scripts/test-ai-rate-limit.js
 *
 * 1) Isolated Express app verifies 429 behavior with a tiny limit.
 * 2) Live server spot-check: AI routes work; non-AI route is unaffected.
 */

require('dotenv').config();

const http = require('http');
const express = require('express');
const { createAiRateLimiter } = require('../src/middleware/aiRateLimiter');

const PORT = process.env.PORT || 5001;
const API_KEY = process.env.API_SECRET_KEY || '';

const post = (port, path, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
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
          resolve({
            status: res.statusCode,
            headers: res.headers,
            json,
            raw,
            contentType: String(res.headers['content-type'] || ''),
          });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

const get = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, raw });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });

const runIsolatedLimiterTests = async () => {
  console.log('[ai-rate-limit-test] isolated middleware tests');

  let hitCount = 0;
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());

  const limiter = createAiRateLimiter({ windowMs: 60_000, max: 3 });

  app.post('/api/ai/chat', limiter, (req, res) => {
    hitCount += 1;
    return res.status(200).json({ success: true, data: { reply: 'ok' } });
  });
  app.post('/api/ai/chat/stream', limiter, (req, res) => {
    hitCount += 1;
    // If rate limit worked, we never reach SSE headers on the 4th call.
    res.setHeader('Content-Type', 'text/event-stream');
    return res.status(200).end('event: start\ndata: {}\n\n');
  });
  app.get('/api/frontend/health-proxy', (req, res) => {
    return res.status(200).json({ success: true, open: true });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();

  const results = [];
  let failed = 0;

  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`[ai-rate-limit-test] ${ok ? 'PASS' : 'FAIL'} — ${name}`);
    if (!ok) {
      failed += 1;
      console.log('  detail:', detail);
    }
  };

  try {
    const a1 = await post(port, '/api/ai/chat', { message: 'a' });
    record('chat request 1 allowed', a1.status === 200 && a1.json?.success === true, a1);

    const a2 = await post(port, '/api/ai/chat/stream', { message: 'b' });
    record(
      'stream request 2 allowed',
      a2.status === 200 && a2.contentType.includes('text/event-stream'),
      { status: a2.status, contentType: a2.contentType }
    );

    const a3 = await post(port, '/api/ai/chat', { message: 'c' });
    record('chat request 3 allowed', a3.status === 200, a3.status);

    const blockedChat = await post(port, '/api/ai/chat', { message: 'd' });
    record(
      'chat request 4 → 429 JSON',
      blockedChat.status === 429 &&
        blockedChat.json?.success === false &&
        typeof blockedChat.json?.message === 'string' &&
        blockedChat.json.message.includes('Too many AI requests') &&
        !String(blockedChat.contentType).includes('text/event-stream'),
      blockedChat
    );

    const blockedStream = await post(port, '/api/ai/chat/stream', {
      message: 'e',
    });
    record(
      'stream request 5 → 429 JSON (not SSE)',
      blockedStream.status === 429 &&
        blockedStream.json?.success === false &&
        !String(blockedStream.contentType).includes('text/event-stream'),
      {
        status: blockedStream.status,
        contentType: blockedStream.contentType,
        json: blockedStream.json,
      }
    );

    record(
      'handler not reached after limit',
      hitCount === 3,
      { hitCount }
    );

    const other = await get(port, '/api/frontend/health-proxy');
    record(
      'non-AI route not rate-limited',
      other.status === 200 && other.raw.includes('open'),
      { status: other.status, raw: other.raw }
    );

    const hasRateHeaders =
      Boolean(blockedChat.headers['ratelimit-limit']) ||
      Boolean(blockedChat.headers['x-ratelimit-limit']);
    record('rate-limit headers present on 429', hasRateHeaders, {
      ratelimitLimit: blockedChat.headers['ratelimit-limit'],
      remaining: blockedChat.headers['ratelimit-remaining'],
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  return { failed, results };
};

const runLiveSpotChecks = async () => {
  console.log('[ai-rate-limit-test] live server spot-checks');
  if (!API_KEY) {
    console.log('[ai-rate-limit-test] SKIP live checks — API_SECRET_KEY missing');
    return { failed: 0, skipped: true };
  }

  let failed = 0;
  const headers = { 'x-api-key': API_KEY };

  try {
    // Confidential = no OpenAI / no vector search
    const chat = await post(
      PORT,
      '/api/ai/chat',
      { message: "Give me an agent's phone number" },
      headers
    );
    const chatOk =
      chat.status === 200 &&
      chat.json?.success === true &&
      typeof chat.json?.data?.reply === 'string';
    console.log(
      `[ai-rate-limit-test] ${chatOk ? 'PASS' : 'FAIL'} — live /api/ai/chat still works`
    );
    if (!chatOk) failed += 1;

    const stream = await post(
      PORT,
      '/api/ai/chat/stream',
      { message: 'How many properties do you have?' },
      headers
    );
    const streamOk =
      stream.status === 200 &&
      String(stream.contentType).includes('text/event-stream') &&
      stream.raw.includes('event: start');
    console.log(
      `[ai-rate-limit-test] ${streamOk ? 'PASS' : 'FAIL'} — live /api/ai/chat/stream still works`
    );
    if (!streamOk) failed += 1;

    const health = await get(PORT, '/');
    const healthOk = health.status === 200;
    console.log(
      `[ai-rate-limit-test] ${healthOk ? 'PASS' : 'FAIL'} — non-AI / remains available`
    );
    if (!healthOk) failed += 1;
  } catch (error) {
    console.log(
      `[ai-rate-limit-test] FAIL — live checks: ${error?.message || error}`
    );
    failed += 1;
  }

  return { failed, skipped: false };
};

const main = async () => {
  console.log('[ai-rate-limit-test] starting');
  const isolated = await runIsolatedLimiterTests();
  const live = await runLiveSpotChecks();

  const failed = isolated.failed + live.failed;
  console.log('[ai-rate-limit-test] summary');
  console.log(
    JSON.stringify(
      {
        isolatedFailed: isolated.failed,
        liveFailed: live.failed,
        liveSkipped: Boolean(live.skipped),
        mongoWrites: 0,
        openaiCalls: 0,
        note: 'Limiter is in-memory per process; not shared across multiple instances.',
      },
      null,
      2
    )
  );

  if (failed > 0) {
    console.error('[ai-rate-limit-test] FAILED');
    process.exit(1);
  }
  console.log('[ai-rate-limit-test] PASSED');
};

main().catch((error) => {
  console.error('[ai-rate-limit-test] failed', error?.message || error);
  process.exit(1);
});
