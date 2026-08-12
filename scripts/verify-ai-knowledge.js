#!/usr/bin/env node
/**
 * Read-only verification for the ai_knowledge collection.
 *
 * Usage:
 *   node scripts/verify-ai-knowledge.js
 *
 * - Inspects ONLY ai_knowledge
 * - OpenAI calls = 0
 * - MongoDB writes = 0
 * - Does not touch source collections
 */

require('dotenv').config();

const mongoose = require('mongoose');
const AiKnowledge = require('../src/models/AiKnowledge');

const EXPECTED_TOTAL = 476;
const EXPECTED_COUNTS = Object.freeze({
  blog: 13,
  areaGuide: 13,
  faq: 13,
  service: 6,
  property: 431,
});

const ALLOWED_SOURCE_TYPES = Object.freeze([
  'blog',
  'areaGuide',
  'faq',
  'service',
  'property',
]);

const EMBEDDING_DIMENSIONS = 1536;
const SHA256_HEX = /^[a-f0-9]{64}$/;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE =
  /(?:\+971[\s-]?)?(?:0?5[0-9]|0?4)[\s-]?\d{3}[\s-]?\d{4}|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/;
const PRIVATE_FIELD_RE =
  /\b(listingAgent|listingAgentEmail|listingAgentPhone|permitNumber|trakheesiPermitUrl|whatsapp|ownerEmail|ownerPhone|customerEmail|customerPhone)\b/i;

const PRIVATE_METADATA_KEYS = new Set([
  'listingAgent',
  'listingAgentEmail',
  'listingAgentPhone',
  'permitNumber',
  'trakheesiPermitUrl',
  'price',
  'email',
  'phone',
  'whatsapp',
  'owner',
  'ownerEmail',
  'ownerPhone',
]);

const emptyErrors = () => ({
  countMismatch: 0,
  missingEmbedding: 0,
  invalidEmbeddingDimension: 0,
  nonNumericEmbedding: 0,
  missingHash: 0,
  invalidHash: 0,
  emptyContent: 0,
  duplicateIdentity: 0,
  unexpectedSourceType: 0,
  careersFaqPresent: 0,
  securityViolations: 0,
});

/**
 * @param {unknown} value
 * @returns {{ insecure: boolean, rules: string[], match?: string }}
 */
const inspectSecurity = (value) => {
  if (value === undefined || value === null) {
    return { insecure: false, rules: [] };
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return { insecure: false, rules: [] };

  const rules = [];
  let match;

  const email = text.match(EMAIL_RE);
  if (email) {
    rules.push('EMAIL_RE');
    match = match || email[0];
  }
  const phone = text.match(PHONE_RE);
  if (phone) {
    rules.push('PHONE_RE');
    match = match || phone[0];
  }
  const priv = text.match(PRIVATE_FIELD_RE);
  if (priv) {
    rules.push('PRIVATE_FIELD_RE');
    match = match || priv[0];
  }

  return { insecure: rules.length > 0, rules, match };
};

const metadataHasPrivateKeys = (metadata) => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return false;
  }
  return Object.keys(metadata).some((key) => PRIVATE_METADATA_KEYS.has(key));
};

const main = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not configured');
  }

  console.log('[ai-knowledge-verify] starting (read-only)');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('[ai-knowledge-verify] MongoDB connected');
  console.log('[ai-knowledge-verify] collection: ai_knowledge');

  const errors = emptyErrors();
  const samples = {
    securityViolations: [],
    careersFaqPresent: [],
    unexpectedSourceType: [],
    duplicateIdentity: [],
  };

  const total = await AiKnowledge.countDocuments({});
  const sourceCounts = {
    blog: 0,
    areaGuide: 0,
    faq: 0,
    service: 0,
    property: 0,
  };

  const identityCounts = new Map();

  const cursor = AiKnowledge.find({})
    .select('+embedding +embeddingHash')
    .lean()
    .cursor({ batchSize: 100 });

  let scanned = 0;

  for await (const doc of cursor) {
    scanned += 1;

    const sourceType = String(doc.sourceType || '');
    const sourceId = String(doc.sourceId || '');

    if (ALLOWED_SOURCE_TYPES.includes(sourceType)) {
      sourceCounts[sourceType] += 1;
    } else {
      errors.unexpectedSourceType += 1;
      if (samples.unexpectedSourceType.length < 5) {
        samples.unexpectedSourceType.push({ sourceType, sourceId });
      }
    }

    const identityKey = `${sourceType}::${sourceId}`;
    identityCounts.set(identityKey, (identityCounts.get(identityKey) || 0) + 1);

    const content = typeof doc.content === 'string' ? doc.content.trim() : '';
    if (!content) {
      errors.emptyContent += 1;
    }

    if (!Array.isArray(doc.embedding) || doc.embedding.length === 0) {
      errors.missingEmbedding += 1;
    } else if (doc.embedding.length !== EMBEDDING_DIMENSIONS) {
      errors.invalidEmbeddingDimension += 1;
    } else if (
      doc.embedding.some((n) => typeof n !== 'number' || !Number.isFinite(n))
    ) {
      errors.nonNumericEmbedding += 1;
    }

    const hash = typeof doc.embeddingHash === 'string' ? doc.embeddingHash : '';
    if (!hash) {
      errors.missingHash += 1;
    } else if (!SHA256_HEX.test(hash)) {
      errors.invalidHash += 1;
    }

    // Careers FAQs must never be indexed
    if (
      sourceType === 'faq' &&
      (doc.metadata?.page === 'careers' ||
        /(^|\n)careers(\n|$)/i.test(content))
    ) {
      errors.careersFaqPresent += 1;
      if (samples.careersFaqPresent.length < 5) {
        samples.careersFaqPresent.push({ sourceId, title: doc.title });
      }
    }

    const checks = [
      inspectSecurity(doc.title),
      inspectSecurity(doc.content),
      inspectSecurity(doc.slug),
      inspectSecurity(doc.metadata),
    ];
    const hit = checks.find((c) => c.insecure);
    const privateMeta = metadataHasPrivateKeys(doc.metadata);

    if (hit || privateMeta) {
      errors.securityViolations += 1;
      if (samples.securityViolations.length < 5) {
        samples.securityViolations.push({
          sourceType,
          sourceId,
          title: doc.title,
          rules: privateMeta
            ? [...(hit?.rules || []), 'PRIVATE_METADATA_KEY']
            : hit.rules,
          match: hit?.match,
        });
      }
    }
  }

  for (const [identity, count] of identityCounts.entries()) {
    if (count > 1) {
      errors.duplicateIdentity += count - 1;
      if (samples.duplicateIdentity.length < 5) {
        samples.duplicateIdentity.push({ identity, count });
      }
    }
  }

  if (total !== EXPECTED_TOTAL) {
    errors.countMismatch += 1;
  }

  for (const [sourceType, expected] of Object.entries(EXPECTED_COUNTS)) {
    if (sourceCounts[sourceType] !== expected) {
      errors.countMismatch += 1;
    }
  }

  const totalErrors = Object.values(errors).reduce((sum, n) => sum + n, 0);

  console.log('[ai-knowledge-verify] summary');
  console.log(
    JSON.stringify(
      {
        total,
        sourceCounts,
        expectedTotal: EXPECTED_TOTAL,
        expectedSourceCounts: { ...EXPECTED_COUNTS },
        validationErrors: errors,
        totalValidationErrors: totalErrors,
        openaiCalls: 0,
        mongoWrites: 0,
        collectionsAccessed: ['ai_knowledge'],
        forbiddenCollectionsAccessed: [],
        ok: totalErrors === 0,
        ...(totalErrors ? { samples } : {}),
      },
      null,
      2
    )
  );

  await mongoose.disconnect();

  if (totalErrors > 0) {
    console.error('[ai-knowledge-verify] FAILED');
    process.exit(1);
  }

  console.log('[ai-knowledge-verify] PASSED');
};

main().catch(async (error) => {
  console.error('[ai-knowledge-verify] failed', error?.message || error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
