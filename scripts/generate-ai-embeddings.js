#!/usr/bin/env node
/**
 * Generate / refresh AI embeddings on source documents.
 *
 * Usage:
 *   node scripts/generate-ai-embeddings.js --dry-run
 *   node scripts/generate-ai-embeddings.js
 *   node scripts/generate-ai-embeddings.js --sources=blog,faq
 *   node scripts/generate-ai-embeddings.js --batch-size=16
 *
 * Dry-run: 0 OpenAI calls, 0 MongoDB writes.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const {
  SOURCE_CONFIG,
  ALLOWED_COLLECTIONS,
  FORBIDDEN_COLLECTIONS,
  syncSourceEmbeddings,
} = require('../src/ai/embeddingService');

const parseArgs = (argv) => {
  const args = {
    dryRun: false,
    batchSize: 32,
    sources: Object.keys(SOURCE_CONFIG),
  };

  argv.forEach((arg) => {
    if (arg === '--dry-run') {
      args.dryRun = true;
      return;
    }
    if (arg.startsWith('--batch-size=')) {
      args.batchSize = Math.max(1, parseInt(arg.slice('--batch-size='.length), 10) || 32);
      return;
    }
    if (arg.startsWith('--sources=')) {
      args.sources = arg
        .slice('--sources='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  });

  return args;
};

const assertSourceAllowed = (sourceType) => {
  const config = SOURCE_CONFIG[sourceType];
  if (!config) {
    throw new Error(`Unknown source: ${sourceType}`);
  }
  if (!ALLOWED_COLLECTIONS.includes(config.collection)) {
    throw new Error(`Source ${sourceType} maps to disallowed collection ${config.collection}`);
  }
  if (FORBIDDEN_COLLECTIONS.includes(config.collection)) {
    throw new Error(`Refusing forbidden collection: ${config.collection}`);
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  for (const sourceType of args.sources) {
    assertSourceAllowed(sourceType);
  }

  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not configured');
  }

  if (!args.dryRun && !process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  console.log('[generate-ai-embeddings] starting', {
    dryRun: args.dryRun,
    batchSize: args.batchSize,
    sources: args.sources,
  });

  await mongoose.connect(process.env.MONGO_URI);
  console.log('[generate-ai-embeddings] MongoDB connected');

  // Verify property count before any OpenAI work
  if (args.sources.includes('property')) {
    const Property = SOURCE_CONFIG.property.model;
    const propertyCount = await Property.countDocuments({});
    console.log('[generate-ai-embeddings] property documents:', propertyCount);
  }

  const results = [];

  for (const sourceType of args.sources) {
    console.log(`[generate-ai-embeddings] processing ${sourceType}...`);
    const summary = await syncSourceEmbeddings(sourceType, {
      dryRun: args.dryRun,
      batchSize: args.batchSize,
      onProgress: (progress) => {
        if (progress.phase === 'embedding') {
          console.log(
            `[generate-ai-embeddings] ${sourceType}: ${progress.processedPending}/${progress.pendingTotal} pending embedded`
          );
        }
      },
    });
    results.push(summary);
    console.log(`[generate-ai-embeddings] ${sourceType} summary`, summary);
  }

  const totals = results.reduce(
    (acc, row) => {
      acc.scanned += row.scanned;
      acc.skippedUnchanged += row.skippedUnchanged;
      acc.emptyText += row.emptyText;
      acc.embedded += row.embedded;
      acc.wouldEmbed += row.wouldEmbed;
      acc.failed += row.failed;
      return acc;
    },
    {
      scanned: 0,
      skippedUnchanged: 0,
      emptyText: 0,
      embedded: 0,
      wouldEmbed: 0,
      failed: 0,
    }
  );

  console.log('[generate-ai-embeddings] done', {
    dryRun: args.dryRun,
    openaiCalls: args.dryRun ? 0 : 'see embedded/failed counts',
    mongoWrites: args.dryRun ? 0 : totals.embedded,
    totals,
    collectionsAccessed: args.sources.map((s) => SOURCE_CONFIG[s].collection),
    forbiddenCollectionsAccessed: [],
  });

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error('[generate-ai-embeddings] failed', error?.message || error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
