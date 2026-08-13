#!/usr/bin/env node
/**
 * STEP 13A — Conversational Property Assistant tests (handleChat).
 *
 * Usage:
 *   node scripts/test-ai-conversational.js
 *
 * Read-only: 0 MongoDB writes.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { handleChat } = require('../src/ai/orchestrator/aiOrchestrator');
const { classifyIntent } = require('../src/ai/orchestrator/intentRouter');
const {
  detectListingType,
  extractPropertySearchQuery,
  mergePropertySearchState,
  FORBIDDEN_PROPERTY_FIELDS,
} = require('../src/ai/tools/propertyTools');

const SAFE_CARD_KEYS = new Set([
  'id',
  'title',
  'building',
  'locality',
  'subLocality',
  'propertyType',
  'bedrooms',
  'bathrooms',
  'size',
  'price',
  'pricePeriod',
  'listingType',
  'url',
  'image',
  'ctaLabel',
]);

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const main = async () => {
  console.log('[ai-conversational-test] starting');

  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not configured');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('[ai-conversational-test] MongoDB connected');

  const results = [];
  let failed = 0;

  const run = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`[ai-conversational-test] PASS — ${name}`);
    } catch (error) {
      failed += 1;
      results.push({ name, ok: false, error: error?.message || String(error) });
      console.log(
        `[ai-conversational-test] FAIL — ${name}: ${error?.message || error}`
      );
    }
  };

  // 1–2 Greeting
  await run('Hi → GREETING, no OpenAI', async () => {
    assert(classifyIntent('Hi') === 'GREETING', 'intent');
    const r = await handleChat('Hi');
    assert(r.route === 'GREETING', `route=${r.route}`);
    assert(r.openaiCalls === 0, 'openaiCalls');
    assert(/Rocky AI/i.test(r.reply), 'reply');
    assert(r.quick_actions?.options?.length >= 4, 'greeting actions');
    assert(!r.property_results, 'no property_results');
    assert(!r.sources, 'no sources');
  });

  await run('Hello → GREETING', async () => {
    assert(classifyIntent('Hello') === 'GREETING', 'intent');
    const r = await handleChat('Hello');
    assert(r.route === 'GREETING', `route=${r.route}`);
    assert(r.openaiCalls === 0, 'openaiCalls');
  });

  // 3 Clarification when listing type missing
  let marinaContext = null;
  await run(
    'Show me apartments in Dubai Marina → quick_actions listing type',
    async () => {
      assert(
        classifyIntent('Show me apartments in Dubai Marina') ===
          'PROPERTY_SEARCH',
        'intent'
      );
      const r = await handleChat('Show me apartments in Dubai Marina');
      assert(r.route === 'PROPERTY_SEARCH', `route=${r.route}`);
      assert(r.openaiCalls === 0, 'openaiCalls');
      assert(r.quick_actions?.type === 'quick_actions', 'quick_actions');
      assert(
        r.quick_actions.options.some((o) => o.value === 'buy'),
        'buy option'
      );
      assert(
        r.quick_actions.options.some((o) => o.value === 'rent'),
        'rent option'
      );
      assert(
        r.quick_actions.options.some((o) => o.value === 'off-plan'),
        'off-plan option'
      );
      assert(!r.property_results, 'no property_results yet');
      assert(r.context?.filters?.propertyType === 'Apartment', 'type preserved');
      assert(/dubai marina/i.test(r.context?.search || ''), 'location preserved');
      assert(r.context?.pendingClarification === 'listingType', 'pending');
      marinaContext = r.context;
    }
  );

  // 4 Buy selection preserves filters
  await run('Buy selection preserves Apartment + Dubai Marina', async () => {
    const r = await handleChat('Buy', { context: marinaContext });
    assert(r.route === 'PROPERTY_SEARCH', `route=${r.route}`);
    assert(r.context?.listingType === 'buy', 'listingType buy');
    assert(r.context?.filters?.propertyType === 'Apartment', 'Apartment');
    assert(/dubai marina/i.test(r.context?.search || ''), 'Marina');
    assert(
      r.context?.pendingClarification === 'bedrooms' || r.property_results,
      'bedrooms or results'
    );
    assert(r.openaiCalls === 0, 'openaiCalls');
  });

  // 5 Rent selection
  await run('Rent selection preserves Apartment + Dubai Marina', async () => {
    const r = await handleChat('Rent', { context: marinaContext });
    assert(r.context?.listingType === 'rent', 'listingType rent');
    assert(r.context?.filters?.propertyType === 'Apartment', 'Apartment');
    assert(/dubai marina/i.test(r.context?.search || ''), 'Marina');
  });

  // 6 Off-plan selection
  await run('Off-plan selection preserves Apartment + Dubai Marina', async () => {
    const r = await handleChat('Off-plan', { context: marinaContext });
    assert(r.context?.listingType === 'off-plan', 'listingType off-plan');
    assert(r.context?.filters?.propertyType === 'Apartment', 'Apartment');
    assert(/dubai marina/i.test(r.context?.search || ''), 'Marina');
  });

  // 7 Filters for 2 bed (missing listing → clarification still has bedrooms)
  await run('Show me 2 bedroom apartments in Dubai Marina → filters', async () => {
    const q = extractPropertySearchQuery(
      'Show me 2 bedroom apartments in Dubai Marina'
    );
    assert(q.filters.propertyType === 'Apartment', 'type');
    assert(String(q.filters.bedrooms) === '2', 'beds');
    assert(/dubai marina/i.test(q.search), 'search');
    assert(q.listingType === null, 'listing missing');

    const r = await handleChat('Show me 2 bedroom apartments in Dubai Marina');
    assert(r.quick_actions, 'asks listing type');
    assert(String(r.context?.filters?.bedrooms) === '2', 'beds in context');
  });

  // 8 Full rent query → results
  await run(
    'I want to rent a 2 bedroom apartment in Dubai Marina → filters + results',
    async () => {
      const q = extractPropertySearchQuery(
        'I want to rent a 2 bedroom apartment in Dubai Marina'
      );
      assert(q.listingType === 'rent', 'rent');
      assert(q.filters.propertyType === 'Apartment', 'Apartment');
      assert(String(q.filters.bedrooms) === '2', '2');
      assert(/dubai marina/i.test(q.search), 'Marina');

      const r = await handleChat(
        'I want to rent a 2 bedroom apartment in Dubai Marina'
      );
      assert(r.route === 'PROPERTY_SEARCH', 'route');
      assert(r.openaiCalls === 0, 'openaiCalls');
      assert(r.property_results, 'property_results');
      assert(Array.isArray(r.property_results.properties), 'properties array');
      assert(typeof r.property_results.total === 'number', 'total');
    }
  );

  // 9 Buy villa Arabian Ranches
  await run('I want to buy a villa in Arabian Ranches → filters', async () => {
    const q = extractPropertySearchQuery(
      'I want to buy a villa in Arabian Ranches'
    );
    assert(q.listingType === 'buy', 'buy');
    assert(q.filters.propertyType === 'Villa', 'Villa');
    assert(/arabian ranches/i.test(q.search), 'area');

    const r = await handleChat('I want to buy a villa in Arabian Ranches');
    // Missing bedrooms → clarification, OR results if we skip — expect bedrooms ask
    assert(
      r.quick_actions?.options?.some((o) => o.value === '2') ||
        r.property_results ||
        r.context?.pendingClarification === 'budget',
      'bedrooms ask or results or budget'
    );
    assert(r.context?.listingType === 'buy', 'listing buy');
    assert(r.context?.filters?.propertyType === 'Villa', 'Villa ctx');
  });

  // 10 Off-plan apartments Dubai
  await run('Show me off plan apartments in Dubai → filters', async () => {
    const q = extractPropertySearchQuery(
      'Show me off plan apartments in Dubai'
    );
    assert(q.listingType === 'off-plan', 'off-plan');
    assert(q.filters.propertyType === 'Apartment', 'Apartment');
    assert(/dubai/i.test(q.search), 'Dubai');
  });

  // 11 Safe property_results fields
  await run('property_results contains only safe fields', async () => {
    const r = await handleChat(
      'I want to rent a 2 bedroom apartment in Dubai Marina'
    );
    assert(r.property_results, 'has results');
    for (const p of r.property_results.properties) {
      for (const key of Object.keys(p)) {
        assert(SAFE_CARD_KEYS.has(key), `unexpected key ${key}`);
      }
      for (const bad of FORBIDDEN_PROPERTY_FIELDS) {
        assert(!Object.prototype.hasOwnProperty.call(p, bad), `leaked ${bad}`);
      }
      if (p.url) {
        assert(
          p.url.startsWith('/properties/rent/in-dubai/') ||
            p.url.startsWith('/properties/buy/in-dubai/') ||
            p.url.startsWith('/off-plan-properties/in-dubai/'),
          `bad url ${p.url}`
        );
      }
    }
  });

  // 12 Property count regression
  await run('Property count regression', async () => {
    const messages = [
      'How many properties are available in Dubai Marina?',
      'How many apartments are available in Dubai Marina?',
      'How many 2 bedroom apartments are available in Dubai Marina?',
      'How many properties do you have?',
    ];
    for (const message of messages) {
      assert(classifyIntent(message) === 'PROPERTY_COUNT', `intent ${message}`);
      const r = await handleChat(message);
      assert(r.route === 'PROPERTY_COUNT', `route ${message}`);
      assert(r.openaiCalls === 0, 'openai');
      assert(!r.property_results, 'no cards');
      assert(/currently \d/i.test(r.reply) || /currently [\d,]+/i.test(r.reply), 'count reply');
    }
  });

  // 13 Service URL
  await run('Service URL structured action', async () => {
    // May use OpenAI for RAG text — skip if no key by checking env
    if (!process.env.OPENAI_API_KEY) {
      console.log('  (skip RAG portion — no OPENAI_API_KEY)');
      return;
    }
    const r = await handleChat('What services does Rocky Real Estate provide?');
    assert(r.route === 'SERVICE_INFO', `route=${r.route}`);
    assert(r.service_action?.type === 'service_action', 'service_action');
    assert(r.service_action.url === '/services', `url=${r.service_action.url}`);
    assert(!r.contact_action, 'no contact on general services');
  });

  // 14 Property Management contact action
  await run('Property Management contact action', async () => {
    if (!process.env.OPENAI_API_KEY) {
      console.log('  (skip — no OPENAI_API_KEY)');
      return;
    }
    const r = await handleChat('What does property management do?');
    assert(r.route === 'SERVICE_INFO', `route=${r.route}`);
    assert(
      r.service_action?.url === '/services/property-management',
      'service url'
    );
    assert(r.contact_action?.type === 'contact_action', 'contact_action');
    assert(
      r.contact_action.service === 'property-management',
      'contact service'
    );
  });

  // 15 SELL_PROPERTY
  await run('SELL_PROPERTY intent + quick actions', async () => {
    assert(
      classifyIntent('I want to sell my apartment.') === 'SELL_PROPERTY',
      'intent'
    );
    const r = await handleChat('I want to sell my apartment.');
    assert(r.route === 'SELL_PROPERTY', `route=${r.route}`);
    assert(r.openaiCalls === 0, 'openai');
    // Seeded type from "apartment" → may skip to location ask
    assert(
      r.quick_actions || /located/i.test(r.reply),
      'quick actions or location ask'
    );
    assert(r.context?.flow === 'sell_property', 'flow');
  });

  // 16 Confidential
  await run('Confidential agent phone', async () => {
    const r = await handleChat("Give me an agent's phone number");
    assert(r.route === 'CONFIDENTIAL', `route=${r.route}`);
    assert(r.openaiCalls === 0, 'openai');
    assert(!/05\d{8}/.test(r.reply), 'no phone');
    assert(!r.property_results, 'no results');
  });

  // 17 Multi-turn rent → bedrooms → results SSE-equivalent sequence via handleChat
  await run('Multi-turn Rent → 2 → property_results', async () => {
    const first = await handleChat('Show me apartments in Dubai Marina');
    const second = await handleChat('Rent', { context: first.context });
    assert(second.context?.listingType === 'rent', 'rent');
    assert(second.quick_actions || second.property_results, 'next step');

    if (second.context?.pendingClarification === 'bedrooms') {
      const third = await handleChat('2', { context: second.context });
      assert(third.property_results, 'results after bedrooms');
      assert(String(third.context?.filters?.bedrooms) === '2', 'beds=2');
      assert(third.context?.listingType === 'rent', 'still rent');
      assert(third.context?.filters?.propertyType === 'Apartment', 'Apartment');
    }
  });

  // 18 merge helpers
  await run('mergePropertySearchState preserves filters', async () => {
    const merged = mergePropertySearchState('Rent', {
      flow: 'property_search',
      filters: { propertyType: 'Apartment' },
      search: 'Dubai Marina',
      pendingClarification: 'listingType',
    });
    assert(merged.listingType === 'rent', 'rent');
    assert(merged.filters.propertyType === 'Apartment', 'type');
    assert(merged.search === 'Dubai Marina', 'search');
  });

  // 19 detectListingType cases
  await run('detectListingType coverage', async () => {
    assert(detectListingType('buy') === 'buy', 'buy');
    assert(detectListingType('rent') === 'rent', 'rent');
    assert(detectListingType('off-plan') === 'off-plan', 'off-plan');
    assert(detectListingType('off plan') === 'off-plan', 'off plan');
    assert(
      detectListingType('I want to rent a 2 bedroom apartment') === 'rent',
      'want rent'
    );
    assert(
      detectListingType('I want to buy a villa') === 'buy',
      'want buy'
    );
  });

  console.log('[ai-conversational-test] summary');
  console.log(
    JSON.stringify(
      {
        total: results.length,
        passed: results.length - failed,
        failed,
        mongoWrites: 0,
        results,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();

  if (failed > 0) {
    console.error('[ai-conversational-test] FAILED');
    process.exit(1);
  }
  console.log('[ai-conversational-test] PASSED');
};

main().catch(async (error) => {
  console.error('[ai-conversational-test] failed', error?.message || error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
