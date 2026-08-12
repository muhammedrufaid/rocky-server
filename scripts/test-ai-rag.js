#!/usr/bin/env node
/**
 * Minimal read-oriented RAG smoke test.
 *
 * Usage:
 *   node scripts/test-ai-rag.js
 *
 * - Uses searchKnowledge + generateRagAnswer
 * - Does not write to MongoDB
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { generateRagAnswer } = require('../src/ai/ragService');

const QUERY = 'What are the best areas to live in Dubai?';

const main = async () => {
  console.log('[ai-rag-test] starting');

  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not configured');
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is missing');
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('[ai-rag-test] MongoDB connected');
  console.log(`[ai-rag-test] query: ${QUERY}`);

  const result = await generateRagAnswer(QUERY, { limit: 5 });

  const hasEmbeddingLeak =
    JSON.stringify(result).includes('"embedding"') ||
    JSON.stringify(result).includes('embeddingHash');

  console.log('[ai-rag-test] reply:');
  console.log(result.reply);
  console.log('[ai-rag-test] sources:');
  console.log(JSON.stringify(result.sources, null, 2));
  console.log('[ai-rag-test] meta:', {
    sourceCount: Array.isArray(result.sources) ? result.sources.length : 0,
    embeddingLeak: hasEmbeddingLeak,
    mongoWrites: 0,
    collectionsAccessed: ['ai_knowledge'],
  });

  if (!result.reply || typeof result.reply !== 'string') {
    throw new Error('Missing reply');
  }
  if (!Array.isArray(result.sources) || result.sources.length === 0) {
    throw new Error('Expected at least one source for this query');
  }
  if (hasEmbeddingLeak) {
    throw new Error('Response leaked embedding fields');
  }

  await mongoose.disconnect();
  console.log('[ai-rag-test] done');
};

main().catch(async (error) => {
  console.error('[ai-rag-test] failed', error?.message || error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
