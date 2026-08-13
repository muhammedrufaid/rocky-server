/**
 * AI chat orchestrator — conversion-first Rocky AI.
 *
 * Flow: confidential → active context → conversion → intent → tools / RAG
 * Knowledge RAG uses ONLY src/ai/ragService.js (unified ai_knowledge path).
 *
 * Structured events (property_results, quick_actions, …) emit after deltas.
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
  detectListingType,
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
const {
  resolveConversionTurn,
  knowledgeNextActions,
  buildGreetingResult,
} = require('../tools/conversionFlow');
const {
  detectConversionAction,
  detectHighIntent,
} = require('../tools/highIntent');
const {
  knowledgeAreaQuickActions,
  greetingQuickActions,
} = require('../tools/quickActions');

const MAX_MESSAGE_LENGTH = 1000;
const DEFAULT_STREAM_TIMEOUT_MS = 60000;

const GREETING_REPLY = "Hi 👋 I'm Rocky AI. How can I help you today?";

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
  "I don't have enough information in my current knowledge base to answer that accurately. I can help with buying, renting, off-plan, selling, services, areas, and FAQs.";

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
  const next = knowledgeNextActions('COMPANY_INFO');
  return {
    mode: 'gpt',
    system: COMPANY_SYSTEM_PROMPT,
    userPrompt: `ROCKY REAL ESTATE COMPANY KNOWLEDGE

${knowledge}

USER QUESTION:
${question}`,
    sources: [],
    ...next,
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
    ...knowledgeNextActions('TEAM_INFO'),
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
    'whatsapp_action',
    'sources',
  ]) {
    if (extra[key] !== undefined && extra[key] !== null) {
      out[key] = extra[key];
    }
  }
  return out;
};

const handleGreeting = () => buildGreetingResult();

const handlePropertyCount = async (question) => {
  const counted = await resolvePropertyCountContext(question);
  return withStructured(
    {
      reply: formatCountReply(counted.count, counted),
      openaiCalls: 0,
      route: 'PROPERTY_COUNT',
    },
    {
      quick_actions: greetingQuickActions(),
      context: { intent: 'PROPERTY_COUNT', conversionIntent: 'low' },
    }
  );
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
      contact_action: result.contact_action,
      whatsapp_action: result.whatsapp_action,
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
      whatsapp_action: result.whatsapp_action,
    }
  );
};

const handleCompany = async (question) => {
  const prepared = buildCompanyPrepared(question);
  const result = await generateText(prepared.userPrompt, {
    system: prepared.system,
  });
  return withStructured(
    { reply: result.text, openaiCalls: 1, route: 'COMPANY_INFO' },
    {
      quick_actions: prepared.quick_actions,
      contact_action: prepared.contact_action,
      whatsapp_action: prepared.whatsapp_action,
    }
  );
};

const handleTeam = async (question) => {
  const prepared = await buildTeamPrepared(question);
  const result = await generateText(prepared.userPrompt, {
    system: prepared.system,
  });
  return withStructured(
    { reply: result.text, openaiCalls: 1, route: 'TEAM_INFO' },
    {
      quick_actions: prepared.quick_actions,
      contact_action: prepared.contact_action,
      whatsapp_action: prepared.whatsapp_action,
    }
  );
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

  return withStructured(base, knowledgeNextActions(route));
};

/**
 * Map starter phrases that should enter property/sell/service flows.
 * @param {string} trimmed
 * @param {object|null} context
 */
const tryStarterRoute = async (trimmed, context) => {
  const lower = trimmed.toLowerCase();

  if (lower === 'sell my property' || lower === 'sell property') {
    return handleSellFlow(trimmed, context);
  }
  if (lower === 'property management') {
    return handleKnowledgeRag(trimmed, ['service'], 'SERVICE_INFO');
  }
  if (lower === 'brokerage') {
    return handleKnowledgeRag(trimmed, ['service'], 'SERVICE_INFO');
  }
  if (
    lower === 'property listing & marketing' ||
    lower === 'property listing and marketing'
  ) {
    return handleKnowledgeRag(
      'Tell me about property listing and marketing',
      ['service'],
      'SERVICE_INFO'
    );
  }
  if (lower === 'explore dubai areas' || lower === 'view properties') {
    if (lower === 'explore dubai areas') {
      return handleKnowledgeRag(
        'What are the best areas in Dubai?',
        ['areaGuide'],
        'AREA_GUIDE'
      );
    }
    return handlePropertySearchFlow('Buy a Property', context);
  }

  if (detectListingType(trimmed)) {
    return handlePropertySearchFlow(trimmed, context);
  }

  return null;
};

/**
 * Build an immediate stream plan from a handleChat-style result.
 * @param {object} result
 * @param {string} route
 */
const toImmediatePrepared = (result, route) => ({
  route: result.route || route,
  prepared: {
    mode: 'immediate',
    reply: result.reply,
    sources: Array.isArray(result.sources) ? result.sources : [],
    context: result.context,
    quick_actions: result.quick_actions,
    property_results: result.property_results,
    service_action: result.service_action,
    contact_action: result.contact_action,
    whatsapp_action: result.whatsapp_action,
  },
});

/**
 * Core routing shared by chat + stream.
 * @param {string} trimmed
 * @param {object|null} context
 */
const resolveChatResult = async (trimmed, context = null) => {
  // Active multi-turn flows
  if (hasActiveSellFlow(context) && context.pendingClarification) {
    return handleSellFlow(trimmed, context);
  }

  // Conversion / high-intent before property clarification when user clearly converts
  const conversionAction = detectConversionAction(trimmed);
  const highIntent = detectHighIntent(trimmed);
  if (
    conversionAction === 'whatsapp' ||
    conversionAction === 'agent' ||
    conversionAction === 'viewing' ||
    (highIntent &&
      (context?.recentProperties?.length || context?.selectedProperty))
  ) {
    const conversion = resolveConversionTurn(trimmed, context);
    if (conversion) return conversion;
  }

  // Change search / area / budget / view more stay in property flow
  if (
    hasActivePropertyFlow(context) &&
    (context.pendingClarification ||
      conversionAction === 'view_more' ||
      conversionAction === 'change_search' ||
      conversionAction === 'change_area' ||
      conversionAction === 'change_budget' ||
      detectListingType(trimmed) ||
      context.pendingClarification)
  ) {
    if (conversionAction === 'view_more' && context.listingType && context.search) {
      return handlePropertySearchFlow(
        // Re-run with same criteria by sending a synthetic complete message path
        `${context.listingType} ${context.filters?.propertyType || ''} ${context.filters?.bedrooms || ''} bedroom in ${context.search}`.trim(),
        {
          ...context,
          pendingClarification: null,
        }
      );
    }
    if (
      context.pendingClarification ||
      conversionAction === 'change_search' ||
      conversionAction === 'change_area' ||
      conversionAction === 'change_budget'
    ) {
      return handlePropertySearchFlow(trimmed, context);
    }
  }

  if (hasActivePropertyFlow(context) && context.pendingClarification) {
    return handlePropertySearchFlow(trimmed, context);
  }

  const starter = await tryStarterRoute(trimmed, context);
  if (starter) return starter;

  const intent = classifyIntent(trimmed);
  console.log('[AIOrchestrator] intent', { intent });

  if (intent === 'GREETING') {
    return handleGreeting();
  }

  if (intent === 'CONVERSION') {
    const conversion = resolveConversionTurn(trimmed, context);
    if (conversion) return conversion;
    // Fallback: open agent CTA
    return resolveConversionTurn('Talk to an Agent', context);
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

  return withStructured(
    {
      reply: UNSUPPORTED_REPLY,
      route: 'UNSUPPORTED',
      openaiCalls: 0,
    },
    {
      quick_actions: greetingQuickActions(),
    }
  );
};

/**
 * Resolve retrieval/prompt plan without GPT (for streaming).
 * @param {string} trimmed
 * @param {object|null} context
 */
const resolveStreamPlan = async (trimmed, context = null) => {
  // GPT routes still need prepared prompts
  if (hasActiveSellFlow(context) && context.pendingClarification) {
    return toImmediatePrepared(handleSellFlow(trimmed, context), 'SELL_PROPERTY');
  }

  const conversionAction = detectConversionAction(trimmed);
  const highIntent = detectHighIntent(trimmed);
  if (
    conversionAction === 'whatsapp' ||
    conversionAction === 'agent' ||
    conversionAction === 'viewing' ||
    (highIntent &&
      (context?.recentProperties?.length || context?.selectedProperty))
  ) {
    const conversion = resolveConversionTurn(trimmed, context);
    if (conversion) return toImmediatePrepared(conversion, 'CONVERSION');
  }

  if (hasActivePropertyFlow(context) && context.pendingClarification) {
    const result = await handlePropertySearchFlow(trimmed, context);
    return toImmediatePrepared(result, 'PROPERTY_SEARCH');
  }

  const starter = await tryStarterRoute(trimmed, context);
  if (starter) {
    // Starter may be RAG (service) — if it has openai path via handleKnowledgeRag it's already resolved text
    // handleKnowledgeRag is async and returns final reply — treat as immediate for stream of final text
    // For SERVICE_INFO from starter we already called RAG (non-stream). Prefer re-prepare for stream.
    const lower = trimmed.toLowerCase();
    if (
      lower === 'property management' ||
      lower === 'brokerage' ||
      lower === 'property listing & marketing' ||
      lower === 'property listing and marketing'
    ) {
      const prepared = await prepareRagContext(
        lower.includes('listing')
          ? 'Tell me about property listing and marketing'
          : trimmed,
        { sourceTypes: ['service'] }
      );
      const actions = resolveServiceActions(
        lower.includes('listing')
          ? 'property listing and marketing'
          : trimmed
      );
      return {
        route: 'SERVICE_INFO',
        prepared: { ...prepared, ...actions },
      };
    }
    if (lower === 'explore dubai areas') {
      const prepared = await prepareRagContext('What are the best areas in Dubai?', {
        sourceTypes: ['areaGuide'],
      });
      return {
        route: 'AREA_GUIDE',
        prepared: { ...prepared, ...knowledgeNextActions('AREA_GUIDE') },
      };
    }
    return toImmediatePrepared(starter, starter.route || 'PROPERTY_SEARCH');
  }

  const intent = classifyIntent(trimmed);
  console.log('[AIOrchestrator] stream intent', { intent });

  if (intent === 'GREETING') {
    return toImmediatePrepared(handleGreeting(), 'GREETING');
  }

  if (intent === 'CONVERSION') {
    const conversion =
      resolveConversionTurn(trimmed, context) ||
      resolveConversionTurn('Talk to an Agent', context);
    return toImmediatePrepared(conversion, 'CONVERSION');
  }

  if (intent === 'PROPERTY_COUNT') {
    return toImmediatePrepared(await handlePropertyCount(trimmed), 'PROPERTY_COUNT');
  }

  if (intent === 'SELL_PROPERTY') {
    return toImmediatePrepared(handleSellFlow(trimmed, context), 'SELL_PROPERTY');
  }

  if (intent === 'PROPERTY_SEARCH') {
    return toImmediatePrepared(
      await handlePropertySearchFlow(trimmed, context),
      'PROPERTY_SEARCH'
    );
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
    const prepared = await prepareRagContext(trimmed, { sourceTypes: ['blog'] });
    return {
      route: 'BLOG',
      prepared: { ...prepared, ...knowledgeNextActions('BLOG') },
    };
  }

  if (intent === 'AREA_GUIDE') {
    const prepared = await prepareRagContext(trimmed, {
      sourceTypes: ['areaGuide'],
    });
    return {
      route: 'AREA_GUIDE',
      prepared: {
        ...prepared,
        ...knowledgeNextActions('AREA_GUIDE'),
        quick_actions: knowledgeAreaQuickActions(),
      },
    };
  }

  if (intent === 'FAQ') {
    const prepared = await prepareRagContext(trimmed, { sourceTypes: ['faq'] });
    return {
      route: 'FAQ',
      prepared: { ...prepared, ...knowledgeNextActions('FAQ') },
    };
  }

  if (intent === 'KNOWLEDGE_BOTH') {
    const prepared = await prepareRagContext(trimmed, {});
    return {
      route: 'KNOWLEDGE_BOTH',
      prepared: { ...prepared, ...knowledgeNextActions('KNOWLEDGE_BOTH') },
    };
  }

  return toImmediatePrepared(
    withStructured(
      { reply: UNSUPPORTED_REPLY, openaiCalls: 0, route: 'UNSUPPORTED' },
      { quick_actions: greetingQuickActions() }
    ),
    'UNSUPPORTED'
  );
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
  if (prepared.whatsapp_action) {
    yield { event: 'whatsapp_action', data: prepared.whatsapp_action };
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
    return await resolveChatResult(trimmed, context);
  } catch (error) {
    if (error instanceof OpenAIServiceError || error instanceof RagServiceError) {
      throw error;
    }
    throw error;
  }
};

/**
 * Streaming chat orchestration.
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
