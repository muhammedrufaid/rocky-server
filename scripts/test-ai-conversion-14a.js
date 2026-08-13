#!/usr/bin/env node
/**
 * STEP 14A — Conversion-focused funnel upgrades.
 *
 * Usage:
 *   node scripts/test-ai-conversion-14a.js
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { handleChat } = require('../src/ai/orchestrator/aiOrchestrator');
const { classifyIntent } = require('../src/ai/orchestrator/intentRouter');
const {
  extractPropertySearchQuery,
  parseBudgetSelection,
} = require('../src/ai/tools/propertyTools');

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const main = async () => {
  console.log('[ai-conversion-14a] starting');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not configured');
  await mongoose.connect(process.env.MONGO_URI);

  let failed = 0;
  const results = [];

  const run = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`[ai-conversion-14a] PASS — ${name}`);
    } catch (error) {
      failed += 1;
      results.push({ name, ok: false, error: error?.message || String(error) });
      console.log(`[ai-conversion-14a] FAIL — ${name}: ${error?.message || error}`);
    }
  };

  await run('Hi → greeting + actions', async () => {
    const r = await handleChat('Hi');
    assert(r.route === 'GREETING', 'route');
    assert(r.quick_actions?.options?.some((o) => o.label === 'Off-Plan'), 'off-plan');
    assert(r.context?.funnelStage === 'DISCOVERY', 'stage');
    assert(r.openaiCalls === 0, 'openai');
  });

  await run('Buy a property → type ask', async () => {
    const r = await handleChat('I want to buy a property');
    assert(r.route === 'PROPERTY_SEARCH', 'route');
    assert(r.context?.listingType === 'buy', 'buy');
    assert(r.context?.pendingClarification === 'propertyType', 'type');
  });

  await run('Rent an apartment → location ask', async () => {
    const r = await handleChat('I want to rent an apartment');
    assert(r.context?.listingType === 'rent', 'rent');
    assert(r.context?.filters?.propertyType === 'Apartment', 'apt');
    assert(r.context?.pendingClarification === 'location', 'location');
  });

  await run('Full rent query → search immediately', async () => {
    const r = await handleChat(
      'I want to rent a 2 bedroom apartment in Dubai Marina'
    );
    assert(r.property_results || r.context?.pendingClarification === 'budget', 'search/budget');
    assert(!r.context?.pendingClarification || r.context.pendingClarification === 'budget', 'no type ask');
    assert(
      !(r.quick_actions?.options || []).some((o) => /talk to an agent/i.test(o.label)),
      'no agent after search'
    );
  });

  await run('2 bedroom apartment → ask location or listing', async () => {
    const r = await handleChat('I want a 2 bedroom apartment');
    assert(
      r.context?.pendingClarification === 'listingType' ||
        r.context?.pendingClarification === 'location',
      `pending=${r.context?.pendingClarification}`
    );
  });

  await run('Buy villa Arabian Ranches → search (no bedrooms ask)', async () => {
    const r = await handleChat('I want to buy a villa in Arabian Ranches');
    assert(
      r.property_results || r.context?.pendingClarification === 'budget',
      'results or budget'
    );
    assert(r.context?.pendingClarification !== 'bedrooms', 'no beds ask');
  });

  await run('under AED 150,000 budget parse', async () => {
    const b = parseBudgetSelection('under AED 150,000');
    assert(b?.priceMax === 150000, `max=${b?.priceMax}`);
    const q = extractPropertySearchQuery(
      'I want something under AED 150,000'
    );
    assert(q.filters.priceMax === 150000, 'extract');
    const r = await handleChat('I want something under AED 150,000');
    assert(r.route === 'PROPERTY_SEARCH', 'route');
    assert(r.context?.filters?.priceMax === 150000, 'budget kept');
  });

  await run('Show apartments Marina → listing type ask', async () => {
    const r = await handleChat('Show me apartments in Dubai Marina');
    assert(r.context?.pendingClarification === 'listingType', 'listing');
  });

  let ctx = null;
  await run('Select Rent continues funnel', async () => {
    const first = await handleChat('Show me apartments in Dubai Marina');
    const r = await handleChat('Rent', { context: first.context });
    assert(r.context?.listingType === 'rent', 'rent');
    assert(r.context?.filters?.propertyType === 'Apartment', 'apt');
    ctx = r.context;
  });

  await run('Property selection stores selectedProperty', async () => {
    const search = await handleChat(
      'I want to rent a 2 bedroom apartment in Dubai Marina under AED 200000'
    );
    // force past large-budget gate
    let working = search;
    if (search.context?.pendingClarification === 'budget') {
      working = await handleChat('budget:flexible', { context: search.context });
    }
    assert(working.property_results?.properties?.length >= 1, 'has cards');
    const pick = await handleChat('I like the second one', {
      context: working.context,
    });
    assert(pick.context?.selectedProperty, 'selected');
    assert(pick.context?.funnelStage === 'PROPERTY_SELECTED', 'stage');
    assert(
      pick.quick_actions?.options?.some((o) => /talk to an agent/i.test(o.label)),
      'agent after select'
    );
    ctx = pick.context;
  });

  await run('Talk to agent includes property on contact_action', async () => {
    const r = await handleChat('Talk to an Agent', { context: ctx });
    assert(r.contact_action, 'contact');
    assert(r.contact_action.service === 'property' || r.contact_action.service === 'agent', 'service');
    if (ctx?.selectedProperty) {
      assert(r.contact_action.property?.title || r.contact_action.property?.url, 'property payload');
      assert(!r.contact_action.property?.image, 'no image');
    }
  });

  await run('Property management short + contact', async () => {
    const r = await handleChat('What is property management?');
    assert(r.route === 'SERVICE_INFO', 'route');
    assert(r.openaiCalls === 0, 'no rag');
    assert(r.reply.split('\n').length <= 5, 'short');
    assert(r.service_action?.url === '/services/property-management', 'url');
    assert(r.contact_action?.service === 'property-management', 'contact');
  });

  await run('Need property management → conversion', async () => {
    const r = await handleChat('I need property management for my apartment.');
    assert(r.openaiCalls === 0, 'no rag');
    assert(/absolutely|property management/i.test(r.reply), 'reply');
    assert(r.contact_action, 'contact');
    assert(r.whatsapp_action, 'whatsapp');
  });

  await run('Confidential agent phone', async () => {
    const r = await handleChat("Give me an agent's phone number");
    assert(r.route === 'CONFIDENTIAL', 'route');
  });

  await run('Property count regression', async () => {
    assert(classifyIntent('How many properties do you have?') === 'PROPERTY_COUNT');
    const r = await handleChat('How many properties do you have?');
    assert(r.route === 'PROPERTY_COUNT', 'route');
    assert(!r.property_results, 'no cards');
  });

  console.log('[ai-conversion-14a] summary');
  console.log(JSON.stringify({ total: results.length, failed, results }, null, 2));
  await mongoose.disconnect();
  if (failed) process.exit(1);
  console.log('[ai-conversion-14a] PASSED');
};

main().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
