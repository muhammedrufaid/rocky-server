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
  getActiveServices,
  findActiveService,
  extractServiceQuery,
} = require('../tools/serviceTools');
const { resolveTeamContext } = require('../tools/teamTools');
const {
  getPropertyCount,
  resolvePropertySearchContext,
  formatCountReply,
} = require('../tools/propertyTools');
const {
  generateBlogAnswer,
  prepareBlogRagContext,
} = require('../../services/blogRagService');
const {
  generateKnowledgeAnswer,
  prepareKnowledgeRagContext,
} = require('../../services/knowledgeRagService');
const { classifyIntent } = require('./intentRouter');

/** Default stream timeout (ms). Override with AI_STREAM_TIMEOUT_MS. */
const DEFAULT_STREAM_TIMEOUT_MS = 60000;

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

const MAX_MESSAGE_LENGTH = 1000;

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

const SERVICES_SYSTEM_PROMPT = `You are the Rocky Real Estate AI Assistant.

Answer using ONLY the public services data provided in the user message.

Rules:
1. Use only the provided services data.
2. Do not invent services, fees, or guarantees.
3. Keep answers concise and natural.
4. If a requested service is not in the data, say it is not listed in the available public services.
5. Never mention MongoDB, collections, internal IDs, or system design.
6. Never include phone numbers, emails, or private contacts.`;

const TEAM_SYSTEM_PROMPT = `You are the Rocky Real Estate AI Assistant.

Answer using ONLY the public team-member data provided in the user message.

Rules:
1. Use only the provided public team fields (name, designation, department, languages, experience, etc.).
2. Never invent or request phone numbers, emails, WhatsApp numbers, or other private contact details.
3. Do not mention isAdmin, MongoDB, collections, or internal IDs.
4. Keep answers concise and natural.
5. When listing people, include each person's designation when available (for example Property Consultant).
6. If no matching public team member is found, say so clearly.`;

const PROPERTY_SEARCH_SYSTEM_PROMPT = `You are the Rocky Real Estate AI Assistant.

Answer using ONLY the public property search results provided in the user message.

Rules:
1. Use only the provided public property fields (title, type, locality, price, bedrooms, etc.).
2. Never invent prices, locations, availability, or property counts.
3. Never include or invent owner details, agent phone numbers, emails, or WhatsApp contacts.
4. Keep answers concise. Summarize the returned listings clearly.
5. If totalMatches is greater than the number of listings shown, mention that more public listings are available.
6. If no listings were found, say so clearly without inventing alternatives.
7. Never mention MongoDB, collections, embeddings, or system design.`;

/**
 * @param {unknown} message
 * @returns {string}
 */
const validateMessage = (message) => {
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
    const err = new Error(`Message must be at most ${MAX_MESSAGE_LENGTH} characters.`);
    err.statusCode = 400;
    err.category = 'invalid_request';
    throw err;
  }

  return trimmed;
};

/**
 * Prepare GPT prompts / immediate replies without calling OpenAI.
 * Shared by non-streaming and streaming paths.
 */

const prepareCompanyContext = (question) => {
  const knowledge = getCompanyKnowledgeText();
  const userPrompt = `ROCKY REAL ESTATE COMPANY KNOWLEDGE

${knowledge}

USER QUESTION:
${question}

Answer the question using only the company knowledge above.`;

  return {
    mode: 'gpt',
    system: COMPANY_SYSTEM_PROMPT,
    userPrompt,
    sources: [],
    collectionsAccessed: [],
  };
};

const prepareServicesContext = async (question) => {
  const serviceQuery = extractServiceQuery(question);
  let payload;
  let mode;

  if (serviceQuery) {
    const found = await findActiveService(serviceQuery);
    if (found.data) {
      payload = found.data;
      mode = 'single';
    }
  }

  if (!payload) {
    const all = await getActiveServices();
    payload = all.data;
    mode = 'list';
  }

  const userPrompt = `ROCKY REAL ESTATE PUBLIC SERVICES DATA (${mode})

${JSON.stringify(payload, null, 2)}

USER QUESTION:
${question}

Answer using only this public services data.`;

  return {
    mode: 'gpt',
    system: SERVICES_SYSTEM_PROMPT,
    userPrompt,
    sources: [],
    collectionsAccessed: ['services'],
  };
};

const prepareTeamContext = async (question) => {
  const team = await resolveTeamContext(question);
  const payload = team.data || [];

  const userPrompt = `ROCKY REAL ESTATE PUBLIC TEAM DATA

${JSON.stringify(payload, null, 2)}

USER QUESTION:
${question}

Answer using only this public team data. Do not include or invent phone, email, or WhatsApp details.`;

  return {
    mode: 'gpt',
    system: TEAM_SYSTEM_PROMPT,
    userPrompt,
    sources: [],
    collectionsAccessed: ['teammembers'],
  };
};

/**
 * Deterministic count — no GPT rephrasing.
 */
const preparePropertyCountContext = async () => {
  const { count } = await getPropertyCount();
  return {
    mode: 'immediate',
    reply: formatCountReply(count),
    sources: [],
    collectionsAccessed: ['properties'],
    count,
  };
};

const preparePropertySearchContext = async (question) => {
  const result = await resolvePropertySearchContext(question);
  const payload = {
    totalMatches: result.total,
    shown: result.properties.length,
    limit: result.limit,
    filtersApplied: result.filters,
    searchApplied: result.search || null,
    listings: result.properties,
  };

  const userPrompt = `ROCKY REAL ESTATE PUBLIC PROPERTY SEARCH RESULTS

${JSON.stringify(payload, null, 2)}

USER QUESTION:
${question}

Summarize these public listings only. Do not invent properties or prices. Do not include agent/owner contact details.`;

  return {
    mode: 'gpt',
    system: PROPERTY_SEARCH_SYSTEM_PROMPT,
    userPrompt,
    sources: [],
    collectionsAccessed: ['properties'],
    total: result.total,
  };
};

const prepareBlogContext = async (question) => {
  const prepared = await prepareBlogRagContext(question);
  if (prepared.mode === 'immediate') {
    return {
      mode: 'immediate',
      reply: prepared.answer,
      sources: [],
      collectionsAccessed: ['blog_embeddings'],
      timingsDetail: prepared.timings,
      usedGpt: false,
    };
  }
  return {
    mode: 'gpt',
    system: prepared.system,
    userPrompt: prepared.userPrompt,
    sources: prepared.sources || [],
    collectionsAccessed: ['blog_embeddings'],
    timingsDetail: prepared.timings,
    usedGpt: true,
  };
};

const prepareKnowledgeContext = async (question, sourceType) => {
  const prepared = await prepareKnowledgeRagContext(question, {
    sourceType,
    skipGuards: true,
  });
  if (prepared.mode === 'immediate') {
    return {
      mode: 'immediate',
      reply: prepared.answer,
      sources: prepared.sources || [],
      collectionsAccessed: ['knowledge_embeddings'],
      timingsDetail: prepared.timings,
      usedGpt: false,
      sourceSelection: prepared.sourceSelection,
    };
  }
  return {
    mode: 'gpt',
    system: prepared.system,
    userPrompt: prepared.userPrompt,
    sources: prepared.sources || [],
    collectionsAccessed: ['knowledge_embeddings'],
    timingsDetail: prepared.timings,
    usedGpt: true,
    sourceSelection: prepared.sourceSelection,
  };
};

const answerFromCompanyKnowledge = async (question) => {
  const prepared = prepareCompanyContext(question);
  const result = await generateText(prepared.userPrompt, { system: prepared.system });
  return { reply: result.text, gptMs: result.durationMs };
};

const answerFromServices = async (question) => {
  const prepared = await prepareServicesContext(question);
  const result = await generateText(prepared.userPrompt, { system: prepared.system });
  return {
    reply: result.text,
    gptMs: result.durationMs,
    collectionsAccessed: prepared.collectionsAccessed,
  };
};

const answerFromTeam = async (question) => {
  const prepared = await prepareTeamContext(question);
  const result = await generateText(prepared.userPrompt, { system: prepared.system });
  return {
    reply: result.text,
    gptMs: result.durationMs,
    collectionsAccessed: prepared.collectionsAccessed,
  };
};

const answerFromPropertyCount = async () => {
  const prepared = await preparePropertyCountContext();
  return {
    reply: prepared.reply,
    gptMs: 0,
    collectionsAccessed: prepared.collectionsAccessed,
    count: prepared.count,
  };
};

const answerFromPropertySearch = async (question) => {
  const prepared = await preparePropertySearchContext(question);
  const gpt = await generateText(prepared.userPrompt, { system: prepared.system });
  return {
    reply: gpt.text,
    gptMs: gpt.durationMs,
    collectionsAccessed: prepared.collectionsAccessed,
    total: prepared.total,
  };
};

const answerFromBlog = async (question) => {
  const result = await generateBlogAnswer(question);
  return {
    reply: result.answer,
    gptMs: result.timings?.gptMs || 0,
    collectionsAccessed: ['blog_embeddings'],
    sources: result.sources || [],
    timingsDetail: result.timings,
    usedGpt: result.usedGpt,
  };
};

const answerFromKnowledge = async (question, sourceType) => {
  const result = await generateKnowledgeAnswer(question, {
    sourceType,
    skipGuards: true, // confidential + dynamic already handled upstream
  });
  return {
    reply: result.answer,
    gptMs: result.timings?.gptMs || 0,
    collectionsAccessed: ['knowledge_embeddings'],
    sources: result.sources || [],
    timingsDetail: result.timings,
    usedGpt: result.usedGpt,
    sourceSelection: result.sourceSelection,
  };
};

/**
 * Phase 1–4 orchestrator.
 * Allowlisted: company.md, services, teammembers, properties,
 * blog_embeddings, knowledge_embeddings.
 *
 * @param {string} message
 */
const handleChat = async (message) => {
  const totalStarted = Date.now();
  const trimmed = validateMessage(message);

  console.log('[AIOrchestrator] request started', {
    messageLength: trimmed.length,
  });

  const confidential = detectConfidentialRequest(trimmed);
  if (confidential.blocked) {
    const totalMs = Date.now() - totalStarted;
    console.log('[AIOrchestrator] blocked confidential request', {
      reason: confidential.reason,
      totalMs,
    });

    return {
      reply: CONFIDENTIAL_REFUSAL,
      route: 'CONFIDENTIAL',
      usedGpt: false,
      mongoQueried: false,
      collectionsAccessed: [],
      sources: [],
      timings: { gptMs: 0, totalMs },
    };
  }

  const intentStarted = Date.now();
  const intent = classifyIntent(trimmed);
  const intentMs = Date.now() - intentStarted;
  console.log('[AIOrchestrator] intent classified', { intent, intentMs });

  try {
    if (intent === 'PROPERTY_COUNT') {
      const { reply, gptMs, collectionsAccessed, count } = await answerFromPropertyCount();
      const totalMs = Date.now() - totalStarted;
      console.log('[AIOrchestrator] property count completed', {
        count,
        gptMs,
        totalMs,
        collectionsAccessed,
      });
      return {
        reply,
        route: 'PROPERTY_COUNT',
        usedGpt: false,
        mongoQueried: true,
        collectionsAccessed,
        sources: [],
        timings: { intentMs, gptMs, totalMs },
      };
    }

    if (intent === 'PROPERTY_SEARCH') {
      const { reply, gptMs, collectionsAccessed, total } = await answerFromPropertySearch(trimmed);
      const totalMs = Date.now() - totalStarted;
      console.log('[AIOrchestrator] property search completed', {
        total,
        gptMs,
        totalMs,
        collectionsAccessed,
      });
      return {
        reply,
        route: 'PROPERTY_SEARCH',
        usedGpt: true,
        mongoQueried: true,
        collectionsAccessed,
        sources: [],
        timings: { intentMs, gptMs, totalMs },
      };
    }

    if (intent === 'COMPANY_INFO') {
      const { reply, gptMs } = await answerFromCompanyKnowledge(trimmed);
      const totalMs = Date.now() - totalStarted;
      console.log('[AIOrchestrator] company answer completed', { gptMs, totalMs });
      return {
        reply,
        route: 'COMPANY_INFO',
        usedGpt: true,
        mongoQueried: false,
        collectionsAccessed: [],
        sources: [],
        timings: { intentMs, gptMs, totalMs },
      };
    }

    if (intent === 'SERVICE_INFO') {
      const { reply, gptMs, collectionsAccessed } = await answerFromServices(trimmed);
      const totalMs = Date.now() - totalStarted;
      console.log('[AIOrchestrator] services answer completed', {
        gptMs,
        totalMs,
        collectionsAccessed,
      });
      return {
        reply,
        route: 'SERVICE_INFO',
        usedGpt: true,
        mongoQueried: true,
        collectionsAccessed,
        sources: [],
        timings: { intentMs, gptMs, totalMs },
      };
    }

    if (intent === 'TEAM_INFO') {
      const { reply, gptMs, collectionsAccessed } = await answerFromTeam(trimmed);
      const totalMs = Date.now() - totalStarted;
      console.log('[AIOrchestrator] team answer completed', {
        gptMs,
        totalMs,
        collectionsAccessed,
      });
      return {
        reply,
        route: 'TEAM_INFO',
        usedGpt: true,
        mongoQueried: true,
        collectionsAccessed,
        sources: [],
        timings: { intentMs, gptMs, totalMs },
      };
    }

    if (intent === 'BLOG') {
      const result = await answerFromBlog(trimmed);
      const totalMs = Date.now() - totalStarted;
      console.log('[AIOrchestrator] blog answer completed', {
        gptMs: result.gptMs,
        totalMs,
      });
      return {
        reply: result.reply,
        route: 'BLOG',
        usedGpt: result.usedGpt,
        mongoQueried: true,
        collectionsAccessed: result.collectionsAccessed,
        sources: result.sources,
        timings: {
          intentMs,
          embeddingMs: result.timingsDetail?.embeddingMs,
          vectorSearchMs: result.timingsDetail?.vectorSearchMs,
          gptMs: result.gptMs,
          totalMs,
        },
      };
    }

    if (intent === 'AREA_GUIDE' || intent === 'FAQ' || intent === 'KNOWLEDGE_BOTH') {
      const sourceType =
        intent === 'AREA_GUIDE' ? 'area_guide' : intent === 'FAQ' ? 'faq' : 'both';
      const result = await answerFromKnowledge(trimmed, sourceType);
      const totalMs = Date.now() - totalStarted;
      console.log('[AIOrchestrator] knowledge answer completed', {
        intent,
        sourceType,
        gptMs: result.gptMs,
        totalMs,
      });
      return {
        reply: result.reply,
        route: intent,
        usedGpt: result.usedGpt,
        mongoQueried: true,
        collectionsAccessed: result.collectionsAccessed,
        sources: result.sources,
        timings: {
          intentMs,
          embeddingMs: result.timingsDetail?.embeddingMs,
          vectorSearchMs: result.timingsDetail?.vectorSearchMs,
          gptMs: result.gptMs,
          totalMs,
        },
      };
    }
  } catch (error) {
    if (error instanceof OpenAIServiceError) throw error;
    throw error;
  }

  const totalMs = Date.now() - totalStarted;
  console.log('[AIOrchestrator] unsupported route', { totalMs });

  return {
    reply: UNSUPPORTED_REPLY,
    route: 'UNSUPPORTED',
    usedGpt: false,
    mongoQueried: false,
    collectionsAccessed: [],
    sources: [],
    timings: { intentMs, gptMs: 0, totalMs },
  };
};

/**
 * Resolve the same routing/retrieval plan as handleChat, without GPT generation.
 * Used by the streaming path so delivery differs but answers share one source of truth.
 *
 * @param {string} trimmed
 * @returns {Promise<{
 *   route: string,
 *   prepared: object,
 *   intentMs: number,
 * }>}
 */
const resolveStreamPlan = async (trimmed) => {
  const intentStarted = Date.now();
  const intent = classifyIntent(trimmed);
  const intentMs = Date.now() - intentStarted;
  console.log('[AIOrchestrator] stream intent classified', { intent, intentMs });

  if (intent === 'PROPERTY_COUNT') {
    const prepared = await preparePropertyCountContext();
    return { route: 'PROPERTY_COUNT', prepared, intentMs };
  }

  if (intent === 'PROPERTY_SEARCH') {
    const prepared = await preparePropertySearchContext(trimmed);
    return { route: 'PROPERTY_SEARCH', prepared, intentMs };
  }

  if (intent === 'COMPANY_INFO') {
    return {
      route: 'COMPANY_INFO',
      prepared: prepareCompanyContext(trimmed),
      intentMs,
    };
  }

  if (intent === 'SERVICE_INFO') {
    const prepared = await prepareServicesContext(trimmed);
    return { route: 'SERVICE_INFO', prepared, intentMs };
  }

  if (intent === 'TEAM_INFO') {
    const prepared = await prepareTeamContext(trimmed);
    return { route: 'TEAM_INFO', prepared, intentMs };
  }

  if (intent === 'BLOG') {
    const prepared = await prepareBlogContext(trimmed);
    return { route: 'BLOG', prepared, intentMs };
  }

  if (intent === 'AREA_GUIDE' || intent === 'FAQ' || intent === 'KNOWLEDGE_BOTH') {
    const sourceType =
      intent === 'AREA_GUIDE' ? 'area_guide' : intent === 'FAQ' ? 'faq' : 'both';
    const prepared = await prepareKnowledgeContext(trimmed, sourceType);
    return { route: intent, prepared, intentMs };
  }

  return {
    route: 'UNSUPPORTED',
    prepared: {
      mode: 'immediate',
      reply: UNSUPPORTED_REPLY,
      sources: [],
      collectionsAccessed: [],
      usedGpt: false,
    },
    intentMs,
  };
};

/**
 * Streaming chat orchestration.
 * Yields SSE-ready events: start → delta* → sources? → done | error
 * Reuses the same intent + retrieval + prompts as handleChat; only final GPT streams.
 *
 * @param {string} message
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {AsyncGenerator<{ event: string, data: object }>}
 */
async function* handleChatStream(message, options = {}) {
  const totalStarted = Date.now();
  const signal = options.signal;

  const throwIfAborted = () => {
    if (signal?.aborted) {
      const err = new OpenAIServiceError('AI request was cancelled.', {
        statusCode: 499,
        category: 'aborted',
      });
      throw err;
    }
  };

  let trimmed;
  try {
    trimmed = validateMessage(message);
  } catch (error) {
    yield {
      event: 'error',
      data: {
        success: false,
        message: error?.message || 'Unable to generate a response.',
      },
    };
    return;
  }

  console.log('[AIOrchestrator] stream request started', {
    messageLength: trimmed.length,
  });

  yield { event: 'start', data: { success: true } };

  try {
    throwIfAborted();

    const confidential = detectConfidentialRequest(trimmed);
    if (confidential.blocked) {
      const totalMs = Date.now() - totalStarted;
      console.log('[AIOrchestrator] stream blocked confidential', {
        reason: confidential.reason,
        totalMs,
      });
      yield { event: 'delta', data: { text: CONFIDENTIAL_REFUSAL } };
      yield { event: 'done', data: { success: true } };
      return;
    }

    throwIfAborted();
    const { route, prepared, intentMs } = await resolveStreamPlan(trimmed);
    throwIfAborted();

    if (prepared.mode === 'immediate') {
      if (prepared.reply) {
        yield { event: 'delta', data: { text: prepared.reply } };
      }
      if (Array.isArray(prepared.sources) && prepared.sources.length) {
        yield { event: 'sources', data: { sources: prepared.sources } };
      }
      const totalMs = Date.now() - totalStarted;
      console.log('[AIOrchestrator] stream immediate completed', {
        route,
        intentMs,
        totalMs,
        collectionsAccessed: prepared.collectionsAccessed || [],
      });
      yield { event: 'done', data: { success: true } };
      return;
    }

    // GPT streaming path — retrieval already finished; only answer tokens stream
    let deltaCount = 0;
    const gptStarted = Date.now();

    for await (const chunk of generateTextStream(prepared.userPrompt, {
      system: prepared.system,
      signal,
    })) {
      throwIfAborted();
      if (chunk.text) {
        deltaCount += 1;
        yield { event: 'delta', data: { text: chunk.text } };
      }
    }

    if (Array.isArray(prepared.sources) && prepared.sources.length) {
      yield { event: 'sources', data: { sources: prepared.sources } };
    }

    const totalMs = Date.now() - totalStarted;
    console.log('[AIOrchestrator] stream gpt completed', {
      route,
      intentMs,
      gptMs: Date.now() - gptStarted,
      deltaCount,
      totalMs,
      collectionsAccessed: prepared.collectionsAccessed || [],
    });

    yield { event: 'done', data: { success: true } };
  } catch (error) {
    const abortReason = signal?.reason;
    const isTimeout =
      abortReason === 'timeout' ||
      error?.category === 'timeout' ||
      (signal?.aborted && abortReason === 'timeout');

    if (isTimeout) {
      yield {
        event: 'error',
        data: {
          success: false,
          message: 'The response took too long. Please try again.',
        },
      };
      return;
    }

    if (signal?.aborted || error?.category === 'aborted') {
      console.log('[AIOrchestrator] stream aborted by client');
      return;
    }

    console.error('[AIOrchestrator] stream failed', {
      category: error?.category || 'unexpected_error',
      statusCode: error?.statusCode,
    });

    yield {
      event: 'error',
      data: {
        success: false,
        message: 'Unable to generate a response.',
      },
    };
  }
}

module.exports = {
  handleChat,
  handleChatStream,
  validateMessage,
  getStreamTimeoutMs,
  UNSUPPORTED_REPLY,
  MAX_MESSAGE_LENGTH,
  DEFAULT_STREAM_TIMEOUT_MS,
};
