/**
 * Embed blogs, area guides, FAQs, and services into chatbot_knowledge.
 * Skips factsheets (PDFs, no extractable text).
 *
 * Usage:
 *   node scripts/embedContent.js
 *   node scripts/embedContent.js --dry-run
 *
 * Requires Atlas vector index `chatbot_knowledge_vector_index` on chatbot_knowledge.embedding.
 */
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const OpenAI = require('openai');

const Blog = require('../src/models/Blog');
const AreaGuide = require('../src/models/AreaGuide');
const Faq = require('../src/models/Faq');
const Service = require('../src/models/Service');
const { ChatbotKnowledge } = require('../src/ai/chat.models');

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const BATCH_SIZE = 64;
const MAX_CHUNK_CHARS = 2000;
const TARGET_CHUNK_CHARS = 1600;
const dryRun = process.argv.includes('--dry-run');

function frontendBase() {
  return (process.env.FRONTEND_URL || 'https://www.rockyrealestate.com').replace(/\/$/, '');
}

function joinUrl(path) {
  const base = frontendBase();
  if (!path) return base;
  const p = String(path).startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

function hashContent(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function chunkText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const paragraphs = raw
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };

  const append = (piece) => {
    if (!piece) return;
    if (piece.length > MAX_CHUNK_CHARS) {
      flush();
      for (let i = 0; i < piece.length; i += MAX_CHUNK_CHARS) {
        chunks.push(piece.slice(i, i + MAX_CHUNK_CHARS));
      }
      return;
    }
    if (!current) {
      current = piece;
      return;
    }
    const merged = `${current}\n\n${piece}`;
    if (merged.length <= MAX_CHUNK_CHARS) {
      current = merged;
      return;
    }
    if (current.length >= TARGET_CHUNK_CHARS) {
      flush();
      current = piece;
      return;
    }
    flush();
    current = piece;
  };

  if (!paragraphs.length) append(raw.replace(/\s+/g, ' ').trim());
  else paragraphs.forEach(append);
  flush();
  return chunks;
}

function blogBlocksToText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      if (typeof block.text === 'string' && block.text.trim()) return block.text.trim();
      if (Array.isArray(block.items)) {
        return block.items
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .join('\n');
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function collectSources() {
  return Promise.all([
    Blog.find({ isActive: true }).lean(),
    AreaGuide.find({ isActive: true }).lean(),
    Faq.find({ isActive: true }).lean(),
    Service.find({ isActive: true }).lean(),
  ]);
}

function documentsToChunks(blogs, areaGuides, faqs, services) {
  const docs = [];

  for (const blog of blogs) {
    const body = [blog.title, blog.subtitle, blog.description, blogBlocksToText(blog.content)]
      .filter(Boolean)
      .join('\n\n');
    const chunks = chunkText(body);
    chunks.forEach((content, index) => {
      docs.push({
        sourceType: 'blog',
        sourceId: String(blog._id),
        title: blog.title,
        url: joinUrl(blog.path),
        content,
        chunkIndex: index,
      });
    });
  }

  for (const guide of areaGuides) {
    const highlights = (guide.keyHighlights || [])
      .map((h) => (h && h.title ? h.title : ''))
      .filter(Boolean)
      .join('\n');
    const body = [guide.title, guide.about, highlights].filter(Boolean).join('\n\n');
    const chunks = chunkText(body);
    chunks.forEach((content, index) => {
      docs.push({
        sourceType: 'area_guide',
        sourceId: String(guide._id),
        title: guide.title,
        url: joinUrl(guide.path),
        content,
        chunkIndex: index,
      });
    });
  }

  for (const faq of faqs) {
    const body = chunkText(`Q: ${faq.question}\nA: ${faq.answer}`);
    const pagePath = faq.page === 'home' ? '/' : `/${faq.page}`;
    body.forEach((content, index) => {
      docs.push({
        sourceType: 'faq',
        sourceId: String(faq._id),
        title: faq.question,
        url: joinUrl(pagePath),
        content,
        chunkIndex: index,
      });
    });
  }

  for (const service of services) {
    const overview = Array.isArray(service.overview) ? service.overview.join('\n') : '';
    const subservices = (service.subservices || [])
      .map((s) => {
        const points = Array.isArray(s.points) ? s.points.join('\n') : '';
        return [s.title, s.description, points].filter(Boolean).join('\n');
      })
      .join('\n\n');
    const body = [service.title, service.description, service.overviewHeading, overview, subservices]
      .filter(Boolean)
      .join('\n\n');
    const chunks = chunkText(body);
    chunks.forEach((content, index) => {
      docs.push({
        sourceType: 'service',
        sourceId: String(service._id),
        title: service.title,
        url: joinUrl(`/services/${service.slug}`),
        content,
        chunkIndex: index,
      });
    });
  }

  return docs.map((doc) => ({
    ...doc,
    embeddingHash: hashContent(doc.content),
  }));
}

async function embedBatch(openai, texts, attempt = 1) {
  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts,
    });
    return response.data.sort((a, b) => a.index - b.index).map((row) => row.embedding);
  } catch (err) {
    const status = err.status || err.statusCode;
    if (status === 429 && attempt < 4) {
      const waitMs = attempt * 2000;
      console.warn(`OpenAI rate limited, retrying in ${waitMs}ms (attempt ${attempt})`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return embedBatch(openai, texts, attempt + 1);
    }
    throw err;
  }
}

async function upsertChunks(chunks) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required');
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const existing = await ChatbotKnowledge.find(
    {},
    { sourceType: 1, sourceId: 1, embeddingHash: 1 }
  ).lean();

  const existingByKey = new Map(
    existing.map((row) => [`${row.sourceType}:${row.sourceId}:${row.embeddingHash}`, row])
  );

  const keepHashesBySource = new Map();
  const toEmbed = [];

  for (const chunk of chunks) {
    const sourceKey = `${chunk.sourceType}:${chunk.sourceId}`;
    if (!keepHashesBySource.has(sourceKey)) keepHashesBySource.set(sourceKey, new Set());
    keepHashesBySource.get(sourceKey).add(chunk.embeddingHash);

    const key = `${chunk.sourceType}:${chunk.sourceId}:${chunk.embeddingHash}`;
    if (!existingByKey.has(key)) toEmbed.push(chunk);
  }

  console.log(`Chunks: ${chunks.length} total, ${toEmbed.length} new, ${chunks.length - toEmbed.length} unchanged`);

  if (dryRun) {
    console.log('[dry-run] skipping embeds and writes');
    return;
  }

  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    const embeddings = await embedBatch(
      openai,
      batch.map((c) => c.content)
    );

    const ops = batch.map((chunk, idx) => ({
      updateOne: {
        filter: {
          sourceType: chunk.sourceType,
          sourceId: chunk.sourceId,
          embeddingHash: chunk.embeddingHash,
        },
        update: {
          $set: {
            title: chunk.title,
            url: chunk.url,
            content: chunk.content,
            embedding: embeddings[idx],
          },
        },
        upsert: true,
      },
    }));

    if (ops.length) await ChatbotKnowledge.bulkWrite(ops);
    console.log(`Upserted ${Math.min(i + BATCH_SIZE, toEmbed.length)}/${toEmbed.length}`);
  }

  let deleted = 0;
  for (const sourceKey of keepHashesBySource.keys()) {
    const sep = sourceKey.indexOf(':');
    const sourceType = sourceKey.slice(0, sep);
    const sourceId = sourceKey.slice(sep + 1);
    const hashes = [...keepHashesBySource.get(sourceKey)];
    const result = await ChatbotKnowledge.deleteMany({
      sourceType,
      sourceId,
      embeddingHash: { $nin: hashes },
    });
    deleted += result.deletedCount || 0;
  }

  const idsByType = new Map();
  for (const chunk of chunks) {
    if (!idsByType.has(chunk.sourceType)) idsByType.set(chunk.sourceType, new Set());
    idsByType.get(chunk.sourceType).add(chunk.sourceId);
  }
  for (const [sourceType, ids] of idsByType) {
    const result = await ChatbotKnowledge.deleteMany({
      sourceType,
      sourceId: { $nin: [...ids] },
    });
    deleted += result.deletedCount || 0;
  }

  console.log(`Removed ${deleted} stale chunks`);
}

const run = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is required');
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to database: ${mongoose.connection.name}`);

  const [blogs, areaGuides, faqs, services] = await collectSources();
  console.log(
    `Loaded ${blogs.length} blogs, ${areaGuides.length} area guides, ${faqs.length} FAQs, ${services.length} services`
  );

  const chunks = documentsToChunks(blogs, areaGuides, faqs, services);
  await upsertChunks(chunks);

  await mongoose.disconnect();
  console.log('Done');
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
