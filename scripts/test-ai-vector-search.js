#!/usr/bin/env node
/**
 * Read-only Atlas Vector Search smoke test for ai_knowledge.
 *
 * Usage:
 *   node scripts/test-ai-vector-search.js
 *
 * - 1 OpenAI embedding call (query only)
 * - 0 MongoDB writes
 * - Does not create/modify indexes or source collections
 */

require('dotenv').config();

const mongoose = require('mongoose');
const AiKnowledge = require('../src/models/AiKnowledge');
const {
  generateEmbedding,
  EMBEDDING_DIMENSIONS,
} = require('../src/ai/embeddingService');

const VECTOR_INDEX_NAME = 'ai_knowledge_vector_index';
const QUERY = 'What are the best areas to live in Dubai?';
const LIMIT = 5;
const NUM_CANDIDATES = 40;

const main = async () => {
  console.log('[ai-vector-search-test] starting');

  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not configured');
  }

  if (!process.env.OPENAI_API_KEY || !String(process.env.OPENAI_API_KEY).trim()) {
    throw new Error('OPENAI_API_KEY is missing');
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('[ai-vector-search-test] MongoDB connected');

  console.log(`[ai-vector-search-test] query: ${QUERY}`);

  const queryVector = await generateEmbedding(QUERY);

  if (
    !Array.isArray(queryVector) ||
    queryVector.length !== EMBEDDING_DIMENSIONS
  ) {
    throw new Error(
      `Unexpected query embedding dimensions: ${
        Array.isArray(queryVector) ? queryVector.length : typeof queryVector
      }`
    );
  }

  let results;
  try {
    results = await AiKnowledge.aggregate([
      {
        $vectorSearch: {
          index: VECTOR_INDEX_NAME,
          path: 'embedding',
          queryVector,
          numCandidates: NUM_CANDIDATES,
          limit: LIMIT,
        },
      },
      {
        $project: {
          _id: 0,
          sourceType: 1,
          sourceId: 1,
          title: 1,
          slug: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ]);
  } catch (error) {
    throw new Error(
      `Vector search aggregation failed: ${error?.message || String(error)}`
    );
  }

  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(
      'Vector search returned zero results. Check that ai_knowledge_vector_index is READY and ai_knowledge has embeddings.'
    );
  }

  console.log('[ai-vector-search-test] results:');
  console.log(JSON.stringify(results, null, 2));

  await mongoose.disconnect();
  console.log('[ai-vector-search-test] done');
};

main().catch(async (error) => {
  console.error('[ai-vector-search-test] failed', error?.message || error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
