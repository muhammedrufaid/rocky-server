#!/usr/bin/env node
/**
 * Content-topic routing — Flexi Rent / dynamic blog RAG (no hard-coded answers).
 *
 * Usage:
 *   node scripts/test-ai-content-topic.js
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { handleChat } = require('../src/ai/orchestrator/aiOrchestrator');
const { classifyIntent } = require('../src/ai/orchestrator/intentRouter');
const {
  resolveShortServiceTurn,
  detectServiceKey,
} = require('../src/ai/tools/serviceActions');

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const GENERIC_SERVICES =
  /Rocky provides brokerage, property management, listing/i;

const main = async () => {
  console.log('[ai-content-topic] starting');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not configured');
  await mongoose.connect(process.env.MONGO_URI);

  let failed = 0;
  const results = [];
  const run = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`[ai-content-topic] PASS — ${name}`);
    } catch (error) {
      failed += 1;
      results.push({ name, ok: false, error: error?.message || String(error) });
      console.log(`[ai-content-topic] FAIL — ${name}: ${error?.message || error}`);
    }
  };

  const flexiQueries = [
    'Do you offer flexi rent?',
    'What is flexi rent?',
    'Do you have flexible rent?',
    'I need flexible rental',
    'Can I rent on a flexible basis?',
    'Is flexible rental available?',
    'Do you offer flexible rental?',
    'flexi rent',
    'flexible rent',
    'short term rental',
  ];

  await run('Flexi / flexible queries → CONTENT_TOPIC (not SERVICE_INFO)', async () => {
    for (const q of flexiQueries) {
      const intent = classifyIntent(q);
      assert(
        intent === 'CONTENT_TOPIC' || intent === 'BLOG',
        `${q} → ${intent}`
      );
      assert(intent !== 'SERVICE_INFO', `${q} not SERVICE_INFO`);
      assert(intent !== 'PROPERTY_SEARCH', `${q} not PROPERTY_SEARCH`);
      assert(!resolveShortServiceTurn(q), `${q} no generic short service`);
      assert(detectServiceKey(q) !== 'services', `${q} not services key`);
    }
  });

  await run('Generic services question → SERVICE_INFO short reply', async () => {
    assert(classifyIntent('What services do you offer?') === 'SERVICE_INFO', 'intent');
    const r = await handleChat('What services do you offer?');
    assert(r.route === 'SERVICE_INFO', `route=${r.route}`);
    assert(GENERIC_SERVICES.test(r.reply), 'generic services reply');
    assert(r.openaiCalls === 0, 'no rag');
  });

  await run('Apartment rent search → PROPERTY_SEARCH', async () => {
    const q = 'What apartments are available for rent in Dubai Marina?';
    assert(classifyIntent(q) === 'PROPERTY_SEARCH', `intent=${classifyIntent(q)}`);
    const r = await handleChat(q);
    assert(r.route === 'PROPERTY_SEARCH', `route=${r.route}`);
    assert(!GENERIC_SERVICES.test(r.reply || ''), 'not services dump');
  });

  await run('Do you offer flexi rent? → RAG content topic (not services dump)', async () => {
    if (!process.env.OPENAI_API_KEY) {
      console.log('  (skip — OPENAI_API_KEY missing)');
      return;
    }
    const r = await handleChat('Do you offer flexi rent?');
    assert(r.route === 'CONTENT_TOPIC', `route=${r.route}`);
    assert(!GENERIC_SERVICES.test(r.reply), 'not generic services');
    assert(typeof r.reply === 'string' && r.reply.length > 0, 'has reply');
    assert(
      r.quick_actions || r.service_action || r.whatsapp_action || r.contact_action,
      'has CTA'
    );
    // Should not invent private agent fields
    assert(!/listingAgentPhone|embedding/i.test(JSON.stringify(r)), 'no private');
  });

  await run('What is flexi rent? → CONTENT_TOPIC RAG', async () => {
    if (!process.env.OPENAI_API_KEY) return;
    const r = await handleChat('What is flexi rent?');
    assert(r.route === 'CONTENT_TOPIC', `route=${r.route}`);
    assert(!GENERIC_SERVICES.test(r.reply), 'not services dump');
  });

  await run('Do you have flexible rent? → CONTENT_TOPIC', async () => {
    if (!process.env.OPENAI_API_KEY) return;
    const r = await handleChat('Do you have flexible rent?');
    assert(r.route === 'CONTENT_TOPIC', `route=${r.route}`);
    assert(!GENERIC_SERVICES.test(r.reply), 'not services dump');
  });

  await run('I need flexible rental → CONTENT_TOPIC', async () => {
    if (!process.env.OPENAI_API_KEY) return;
    const r = await handleChat('I need flexible rental');
    assert(r.route === 'CONTENT_TOPIC', `route=${r.route}`);
  });

  await run('Property management still SERVICE_INFO', async () => {
    assert(classifyIntent('What is property management?') === 'SERVICE_INFO', 'intent');
    const r = await handleChat('What is property management?');
    assert(r.route === 'SERVICE_INFO', 'route');
    assert(r.openaiCalls === 0, 'short');
  });

  console.log('[ai-content-topic] summary');
  console.log(JSON.stringify({ total: results.length, failed, results }, null, 2));
  await mongoose.disconnect();
  if (failed) process.exit(1);
  console.log('[ai-content-topic] PASSED');
};

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
