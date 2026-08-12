#!/usr/bin/env node
/**
 * Synchronize public CMS / property content into ai_knowledge.
 *
 * Usage:
 *   node scripts/sync-ai-knowledge.js --dry-run
 *   node scripts/sync-ai-knowledge.js --source=property --dry-run
 *   node scripts/sync-ai-knowledge.js --source=blog --dry-run
 *   node scripts/sync-ai-knowledge.js --sources=blog,areaGuide,faq
 *   node scripts/sync-ai-knowledge.js
 *
 * Default sources (no --source): blog, areaGuide, faq, service
 * Property is opt-in via --source=property
 *
 * Dry-run: 0 OpenAI calls, 0 MongoDB writes.
 * Live mode writes ONLY to ai_knowledge (never source-document embedding fields).
 */

require('dotenv').config();

const mongoose = require('mongoose');

const AiKnowledge = require('../src/models/AiKnowledge');
const {
  SOURCE_CONFIG,
  ALLOWED_COLLECTIONS,
  FORBIDDEN_COLLECTIONS,
  DEFAULT_BATCH_SIZE,
  buildSearchableText,
  hashSearchableText,
  needsEmbeddingUpdate,
  embedTexts,
} = require('../src/ai/embeddingService');

/** Default run excludes properties (opt-in via --source=property). */
const DEFAULT_SOURCES = Object.freeze([
  'blog',
  'areaGuide',
  'faq',
  'service',
]);

/** How many source docs to buffer from the cursor before hash checks / embeds. */
const CURSOR_PAGE_SIZE = 100;

const parseSourceList = (raw) =>
  String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const parseArgs = (argv) => {
  const args = {
    dryRun: false,
    batchSize: DEFAULT_BATCH_SIZE,
    sources: [...DEFAULT_SOURCES],
  };

  argv.forEach((arg) => {
    if (arg === '--dry-run') {
      args.dryRun = true;
      return;
    }

    if (arg.startsWith('--batch-size=')) {
      args.batchSize = Math.max(
        1,
        parseInt(arg.slice('--batch-size='.length), 10) || DEFAULT_BATCH_SIZE
      );
      return;
    }

    if (arg.startsWith('--source=')) {
      const list = parseSourceList(arg.slice('--source='.length));
      if (list.length) args.sources = list;
      return;
    }

    if (arg.startsWith('--sources=')) {
      const list = parseSourceList(arg.slice('--sources='.length));
      if (list.length) args.sources = list;
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
    throw new Error(
      `Source ${sourceType} maps to disallowed collection ${config.collection}`
    );
  }
  if (FORBIDDEN_COLLECTIONS.includes(config.collection)) {
    throw new Error(`Refusing forbidden collection: ${config.collection}`);
  }
};

const emptySourceSummary = (sourceType, collection) => ({
  sourceType,
  collection,
  scanned: 0,
  new: 0,
  changed: 0,
  unchanged: 0,
  empty: 0,
  wouldEmbed: 0,
  embedded: 0,
  failed: 0,
});

/**
 * Load existing AiKnowledge hashes for a page of source IDs.
 * @param {string} sourceType
 * @param {string[]} sourceIds
 * @returns {Promise<Map<string, object>>}
 */
const loadExistingKnowledgeMap = async (sourceType, sourceIds) => {
  if (!sourceIds.length) return new Map();

  const rows = await AiKnowledge.find({
    sourceType,
    sourceId: { $in: sourceIds },
  })
    .select('+embedding +embeddingHash sourceId')
    .lean();

  const map = new Map();
  rows.forEach((row) => {
    map.set(String(row.sourceId), row);
  });
  return map;
};

/**
 * Classify / prepare one cursor page for embed or dry-run accounting.
 */
const classifyPage = (sourceType, config, docs, existingMap) => {
  const pending = [];
  const counts = {
    scanned: docs.length,
    new: 0,
    changed: 0,
    unchanged: 0,
    empty: 0,
  };

  for (const doc of docs) {
    const sourceId = String(doc._id);
    const content = buildSearchableText(sourceType, doc);

    if (!content) {
      counts.empty += 1;
      continue;
    }

    const hash = hashSearchableText(content);
    const existing = existingMap.get(sourceId);

    if (existing && !needsEmbeddingUpdate(existing, hash)) {
      counts.unchanged += 1;
      continue;
    }

    if (existing) counts.changed += 1;
    else counts.new += 1;

    pending.push({
      sourceId,
      hash,
      content,
      title: config.resolveTitle(doc),
      slug: config.resolveSlug(doc),
      metadata: config.resolveMetadata(doc),
    });
  }

  return { counts, pending };
};

/**
 * Persist one embed batch into ai_knowledge only.
 */
const writeKnowledgeBatch = async (sourceType, batch, embeddings) => {
  await Promise.all(
    batch.map((item, index) =>
      AiKnowledge.findOneAndUpdate(
        { sourceType, sourceId: item.sourceId },
        {
          $set: {
            sourceType,
            sourceId: item.sourceId,
            title: item.title,
            content: item.content,
            slug: item.slug,
            metadata: item.metadata,
            embedding: embeddings[index],
            embeddingHash: item.hash,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )
    )
  );
};

/**
 * Cursor-based sync for one source type. Does not load the full collection.
 */
const syncSource = async (sourceType, options) => {
  const { dryRun, batchSize, counters } = options;
  const config = SOURCE_CONFIG[sourceType];
  const summary = emptySourceSummary(sourceType, config.collection);

  const cursor = config.model
    .find(config.activeFilter)
    .lean()
    .cursor({ batchSize: CURSOR_PAGE_SIZE });

  let page = [];

  const flushPage = async () => {
    if (!page.length) return;

    const sourceIds = page.map((doc) => String(doc._id));
    const existingMap = await loadExistingKnowledgeMap(sourceType, sourceIds);
    counters.collectionsAccessed.add('ai_knowledge');

    const { counts, pending } = classifyPage(sourceType, config, page, existingMap);

    summary.scanned += counts.scanned;
    summary.new += counts.new;
    summary.changed += counts.changed;
    summary.unchanged += counts.unchanged;
    summary.empty += counts.empty;

    if (dryRun) {
      summary.wouldEmbed += pending.length;
      page = [];
      return;
    }

    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const texts = batch.map((item) => item.content);

      try {
        const embeddings = await embedTexts(texts);
        counters.openaiCalls += 1;
        await writeKnowledgeBatch(sourceType, batch, embeddings);
        counters.mongoWrites += batch.length;
        summary.embedded += batch.length;
      } catch (batchError) {
        for (const item of batch) {
          try {
            const embeddings = await embedTexts([item.content]);
            counters.openaiCalls += 1;
            await writeKnowledgeBatch(sourceType, [item], embeddings);
            counters.mongoWrites += 1;
            summary.embedded += 1;
          } catch (itemError) {
            summary.failed += 1;
            console.error('[ai-knowledge-sync] document failed', {
              sourceType,
              sourceId: item.sourceId,
              message: itemError?.message || String(itemError),
            });
          }
        }

        if (!summary.failed) {
          // batch failed but every item recovered — keep going
          console.error('[ai-knowledge-sync] batch recovered via per-doc fallback', {
            sourceType,
            message: batchError?.message || String(batchError),
          });
        }
      }
    }

    page = [];
  };

  for await (const doc of cursor) {
    page.push(doc);
    if (page.length >= CURSOR_PAGE_SIZE) {
      await flushPage();
    }
  }

  await flushPage();
  return summary;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.sources.length) {
    throw new Error(
      'No sources selected. Use --source=blog|areaGuide|faq|service|property'
    );
  }

  for (const sourceType of args.sources) {
    assertSourceAllowed(sourceType);
  }

  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not configured');
  }

  if (!args.dryRun && !process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  console.log('[ai-knowledge-sync] starting', {
    dryRun: args.dryRun,
    batchSize: args.batchSize,
    sources: args.sources,
  });

  await mongoose.connect(process.env.MONGO_URI);
  console.log('[ai-knowledge-sync] MongoDB connected');

  const counters = {
    openaiCalls: 0,
    mongoWrites: 0,
    collectionsAccessed: new Set(),
  };

  const results = [];

  for (const sourceType of args.sources) {
    const collection = SOURCE_CONFIG[sourceType].collection;
    counters.collectionsAccessed.add(collection);

    console.log(`[ai-knowledge-sync] ${sourceType}`);
    const summary = await syncSource(sourceType, {
      dryRun: args.dryRun,
      batchSize: args.batchSize,
      counters,
    });
    results.push(summary);

    console.log(`scanned: ${summary.scanned}`);
    console.log(`new: ${summary.new}`);
    console.log(`changed: ${summary.changed}`);
    console.log(`unchanged: ${summary.unchanged}`);
    console.log(`empty: ${summary.empty}`);
    if (args.dryRun) {
      console.log(`wouldEmbed: ${summary.wouldEmbed}`);
    } else {
      console.log(`embedded: ${summary.embedded}`);
      console.log(`failed: ${summary.failed}`);
    }
    console.log('');
  }

  const totals = results.reduce(
    (acc, row) => {
      acc.scanned += row.scanned;
      acc.unchanged += row.unchanged;
      acc.new += row.new;
      acc.changed += row.changed;
      acc.empty += row.empty;
      acc.embedded += row.embedded;
      acc.wouldEmbed += row.wouldEmbed;
      acc.failed += row.failed;
      return acc;
    },
    {
      scanned: 0,
      unchanged: 0,
      new: 0,
      changed: 0,
      empty: 0,
      embedded: 0,
      wouldEmbed: 0,
      failed: 0,
    }
  );

  const report = {
    dryRun: args.dryRun,
    sources: args.sources,
    totals: {
      scanned: totals.scanned,
      unchanged: totals.unchanged,
      new: totals.new,
      changed: totals.changed,
      empty: totals.empty,
      embedded: args.dryRun ? 0 : totals.embedded,
      wouldEmbed: args.dryRun ? totals.wouldEmbed : undefined,
      failed: totals.failed,
    },
    openaiCalls: counters.openaiCalls,
    mongoWrites: counters.mongoWrites,
    collectionsAccessed: [...counters.collectionsAccessed].sort(),
    forbiddenCollectionsAccessed: [],
  };

  // Drop undefined keys for cleaner dry/live output
  if (report.totals.wouldEmbed === undefined) {
    delete report.totals.wouldEmbed;
  }

  console.log('[ai-knowledge-sync] done');
  console.log(JSON.stringify(report, null, 2));

  await mongoose.disconnect();

  if (totals.failed > 0) {
    process.exit(1);
  }
};

main().catch(async (error) => {
  console.error('[ai-knowledge-sync] failed', error?.message || error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
