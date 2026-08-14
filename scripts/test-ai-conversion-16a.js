#!/usr/bin/env node
/**
 * STEP 16A — Property-specific Talk to an Agent (listingAgentPhone).
 *
 * Usage:
 *   node scripts/test-ai-conversion-16a.js
 */

require('dotenv').config();

const mongoose = require('mongoose');
const Property = require('../src/models/Property');
const { handleChat } = require('../src/ai/orchestrator/aiOrchestrator');
const {
  FORBIDDEN_PROPERTY_FIELDS,
  sanitizeListingAgentPhone,
  fetchListingAgentForSelectedProperty,
} = require('../src/ai/tools/propertyTools');
const { getRockyWhatsAppNumber } = require('../src/ai/tools/whatsappAction');

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const jsonHasAgentPhone = (obj) =>
  /listingAgentPhone|listingAgentEmail/i.test(JSON.stringify(obj || {}));

const main = async () => {
  console.log('[ai-conversion-16a] starting');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not configured');
  await mongoose.connect(process.env.MONGO_URI);

  let failed = 0;
  const results = [];
  const run = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`[ai-conversion-16a] PASS — ${name}`);
    } catch (error) {
      failed += 1;
      results.push({ name, ok: false, error: error?.message || String(error) });
      console.log(`[ai-conversion-16a] FAIL — ${name}: ${error?.message || error}`);
    }
  };

  // Prefer live listings that have agent phones for end-to-end checks
  const withPhone = await Property.find({
    listingAgentPhone: { $exists: true, $nin: [null, ''] },
    propertyRefNo: { $exists: true, $nin: [null, ''] },
    propertyTitle: { $exists: true, $nin: [null, ''] },
  })
    .select('propertyRefNo propertyTitle listingAgent listingAgentPhone locality towerName price')
    .limit(5)
    .lean();

  const agentsWithPhone = withPhone
    .map((d) => ({
      id: d.propertyRefNo,
      title: d.propertyTitle,
      listingAgent: d.listingAgent,
      phone: sanitizeListingAgentPhone(d.listingAgentPhone),
      locality: d.locality,
      building: d.towerName,
      price: d.price,
    }))
    .filter((d) => d.id && d.phone);

  const propA = agentsWithPhone[0] || null;
  const propB =
    agentsWithPhone.find((p) => p.id !== propA?.id && p.phone !== propA?.phone) ||
    agentsWithPhone[1] ||
    null;

  await run('sanitizeListingAgentPhone normalizes UAE local', async () => {
    assert(sanitizeListingAgentPhone('0551352390') === '971551352390', 'local');
    assert(sanitizeListingAgentPhone('+971 55 135 2390') === '971551352390', 'intl');
    assert(sanitizeListingAgentPhone('not-a-phone') === null, 'invalid');
    assert(sanitizeListingAgentPhone('') === null, 'empty');
  });

  await run('Search property → no agent phone exposed', async () => {
    const r = await handleChat('Buy an apartment in Dubai Marina');
    assert(!jsonHasAgentPhone(r.property_results), 'no phone in results');
    assert(!jsonHasAgentPhone(r.context?.recentProperties), 'no phone in recent');
    if (r.property_results?.properties?.length) {
      for (const p of r.property_results.properties) {
        for (const bad of ['listingAgent', 'listingAgentPhone', 'listingAgentEmail', 'image'].filter(
          (k) => k !== 'image'
        )) {
          assert(!Object.prototype.hasOwnProperty.call(p, bad), `card no ${bad}`);
        }
        // images allowed on cards — phone not
        assert(p.listingAgentPhone === undefined, 'no phone field');
      }
    }
  });

  let selectedCtx = null;
  await run('Select property → no agent phone yet', async () => {
    const search = await handleChat(
      'I want to rent a 2 bedroom apartment in Dubai Marina under AED 300000'
    );
    let working = search;
    if (!working.property_results?.properties?.length) {
      working = await handleChat('Show Closest Options', { context: search.context });
    }
    if (!working.property_results?.properties?.length) {
      // Fall back to synthetic selected context from a known DB listing
      if (!propA) {
        console.log('  (skip — no results and no agent phones in DB)');
        return;
      }
      selectedCtx = {
        flow: 'property_search',
        intent: 'CONVERSION',
        funnelStage: 'PROPERTY_SELECTED',
        listingType: 'buy',
        selectedProperty: {
          id: propA.id,
          title: propA.title,
          locality: propA.locality,
          building: propA.building,
          price: propA.price,
          listingType: 'buy',
          url: `https://example.com/${propA.id}`,
        },
        recentProperties: [
          {
            id: propA.id,
            title: propA.title,
            locality: propA.locality,
            listingType: 'buy',
            url: `https://example.com/${propA.id}`,
            index: 0,
          },
        ],
      };
      const pick = await handleChat("I'm Interested", { context: selectedCtx });
      assert(pick.context?.selectedProperty, 'selected');
      assert(!jsonHasAgentPhone(pick), 'no phone on interested');
      assert(!pick.contact_action?.property?.listingAgentPhone, 'no phone in contact');
      selectedCtx = pick.context;
      return;
    }

    const pick = await handleChat("I'm Interested", { context: working.context });
    assert(pick.context?.selectedProperty, 'selected');
    assert(pick.context?.funnelStage === 'PROPERTY_SELECTED', 'stage');
    assert(!jsonHasAgentPhone(pick.context?.selectedProperty), 'no phone on selected');
    assert(!pick.contact_action?.property?.listingAgentPhone, 'no phone yet');
    selectedCtx = pick.context;
  });

  await run('Talk to an Agent → listingAgent + phone from selected property', async () => {
    if (!selectedCtx?.selectedProperty?.id) {
      console.log('  (skip — no selected property)');
      return;
    }
    const r = await handleChat('Talk to an Agent', { context: selectedCtx });
    assert(r.contact_action?.service === 'property_agent', 'service');
    assert(r.contact_action.property, 'property');
    assert(!r.contact_action.property.image, 'no image');
    assert(!r.contact_action.property.listingAgentEmail, 'no email');
    assert(!r.whatsapp_action, 'no whatsapp action');
    assert(
      !r.quick_actions?.options?.some((o) => /schedule a viewing|whatsapp rocky/i.test(o.label)),
      'no viewing/wa as selected actions'
    );

    const expected = await fetchListingAgentForSelectedProperty(
      selectedCtx.selectedProperty
    );
    if (expected.listingAgentPhone) {
      assert(
        r.contact_action.property.listingAgentPhone === expected.listingAgentPhone,
        'phone matches DB listing'
      );
      assert(/connect you directly with the agent/i.test(r.reply), 'direct agent reply');
    } else {
      assert(
        r.contact_action.property.listingAgentPhone === undefined,
        'omit missing phone'
      );
      assert(/team about this property|follow up/i.test(r.reply), 'fallback reply');
    }
    if (expected.listingAgent) {
      assert(
        r.contact_action.property.listingAgent === expected.listingAgent,
        'agent name'
      );
    }

    const stillForbidden = FORBIDDEN_PROPERTY_FIELDS.filter(
      (k) => k !== 'listingAgent' && k !== 'listingAgentPhone'
    );
    for (const bad of stillForbidden) {
      assert(
        !Object.prototype.hasOwnProperty.call(r.contact_action.property, bad),
        `no ${bad}`
      );
    }
  });

  await run('Schedule a Viewing does not expose agent phone', async () => {
    if (!selectedCtx?.selectedProperty) {
      console.log('  (skip)');
      return;
    }
    const r = await handleChat('Schedule a Viewing', { context: selectedCtx });
    assert(r.context?.selectedProperty, 'selected preserved');
    assert(r.contact_action?.service === 'viewing', 'viewing');
    assert(!r.contact_action?.property?.listingAgentPhone, 'no phone');
    assert(!r.contact_action?.property?.listingAgent, 'no agent name on viewing');
    assert(!jsonHasAgentPhone(r.contact_action), 'no agent fields');
  });

  await run('WhatsApp Rocky does not use listingAgentPhone', async () => {
    if (!selectedCtx?.selectedProperty) {
      console.log('  (skip)');
      return;
    }
    const r = await handleChat('WhatsApp Rocky', { context: selectedCtx });
    assert(r.whatsapp_action?.url, 'wa url');
    assert(
      r.whatsapp_action.url.includes(`wa.me/${getRockyWhatsAppNumber()}`),
      'official rocky number'
    );
    assert(!r.contact_action?.property?.listingAgentPhone, 'no listing phone');
    if (propA?.phone) {
      assert(!r.whatsapp_action.url.includes(propA.phone), 'not agent phone');
    }
  });

  await run('Different selected properties return their own listingAgentPhone', async () => {
    if (!propA || !propB) {
      console.log('  (skip — need two listings with agent phones)');
      return;
    }
    const ctxA = {
      flow: 'property_search',
      funnelStage: 'PROPERTY_SELECTED',
      selectedProperty: {
        id: propA.id,
        title: propA.title,
        locality: propA.locality,
        listingType: 'buy',
        url: `https://example.com/${propA.id}`,
      },
    };
    const ctxB = {
      flow: 'property_search',
      funnelStage: 'PROPERTY_SELECTED',
      selectedProperty: {
        id: propB.id,
        title: propB.title,
        locality: propB.locality,
        listingType: 'buy',
        url: `https://example.com/${propB.id}`,
      },
    };
    const a = await handleChat('Talk to an Agent', { context: ctxA });
    const b = await handleChat('Talk to an Agent', { context: ctxB });
    assert(a.contact_action.property.listingAgentPhone === propA.phone, 'phone A');
    assert(b.contact_action.property.listingAgentPhone === propB.phone, 'phone B');
    if (propA.phone !== propB.phone) {
      assert(
        a.contact_action.property.listingAgentPhone !==
          b.contact_action.property.listingAgentPhone,
        'distinct phones'
      );
    }
  });

  await run('Missing listingAgentPhone → safe fallback', async () => {
    // Use a selected id that will not resolve to a phone (bogus ref)
    const ctx = {
      flow: 'property_search',
      funnelStage: 'PROPERTY_SELECTED',
      selectedProperty: {
        id: 'RO-DOES-NOT-EXIST-16A',
        title: 'Test Property',
        locality: 'Dubai Marina',
        listingType: 'buy',
        url: 'https://example.com/missing',
      },
    };
    const r = await handleChat('Talk to an Agent', { context: ctx });
    assert(r.contact_action?.service === 'property_agent', 'service');
    assert(r.contact_action.property?.title === 'Test Property', 'title');
    assert(r.contact_action.property.listingAgentPhone === undefined, 'no phone');
    assert(!r.whatsapp_action, 'no wa');
    assert(typeof r.reply === 'string' && r.reply.length > 0, 'fallback reply');
  });

  await run('Client-injected phone is ignored', async () => {
    if (!propA) {
      console.log('  (skip)');
      return;
    }
    const ctx = {
      flow: 'property_search',
      funnelStage: 'PROPERTY_SELECTED',
      selectedProperty: {
        id: propA.id,
        title: propA.title,
        locality: propA.locality,
        listingType: 'buy',
        url: `https://example.com/${propA.id}`,
        listingAgentPhone: '999999999999',
        listingAgent: 'Fake Agent',
      },
    };
    const r = await handleChat('Talk to an Agent', { context: ctx });
    assert(
      r.contact_action.property.listingAgentPhone === propA.phone,
      'uses DB phone not client'
    );
    assert(r.contact_action.property.listingAgentPhone !== '999999999999', 'ignore inject');
  });

  await run('Confidential agent phone request still refused', async () => {
    const r = await handleChat("Give me an agent's phone number");
    assert(r.route === 'CONFIDENTIAL', 'route');
    assert(!r.contact_action, 'no contact');
  });

  console.log('[ai-conversion-16a] summary');
  console.log(JSON.stringify({ total: results.length, failed, results }, null, 2));
  await mongoose.disconnect();
  if (failed) process.exit(1);
  console.log('[ai-conversion-16a] PASSED');
};

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
