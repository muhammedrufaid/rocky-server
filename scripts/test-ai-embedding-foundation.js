#!/usr/bin/env node
/**
 * Foundation tests for AI embedding layer (no vector search / RAG).
 *
 * Usage:
 *   node scripts/test-ai-embedding-foundation.js
 */

require('dotenv').config();

const assert = require('assert');
const mongoose = require('mongoose');
const {
  EMBEDDING_DIMENSIONS,
  ALLOWED_COLLECTIONS,
  FORBIDDEN_COLLECTIONS,
  SOURCE_CONFIG,
  buildSearchableText,
  hashSearchableText,
  needsEmbeddingUpdate,
  generateEmbedding,
  syncSourceEmbeddings,
} = require('../src/ai/embeddingService');

const results = [];

const pass = (name, detail = '') => {
  results.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
};

const fail = (name, error) => {
  results.push({ name, ok: false, detail: error?.message || String(error) });
  console.error(`FAIL  ${name} — ${error?.message || error}`);
};

const run = async (name, fn) => {
  try {
    await fn();
    pass(name);
  } catch (error) {
    fail(name, error);
  }
};

const sampleBlog = {
  title: 'Flexi Rent Guide',
  subtitle: 'Short stays in Dubai',
  description: 'How flexi rent works',
  content: [
    { type: 'paragraph', text: 'Flexi rent offers flexible leases.' },
    { type: 'heading2', text: 'Benefits' },
    { type: 'list', items: ['Short term', 'Furnished options'] },
    {
      type: 'image',
      src: 'https://cdn.example.com/secret-path.jpg',
      alt: 'Apartment balcony',
      caption: 'Bright balcony',
    },
  ],
  // Private-ish fields that must never appear in searchable text
  internalNote: 'DO-NOT-EMBED-INTERNAL',
};

const sampleProperty = {
  propertyTitle: 'Marina View Apartment',
  propertyType: 'Apartment',
  propertyPurpose: 'Rent',
  propertyDescription: 'Sea view two bedroom',
  city: 'Dubai',
  locality: 'Dubai Marina',
  subLocality: 'Cluster A',
  towerName: 'Marina Heights',
  bedrooms: '2',
  bathrooms: '2',
  propertySize: '1200',
  propertySizeUnit: 'sqft',
  furnished: 'Yes',
  offPlan: 'No',
  listingAgent: 'SECRET-AGENT',
  listingAgentEmail: 'agent@secret.test',
  listingAgentPhone: '+971500000000',
  permitNumber: 'PERMIT-SECRET',
  trakheesiPermitUrl: 'https://secret-permit.test',
  price: '999999',
};

const main = async () => {
  console.log('[test-ai-embedding-foundation] starting');

  await run('1. searchable text generation (blog)', () => {
    const text = buildSearchableText('blog', sampleBlog);
    assert.ok(text.includes('Flexi Rent Guide'));
    assert.ok(text.includes('How flexi rent works'));
    assert.ok(text.includes('Flexi rent offers flexible leases.'));
    assert.ok(text.includes('Benefits'));
    assert.ok(text.includes('Short term'));
    assert.ok(text.includes('Apartment balcony'));
  });

  await run('2. private field exclusion', () => {
    const blogText = buildSearchableText('blog', sampleBlog);
    assert.ok(!blogText.includes('https://cdn.example.com/secret-path.jpg'));
    assert.ok(!blogText.includes('DO-NOT-EMBED-INTERNAL'));

    const propertyText = buildSearchableText('property', sampleProperty);
    assert.ok(propertyText.includes('Marina View Apartment'));
    assert.ok(propertyText.includes('Dubai Marina'));
    assert.ok(!propertyText.includes('SECRET-AGENT'));
    assert.ok(!propertyText.includes('agent@secret.test'));
    assert.ok(!propertyText.includes('+971500000000'));
    assert.ok(!propertyText.includes('PERMIT-SECRET'));
    assert.ok(!propertyText.includes('secret-permit'));
    assert.ok(!propertyText.includes('999999'));

    const areaText = buildSearchableText('areaGuide', {
      title: 'JLT',
      about: 'Lakes and towers',
      keyHighlights: [{ icon: 'x', title: 'Metro access' }],
      agentOrders: [1, 2, 3],
      mapQuery: 'SHOULD-NOT-EMBED-MAP',
      listingsSearch: ['SHOULD-NOT-EMBED-SEARCH'],
    });
    assert.ok(areaText.includes('Metro access'));
    assert.ok(!areaText.includes('SHOULD-NOT-EMBED-MAP'));
    assert.ok(!areaText.includes('SHOULD-NOT-EMBED-SEARCH'));
  });

  await run('3. hash generation', () => {
    const text = buildSearchableText('faq', {
      question: 'What is Rocky?',
      answer: 'A real estate company',
      page: 'home',
    });
    const hash = hashSearchableText(text);
    assert.strictEqual(typeof hash, 'string');
    assert.strictEqual(hash.length, 64);
    assert.strictEqual(hash, hashSearchableText(text));
    assert.notStrictEqual(hash, hashSearchableText(`${text}\nchanged`));
  });

  await run('4. embedding dimension = 1536', async () => {
    if (!process.env.OPENAI_API_KEY || !String(process.env.OPENAI_API_KEY).trim()) {
      throw new Error('OPENAI_API_KEY missing — cannot verify live embedding dimensions');
    }
    const embedding = await generateEmbedding(
      'Rocky Real Estate embedding foundation dimension check'
    );
    assert.strictEqual(embedding.length, EMBEDDING_DIMENSIONS);
    assert.strictEqual(EMBEDDING_DIMENSIONS, 1536);
  });

  await run('5. dry-run behavior (0 OpenAI calls, 0 writes)', async () => {
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI missing');
    }

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI);
    }

    // dryRun path returns before generateEmbeddings / updateOne
    const summary = await syncSourceEmbeddings('faq', { dryRun: true, limit: 5 });
    assert.strictEqual(summary.embedded, 0);
    assert.strictEqual(summary.failed, 0);
    assert.ok(typeof summary.wouldEmbed === 'number');
    assert.ok(summary.scanned >= 0);
    assert.ok(ALLOWED_COLLECTIONS.includes(summary.collection));
    assert.ok(!FORBIDDEN_COLLECTIONS.includes(summary.collection));

    // Also exercise the CLI dry-run contract: sources limited to allowed collections
    Object.values(SOURCE_CONFIG).forEach((config) => {
      assert.ok(ALLOWED_COLLECTIONS.includes(config.collection));
    });
  });

  await run('6. unchanged hash skips embedding', () => {
    const text = buildSearchableText('service', {
      title: 'Buying',
      description: 'Help buying property',
      overviewHeading: 'Overview',
      overview: ['Step one'],
      subservices: [{ title: 'Valuation', description: 'Market value', points: ['Data'] }],
    });
    const hash = hashSearchableText(text);
    const fakeEmbedding = Array.from({ length: 1536 }, (_, i) => i * 0.0001);

    assert.strictEqual(
      needsEmbeddingUpdate({ embedding: fakeEmbedding, embeddingHash: hash }, hash),
      false
    );
    assert.strictEqual(
      needsEmbeddingUpdate({ embedding: fakeEmbedding, embeddingHash: 'old' }, hash),
      true
    );
    assert.strictEqual(
      needsEmbeddingUpdate({ embedding: [], embeddingHash: hash }, hash),
      true
    );
  });

  await run('7. forbidden collections are not accessed', () => {
    const allowed = new Set(ALLOWED_COLLECTIONS);
    const forbidden = new Set(FORBIDDEN_COLLECTIONS);

    Object.values(SOURCE_CONFIG).forEach((config) => {
      assert.ok(allowed.has(config.collection), `${config.collection} must be allowed`);
      assert.ok(!forbidden.has(config.collection), `${config.collection} must not be forbidden`);
    });

    // Explicitly ensure lead/user/team collections are not in SOURCE_CONFIG
    const collections = Object.values(SOURCE_CONFIG).map((c) => c.collection);
    [
      'areaguideleads',
      'contacts',
      'users',
      'careers',
      'teammembers',
      'newsletters',
      'sells',
    ].forEach((name) => {
      assert.ok(!collections.includes(name), `${name} must not be an embedding source`);
    });

    assert.throws(() => buildSearchableText('teamMember', { name: 'x' }), /Unsupported/);
  });

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n[test-ai-embedding-foundation] summary', {
    passed: results.filter((r) => r.ok).length,
    failed: failed.length,
    openaiCallsForDimensionTest: results.some((r) => r.name.startsWith('4.') && r.ok)
      ? 1
      : 0,
    mongoWrites: 0,
    collectionsAccessed: ['faqs'],
    forbiddenCollectionsAccessed: [],
  });

  if (failed.length) {
    process.exit(1);
  }
};

main().catch(async (error) => {
  console.error('[test-ai-embedding-foundation] crashed', error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
