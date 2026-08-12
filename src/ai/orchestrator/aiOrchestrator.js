/**
 * AI chat orchestrator — clean architecture.
 *
 * Flow: confidential → intent → structured tools OR ragService
 * Knowledge RAG uses ONLY src/ai/ragService.js (unified ai_knowledge path).
 */

const { generateText, OpenAIServiceError } = require('../../services/openaiService');
const {
  detectConfidentialRequest,
  CONFIDENTIAL_REFUSAL,
} = require('../security/confidentialGuard');
const { getCompanyKnowledgeText } = require('../tools/companyKnowledge');
const {
  getPropertyCount,
  resolvePropertySearchContext,
  formatCountReply,
} = require('../tools/propertyTools');
const { resolveTeamContext } = require('../tools/teamTools');
const { generateRagAnswer, RagServiceError } = require('../ragService');
const { classifyIntent } = require('./intentRouter');

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

const TEAM_SYSTEM_PROMPT = `You are the Rocky Real Estate AI Assistant.

Answer using ONLY the public team-member data provided in the user message.

Rules:
1. Use only the provided public team fields (name, designation, department, languages, experience, etc.).
2. Never invent phone numbers, emails, WhatsApp, or private contacts.
3. Keep answers concise and natural.
4. If the person or role is not in the data, say you don't have that public team information.
5. Never mention MongoDB, collections, internal IDs, or system design.`;

const PROPERTY_SEARCH_SYSTEM_PROMPT = `You are the Rocky Real Estate AI Assistant.

Answer using ONLY the public property search results provided in the user message.

Rules:
1. Use only the provided property results for listings, prices, and counts.
2. Do not invent properties, prices, or availability.
3. Never invent or include agent phone numbers, emails, or owner details.
4. Keep answers concise and natural.
5. If results are empty, say no matching public listings were found.
6. Never mention MongoDB, embeddings, or system design.`;

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

const handleCompany = async (question) => {
  const knowledge = getCompanyKnowledgeText();
  const userPrompt = `ROCKY REAL ESTATE COMPANY KNOWLEDGE

${knowledge}

USER QUESTION:
${question}`;

  const result = await generateText(userPrompt, { system: COMPANY_SYSTEM_PROMPT });
  return { reply: result.text, openaiCalls: 1 };
};

const handleTeam = async (question) => {
  const team = await resolveTeamContext(question);
  const payload = Array.isArray(team.data) ? team.data : [];
  const userPrompt = `ROCKY REAL ESTATE PUBLIC TEAM DATA

${JSON.stringify(payload, null, 2)}

USER QUESTION:
${question}`;

  const result = await generateText(userPrompt, { system: TEAM_SYSTEM_PROMPT });
  return { reply: result.text, openaiCalls: 1 };
};

const handlePropertyCount = async () => {
  const { count } = await getPropertyCount({});
  return {
    reply: formatCountReply(count),
    openaiCalls: 0,
  };
};

const handlePropertySearch = async (question) => {
  const prepared = await resolvePropertySearchContext(question);
  const userPrompt = `ROCKY REAL ESTATE PUBLIC PROPERTY SEARCH RESULTS

${JSON.stringify(prepared, null, 2)}

USER QUESTION:
${question}`;

  const result = await generateText(userPrompt, {
    system: PROPERTY_SEARCH_SYSTEM_PROMPT,
  });
  return { reply: result.text, openaiCalls: 1 };
};

/**
 * Unified knowledge RAG via ragService → vectorSearchService → ai_knowledge.
 * @param {string} question
 * @param {string[]|undefined} sourceTypes
 */
const handleKnowledgeRag = async (question, sourceTypes) => {
  const options = {};
  if (Array.isArray(sourceTypes) && sourceTypes.length) {
    options.sourceTypes = sourceTypes;
  }

  const result = await generateRagAnswer(question, options);
  return {
    reply: result.reply,
    sources: Array.isArray(result.sources) ? result.sources : [],
    // query embedding + GPT generation inside ragService
    openaiCalls: 2,
  };
};

/**
 * Non-streaming chat orchestration.
 * @param {string} message
 * @returns {Promise<{ reply: string, sources?: object[], route: string, openaiCalls: number }>}
 */
const handleChat = async (message) => {
  const trimmed = assertValidMessage(message);

  const confidential = detectConfidentialRequest(trimmed);
  if (confidential.blocked) {
    return {
      reply: CONFIDENTIAL_REFUSAL,
      route: 'CONFIDENTIAL',
      openaiCalls: 0,
    };
  }

  const intent = classifyIntent(trimmed);
  console.log('[AIOrchestrator] intent', { intent });

  try {
    if (intent === 'PROPERTY_COUNT') {
      const result = await handlePropertyCount();
      return { ...result, route: 'PROPERTY_COUNT' };
    }

    if (intent === 'PROPERTY_SEARCH') {
      const result = await handlePropertySearch(trimmed);
      return { ...result, route: 'PROPERTY_SEARCH' };
    }

    if (intent === 'COMPANY_INFO') {
      const result = await handleCompany(trimmed);
      return { ...result, route: 'COMPANY_INFO' };
    }

    if (intent === 'SERVICE_INFO') {
      const result = await handleKnowledgeRag(trimmed, ['service']);
      return { ...result, route: 'SERVICE_INFO' };
    }

    if (intent === 'TEAM_INFO') {
      const result = await handleTeam(trimmed);
      return { ...result, route: 'TEAM_INFO' };
    }

    if (intent === 'BLOG') {
      const result = await handleKnowledgeRag(trimmed, ['blog']);
      return { ...result, route: 'BLOG' };
    }

    if (intent === 'AREA_GUIDE') {
      const result = await handleKnowledgeRag(trimmed, ['areaGuide']);
      return { ...result, route: 'AREA_GUIDE' };
    }

    if (intent === 'FAQ') {
      const result = await handleKnowledgeRag(trimmed, ['faq']);
      return { ...result, route: 'FAQ' };
    }

    if (intent === 'KNOWLEDGE_BOTH') {
      const result = await handleKnowledgeRag(trimmed, undefined);
      return { ...result, route: 'KNOWLEDGE_BOTH' };
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

module.exports = {
  handleChat,
  MAX_MESSAGE_LENGTH,
  UNSUPPORTED_REPLY,
};
