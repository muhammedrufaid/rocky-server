/**
 * Phase 4 Step 3 — knowledge chunking validation (READ ONLY).
 *
 * Usage:
 *   node scripts/test-knowledge-chunking.js
 *
 * Does NOT:
 * - call OpenAI
 * - write to MongoDB
 * - create embeddings / indexes
 * - modify Blog RAG
 */
require('dotenv').config();
const mongoose = require('mongoose');
const {
  prepareKnowledgeChunks,
  chunkLogicalKey,
  hashChunkContent,
} = require('../src/services/knowledgeChunkingService');
const AreaGuide = require('../src/models/AreaGuide');
const Faq = require('../src/models/Faq');

const ALLOWED_MODELS = new Set(['AreaGuide', 'Faq']);
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

const FORBIDDEN_CHUNK_KEYS = [
  'agentOrders',
  'agents',
  'listingsSearch',
  'image',
  'createdAt',
  'updatedAt',
  '_id',
  '__v',
  'embedding',
];

const wordCount = (text) =>
  String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

const looksLikeHtml = (text) => /<\/?[a-z][\s\S]*>/i.test(String(text || ''));
const looksLikeImageUrl = (text) =>
  /https?:\/\/\S+\.(png|jpe?g|gif|webp|svg)(\?\S*)?/i.test(String(text || '')) ||
  /\/assets\/area-guides\//i.test(String(text || ''));
const looksLikeEmail = (text) => /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(String(text || ''));
const looksLikePhone = (text) => /\+\d[\d\s()-]{7,}\d/.test(String(text || ''));
const looksLikeWhatsApp = (text) => /\bwhatsapp\b/i.test(String(text || '')) && /\d{6,}/.test(String(text || ''));

(async () => {
  console.log('=== Phase 4 Step 3: Knowledge chunk preparation ===');
  console.log('OpenAI calls: NO');
  console.log('MongoDB writes: NO');
  console.log('Blog RAG modified: NO');
  console.log('');

  await mongoose.connect(process.env.MONGO_URI);

  const { areaGuideChunks, faqChunks, chunks, meta } = await prepareKnowledgeChunks();
  const issues = [];

  // Expected counts
  if (meta.areaGuideSources !== 13) {
    issues.push(`expected 13 area guide sources, got ${meta.areaGuideSources}`);
  }
  if (areaGuideChunks.length !== 13) {
    issues.push(`expected 13 area guide chunks, got ${areaGuideChunks.length}`);
  }
  if (meta.faqSources !== 13) {
    issues.push(`expected 13 FAQ sources, got ${meta.faqSources}`);
  }
  if (faqChunks.length !== 13) {
    issues.push(`expected 13 FAQ chunks, got ${faqChunks.length}`);
  }
  if (chunks.length !== 26) {
    issues.push(`expected 26 total chunks, got ${chunks.length}`);
  }
  if (meta.careersFaqsExcluded !== 6) {
    issues.push(`expected 6 careers FAQs excluded, got ${meta.careersFaqsExcluded}`);
  }

  const contentSeen = new Map();
  const identitySeen = new Map();

  for (const chunk of chunks) {
    const label = `${chunk.sourceType}:${chunk.sourceId}`;

    if (!chunk.sourceType || !['area_guide', 'faq'].includes(chunk.sourceType)) {
      issues.push(`bad sourceType (${label})`);
    }
    if (!chunk.sourceId) issues.push(`missing sourceId (${label})`);
    if (chunk.chunkIndex !== 0) {
      issues.push(`expected chunkIndex 0, got ${chunk.chunkIndex} (${label})`);
    }
    if (!chunk.content || !String(chunk.content).trim()) {
      issues.push(`empty content (${label})`);
    }
    if (!chunk.contentHash || !/^[a-f0-9]{64}$/i.test(chunk.contentHash)) {
      issues.push(`invalid contentHash (${label})`);
    }
    if (chunk.contentHash !== hashChunkContent(chunk.content)) {
      issues.push(`contentHash mismatch (${label})`);
    }
    if (looksLikeHtml(chunk.content)) issues.push(`HTML in content (${label})`);
    if (looksLikeImageUrl(chunk.content)) issues.push(`image URL in content (${label})`);
    if (looksLikeEmail(chunk.content)) issues.push(`email in content (${label})`);
    if (looksLikePhone(chunk.content)) issues.push(`phone in content (${label})`);
    if (looksLikeWhatsApp(chunk.content)) issues.push(`whatsapp in content (${label})`);
    if (/\{\{\s*DIRHAM\s*\}\}/i.test(chunk.content) || /\{\{/.test(chunk.content)) {
      issues.push(`placeholder token in content (${label})`);
    }
    if (/\bagentOrders\b/i.test(chunk.content)) issues.push(`agentOrders text (${label})`);
    if (/\blistingsSearch\b/i.test(chunk.content)) issues.push(`listingsSearch text (${label})`);
    if (/\nmapQuery:/i.test(chunk.content)) {
      issues.push(`mapQuery labeled in searchable content (${label})`);
    }

    for (const key of FORBIDDEN_CHUNK_KEYS) {
      if (Object.prototype.hasOwnProperty.call(chunk, key)) {
        issues.push(`forbidden key ${key} on chunk (${label})`);
      }
    }

    // No null/undefined values stored
    for (const [k, v] of Object.entries(chunk)) {
      if (v === null || v === undefined) {
        issues.push(`null/undefined field ${k} (${label})`);
      }
    }

    if (chunk.sourceType === 'area_guide') {
      if (!chunk.title) issues.push(`area guide missing title (${label})`);
      if (!chunk.slug) issues.push(`area guide missing slug (${label})`);
      if (Object.prototype.hasOwnProperty.call(chunk, 'question')) {
        issues.push(`area guide should not have question (${label})`);
      }
      if (Object.prototype.hasOwnProperty.call(chunk, 'category')) {
        issues.push(`area guide should not have category (${label})`);
      }
    }

    if (chunk.sourceType === 'faq') {
      if (!chunk.question) issues.push(`FAQ missing question (${label})`);
      if (!chunk.category) issues.push(`FAQ missing category (${label})`);
      if (chunk.category === 'careers') issues.push(`careers FAQ leaked (${label})`);
      if (!['home', 'off-plan', 'area-guide'].includes(chunk.category)) {
        issues.push(`unexpected FAQ category ${chunk.category} (${label})`);
      }
      if (!/^Q:\s/.test(chunk.content) || !/\nA:\s/.test(chunk.content)) {
        issues.push(`FAQ content missing Q/A structure (${label})`);
      }
    }

    const contentKey = chunk.content;
    if (contentSeen.has(contentKey)) {
      issues.push(`duplicate content: ${label} vs ${contentSeen.get(contentKey)}`);
    } else {
      contentSeen.set(contentKey, label);
    }

    const idKey = chunkLogicalKey(chunk);
    if (identitySeen.has(idKey)) {
      issues.push(`duplicate logical identity: ${idKey}`);
    } else {
      identitySeen.set(idKey, label);
    }
  }

  // Security
  const loadedModels = mongoose.modelNames();
  const unexpectedModels = loadedModels.filter((n) => !ALLOWED_MODELS.has(n));
  if (unexpectedModels.length) {
    issues.push(`unexpected models: ${unexpectedModels.join(', ')}`);
  }

  const collectionsAccessed = [
    AreaGuide.collection.collectionName,
    Faq.collection.collectionName,
  ];
  const forbiddenHit = collectionsAccessed.filter((c) => FORBIDDEN_COLLECTIONS.includes(c));
  if (forbiddenHit.length) {
    issues.push(`forbidden collections: ${forbiddenHit.join(', ')}`);
  }

  const charCounts = chunks.map((c) => c.content.length);
  const wordCounts = chunks.map((c) => wordCount(c.content));
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

  // Representative examples
  const areaExample = areaGuideChunks.find((c) => c.slug === 'dubai-marina') || areaGuideChunks[0];
  const faqExample = faqChunks[0];

  console.log('--- Area Guide Chunk ---');
  console.log('sourceType:', areaExample.sourceType);
  console.log('title:', areaExample.title);
  console.log('slug:', areaExample.slug);
  console.log('chunkIndex:', areaExample.chunkIndex);
  console.log('characterCount:', areaExample.content.length);
  console.log('wordCount:', wordCount(areaExample.content));
  console.log('content:');
  console.log(areaExample.content);
  console.log('contentHash:', areaExample.contentHash);

  console.log('\n--- FAQ Chunk ---');
  console.log('sourceType:', faqExample.sourceType);
  console.log('category:', faqExample.category);
  console.log('question:', faqExample.question);
  console.log('chunkIndex:', faqExample.chunkIndex);
  console.log('characterCount:', faqExample.content.length);
  console.log('wordCount:', wordCount(faqExample.content));
  console.log('content:');
  console.log(faqExample.content);
  console.log('contentHash:', faqExample.contentHash);

  console.log('\n=== Statistics ===');
  console.log('Area Guide sources:', meta.areaGuideSources);
  console.log('Area Guide chunks:', areaGuideChunks.length);
  console.log('FAQ sources:', meta.faqSources);
  console.log('FAQ chunks:', faqChunks.length);
  console.log('Careers FAQs excluded:', meta.careersFaqsExcluded);
  console.log('Total chunks:', chunks.length);
  console.log('Average character count:', avg(charCounts));
  console.log('Average word count:', avg(wordCounts));
  console.log('Min/Max chars:', Math.min(...charCounts), '/', Math.max(...charCounts));
  console.log('All chunkIndex=0:', chunks.every((c) => c.chunkIndex === 0));
  console.log('Duplicate content:', contentSeen.size === chunks.length ? 'NONE' : 'FOUND');
  console.log('Duplicate identities:', identitySeen.size === chunks.length ? 'NONE' : 'FOUND');
  console.log('Empty content:', chunks.some((c) => !c.content?.trim()) ? 'FOUND' : 'NONE');
  console.log('HTML:', chunks.some((c) => looksLikeHtml(c.content)) ? 'FOUND' : 'NONE');
  console.log('Image URLs:', chunks.some((c) => looksLikeImageUrl(c.content)) ? 'FOUND' : 'NONE');
  console.log('{{DIRHAM}} leftovers:', chunks.some((c) => /\{\{/.test(c.content)) ? 'FOUND' : 'NONE');
  console.log('Private contact patterns:', chunks.some((c) => looksLikeEmail(c.content) || looksLikePhone(c.content)) ? 'FOUND' : 'NONE');

  console.log('\n=== Security ===');
  console.log('collections accessed:', collectionsAccessed);
  console.log('mongoose models loaded:', loadedModels);
  console.log('forbidden collections accessed:', forbiddenHit.length ? forbiddenHit : 'NONE');
  console.log('TeamMember loaded:', loadedModels.includes('TeamMember') ? 'YES' : 'NO');
  console.log('AreaGuideLead loaded:', loadedModels.includes('AreaGuideLead') ? 'YES' : 'NO');
  console.log('Property loaded:', loadedModels.includes('Property') ? 'YES' : 'NO');
  console.log('MongoDB writes: 0');
  console.log('OpenAI calls: 0');
  console.log('Blog RAG status: UNCHANGED');

  const pass = issues.length === 0;
  console.log('\n=== Summary ===');
  if (!pass) {
    console.log('Issues:');
    for (const issue of issues) console.log(' -', issue);
  }
  console.log('Overall:', pass ? 'PASS' : 'FAIL');
  console.log('Errors:', issues.length);

  await mongoose.disconnect();
  process.exit(pass ? 0 : 1);
})().catch(async (error) => {
  console.error('Chunking test failed:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
