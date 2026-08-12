const { generateText, OpenAIServiceError } = require('../../services/openaiService');
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
const { classifyIntent } = require('./intentRouter');

const MAX_MESSAGE_LENGTH = 1000;

const UNSUPPORTED_REPLY =
  "I can currently help with Rocky Real Estate's company information, services, public team details, and public property listings. More knowledge sources will be connected shortly.";

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

const answerFromCompanyKnowledge = async (question) => {
  const knowledge = getCompanyKnowledgeText();
  const userPrompt = `ROCKY REAL ESTATE COMPANY KNOWLEDGE

${knowledge}

USER QUESTION:
${question}

Answer the question using only the company knowledge above.`;

  const result = await generateText(userPrompt, { system: COMPANY_SYSTEM_PROMPT });
  return { reply: result.text, gptMs: result.durationMs };
};

const answerFromServices = async (question) => {
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

  const result = await generateText(userPrompt, { system: SERVICES_SYSTEM_PROMPT });
  return {
    reply: result.text,
    gptMs: result.durationMs,
    collectionsAccessed: ['services'],
  };
};

const answerFromTeam = async (question) => {
  const team = await resolveTeamContext(question);
  const payload = team.data || [];

  const userPrompt = `ROCKY REAL ESTATE PUBLIC TEAM DATA

${JSON.stringify(payload, null, 2)}

USER QUESTION:
${question}

Answer using only this public team data. Do not include or invent phone, email, or WhatsApp details.`;

  const result = await generateText(userPrompt, { system: TEAM_SYSTEM_PROMPT });
  return {
    reply: result.text,
    gptMs: result.durationMs,
    collectionsAccessed: ['teammembers'],
  };
};

/**
 * Deterministic count — no GPT rephrasing.
 */
const answerFromPropertyCount = async () => {
  const { count } = await getPropertyCount();
  return {
    reply: formatCountReply(count),
    gptMs: 0,
    collectionsAccessed: ['properties'],
    count,
  };
};

const answerFromPropertySearch = async (question) => {
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

  const gpt = await generateText(userPrompt, { system: PROPERTY_SEARCH_SYSTEM_PROMPT });
  return {
    reply: gpt.text,
    gptMs: gpt.durationMs,
    collectionsAccessed: ['properties'],
    total: result.total,
  };
};

/**
 * Phase 1–3 orchestrator.
 * Does NOT call blogRagService.
 * Allowlisted collections: services, teammembers, properties (plus company.md file).
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
      timings: { gptMs: 0, totalMs },
    };
  }

  const intent = classifyIntent(trimmed);
  console.log('[AIOrchestrator] intent classified', { intent });

  try {
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
        timings: { gptMs, totalMs },
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
        timings: { gptMs, totalMs },
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
        timings: { gptMs, totalMs },
      };
    }

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
        timings: { gptMs, totalMs },
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
        timings: { gptMs, totalMs },
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
    timings: { gptMs: 0, totalMs },
  };
};

module.exports = {
  handleChat,
  validateMessage,
  UNSUPPORTED_REPLY,
  MAX_MESSAGE_LENGTH,
};
