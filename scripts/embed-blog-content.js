/**
 * Step 4: Embed public blog chunks with OpenAI text-embedding-3-small.
 *
 * Flow (public blogs ONLY):
 *   MongoDB blogs
 *     → blogContentService
 *     → blogChunkingService
 *     → OpenAI embeddings
 *     → blog_embeddings collection
 *
 * Usage:
 *   node scripts/embed-blog-content.js --dry-run
 *   node scripts/embed-blog-content.js
 *   node scripts/embed-blog-content.js --skip-smoke-test
 *
 * Does NOT:
 *   - modify blogs collection
 *   - create vector search indexes
 *   - implement RAG / chat
 *   - touch contacts, leads, careers, or other confidential data
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { extractAllBlogContent } = require('../src/services/blogContentService');
const { chunkBlog } = require('../src/services/blogChunkingService');
const {
  generateEmbeddings,
  generateEmbedding,
  getEmbeddingModel,
  getEmbeddingBatchSize,
  hashContent,
  isMeaningfulText,
  DEFAULT_EMBEDDING_MODEL,
  EXPECTED_EMBEDDING_DIMENSION,
} = require('../src/services/embeddingService');
const BlogEmbedding = require('../src/models/BlogEmbedding');

const FLEXI_SLUG = 'flexi-rent-dubai-land-department';
const CONFIDENTIAL_COLLECTIONS = [
  'contacts',
  'sells',
  'careers',
  'newsletters',
  'users',
  'areaguideleads',
  'dubaisouthleads',
  'jeweltowerleads',
  'binghattileads',
  'landingpageleads',
  'propertymanagementleads',
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipSmokeTest = args.includes('--skip-smoke-test');

/**
 * Build all chunks for active public blogs.
 * @returns {Promise<{ blogs: object[], chunks: object[] }>}
 */
const buildPublicBlogChunks = async () => {
  const blogs = await extractAllBlogContent({ includeInactive: false });
  const chunks = [];

  for (const blog of blogs) {
    const blogChunks = chunkBlog(blog);
    for (const chunk of blogChunks) {
      chunks.push({
        ...chunk,
        contentHash: hashContent(chunk.content),
      });
    }
  }

  return { blogs, chunks };
};

/**
 * Decide create / update / skip for each chunk against existing embeddings.
 * @param {object[]} chunks
 * @param {string} embeddingModel
 */
const classifyChunks = async (chunks, embeddingModel) => {
  const existing = await BlogEmbedding.find({ embeddingModel })
    .select('blogId chunkIndex contentHash embeddingDimension')
    .lean();

  const existingMap = new Map(
    existing.map((doc) => [
      `${String(doc.blogId)}:${doc.chunkIndex}`,
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

    const key = `${String(chunk.blogId)}:${chunk.chunkIndex}`;
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
 * Smoke-test embeddings with one Flexi Rent chunk.
 */
const runFlexiSmokeTest = async (chunks) => {
  const flexiChunk =
    chunks.find(
      (c) =>
        c.slug === FLEXI_SLUG &&
        typeof c.headingContext === 'string' &&
        /flexi rent|what this means/i.test(c.headingContext)
    ) || chunks.find((c) => c.slug === FLEXI_SLUG);

  if (!flexiChunk) {
    throw new Error('Flexi Rent chunk not found for smoke test');
  }

  console.log('\n=== Flexi Rent embedding smoke test ===');
  console.log('Slug:', flexiChunk.slug);
  console.log('Chunk index:', flexiChunk.chunkIndex);
  console.log('Heading:', flexiChunk.headingContext);
  console.log('Content preview:', flexiChunk.content.slice(0, 120).replace(/\s+/g, ' ') + '…');

  const result = await generateEmbedding(flexiChunk.content);
  const vector = result.embedding;

  const pass =
    Array.isArray(vector) &&
    vector.length > 0 &&
    vector.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    vector.length === EXPECTED_EMBEDDING_DIMENSION;

  console.log('\nEmbedding test:', pass ? 'PASS' : 'FAIL');
  console.log('Model:', result.model);
  console.log('Dimension:', result.dimension);
  console.log('Sample values (first 3 only):', vector.slice(0, 3).map((n) => Number(n.toFixed(6))));

  if (!pass) {
    throw new Error('Flexi Rent embedding smoke test failed');
  }

  return result;
};

/**
 * Upsert embedding docs for create/update chunks.
 */
const persistEmbeddings = async (chunksNeedingEmbed, vectors, model, dimension) => {
  let created = 0;
  let updated = 0;

  for (let i = 0; i < chunksNeedingEmbed.length; i += 1) {
    const chunk = chunksNeedingEmbed[i];
    const embedding = vectors[i];

    if (!Array.isArray(embedding)) {
      throw new Error(
        `Missing embedding vector for slug=${chunk.slug} chunkIndex=${chunk.chunkIndex}`
      );
    }

    const filter = {
      blogId: chunk.blogId,
      chunkIndex: chunk.chunkIndex,
      embeddingModel: model,
    };

    const payload = {
      blogId: chunk.blogId,
      slug: chunk.slug,
      title: chunk.title,
      category: chunk.category,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content.trim(),
      contentHash: chunk.contentHash,
      headingContext: chunk.headingContext || null,
      sourceBlockStart: chunk.sourceBlockStart,
      sourceBlockEnd: chunk.sourceBlockEnd,
      charCount: chunk.charCount,
      wordCount: chunk.wordCount,
      embedding,
      embeddingModel: model,
      embeddingDimension: dimension,
    };

    const result = await BlogEmbedding.updateOne(filter, { $set: payload }, { upsert: true });

    if (result.upsertedCount > 0) created += 1;
    else if (result.modifiedCount > 0) updated += 1;
    else updated += 1; // matched existing (treat as update path)
  }

  return { created, updated };
};

const validateStoredEmbeddings = async (embeddingModel) => {
  const docs = await BlogEmbedding.find({ embeddingModel }).lean();
  const uniqueBlogs = new Set(docs.map((d) => String(d.blogId)));
  const keySet = new Set();
  let duplicateKeys = 0;
  let emptyContent = 0;
  let missingMeta = 0;
  const dimensions = new Set();
  const perBlog = {};

  for (const doc of docs) {
    const key = `${String(doc.blogId)}:${doc.chunkIndex}:${doc.embeddingModel}`;
    if (keySet.has(key)) duplicateKeys += 1;
    keySet.add(key);

    if (!doc.content || !String(doc.content).trim()) emptyContent += 1;
    if (
      doc.blogId == null ||
      doc.slug == null ||
      doc.title == null ||
      doc.category == null ||
      doc.chunkIndex == null ||
      !Array.isArray(doc.embedding) ||
      !doc.embeddingModel
    ) {
      missingMeta += 1;
    }

    dimensions.add(doc.embeddingDimension || doc.embedding?.length || 0);
    perBlog[doc.slug] = (perBlog[doc.slug] || 0) + 1;
  }

  return {
    documentCount: docs.length,
    uniqueBlogIds: uniqueBlogs.size,
    chunksPerBlog: perBlog,
    duplicateKeys,
    emptyContent,
    missingMeta,
    dimensions: [...dimensions],
    sameDimension: dimensions.size === 1,
  };
};

const assertNoConfidentialAccess = async () => {
  // Safety check: this script only imports Blog / BlogEmbedding models.
  // Confirm confidential collections were not touched in this process.
  const accessed = mongoose.modelNames();
  const leaked = accessed.filter((name) =>
    CONFIDENTIAL_COLLECTIONS.includes(String(name).toLowerCase())
  );

  return {
    mongooseModelsLoaded: accessed,
    confidentialModelsLoaded: leaked,
    pass: leaked.length === 0,
  };
};

(async () => {
  const startedAt = Date.now();
  const embeddingModel = getEmbeddingModel();
  const batchSize = getEmbeddingBatchSize();

  console.log('=== Step 4: Blog embeddings ===');
  console.log('Mode:', dryRun ? 'DRY RUN' : 'LIVE');
  console.log('Embedding model:', embeddingModel);
  console.log('Batch size:', batchSize);
  console.log('Expected dimension:', EXPECTED_EMBEDDING_DIMENSION);
  console.log('Default model constant:', DEFAULT_EMBEDDING_MODEL);
  console.log('Scope: active public blogs ONLY');
  console.log('Vector search: NOT implemented');
  console.log('RAG: NOT implemented\n');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected');

  const { blogs, chunks } = await buildPublicBlogChunks();
  console.log('Blogs discovered:', blogs.length);
  console.log('Chunks discovered:', chunks.length);

  const classification = await classifyChunks(chunks, embeddingModel);

  console.log('\nClassification:');
  console.log('- Existing embeddings:', classification.existingCount);
  console.log('- New embeddings required:', classification.toCreate.length);
  console.log('- Chunks that would be updated:', classification.toUpdate.length);
  console.log('- Unchanged (skip):', classification.toSkip.length);
  console.log('- Empty skipped:', classification.skippedEmpty.length);

  if (dryRun) {
    console.log('\nDry run complete — OpenAI NOT called, MongoDB NOT written.');
    console.log('Duration ms:', Date.now() - startedAt);
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!skipSmokeTest) {
    await runFlexiSmokeTest(chunks);
  }

  const needingEmbed = [...classification.toCreate, ...classification.toUpdate];

  let openaiRequestCount = skipSmokeTest ? 0 : 1;
  let created = 0;
  let updated = 0;
  let dimension = null;

  if (!needingEmbed.length) {
    console.log('\nNo chunks require embedding. Database already up to date.');
  } else {
    console.log('\nEmbedding required chunks:', needingEmbed.length);

    const embedResult = await generateEmbeddings(
      needingEmbed.map((c) => c.content),
      { model: embeddingModel, batchSize }
    );

    openaiRequestCount += embedResult.requestCount;
    dimension = embedResult.dimension;

    // Map non-null embeddings back in order of needingEmbed
    const vectors = needingEmbed.map((_, i) => embedResult.embeddings[i]);
    if (vectors.some((v) => !Array.isArray(v))) {
      throw new Error('One or more required chunks did not receive an embedding vector');
    }

    const writeResult = await persistEmbeddings(
      needingEmbed,
      vectors,
      embeddingModel,
      dimension
    );
    created = writeResult.created;
    updated = writeResult.updated;

    console.log('Database writes complete:', { created, updated });
  }

  const validation = await validateStoredEmbeddings(embeddingModel);
  const confidentiality = await assertNoConfidentialAccess();

  console.log('\n=== Post-run validation ===');
  console.log(JSON.stringify(validation, null, 2));
  console.log('Confidential collections accessed:', confidentiality.pass ? 'NONE' : confidentiality.confidentialModelsLoaded);
  console.log('Mongoose models loaded:', confidentiality.mongooseModelsLoaded);

  console.log('\n=== Summary ===');
  console.log({
    blogsProcessed: blogs.length,
    chunksProcessed: chunks.length,
    embeddingsCreated: created,
    embeddingsUpdated: updated,
    embeddingsSkippedUnchanged: classification.toSkip.length,
    embeddingsSkippedEmpty: classification.skippedEmpty.length,
    openaiEmbeddingRequests: openaiRequestCount,
    embeddingDimension: dimension || validation.dimensions[0] || null,
    collection: 'blog_embeddings',
    durationMs: Date.now() - startedAt,
  });

  const validationPass =
    validation.documentCount > 0 &&
    validation.duplicateKeys === 0 &&
    validation.emptyContent === 0 &&
    validation.missingMeta === 0 &&
    validation.sameDimension &&
    confidentiality.pass;

  console.log('\nOverall validation:', validationPass ? 'PASS' : 'FAIL');
  console.log('Vector search implemented: NO');
  console.log('RAG implemented: NO');

  await mongoose.disconnect();
  process.exit(validationPass ? 0 : 1);
})().catch(async (error) => {
  console.error('\nEmbedding script FAILED:', {
    name: error?.name,
    category: error?.category,
    message: error?.message,
  });
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
