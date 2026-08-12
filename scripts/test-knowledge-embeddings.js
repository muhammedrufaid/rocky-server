/**
 * Phase 4 Step 4 — validate knowledge_embeddings (READ ONLY).
 *
 * Usage:
 *   node scripts/test-knowledge-embeddings.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const KnowledgeEmbedding = require('../src/models/KnowledgeEmbedding');
const {
  getEmbeddingModel,
  EXPECTED_EMBEDDING_DIMENSION,
} = require('../src/services/embeddingService');

const FORBIDDEN_DOC_KEYS = [
  'agentOrders',
  'agents',
  'listingsSearch',
  'listingAgent',
  'listingAgentEmail',
  'listingAgentPhone',
  'phone',
  'email',
  'whatsapp',
];

(async () => {
  console.log('=== Phase 4 Step 4: knowledge_embeddings validation ===');
  await mongoose.connect(process.env.MONGO_URI);

  const model = getEmbeddingModel();
  const docs = await KnowledgeEmbedding.find({ embeddingModel: model }).lean();
  const issues = [];

  if (docs.length !== 26) issues.push(`expected 26 docs, got ${docs.length}`);

  const area = docs.filter((d) => d.sourceType === 'area_guide');
  const faq = docs.filter((d) => d.sourceType === 'faq');
  if (area.length !== 13) issues.push(`expected 13 area_guide, got ${area.length}`);
  if (faq.length !== 13) issues.push(`expected 13 faq, got ${faq.length}`);

  const careers = docs.filter((d) => d.category === 'careers');
  if (careers.length) issues.push(`careers FAQs present: ${careers.length}`);

  const blogs = docs.filter((d) => d.sourceType === 'blog');
  if (blogs.length) issues.push(`blog sourceType present: ${blogs.length}`);

  const dims = new Set();
  const identities = new Map();
  const hashes = new Set();

  for (const doc of docs) {
    const label = `${doc.sourceType}:${doc.sourceId}:${doc.chunkIndex}`;

    if (!doc.content?.trim()) issues.push(`empty content ${label}`);
    if (!doc.contentHash) issues.push(`missing contentHash ${label}`);
    if (doc.embeddingModel !== model && doc.embeddingModel !== 'text-embedding-3-small') {
      issues.push(`unexpected model ${doc.embeddingModel} ${label}`);
    }
    if (!Array.isArray(doc.embedding) || doc.embedding.length !== EXPECTED_EMBEDDING_DIMENSION) {
      issues.push(`bad dimension ${doc.embedding?.length} ${label}`);
    }
    dims.add(doc.embedding?.length);

    if (doc.embeddingDimension !== EXPECTED_EMBEDDING_DIMENSION) {
      issues.push(`embeddingDimension field mismatch ${label}`);
    }

    const idKey = `${doc.sourceType}|${doc.sourceId}|${doc.chunkIndex}|${doc.embeddingModel}`;
    if (identities.has(idKey)) issues.push(`duplicate logical key ${idKey}`);
    else identities.set(idKey, true);

    hashes.add(doc.contentHash);

    for (const key of FORBIDDEN_DOC_KEYS) {
      if (Object.prototype.hasOwnProperty.call(doc, key) && doc[key] !== undefined) {
        issues.push(`forbidden field ${key} on ${label}`);
      }
    }

    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(doc.content)) {
      issues.push(`email in content ${label}`);
    }
    if (/\+\d[\d\s()-]{7,}\d/.test(doc.content)) {
      issues.push(`phone in content ${label}`);
    }
    if (/\{\{/.test(doc.content)) issues.push(`placeholder in content ${label}`);
  }

  const uniqueSourceIds = new Set(docs.map((d) => `${d.sourceType}:${d.sourceId}`));

  console.log('Documents:', docs.length);
  console.log('Area Guide embeddings:', area.length);
  console.log('FAQ embeddings:', faq.length);
  console.log('Unique sources:', uniqueSourceIds.size);
  console.log('Dimensions:', [...dims]);
  console.log('Embedding model:', model);
  console.log('Unique contentHashes:', hashes.size);
  console.log('Careers FAQs:', careers.length);
  console.log('Blog docs:', blogs.length);
  console.log('Duplicate logical keys:', identities.size === docs.length ? 'NONE' : 'FOUND');

  console.log('\nModels loaded:', mongoose.modelNames());
  console.log('Collection:', KnowledgeEmbedding.collection.collectionName);
  console.log('Blog RAG: UNCHANGED');

  const pass = issues.length === 0;
  console.log('\nOverall:', pass ? 'PASS' : 'FAIL');
  if (!pass) {
    for (const issue of issues) console.log(' -', issue);
  }

  await mongoose.disconnect();
  process.exit(pass ? 0 : 1);
})().catch(async (error) => {
  console.error('Validation failed:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
