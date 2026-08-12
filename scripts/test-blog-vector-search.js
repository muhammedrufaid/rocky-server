/**
 * Step 5 test: MongoDB Atlas Vector Search over blog_embeddings.
 *
 * Usage:
 *   node scripts/test-blog-vector-search.js
 *
 * Flow:
 *   query → text-embedding-3-small → $vectorSearch → top chunks
 *
 * Does NOT call gpt-5-nano.
 * Does NOT write to MongoDB.
 * Does NOT implement RAG answers.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const {
  searchBlogChunks,
  getSearchConfig,
  VECTOR_INDEX_NAME,
} = require('../src/services/blogVectorSearchService');

const QUERIES = [
  {
    id: 'TEST 1',
    query: 'What are the payment options for Flexi Rent?',
    expectSlugIncludes: 'flexi-rent',
  },
  {
    id: 'TEST 2',
    query: 'How does Flexi Rent work?',
    expectSlugIncludes: 'flexi-rent',
    expectHeadingIncludes: 'how does',
  },
  {
    id: 'TEST 3',
    query: 'What exemptions are available under Flexi Rent?',
    expectSlugIncludes: 'flexi-rent',
    expectHeadingIncludes: 'exemption',
  },
  {
    id: 'TEST 4',
    query: 'Can foreigners buy property in Dubai?',
    // Either the dedicated foreigner guide or the freehold guide's
    // "ownership for foreigners" section is a strong semantic hit.
    expectAnySlugIncludes: ['foreigner', 'freehold-vs-leasehold'],
    expectTop3ContentIncludes: 'foreign',
  },
  {
    id: 'TEST 5',
    query: 'What is the difference between freehold and leasehold?',
    expectSlugIncludes: 'freehold-vs-leasehold',
  },
];

const preview = (text, max = 220) => {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}…`;
};

const evaluate = (test, results) => {
  const top = results[0];
  if (!top) {
    return { pass: false, reason: 'No results returned' };
  }

  if (test.expectAnySlugIncludes) {
    const top3 = results.slice(0, 3);
    const slugHit = top3.some((r) =>
      test.expectAnySlugIncludes.some((needle) =>
        String(r.slug || '')
          .toLowerCase()
          .includes(String(needle).toLowerCase())
      )
    );
    const contentHit =
      !test.expectTop3ContentIncludes ||
      top3.some((r) =>
        `${r.headingContext || ''} ${r.content || ''}`
          .toLowerCase()
          .includes(String(test.expectTop3ContentIncludes).toLowerCase())
      );

    return {
      pass: slugHit && contentHit,
      reason:
        slugHit && contentHit
          ? `Relevant foreigner/property content in top 3 (rank1=${top.slug})`
          : 'Expected foreigner/property content not found in top 3',
    };
  }

  const slugOk =
    !test.expectSlugIncludes ||
    String(top.slug || '').toLowerCase().includes(test.expectSlugIncludes.toLowerCase());

  // For heading-specific tests, require expected slug in top 3 and heading signal in top 3
  if (test.expectHeadingIncludes) {
    const top3HasSlug = results
      .slice(0, 3)
      .some((r) =>
        String(r.slug || '')
          .toLowerCase()
          .includes(test.expectSlugIncludes.toLowerCase())
      );
    const top3HasHeading = results.slice(0, 3).some((r) => {
      const text = `${r.headingContext || ''} ${r.content || ''}`.toLowerCase();
      return text.includes(test.expectHeadingIncludes.toLowerCase());
    });
    return {
      pass: top3HasSlug && top3HasHeading,
      reason:
        top3HasSlug && top3HasHeading
          ? 'Expected Flexi Rent section ranked in top 3'
          : 'Expected heading/slug not found in top 3',
    };
  }

  return {
    pass: slugOk,
    reason: slugOk
      ? 'Expected blog ranked #1'
      : `Expected slug containing "${test.expectSlugIncludes}", got "${top.slug}"`,
  };
};

(async () => {
  const config = getSearchConfig();
  console.log('=== Step 5: Blog vector search tests ===');
  console.log('Index:', VECTOR_INDEX_NAME);
  console.log('Config:', config);
  console.log('GPT called: NO');
  console.log('RAG answer generation: NO');
  console.log('Collection: blog_embeddings ONLY\n');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected (read-only for documents)\n');

  // Verify index readiness
  const indexes = await mongoose.connection.db
    .collection('blog_embeddings')
    .listSearchIndexes(VECTOR_INDEX_NAME)
    .toArray();
  const index = indexes[0];
  console.log('Index status:', {
    name: index?.name,
    type: index?.type,
    status: index?.status,
    queryable: index?.queryable,
    definition: index?.latestDefinition || index?.definition,
  });

  if (!index || index.queryable !== true) {
    throw new Error('blog_vector_index is not queryable yet');
  }

  const outcomes = [];

  for (const test of QUERIES) {
    console.log('\n========================================');
    console.log(`${test.id}`);
    console.log(`Query: ${test.query}`);
    console.log('========================================');

    const result = await searchBlogChunks(test.query);
    const evaluation = evaluate(test, result.results);
    outcomes.push({ id: test.id, ...evaluation, timings: result.timings });

    result.results.forEach((hit, i) => {
      console.log(`\nRank ${i + 1}:`);
      console.log(`Title: ${hit.title}`);
      console.log(`Slug: ${hit.slug}`);
      console.log(`Heading: ${hit.headingContext || '(none)'}`);
      console.log(`Score: ${hit.score}`);
      console.log(`Content preview: ${preview(hit.content)}`);
    });

    console.log('\nTimings (ms):', result.timings);
    console.log('Evaluation:', evaluation.pass ? 'PASS' : 'FAIL', '-', evaluation.reason);
  }

  console.log('\n=== Summary ===');
  for (const outcome of outcomes) {
    console.log(
      `${outcome.id}: ${outcome.pass ? 'PASS' : 'FAIL'} | embed=${outcome.timings.embeddingMs}ms search=${outcome.timings.vectorSearchMs}ms total=${outcome.timings.totalMs}ms`
    );
  }

  const allPass = outcomes.every((o) => o.pass);
  console.log('\nOverall retrieval quality:', allPass ? 'PASS' : 'FAIL');
  console.log('GPT called: NO');
  console.log('RAG implemented: NO');
  console.log('Confidential collections accessed: NO');

  await mongoose.disconnect();
  process.exit(allPass ? 0 : 1);
})().catch(async (error) => {
  console.error('\nVector search test FAILED:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
