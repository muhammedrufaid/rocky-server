#!/usr/bin/env node
/**
 * STEP 14 — Conversion-first Rocky AI tests (handleChat).
 *
 * Usage:
 *   node scripts/test-ai-conversion.js
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { handleChat, GREETING_REPLY } = require('../src/ai/orchestrator/aiOrchestrator');
const { classifyIntent } = require('../src/ai/orchestrator/intentRouter');
const {
  extractPropertySearchQuery,
  FORBIDDEN_PROPERTY_FIELDS,
} = require('../src/ai/tools/propertyTools');
const { getRockyWhatsAppNumber } = require('../src/ai/tools/whatsappAction');

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
  console.log('[ai-conversion-test] starting');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not configured');
  await mongoose.connect(process.env.MONGO_URI);

  const results = [];
  let failed = 0;

  const run = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`[ai-conversion-test] PASS — ${name}`);
    } catch (error) {
      failed += 1;
      results.push({ name, ok: false, error: error?.message || String(error) });
      console.log(`[ai-conversion-test] FAIL — ${name}: ${error?.message || error}`);
    }
  };

  await run('Hi → GREETING + quick actions', async () => {
    assert(classifyIntent('Hi') === 'GREETING', 'intent');
    const r = await handleChat('Hi');
    assert(r.route === 'GREETING', `route=${r.route}`);
    assert(r.openaiCalls === 0, 'openai');
    assert(r.reply.includes("I'm Rocky AI"), 'reply');
    assert(r.quick_actions?.options?.length >= 4, 'actions');
    assert(
      r.quick_actions.options.some((o) => /buy/i.test(o.label)),
      'buy action'
    );
  });

  await run('Hello → GREETING', async () => {
    const r = await handleChat('Hello');
    assert(r.route === 'GREETING', 'route');
    assert(r.quick_actions, 'quick_actions');
  });

  await run('Buy a property → property type ask', async () => {
    const r = await handleChat('Buy a Property');
    assert(r.route === 'PROPERTY_SEARCH', `route=${r.route}`);
    assert(r.context?.listingType === 'buy', 'listing buy');
    assert(r.context?.pendingClarification === 'propertyType', 'ask type');
    assert(r.quick_actions?.options?.some((o) => o.value === 'Apartment'), 'apt');
    assert(r.openaiCalls === 0, 'openai');
  });

  await run('Rent a property → property type ask', async () => {
    const r = await handleChat('Rent a Property');
    assert(r.context?.listingType === 'rent', 'rent');
    assert(r.context?.pendingClarification === 'propertyType', 'type');
  });

  await run('Off-plan → property type ask', async () => {
    const r = await handleChat('Off-Plan Properties');
    assert(r.context?.listingType === 'off-plan', 'off-plan');
    assert(r.context?.pendingClarification === 'propertyType', 'type');
  });

  await run('Sell my property → sell flow', async () => {
    assert(classifyIntent('Sell My Property') === 'SELL_PROPERTY', 'intent');
    const r = await handleChat('Sell My Property');
    assert(r.route === 'SELL_PROPERTY', `route=${r.route}`);
    assert(r.quick_actions || /located/i.test(r.reply), 'next step');
  });

  await run('Property management → service + contact', async () => {
    if (!process.env.OPENAI_API_KEY) return;
    const r = await handleChat('Property Management');
    assert(r.route === 'SERVICE_INFO', `route=${r.route}`);
    assert(
      r.service_action?.url === '/services/property-management',
      'service url'
    );
    assert(r.contact_action?.service === 'property-management', 'contact');
    assert(r.whatsapp_action?.type === 'whatsapp_action', 'whatsapp');
    assert(
      String(r.whatsapp_action.url).includes(getRockyWhatsAppNumber()),
      'official wa'
    );
  });

  let buyCtx = null;
  await run('Buy → Apartment → location ask', async () => {
    const first = await handleChat('Buy a Property');
    const second = await handleChat('Apartment', { context: first.context });
    assert(second.context?.filters?.propertyType === 'Apartment', 'type');
    assert(second.context?.listingType === 'buy', 'buy');
    assert(second.context?.pendingClarification === 'location', 'location');
    buyCtx = second.context;
  });

  await run('Guided: Dubai Marina → search immediately (no beds/budget gate)', async () => {
    const r = await handleChat('Dubai Marina', { context: buyCtx });
    assert(/dubai marina/i.test(r.context?.search || ''), 'search');
    assert(r.context?.pendingClarification !== 'budget', 'no budget gate');
    assert(r.context?.pendingClarification !== 'bedrooms', 'no beds');
    assert(
      r.property_results ||
        r.quick_actions?.options?.some((o) =>
          /similar|closest|change|budget|bedroom/i.test(o.label)
        ),
      'results or refine/recovery'
    );
    buyCtx = r.context;
  });

  await run('After results: no Talk to an Agent', async () => {
    const r = await handleChat(
      'I want to rent a 2 bedroom apartment in Dubai Marina under AED 200000'
    );
    let working = r;
    if (r.context?.pendingClarification === 'budget') {
      working = await handleChat('Flexible', { context: r.context });
    }
    if (working.property_results) {
      assert(
        !(working.quick_actions?.options || []).some((o) =>
          /talk to an agent/i.test(o.label)
        ),
        'no agent CTA on results'
      );
    }
  });

  await run('Full NL buy query searches immediately', async () => {
    const q = extractPropertySearchQuery(
      'I want to buy a 2 bedroom apartment in Dubai Marina under AED 2M'
    );
    assert(q.listingType === 'buy', 'buy');
    assert(q.filters.propertyType === 'Apartment', 'apt');
    assert(String(q.filters.bedrooms) === '2', 'beds');
    assert(/dubai marina/i.test(q.search), 'marina');
    assert(q.filters.priceMax === 2000000, `budget=${q.filters.priceMax}`);

    const r = await handleChat(
      'I want to buy a 2 bedroom apartment in Dubai Marina under AED 2M'
    );
    assert(r.route === 'PROPERTY_SEARCH', 'route');
    assert(r.context?.filters?.priceMax === 2000000, 'budget applied');
    assert(r.context?.pendingClarification !== 'budget', 'no budget gate');
    assert(
      r.property_results ||
        r.quick_actions?.options?.some((o) =>
          /similar|closest|change/i.test(o.label)
        ),
      'results or recovery'
    );
    assert(!r.context?.pendingClarification, 'no pending');
  });

  await run('2 bed apartment Dubai South off-plan path', async () => {
    const r = await handleChat(
      'Show me 2 bedroom off plan apartments in Dubai South'
    );
    assert(r.context?.listingType === 'off-plan', 'off-plan');
    assert(r.property_results || r.context?.filters?.bedrooms === '2', 'progress');
  });

  await run('property_results safe fields + View Property CTA', async () => {
    const r = await handleChat(
      'I want to rent a 2 bedroom apartment in Dubai Marina'
    );
    assert(r.property_results, 'results');
    for (const p of r.property_results.properties) {
      for (const key of Object.keys(p)) {
        assert(SAFE_CARD_KEYS.has(key), `unexpected ${key}`);
      }
      for (const bad of FORBIDDEN_PROPERTY_FIELDS) {
        assert(!Object.prototype.hasOwnProperty.call(p, bad), `leaked ${bad}`);
      }
      assert(p.ctaLabel === 'View Property', 'cta');
    }
  });

  await run('I like the second property → conversion', async () => {
    const search = await handleChat(
      'I want to rent a 2 bedroom apartment in Dubai Marina'
    );
    assert(search.context?.recentProperties?.length >= 1, 'recent');
    const r = await handleChat('I like the second property', {
      context: search.context,
    });
    assert(r.route === 'CONVERSION' || r.contact_action, 'conversion');
    assert(r.quick_actions || r.whatsapp_action, 'next actions');
    assert(r.context?.selectedProperty || r.contact_action, 'selected/contact');
  });

  await run('Can I view this property? → viewing CTA', async () => {
    const search = await handleChat(
      'I want to rent a 2 bedroom apartment in Dubai Marina'
    );
    const r = await handleChat('Can I view this property?', {
      context: search.context,
    });
    assert(r.contact_action || r.whatsapp_action, 'cta');
    assert(r.openaiCalls === 0, 'openai');
  });

  await run('Talk to an agent', async () => {
    const r = await handleChat('Talk to an Agent');
    assert(r.route === 'CONVERSION', `route=${r.route}`);
    assert(r.contact_action?.service === 'agent', 'agent');
  });

  await run('WhatsApp Rocky uses official number', async () => {
    const r = await handleChat('WhatsApp Rocky');
    assert(r.whatsapp_action?.url, 'url');
    assert(
      r.whatsapp_action.url.includes(`wa.me/${getRockyWhatsAppNumber()}`),
      'official'
    );
    assert(!/agentPhone|listingAgentPhone/i.test(JSON.stringify(r)), 'no private');
  });

  await run('Flexi Rent → knowledge + next actions', async () => {
    if (!process.env.OPENAI_API_KEY) return;
    assert(classifyIntent('What is Flexi Rent?') === 'BLOG', 'intent');
    const r = await handleChat('What is Flexi Rent?');
    assert(r.route === 'BLOG', `route=${r.route}`);
    assert(r.quick_actions, 'next actions');
  });

  await run('Best areas in Dubai → area guide + actions', async () => {
    if (!process.env.OPENAI_API_KEY) return;
    const r = await handleChat('What are the best areas in Dubai?');
    assert(r.route === 'AREA_GUIDE', `route=${r.route}`);
    assert(r.quick_actions?.options?.some((o) => /area|propert|agent/i.test(o.label)), 'actions');
  });

  await run('Confidential agent phone', async () => {
    const r = await handleChat("Give me an agent's phone number");
    assert(r.route === 'CONFIDENTIAL', 'route');
    assert(!r.whatsapp_action, 'no wa on confidential');
  });

  await run('Unsupported still has next actions', async () => {
    const r = await handleChat('What is the weather on Mars today?');
    assert(r.route === 'UNSUPPORTED', 'route');
    assert(r.quick_actions, 'still offer actions');
  });

  await run('Greeting reply constant matches conversion copy', async () => {
    assert(/Rocky AI/i.test(GREETING_REPLY), 'constant');
  });

  console.log('[ai-conversion-test] summary');
  console.log(
    JSON.stringify(
      {
        total: results.length,
        passed: results.length - failed,
        failed,
        whatsappNumber: getRockyWhatsAppNumber(),
        results,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
  if (failed > 0) {
    console.error('[ai-conversion-test] FAILED');
    process.exit(1);
  }
  console.log('[ai-conversion-test] PASSED');
};

main().catch(async (error) => {
  console.error('[ai-conversion-test] failed', error?.message || error);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
