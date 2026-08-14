#!/usr/bin/env node
/**
 * STEP 15A — Result-count conversion search (no mandatory budget gate).
 *
 * Usage:
 *   node scripts/test-ai-conversion-15a.js
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { handleChat } = require('../src/ai/orchestrator/aiOrchestrator');
const { classifyIntent } = require('../src/ai/orchestrator/intentRouter');
const { FORBIDDEN_PROPERTY_FIELDS } = require('../src/ai/tools/propertyTools');

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const main = async () => {
  console.log('[ai-conversion-15a] starting');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not configured');
  await mongoose.connect(process.env.MONGO_URI);

  let failed = 0;
  const results = [];
  const run = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`[ai-conversion-15a] PASS — ${name}`);
    } catch (error) {
      failed += 1;
      results.push({ name, ok: false, error: error?.message || String(error) });
      console.log(`[ai-conversion-15a] FAIL — ${name}: ${error?.message || error}`);
    }
  };

  await run('Hi → GREETING', async () => {
    const r = await handleChat('Hi');
    assert(r.route === 'GREETING', 'route');
    assert(r.openaiCalls === 0, 'openai');
    assert(r.quick_actions, 'actions');
  });

  await run('Buy a property → type ask', async () => {
    const r = await handleChat('Buy a property');
    assert(r.context?.pendingClarification === 'propertyType', 'type');
  });

  await run('Buy an apartment → location ask', async () => {
    const r = await handleChat('Buy an apartment');
    assert(r.context?.listingType === 'buy', 'buy');
    assert(r.context?.filters?.propertyType === 'Apartment', 'apt');
    assert(r.context?.pendingClarification === 'location', 'location');
  });

  await run('Buy apartment Dubai Marina → search immediately (no budget gate)', async () => {
    const r = await handleChat('Buy an apartment in Dubai Marina');
    assert(r.context?.pendingClarification !== 'budget', 'no budget gate');
    assert(
      r.property_results ||
        r.quick_actions?.options?.some((o) => /similar|closest|change/i.test(o.label)),
      'results or recovery'
    );
    if (r.property_results) {
      assert(
        !(r.quick_actions?.options || []).some((o) => /talk to an agent/i.test(o.label)),
        'no agent on search'
      );
    }
  });

  let marinaCtx = null;
  await run('1–3 or many results: selection/refine actions', async () => {
    const r = await handleChat('Buy an apartment in Dubai Marina');
    marinaCtx = r.context;
    if (r.property_results) {
      const total = r.property_results.total;
      const labels = (r.quick_actions?.options || []).map((o) => o.label);
      if (total > 0 && total <= 3) {
        assert(labels.some((l) => /interested/i.test(l)), 'interested');
        assert(labels.some((l) => /view property/i.test(l)), 'view');
      } else if (total > 3) {
        assert(labels.some((l) => /budget/i.test(l)), 'budget refine');
        assert(labels.some((l) => /bedroom/i.test(l)), 'beds refine');
      }
    }
  });

  await run('Budget refine → zero preserves previous recentProperties', async () => {
    // Get a successful search first
    let search = await handleChat('Buy an apartment in Dubai Marina');
    if (!search.property_results?.properties?.length) {
      console.log('  (skip — no marina buy apartments in inventory)');
      return;
    }
    const prior = search.context.recentProperties;
    // Ask budget then apply a very low max
    const ask = await handleChat('Budget', { context: search.context });
    assert(ask.context?.pendingClarification === 'budget', 'budget pending');
    const zero = await handleChat('Under AED 1', { context: ask.context });
    // Either recovery with prior preserved, or unexpected hits
    if (!zero.property_results?.properties?.length) {
      assert(
        (zero.context?.recentProperties || []).length > 0 ||
          (zero.context?.previousRecentProperties || []).length > 0,
        'prior preserved'
      );
      assert(
        zero.quick_actions?.options?.some((o) => /closest|similar|change/i.test(o.label)),
        'recovery actions'
      );
      assert(Array.isArray(prior) && prior.length > 0, 'had prior');
    }
  });

  await run('Select second property → PROPERTY_SELECTED', async () => {
    const search = await handleChat(
      'I want to rent a 2 bedroom apartment in Dubai Marina under AED 300000'
    );
    let working = search;
    if (!working.property_results?.properties?.length) {
      working = await handleChat('Show Closest Options', { context: search.context });
    }
    if (!working.property_results?.properties?.length) {
      console.log('  (skip — no rent results)');
      return;
    }
    const pick = await handleChat("I'm interested in the second one", {
      context: working.context,
    });
    assert(pick.context?.selectedProperty, 'selected');
    assert(pick.context?.funnelStage === 'PROPERTY_SELECTED', 'stage');
    assert(
      pick.quick_actions?.options?.some((o) => /talk to an agent/i.test(o.label)),
      'agent after select'
    );
    marinaCtx = pick.context;
  });

  await run('Talk to Agent after selection → contact_action.property', async () => {
    if (!marinaCtx?.selectedProperty) {
      console.log('  (skip — no selected property)');
      return;
    }
    const r = await handleChat('Talk to an Agent', { context: marinaCtx });
    assert(r.contact_action, 'contact');
    assert(r.contact_action.service === 'property_agent', 'property_agent');
    assert(r.contact_action.property?.url || r.contact_action.property?.title, 'property');
    assert(!r.contact_action.property?.image, 'no image');
    assert(!r.contact_action.property?.listingAgentEmail, 'no email');
    assert(!r.whatsapp_action, 'no whatsapp on agent turn');
    const stillForbidden = FORBIDDEN_PROPERTY_FIELDS.filter(
      (k) => k !== 'listingAgent' && k !== 'listingAgentPhone'
    );
    for (const bad of stillForbidden) {
      assert(
        !Object.prototype.hasOwnProperty.call(r.contact_action.property || {}, bad),
        `no ${bad}`
      );
    }
  });

  await run('Schedule Viewing preserves selectedProperty', async () => {
    if (!marinaCtx?.selectedProperty) return;
    const r = await handleChat('Schedule a Viewing', { context: marinaCtx });
    assert(r.context?.selectedProperty, 'selected');
  });

  await run('WhatsApp after selection', async () => {
    if (!marinaCtx?.selectedProperty) return;
    const r = await handleChat('WhatsApp Rocky', { context: marinaCtx });
    assert(r.whatsapp_action?.url, 'wa');
  });

  await run('Service question short', async () => {
    const r = await handleChat('What is property management?');
    assert(r.openaiCalls === 0, 'no rag');
    assert(r.reply.length < 400, 'short');
  });

  await run('Confidential still refused', async () => {
    const r = await handleChat("Give me an agent's phone number");
    assert(r.route === 'CONFIDENTIAL', 'route');
  });

  await run('Property count still works', async () => {
    assert(classifyIntent('How many properties do you have?') === 'PROPERTY_COUNT');
    const r = await handleChat('How many properties do you have?');
    assert(r.route === 'PROPERTY_COUNT', 'route');
  });

  console.log('[ai-conversion-15a] summary');
  console.log(JSON.stringify({ total: results.length, failed, results }, null, 2));
  await mongoose.disconnect();
  if (failed) process.exit(1);
  console.log('[ai-conversion-15a] PASSED');
};

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
