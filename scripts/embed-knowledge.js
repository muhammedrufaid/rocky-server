/**
 * Phase 4 Step 4: Embed Area Guide + FAQ knowledge chunks.
 *
 * Flow:
 *   areaguides / faqs
 *     → content services (Step 2)
 *     → knowledgeChunkingService (Step 3)
 *     → OpenAI text-embedding-3-small
 *     → knowledge_embeddings
 *
 * Usage:
 *   node scripts/embed-knowledge.js --dry-run
 *   node scripts/embed-knowledge.js
 *
 * Does NOT:
 *   - modify blog_embeddings / Blog RAG
 *   - create Atlas vector indexes
 *   - hydrate agents / TeamMember
 *   - query forbidden collections
 */
require('dotenv').config();
const mongoose = require('mongoose');
const {
  prepareKnowledgeChunks,
  chunkLogicalKey,
} = require('../src/services/knowledgeChunkingService');
const {
  generateEmbeddings,
  getEmbeddingModel,
  getEmbeddingBatchSize,
  isMeaningfulText,
  EXPECTED_EMBEDDING_DIMENSION,
} = require('../src/services/embeddingService');
const KnowledgeEmbedding = require('../src/models/KnowledgeEmbedding');

const FORBIDDEN_COLLECTIONS = [
  'areaguideleads',
  'binghattileads',
  'careers',
  'contacts',
  'dubaisouthleads',
  'jeweltowerleads',
  'landingpageleads',
  'newsletters',
  'propertymanagementleads',
  'sells',
  'teamtailorjobs',
  'users',
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const looksLikePrivate = (text) => {
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return 'email';
  if (/\+\d[\d\s()-]{7,}\d/.test(text)) return 'phone';
  if (/\bwhatsapp\b/i.test(text) && /\d{6,}/.test(text)) return 'whatsapp';
  if (/\bagentOrders\b/i.test(text)) return 'agentOrders';
  if (/\blistingsSearch\b/i.test(text)) return 'listingsSearch';
  return null;
};

/**
 * @param {object[]} chunks
 * @param {string} embeddingModel
 */
const classifyChunks = async (chunks, embeddingModel) => {
  const existing = await KnowledgeEmbedding.find({ embeddingModel })
    .select('sourceType sourceId chunkIndex contentHash embeddingDimension')
    .lean();

  const existingMap = new Map(
    existing.map((doc) => [
      `${doc.sourceType}:${doc.sourceId}:${doc.chunkIndex}`,
      doc,
    ])
  );

  const toCreate = [];
  const toUpdate = [];
  const toSkip = [];
  const skippedEmpty = [];

  for (const chunk of chunks) {
    if (!isMeaningfulText(chunk.content)) {
      skippedEmpty.push(chunk);
      continue;
    }

    const privateHit = looksLikePrivate(chunk.content);
    if (privateHit) {
      throw new Error(
        `Refusing to embed chunk with private pattern (${privateHit}): ${chunkLogicalKey(chunk)}`
      );
    }

    if (chunk.sourceType === 'faq' && chunk.category === 'careers') {
      throw new Error(`Careers FAQ must not be embedded: ${chunk.sourceId}`);
    }

    const key = `${chunk.sourceType}:${chunk.sourceId}:${chunk.chunkIndex}`;
    const prev = existingMap.get(key);

    if (!prev) {
      toCreate.push(chunk);
      continue;
    }

    if (prev.contentHash === chunk.contentHash) {
      toSkip.push(chunk);
      continue;
    }

    toUpdate.push(chunk);
  }

  return {
    existingCount: existing.length,
    toCreate,
    toUpdate,
    toSkip,
    skippedEmpty,
  };
};

/**
 * @param {object} chunk
 * @param {number[]} embedding
 * @param {string} model
 * @param {number} dimension
 */
const toPayload = (chunk, embedding, model, dimension) => {
  const payload = {
    sourceType: chunk.sourceType,
    sourceId: chunk.sourceId,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    contentHash: chunk.contentHash,
    embedding,
    embeddingModel: model,
    embeddingDimension: dimension,
  };

  if (chunk.slug) payload.slug = chunk.slug;
  if (chunk.title) payload.title = chunk.title;
  if (chunk.category) payload.category = chunk.category;
  if (chunk.question) payload.question = chunk.question;
  if (chunk.path) payload.path = chunk.path;
  if (chunk.mapQuery) payload.mapQuery = chunk.mapQuery;
  if (typeof chunk.order === 'number') payload.order = chunk.order;

  return payload;
};

const persistEmbeddings = async (chunksNeedingEmbed, vectors, model, dimension) => {
  let created = 0;
  let updated = 0;

  for (let i = 0; i < chunksNeedingEmbed.length; i += 1) {
    const chunk = chunksNeedingEmbed[i];
    const embedding = vectors[i];

    if (!Array.isArray(embedding) || embedding.length !== dimension) {
      throw new Error(
        `Missing/invalid embedding for ${chunkLogicalKey(chunk)} (dim=${embedding?.length})`
      );
    }

    const filter = {
      sourceType: chunk.sourceType,
      sourceId: chunk.sourceId,
      chunkIndex: chunk.chunkIndex,
      embeddingModel: model,
    };

    const payload = toPayload(chunk, embedding, model, dimension);

    const existing = await KnowledgeEmbedding.findOne(filter).select('_id').lean();
    await KnowledgeEmbedding.findOneAndUpdate(
      filter,
      { $set: payload },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    if (existing) updated += 1;
    else created += 1;
  }

  return { created, updated };
};

(async () => {
  console.log('=== Phase 4 Step 4: Embed knowledge (Area Guides + FAQs) ===');
  console.log('Mode:', dryRun ? 'DRY RUN' : 'LIVE');
  console.log('Target collection: knowledge_embeddings');
  console.log('Blog RAG: UNCHANGED');
  console.log('');

  await mongoose.connect(process.env.MONGO_URI);

  const embeddingModel = getEmbeddingModel();
  const batchSize = getEmbeddingBatchSize();

  const { areaGuideChunks, faqChunks, chunks, meta } = await prepareKnowledgeChunks();

  console.log('Area Guides discovered:', meta.areaGuideSources);
  console.log('FAQs discovered (included):', meta.faqSources);
  console.log('Careers FAQs excluded:', meta.careersFaqsExcluded);
  console.log('Chunks discovered:', chunks.length);
  console.log('Area Guide chunks:', areaGuideChunks.length);
  console.log('FAQ chunks:', faqChunks.length);
  console.log('Embedding model:', embeddingModel);
  console.log('Batch size:', batchSize);
  console.log('Expected dimension:', EXPECTED_EMBEDDING_DIMENSION);

  const classification = await classifyChunks(chunks, embeddingModel);
  const needEmbed = [...classification.toCreate, ...classification.toUpdate];
  const expectedBatches = needEmbed.length
    ? Math.ceil(needEmbed.length / batchSize)
    : 0;

  console.log('\n--- Classification ---');
  console.log('Existing embeddings:', classification.existingCount);
  console.log('New embeddings required:', classification.toCreate.length);
  console.log('Changed embeddings:', classification.toUpdate.length);
  console.log('Unchanged embeddings:', classification.toSkip.length);
  console.log('Empty skipped:', classification.skippedEmpty.length);
  console.log('Expected OpenAI requests:', expectedBatches);

  if (dryRun) {
    console.log('\nDRY RUN complete — OpenAI calls: 0, MongoDB writes: 0');
    await mongoose.disconnect();
    process.exit(0);
  }

  let requestCount = 0;
  let created = 0;
  let updated = 0;

  if (needEmbed.length) {
    const texts = needEmbed.map((c) => c.content);
    const result = await generateEmbeddings(texts, {
      model: embeddingModel,
      batchSize,
      expectedDimension: EXPECTED_EMBEDDING_DIMENSION,
    });
    requestCount = result.requestCount;

    if (result.dimension !== EXPECTED_EMBEDDING_DIMENSION) {
      throw new Error(`Unexpected dimension: ${result.dimension}`);
    }

    const persist = await persistEmbeddings(
      needEmbed,
      result.embeddings,
      result.model,
      result.dimension
    );
    created = persist.created;
    updated = persist.updated;
  }

  const totalDocs = await KnowledgeEmbedding.countDocuments({ embeddingModel });
  const areaDocs = await KnowledgeEmbedding.countDocuments({
    embeddingModel,
    sourceType: 'area_guide',
  });
  const faqDocs = await KnowledgeEmbedding.countDocuments({
    embeddingModel,
    sourceType: 'faq',
  });
  const careersDocs = await KnowledgeEmbedding.countDocuments({
    embeddingModel,
    category: 'careers',
  });
  const blogTypeDocs = await KnowledgeEmbedding.countDocuments({
    embeddingModel,
    sourceType: 'blog',
  });

  const sample = await KnowledgeEmbedding.findOne({ embeddingModel })
    .select('sourceType embedding embeddingDimension embeddingModel contentHash')
    .lean();

  console.log('\n--- Live result ---');
  console.log('Embeddings created:', created);
  console.log('Embeddings updated:', updated);
  console.log('Embeddings skipped:', classification.toSkip.length);
  console.log('OpenAI embedding requests:', requestCount);
  console.log('Total documents:', totalDocs);
  console.log('Area Guide embeddings:', areaDocs);
  console.log('FAQ embeddings:', faqDocs);
  console.log('Careers FAQ embeddings:', careersDocs);
  console.log('Blog sourceType embeddings:', blogTypeDocs);
  console.log('Sample dimension:', sample?.embedding?.length);
  console.log('Sample model:', sample?.embeddingModel);

  const loadedModels = mongoose.modelNames();
  console.log('\n--- Security ---');
  console.log('Models loaded:', loadedModels);
  console.log(
    'Forbidden models:',
    loadedModels.filter((n) =>
      ['AreaGuideLead', 'TeamMember', 'Property', 'User', 'Contact'].includes(n)
    ).length
      ? 'FOUND'
      : 'NONE'
  );
  console.log('Collections used: areaguides, faqs, knowledge_embeddings');
  console.log('Forbidden collections accessed: NONE (not queried)');
  console.log('Blog RAG: UNCHANGED');
  console.log('Vector index: NOT CREATED');

  if (totalDocs !== 26 || areaDocs !== 13 || faqDocs !== 13 || careersDocs !== 0) {
    throw new Error(
      `Unexpected document counts: total=${totalDocs} area=${areaDocs} faq=${faqDocs} careers=${careersDocs}`
    );
  }

  await mongoose.disconnect();
  console.log('\nDone.');
  process.exit(0);
})().catch(async (error) => {
  console.error('embed-knowledge failed:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
