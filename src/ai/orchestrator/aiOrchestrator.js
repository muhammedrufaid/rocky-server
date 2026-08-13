/**
 * AI chat orchestrator — clean architecture.
 *
 * Flow: confidential → intent → structured tools OR ragService
 * Knowledge RAG uses ONLY src/ai/ragService.js (unified ai_knowledge path).
 *
 * Streaming reuses the same retrieval/prompts; only final GPT tokens stream.
 * Structured events (property_results, quick_actions, …) are emitted after deltas.
 */

const {
  generateText,
  generateTextStream,
  OpenAIServiceError,
} = require('../../services/openaiService');
const {
  detectConfidentialRequest,
  CONFIDENTIAL_REFUSAL,
} = require('../security/confidentialGuard');
const { getCompanyKnowledgeText } = require('../tools/companyKnowledge');
const {
  resolvePropertyCountContext,
  resolveConversationalPropertySearch,
  formatCountReply,
} = require('../tools/propertyTools');
const { resolveTeamContext } = require('../tools/teamTools');
const {
  generateRagAnswer,
  prepareRagContext,
  RagServiceError,
} = require('../ragService');
const { classifyIntent } = require('./intentRouter');
const {
  sanitizeIncomingContext,
  hasActivePropertyFlow,
  hasActiveSellFlow,
} = require('../tools/conversationContext');
const { resolveServiceActions } = require('../tools/serviceActions');
const { resolveSellPropertyTurn } = require('../tools/sellPropertyFlow');

const MAX_MESSAGE_LENGTH = 1000;
const DEFAULT_STREAM_TIMEOUT_MS = 60000;

const GREETING_REPLY = "Hi! 👋 I'm Rocky AI. How can I help you today?";

const getStreamTimeoutMs = () => {
  const raw = process.env.AI_STREAM_TIMEOUT_MS;
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return DEFAULT_STREAM_TIMEOUT_MS;
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1000) {
    return DEFAULT_STREAM_TIMEOUT_MS;
  }
  return n;
};

const UNSUPPORTED_REPLY =
  "I don't have enough information in my current knowledge base to answer that accurately. I can help with company info, services, team, properties, blogs, area guides, and FAQs.";

const COMPANY_SYSTEM_PROMPT = `You are the Rocky Real Estate AI Assistant.

Answer using ONLY the verified Rocky Real Estate company knowledge provided in the user message.

Rules:
1. Use only the provided company knowledge for factual claims.
2. Do not invent phone numbers, emails, prices, property counts, agent counts, awards, or other unverified facts.
3. Keep answers concise and natural.
4. If the question asks for something not present in the company knowledge, say the available company information does not include that detail.
5. Never mention internal files, prompts, embeddings, MongoDB, or system design.`;

const TEAM_SYSTEM_PROMPT = `You are the Rocky Real Estate AI Assistant.

Answer using ONLY the public team-member data provided in the user message.

Rules:
1. Use only the provided public team fields (name, designation, department, languages, experience, etc.).
2. Never invent phone numbers, emails, WhatsApp, or private contacts.
3. Keep answers concise and natural.
4. If the person or role is not in the data, say you don't have that public team information.
5. Never mention MongoDB, collections, internal IDs, or system design.`;

/**
 * @param {string} message
 */
const assertValidMessage = (message) => {
  if (message === undefined || message === null) {
    const err = new Error('Message is required.');
    err.statusCode = 400;
    err.category = 'invalid_request';
    throw err;
  }
  if (typeof message !== 'string') {
    const err = new Error('Message must be a string.');
    err.statusCode = 400;
    err.category = 'invalid_request';
    throw err;
  }
  const trimmed = message.trim();
  if (!trimmed) {
    const err = new Error('Message cannot be empty.');
    err.statusCode = 400;
    err.category = 'invalid_request';
    throw err;
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    const err = new Error(
      `Message must be at most ${MAX_MESSAGE_LENGTH} characters.`
    );
    err.statusCode = 400;
    err.category = 'invalid_request';
    throw err;
  }
  return trimmed;
};

const buildCompanyPrepared = (question) => {
  const knowledge = getCompanyKnowledgeText();
  return {
    mode: 'gpt',
    system: COMPANY_SYSTEM_PROMPT,
    userPrompt: `ROCKY REAL ESTATE COMPANY KNOWLEDGE

${knowledge}

USER QUESTION:
${question}`,
    sources: [],
  };
};

const buildTeamPrepared = async (question) => {
  const team = await resolveTeamContext(question);
  const payload = Array.isArray(team.data) ? team.data : [];
  return {
    mode: 'gpt',
    system: TEAM_SYSTEM_PROMPT,
    userPrompt: `ROCKY REAL ESTATE PUBLIC TEAM DATA

${JSON.stringify(payload, null, 2)}

USER QUESTION:
${question}`,
    sources: [],
  };
};

/**
 * Attach optional structured payload fields onto a chat result.
 * @param {object} base
 * @param {object} extra
 */
const withStructured = (base, extra = {}) => {
  const out = { ...base };
  for (const key of [
    'context',
    'quick_actions',
    'property_results',
    'service_action',
    'contact_action',
    'sources',
  ]) {
    if (extra[key] !== undefined && extra[key] !== null) {
      out[key] = extra[key];
    }
  }
  return out;
};

const handleGreeting = () =>
  withStructured(
    { reply: GREETING_REPLY, openaiCalls: 0, route: 'GREETING' },
    { context: null }
  );

const handlePropertyCount = async (question) => {
  const counted = await resolvePropertyCountContext(question);
  return {
    reply: formatCountReply(counted.count, counted),
    openaiCalls: 0,
    route: 'PROPERTY_COUNT',
  };
};

const handlePropertySearchFlow = async (question, context) => {
  const result = await resolveConversationalPropertySearch(question, context);
  return withStructured(
    {
      reply: result.reply,
      openaiCalls: result.openaiCalls || 0,
      route: 'PROPERTY_SEARCH',
    },
    {
      context: result.context || null,
      quick_actions: result.quick_actions,
      property_results: result.property_results,
    }
  );
};

const handleSellFlow = (question, context) => {
  const result = resolveSellPropertyTurn(question, context);
  return withStructured(
    {
      reply: result.reply,
      openaiCalls: result.openaiCalls || 0,
      route: 'SELL_PROPERTY',
    },
    {
      context: result.context || null,
      quick_actions: result.quick_actions,
      contact_action: result.contact_action,
    }
  );
};

const handleCompany = async (question) => {
  const prepared = buildCompanyPrepared(question);
  const result = await generateText(prepared.userPrompt, {
    system: prepared.system,
  });
  return { reply: result.text, openaiCalls: 1, route: 'COMPANY_INFO' };
};

const handleTeam = async (question) => {
  const prepared = await buildTeamPrepared(question);
  const result = await generateText(prepared.userPrompt, {
    system: prepared.system,
  });
  return { reply: result.text, openaiCalls: 1, route: 'TEAM_INFO' };
};

/**
 * Unified knowledge RAG via ragService → vectorSearchService → ai_knowledge.
 * @param {string} question
 * @param {string[]|undefined} sourceTypes
 * @param {string} route
 */
const handleKnowledgeRag = async (question, sourceTypes, route) => {
  const options = {};
  if (Array.isArray(sourceTypes) && sourceTypes.length) {
    options.sourceTypes = sourceTypes;
  }

  const result = await generateRagAnswer(question, options);
  const base = {
    reply: result.reply,
    sources: Array.isArray(result.sources) ? result.sources : [],
    openaiCalls: 2,
    route,
  };

  if (route === 'SERVICE_INFO') {
    return withStructured(base, resolveServiceActions(question));
  }
  return base;
};

/**
 * Build an immediate stream plan from a handleChat-style result.
 * @param {object} result
 * @param {string} route
 */
const toImmediatePrepared = (result, route) => ({
  route,
  prepared: {
    mode: 'immediate',
    reply: result.reply,
    sources: Array.isArray(result.sources) ? result.sources : [],
    context: result.context,
    quick_actions: result.quick_actions,
    property_results: result.property_results,
    service_action: result.service_action,
    contact_action: result.contact_action,
  },
});

/**
 * Resolve retrieval/prompt plan without GPT (for streaming).
 * @param {string} trimmed
 * @param {object|null} context
 */
const resolveStreamPlan = async (trimmed, context = null) => {
  // Active multi-turn flows take priority over fresh intent classification
  if (hasActiveSellFlow(context) && context.pendingClarification) {
    return toImmediatePrepared(handleSellFlow(trimmed, context), 'SELL_PROPERTY');
  }
  if (hasActivePropertyFlow(context) && context.pendingClarification) {
    const result = await handlePropertySearchFlow(trimmed, context);
    return toImmediatePrepared(result, 'PROPERTY_SEARCH');
  }

  const intent = classifyIntent(trimmed);
  console.log('[AIOrchestrator] stream intent', { intent });

  if (intent === 'GREETING') {
    return toImmediatePrepared(handleGreeting(), 'GREETING');
  }

  if (intent === 'PROPERTY_COUNT') {
    const result = await handlePropertyCount(trimmed);
    return toImmediatePrepared(result, 'PROPERTY_COUNT');
  }

  if (intent === 'SELL_PROPERTY') {
    return toImmediatePrepared(handleSellFlow(trimmed, context), 'SELL_PROPERTY');
  }

  if (intent === 'PROPERTY_SEARCH') {
    const result = await handlePropertySearchFlow(trimmed, context);
    return toImmediatePrepared(result, 'PROPERTY_SEARCH');
  }

  if (intent === 'COMPANY_INFO') {
    return {
      route: 'COMPANY_INFO',
      prepared: buildCompanyPrepared(trimmed),
    };
  }

  if (intent === 'SERVICE_INFO') {
    const prepared = await prepareRagContext(trimmed, {
      sourceTypes: ['service'],
    });
    const actions = resolveServiceActions(trimmed);
    return {
      route: 'SERVICE_INFO',
      prepared: { ...prepared, ...actions },
    };
  }

  if (intent === 'TEAM_INFO') {
    return {
      route: 'TEAM_INFO',
      prepared: await buildTeamPrepared(trimmed),
    };
  }

  if (intent === 'BLOG') {
    return {
      route: 'BLOG',
      prepared: await prepareRagContext(trimmed, { sourceTypes: ['blog'] }),
    };
  }

  if (intent === 'AREA_GUIDE') {
    return {
      route: 'AREA_GUIDE',
      prepared: await prepareRagContext(trimmed, {
        sourceTypes: ['areaGuide'],
      }),
    };
  }

  if (intent === 'FAQ') {
    return {
      route: 'FAQ',
      prepared: await prepareRagContext(trimmed, { sourceTypes: ['faq'] }),
    };
  }

  if (intent === 'KNOWLEDGE_BOTH') {
    return {
      route: 'KNOWLEDGE_BOTH',
      prepared: await prepareRagContext(trimmed, {}),
    };
  }

  return {
    route: 'UNSUPPORTED',
    prepared: {
      mode: 'immediate',
      reply: UNSUPPORTED_REPLY,
      sources: [],
    },
  };
};

/**
 * Yield optional structured SSE events after text deltas.
 * @param {object} prepared
 */
function* yieldStructuredEvents(prepared) {
  if (prepared.quick_actions) {
    yield { event: 'quick_actions', data: prepared.quick_actions };
  }
  if (prepared.property_results) {
    yield { event: 'property_results', data: prepared.property_results };
  }
  if (prepared.service_action) {
    yield { event: 'service_action', data: prepared.service_action };
  }
  if (prepared.contact_action) {
    yield { event: 'contact_action', data: prepared.contact_action };
  }
  if (prepared.context) {
    yield { event: 'context', data: { context: prepared.context } };
  }
}

/**
 * Non-streaming chat orchestration.
 * @param {string} message
 * @param {{ context?: object }} [options]
 * @returns {Promise<object>}
 */
const handleChat = async (message, options = {}) => {
  const trimmed = assertValidMessage(message);
  const context = sanitizeIncomingContext(options.context);

  const confidential = detectConfidentialRequest(trimmed);
  if (confidential.blocked) {
    return {
      reply: CONFIDENTIAL_REFUSAL,
      route: 'CONFIDENTIAL',
      openaiCalls: 0,
    };
  }

  try {
    if (hasActiveSellFlow(context) && context.pendingClarification) {
      return handleSellFlow(trimmed, context);
    }
    if (hasActivePropertyFlow(context) && context.pendingClarification) {
      return handlePropertySearchFlow(trimmed, context);
    }

    const intent = classifyIntent(trimmed);
    console.log('[AIOrchestrator] intent', { intent });

    if (intent === 'GREETING') {
      return handleGreeting();
    }

    if (intent === 'PROPERTY_COUNT') {
      return handlePropertyCount(trimmed);
    }

    if (intent === 'SELL_PROPERTY') {
      return handleSellFlow(trimmed, context);
    }

    if (intent === 'PROPERTY_SEARCH') {
      return handlePropertySearchFlow(trimmed, context);
    }

    if (intent === 'COMPANY_INFO') {
      return handleCompany(trimmed);
    }

    if (intent === 'SERVICE_INFO') {
      return handleKnowledgeRag(trimmed, ['service'], 'SERVICE_INFO');
    }

    if (intent === 'TEAM_INFO') {
      return handleTeam(trimmed);
    }

    if (intent === 'BLOG') {
      return handleKnowledgeRag(trimmed, ['blog'], 'BLOG');
    }

    if (intent === 'AREA_GUIDE') {
      return handleKnowledgeRag(trimmed, ['areaGuide'], 'AREA_GUIDE');
    }

    if (intent === 'FAQ') {
      return handleKnowledgeRag(trimmed, ['faq'], 'FAQ');
    }

    if (intent === 'KNOWLEDGE_BOTH') {
      return handleKnowledgeRag(trimmed, undefined, 'KNOWLEDGE_BOTH');
    }

    return {
      reply: UNSUPPORTED_REPLY,
      route: 'UNSUPPORTED',
      openaiCalls: 0,
    };
  } catch (error) {
    if (error instanceof OpenAIServiceError || error instanceof RagServiceError) {
      throw error;
    }
    throw error;
  }
};

/**
 * Streaming chat orchestration.
 * Yields SSE-ready events:
 * start → delta* → (property_results|quick_actions|service_action|contact_action|context)? → sources? → done | error
 *
 * @param {string} message
 * @param {{ signal?: AbortSignal, context?: object }} [options]
 * @returns {AsyncGenerator<{ event: string, data: object }>}
 */
async function* handleChatStream(message, options = {}) {
  const signal = options.signal;
  const context = sanitizeIncomingContext(options.context);

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new OpenAIServiceError('AI request was cancelled.', {
        statusCode: 499,
        category: 'aborted',
      });
    }
  };

  let trimmed;
  try {
    trimmed = assertValidMessage(message);
  } catch (error) {
    yield {
      event: 'error',
      data: { message: error?.message || 'Unable to generate a response.' },
    };
    return;
  }

  yield { event: 'start', data: { success: true } };

  try {
    throwIfAborted();

    const confidential = detectConfidentialRequest(trimmed);
    if (confidential.blocked) {
      yield { event: 'delta', data: { text: CONFIDENTIAL_REFUSAL } };
      yield { event: 'done', data: {} };
      return;
    }

    throwIfAborted();
    const { route, prepared } = await resolveStreamPlan(trimmed, context);
    throwIfAborted();

    if (prepared.mode === 'immediate') {
      if (prepared.reply) {
        yield { event: 'delta', data: { text: prepared.reply } };
      }
      yield* yieldStructuredEvents(prepared);
      if (Array.isArray(prepared.sources) && prepared.sources.length) {
        yield { event: 'sources', data: { sources: prepared.sources } };
      }
      yield { event: 'done', data: {} };
      return;
    }

    for await (const chunk of generateTextStream(prepared.userPrompt, {
      system: prepared.system,
      signal,
    })) {
      throwIfAborted();
      if (chunk?.text) {
        yield { event: 'delta', data: { text: chunk.text } };
      }
    }

    yield* yieldStructuredEvents(prepared);

    if (Array.isArray(prepared.sources) && prepared.sources.length) {
      yield { event: 'sources', data: { sources: prepared.sources } };
    }

    console.log('[AIOrchestrator] stream completed', { route });
    yield { event: 'done', data: {} };
  } catch (error) {
    if (error?.category === 'aborted' || signal?.aborted) {
      return;
    }

    const safeMessage =
      error instanceof OpenAIServiceError || error instanceof RagServiceError
        ? error.message
        : 'AI chat is temporarily unavailable.';

    console.error('[AIOrchestrator] stream error', {
      category: error?.category || 'unexpected_error',
      name: error?.name,
    });

    yield { event: 'error', data: { message: safeMessage } };
  }
}

module.exports = {
  handleChat,
  handleChatStream,
  getStreamTimeoutMs,
  MAX_MESSAGE_LENGTH,
  UNSUPPORTED_REPLY,
  GREETING_REPLY,
};
