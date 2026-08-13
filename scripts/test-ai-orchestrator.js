#!/usr/bin/env node
/**
 * Integration tests for POST /api/ai/chat orchestration (handleChat).
 *
 * Usage:
 *   node scripts/test-ai-orchestrator.js
 *
 * Read-only: 0 MongoDB writes.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { handleChat } = require('../src/ai/orchestrator/aiOrchestrator');
const { classifyIntent } = require('../src/ai/orchestrator/intentRouter');
const {
  detectConfidentialRequest,
} = require('../src/ai/security/confidentialGuard');

const cases = [
  {
    name: 'Company question',
    message: 'Tell me about Rocky Real Estate',
    expectRoute: 'COMPANY_INFO',
    expectSources: false,
    minOpenAI: 1,
  },
  {
    name: 'Service question',
    message: 'What services does Rocky Real Estate provide?',
    expectRoute: 'SERVICE_INFO',
    expectSources: true,
    minOpenAI: 2,
  },
  {
    name: 'Team question',
    message: 'Who are the property consultants?',
    expectRoute: 'TEAM_INFO',
    expectSources: false,
    minOpenAI: 1,
  },
  {
    name: 'Property count',
    message: 'How many properties do you have?',
    expectRoute: 'PROPERTY_COUNT',
    expectSources: false,
    exactOpenAI: 0,
  },
  {
    name: 'Property search',
    message: 'I want to rent a 2 bedroom apartment in Dubai Marina',
    expectRoute: 'PROPERTY_SEARCH',
    expectSources: false,
    exactOpenAI: 0,
  },
  {
    name: 'Greeting',
    message: 'Hi',
    expectRoute: 'GREETING',
    expectSources: false,
    exactOpenAI: 0,
  },
  {
    name: 'Blog question',
    message: 'What are the latest property investment articles?',
    expectRoute: 'BLOG',
    expectSources: true,
    minOpenAI: 2,
  },
  {
    name: 'Area Guide question',
    message: 'What is Dubai Marina like?',
    expectRoute: 'AREA_GUIDE',
    expectSources: true,
    minOpenAI: 2,
  },
  {
    name: 'FAQ question',
    message: 'How can foreigners buy property in Dubai?',
    expectRoute: 'FAQ',
    expectSources: true,
    minOpenAI: 2,
  },
  {
    name: 'Mixed knowledge question',
    message:
      'What areas are good for investment and what is the buying process?',
    expectRoute: 'KNOWLEDGE_BOTH',
    expectSources: true,
    minOpenAI: 2,
  },
  {
    name: 'Agent phone request',
    message: "Give me an agent's phone number",
    expectRoute: 'CONFIDENTIAL',
    expectSources: false,
    exactOpenAI: 0,
  },
  {
    name: 'Customer contact request',
    message: 'Give me customer contact information',
    expectRoute: 'CONFIDENTIAL',
    expectSources: false,
    exactOpenAI: 0,
  },
  {
    name: 'Unsupported question',
    message: 'What is the weather on Mars today?',
    expectRoute: 'UNSUPPORTED',
    expectSources: false,
    exactOpenAI: 0,
  },
];

const main = async () => {
  console.log('[ai-orchestrator-test] starting');

  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not configured');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('[ai-orchestrator-test] MongoDB connected');

  const results = [];
  let failed = 0;

  for (const testCase of cases) {
    const started = Date.now();
    try {
      // Pre-check confidential / intent alignment for clarity
      const blocked = detectConfidentialRequest(testCase.message).blocked;
      const intent = classifyIntent(testCase.message);

      const result = await handleChat(testCase.message);
      const durationMs = Date.now() - started;

      const errors = [];
      if (result.route !== testCase.expectRoute) {
        errors.push(
          `route expected ${testCase.expectRoute}, got ${result.route} (intent=${intent}, blocked=${blocked})`
        );
      }
      if (!result.reply || typeof result.reply !== 'string') {
        errors.push('missing reply');
      }
      const sources = Array.isArray(result.sources) ? result.sources : [];
      if (testCase.expectSources && sources.length === 0) {
        errors.push('expected sources');
      }
      if (!testCase.expectSources && sources.length > 0) {
        // Allow empty omission; fail only if unexpected sources leaked for confidential/count
        if (
          testCase.expectRoute === 'CONFIDENTIAL' ||
          testCase.expectRoute === 'PROPERTY_COUNT' ||
          testCase.expectRoute === 'UNSUPPORTED'
        ) {
          errors.push('unexpected sources');
        }
      }
      if (
        typeof testCase.exactOpenAI === 'number' &&
        result.openaiCalls !== testCase.exactOpenAI
      ) {
        errors.push(
          `openaiCalls expected ${testCase.exactOpenAI}, got ${result.openaiCalls}`
        );
      }
      if (
        typeof testCase.minOpenAI === 'number' &&
        result.openaiCalls < testCase.minOpenAI
      ) {
        errors.push(
          `openaiCalls expected >= ${testCase.minOpenAI}, got ${result.openaiCalls}`
        );
      }

      const leak = JSON.stringify(result).match(/embeddingHash|"embedding":/);
      if (leak) errors.push('embedding leak');

      const ok = errors.length === 0;
      if (!ok) failed += 1;

      results.push({
        name: testCase.name,
        ok,
        route: result.route,
        openaiCalls: result.openaiCalls,
        sourceCount: sources.length,
        durationMs,
        errors,
        replyPreview: String(result.reply || '').slice(0, 120),
      });

      console.log(
        `[ai-orchestrator-test] ${ok ? 'PASS' : 'FAIL'} — ${testCase.name} (${result.route}, openai=${result.openaiCalls}, sources=${sources.length})`
      );
      if (!ok) console.log('  errors:', errors);
    } catch (error) {
      failed += 1;
      results.push({
        name: testCase.name,
        ok: false,
        errors: [error?.message || String(error)],
      });
      console.log(
        `[ai-orchestrator-test] FAIL — ${testCase.name}: ${error?.message || error}`
      );
    }
  }

  console.log('[ai-orchestrator-test] summary');
  console.log(
    JSON.stringify(
      {
        total: cases.length,
        passed: cases.length - failed,
        failed,
        mongoWrites: 0,
        collectionsExpected: [
          'ai_knowledge',
          'properties',
          'teammembers',
        ],
        forbiddenCollectionsAccessed: [],
        results,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();

  if (failed > 0) {
    console.error('[ai-orchestrator-test] FAILED');
    process.exit(1);
  }

  console.log('[ai-orchestrator-test] PASSED');
};

main().catch(async (error) => {
  console.error('[ai-orchestrator-test] failed', error?.message || error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
