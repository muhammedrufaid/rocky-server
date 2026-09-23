/**
 * Embed blogs, area guides, FAQs, services, and company info into chatbot_knowledge.
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
const CompanyInfo = require('../src/models/CompanyInfo');
const ChatbotKnowledge = require('../src/models/ChatbotKnowledge');

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
  if (!Array.isArray(content)) return { body: '', headings: [] };
  const headings = [];
  const parts = content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const type = String(block.type || '').toLowerCase();
      if (typeof block.text === 'string' && block.text.trim()) {
        if (/heading|title|h[1-6]/.test(type)) headings.push(block.text.trim());
        return block.text.trim();
      }
      if (Array.isArray(block.items)) {
        return block.items
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .join('\n');
      }
      return '';
    })
    .filter(Boolean);
  return { body: parts.join('\n\n'), headings };
}

function collectSources() {
  return Promise.all([
    Blog.find({ isActive: true }).lean(),
    AreaGuide.find({ isActive: true }).lean(),
    Faq.find({ isActive: true }).lean(),
    Service.find({ isActive: true }).lean(),
    CompanyInfo.find({ isActive: true }).lean(),
  ]);
}

function documentsToChunks(blogs, areaGuides, faqs, services, companyInfos = []) {
  const docs = [];

  for (const blog of blogs) {
    const { body: blockBody, headings } = blogBlocksToText(blog.content);
    const tags = Array.isArray(blog.keywords) ? blog.keywords.filter(Boolean).map(String) : [];
    const metaLines = [
      blog.slug ? `Slug: ${blog.slug}` : '',
      blog.category ? `Category: ${blog.category}` : '',
      tags.length ? `Tags: ${tags.join(', ')}` : '',
      headings.length ? `Headings: ${headings.join(' | ')}` : '',
    ].filter(Boolean);
    const body = [blog.title, blog.subtitle, blog.description, ...metaLines, blockBody]
      .filter(Boolean)
      .join('\n\n');
    const chunks = chunkText(body);
    chunks.forEach((content, index) => {
      docs.push({
        sourceType: 'blog',
        sourceId: String(blog._id),
        title: blog.title,
        url: joinUrl(blog.path || (blog.slug ? `/blogs/${blog.slug}` : '')),
        slug: blog.slug || '',
        excerpt: blog.description || '',
        category: blog.category || '',
        tags,
        headings,
        content,
        chunkIndex: index,
      });
    });
  }

  for (const guide of areaGuides) {
    const highlightTitles = (guide.keyHighlights || [])
      .map((h) => (h && h.title ? h.title : ''))
      .filter(Boolean);
    const metaLines = [
      guide.slug ? `Slug: ${guide.slug}` : '',
      highlightTitles.length ? `Headings: ${highlightTitles.join(' | ')}` : '',
    ].filter(Boolean);
    const body = [guide.title, guide.about, ...metaLines, highlightTitles.join('\n')]
      .filter(Boolean)
      .join('\n\n');
    const chunks = chunkText(body);
    chunks.forEach((content, index) => {
      docs.push({
        sourceType: 'area_guide',
        sourceId: String(guide._id),
        title: guide.title,
        url: joinUrl(guide.path || (guide.slug ? `/area-guides/${guide.slug}` : '')),
        slug: guide.slug || '',
        excerpt: String(guide.about || '').slice(0, 280),
        category: 'area_guide',
        tags: [],
        headings: highlightTitles,
        content,
        chunkIndex: index,
      });
    });
  }

  for (const faq of faqs) {
    const body = chunkText(
      [
        faq.slug ? `Slug: ${faq.slug}` : '',
        faq.page ? `Category: ${faq.page}` : '',
        `Q: ${faq.question}`,
        `A: ${faq.answer}`,
      ]
        .filter(Boolean)
        .join('\n')
    );
    const pagePath = faq.page === 'home' ? '/' : `/${faq.page}`;
    body.forEach((content, index) => {
      docs.push({
        sourceType: 'faq',
        sourceId: String(faq._id),
        title: faq.question,
        url: joinUrl(pagePath),
        slug: faq.slug || '',
        excerpt: String(faq.answer || '').slice(0, 280),
        category: faq.page || '',
        tags: [],
        headings: [],
        content,
        chunkIndex: index,
      });
    });
  }

  for (const service of services) {
    const overview = Array.isArray(service.overview) ? service.overview.join('\n') : '';
    const subTitles = (service.subservices || []).map((s) => s?.title).filter(Boolean);
    const subservices = (service.subservices || [])
      .map((s) => {
        const points = Array.isArray(s.points) ? s.points.join('\n') : '';
        return [s.title, s.description, points].filter(Boolean).join('\n');
      })
      .join('\n\n');
    const metaLines = [
      service.slug ? `Slug: ${service.slug}` : '',
      subTitles.length ? `Headings: ${subTitles.join(' | ')}` : '',
    ].filter(Boolean);
    const body = [
      service.title,
      service.description,
      ...metaLines,
      service.overviewHeading,
      overview,
      subservices,
    ]
      .filter(Boolean)
      .join('\n\n');
    const chunks = chunkText(body);
    chunks.forEach((content, index) => {
      docs.push({
        sourceType: 'service',
        sourceId: String(service._id),
        title: service.title,
        url: joinUrl(`/services/${service.slug}`),
        slug: service.slug || '',
        excerpt: service.description || '',
        category: 'service',
        tags: [],
        headings: [service.overviewHeading, ...subTitles].filter(Boolean),
        content,
        chunkIndex: index,
      });
    });
  }

  for (const info of companyInfos) {
    const topicLine = info.topic ? `Topic: ${info.topic}` : '';
    const categoryLine = info.category ? `Category: ${info.category}` : '';
    const body = chunkText(
      [topicLine, categoryLine, `Q: ${info.question}`, `A: ${info.answer}`].filter(Boolean).join('\n')
    );
    body.forEach((content, index) => {
      docs.push({
        sourceType: 'company_info',
        sourceId: String(info._id),
        title: info.topic || info.question,
        url: '',
        slug: '',
        excerpt: String(info.answer || '').slice(0, 280),
        category: info.category || '',
        tags: info.topic ? [String(info.topic)] : [],
        headings: [],
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
  const metaOps = [];

  for (const chunk of chunks) {
    const sourceKey = `${chunk.sourceType}:${chunk.sourceId}`;
    if (!keepHashesBySource.has(sourceKey)) keepHashesBySource.set(sourceKey, new Set());
    keepHashesBySource.get(sourceKey).add(chunk.embeddingHash);

    const key = `${chunk.sourceType}:${chunk.sourceId}:${chunk.embeddingHash}`;
    if (!existingByKey.has(key)) {
      toEmbed.push(chunk);
    } else {
      metaOps.push({
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
              slug: chunk.slug || '',
              excerpt: chunk.excerpt || '',
              category: chunk.category || '',
              tags: chunk.tags || [],
              headings: chunk.headings || [],
            },
          },
        },
      });
    }
  }

  console.log(`Chunks: ${chunks.length} total, ${toEmbed.length} new, ${chunks.length - toEmbed.length} unchanged`);

  if (dryRun) {
    console.log('[dry-run] skipping embeds and writes');
    return;
  }

  if (metaOps.length) {
    await ChatbotKnowledge.bulkWrite(metaOps);
    console.log(`Synced metadata on ${metaOps.length} existing chunks`);
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
            slug: chunk.slug || '',
            excerpt: chunk.excerpt || '',
            category: chunk.category || '',
            tags: chunk.tags || [],
            headings: chunk.headings || [],
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

  const [blogs, areaGuides, faqs, services, companyInfos] = await collectSources();
  console.log(
    `Loaded ${blogs.length} blogs, ${areaGuides.length} area guides, ${faqs.length} FAQs, ${services.length} services, ${companyInfos.length} company info`
  );

  const chunks = documentsToChunks(blogs, areaGuides, faqs, services, companyInfos);
  await upsertChunks(chunks);

  await mongoose.disconnect();
  console.log('Done');
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
