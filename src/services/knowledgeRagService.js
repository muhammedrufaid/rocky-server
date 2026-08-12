const { generateText, OpenAIServiceError } = require('./openaiService');
const {
  searchKnowledge,
  runVectorSearch,
  KnowledgeVectorSearchError,
} = require('./knowledgeVectorSearchService');
const { generateEmbedding } = require('./embeddingService');
const {
  detectConfidentialRequest,
  CONFIDENTIAL_REFUSAL,
} = require('../ai/security/confidentialGuard');

const MAX_QUERY_LENGTH = 1000;
const DEFAULT_MAX_CONTEXT_CHUNKS = 4;
const DEFAULT_RELATIVE_SCORE_RATIO = 0.85;

const NO_CONTEXT_ANSWER =
  "I don't have enough information in my current knowledge base to answer that accurately.";

const DYNAMIC_DATA_ANSWER =
  "I can't answer that from Area Guide or FAQ knowledge. Current property counts, listings, and live prices need the property tools — not this static knowledge base.";

const SYSTEM_PROMPT = `You are the Rocky Real Estate AI Assistant.

You answer questions using ONLY the Rocky Real Estate knowledge context provided in the user message (Area Guides and/or FAQs).

Rules:
1. Answer ONLY from the supplied knowledge context.
2. Never invent facts.
3. Never use outside/general model knowledge to fill missing information.
4. If the context does not contain the answer, clearly say the information is not available in the current knowledge base.
5. Do not expose internal implementation details.
6. Never mention embeddings, vector search, chunks, retrieval scores, MongoDB, or internal tools.
7. Do not expose private information (phones, emails, WhatsApp, owners, leads, contacts).
8. Do not answer dynamic property questions (current counts, live listings, current prices, availability) from this static knowledge.
9. Do not provide agent phone/email/WhatsApp information.
10. Keep answers concise and useful.
11. If the user asks something outside the supplied knowledge, do not guess.
12. When useful, refer to the area name or FAQ topic in plain language (not as an internal ID).`;

const AREA_GUIDE_PATTERNS = [
  /\b(dubai\s+marina|dubai\s+south|arabian\s+ranches|dubai\s+media\s+city|jumeirah\s+village\s+circle|\bjvc\b|business\s+bay|the\s+springs|the\s+greens|emaar\s+beachfront|dubai\s+creek|jebel\s+ali|madinat\s+jumeirah|jumeirah\s+golf)\b/i,
  /\b(what\s+is|tell\s+me\s+about|where\s+is|living\s+in|highlights?\s+of|what\s+are\s+the\s+highlights)\b.{0,60}\b(marina|south|ranches|media\s+city|jvc|village|bay|springs|greens|beachfront|creek|jebel|golf)\b/i,
  /\b(area\s+guide|community\s+overview|what\s+is\s+.{0,40}\s+like)\b/i,
];

const FAQ_PATTERNS = [
  /\b(faq|frequently\s+asked)\b/i,
  /\b(costs?\s+involved|buying\s+process|can\s+foreigners|off[\s-]?plan|golden\s+visa|snagging|property\s+management\s+service\s+include|why\s+should\s+i\s+choose)\b/i,
  /\b(how\s+(long|does|do)|what\s+(are|is|does)|can\s+i)\b.{0,80}\b(buying|buyers?|off[\s-]?plan|foreign(?:ers)?|visa|manage|snagging|cost|fee|process)\b/i,
  /\b(common\s+questions?|questions?\s+about)\b/i,
];

const DYNAMIC_DATA_PATTERNS = [
  /\bhow\s+many\s+(properties|listings|homes|units)\b/i,
  /\b(current|live)\s+(price|prices|listing|listings|availability)\b/i,
  /\b(show|find|list)\b.{0,40}\b(apartments?|villas?|properties|listings)\b/i,
  /\bproperties?\s+(under|below|for\s+sale|for\s+rent)\b/i,
  /\b(price\s+of\s+(a|an|this|the)\s+(apartment|villa|property)|apartment\s+price)\b/i,
  /\b(currently\s+)?(manage|managing|managed)\b.{0,30}\bpropert/i,
];

/**
 * @param {unknown} value
 * @param {number} fallback
 */
const parsePositiveInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * @param {unknown} value
 * @param {number} fallback
 */
const parseRatio = (value, fallback) => {
  const n = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
  return n;
};

const getRagConfig = () => ({
  maxContextChunks: parsePositiveInt(
    process.env.KNOWLEDGE_RAG_MAX_CONTEXT_CHUNKS,
    DEFAULT_MAX_CONTEXT_CHUNKS
  ),
  relativeScoreRatio: parseRatio(
    process.env.KNOWLEDGE_RAG_RELATIVE_SCORE_RATIO,
    DEFAULT_RELATIVE_SCORE_RATIO
  ),
});

/**
 * Deterministic source selection — no LLM classifier.
 * @param {string} message
 * @returns {'area_guide'|'faq'|'both'}
 */
const selectKnowledgeSource = (message) => {
  const text = String(message || '');
  const area = AREA_GUIDE_PATTERNS.some((re) => re.test(text));
  const faq = FAQ_PATTERNS.some((re) => re.test(text));

  if (area && faq) return 'both';
  if (area) return 'area_guide';
  if (faq) return 'faq';
  return 'both';
};

/**
 * @param {string} message
 */
const isDynamicDataQuestion = (message) =>
  DYNAMIC_DATA_PATTERNS.some((re) => re.test(String(message || '')));

/**
 * @param {object[]} results
 * @param {{ maxContextChunks: number, relativeScoreRatio: number }} config
 */
const selectRelevantChunks = (results, config) => {
  const usable = (Array.isArray(results) ? results : []).filter(
    (r) => r && typeof r.content === 'string' && r.content.trim()
  );

  if (!usable.length) return [];

  const topScore =
    typeof usable[0].score === 'number' && Number.isFinite(usable[0].score)
      ? usable[0].score
      : null;

  let filtered = usable;
  if (topScore !== null && topScore > 0) {
    const floor = topScore * config.relativeScoreRatio;
    filtered = usable.filter(
      (r) => typeof r.score !== 'number' || r.score >= floor
    );
  }

  return filtered.slice(0, config.maxContextChunks);
};

/**
 * @param {object[]} chunks
 */
const buildContextBlock = (chunks) => {
  const parts = ['ROCKY REAL ESTATE KNOWLEDGE CONTEXT', ''];

  chunks.forEach((chunk, index) => {
    parts.push(`Source ${index + 1}:`);
    if (chunk.sourceType === 'area_guide') {
      parts.push('[AREA GUIDE]');
      if (chunk.title) parts.push(`Title: ${chunk.title}`);
      if (chunk.slug) parts.push(`Area: ${chunk.title || chunk.slug}`);
    } else if (chunk.sourceType === 'faq') {
      parts.push('[FAQ]');
      if (chunk.category) parts.push(`Category: ${chunk.category}`);
      if (chunk.question) parts.push(`Question: ${chunk.question}`);
    }
    parts.push('');
    parts.push('Content:');
    parts.push(String(chunk.content).trim());
    parts.push('');
  });

  return parts.join('\n').trim();
};

const buildUserPrompt = (query, contextBlock) => `${contextBlock}

USER QUESTION:
${query}

Answer the user question using only the Rocky Real Estate knowledge context above. If the context is insufficient, say so clearly.`;

/**
 * Safe public sources — no scores, embeddings, or IDs.
 * @param {object[]} chunks
 */
const mapSources = (chunks) => {
  const seen = new Set();
  const sources = [];

  for (const chunk of chunks) {
    if (chunk.sourceType === 'area_guide') {
      const key = `area_guide::${chunk.slug || chunk.title || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const src = { sourceType: 'area_guide' };
      if (chunk.title) src.title = chunk.title;
      if (chunk.slug) src.slug = chunk.slug;
      sources.push(src);
      continue;
    }

    if (chunk.sourceType === 'faq') {
      const key = `faq::${chunk.question || chunk.content || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const src = { sourceType: 'faq' };
      if (chunk.question) src.question = chunk.question;
      if (chunk.category) src.category = chunk.category;
      sources.push(src);
    }
  }

  return sources;
};

/**
 * Merge two result lists by score desc, dedupe by sourceType+sourceId+chunkIndex.
 * @param {object[]} a
 * @param {object[]} b
 */
const mergeResults = (a, b) => {
  const map = new Map();
  for (const item of [...(a || []), ...(b || [])]) {
    const key = `${item.sourceType}:${item.sourceId}:${item.chunkIndex}`;
    const prev = map.get(key);
    if (!prev || (item.score || 0) > (prev.score || 0)) {
      map.set(key, item);
    }
  }
  return [...map.values()].sort((x, y) => (y.score || 0) - (x.score || 0));
};

/**
 * Retrieve knowledge chunks for the selected source(s).
 * Embeds the query once even when searching both source types.
 * @param {string} query
 * @param {'area_guide'|'faq'|'both'} source
 */
const retrieveKnowledge = async (query, source) => {
  if (source === 'both') {
    const embedStarted = Date.now();
    const embeddingResult = await generateEmbedding(query);
    const embeddingMs = Date.now() - embedStarted;

    const searchStarted = Date.now();
    const [areaResults, faqResults] = await Promise.all([
      runVectorSearch(embeddingResult.embedding, { sourceType: 'area_guide' }),
      runVectorSearch(embeddingResult.embedding, { sourceType: 'faq' }),
    ]);
    const vectorSearchMs = Date.now() - searchStarted;

    return {
      results: mergeResults(areaResults, faqResults),
      timings: {
        embeddingMs,
        vectorSearchMs,
        totalMs: embeddingMs + vectorSearchMs,
      },
      model: embeddingResult.model,
      dimension: embeddingResult.dimension,
      embeddingRequestCount: 1,
    };
  }

  const result = await searchKnowledge(query, { sourceType: source });
  return { ...result, embeddingRequestCount: 1 };
};

/**
 * Prepare knowledge RAG context for non-streaming or streaming GPT.
 * Does not call GPT (except guards may short-circuit without GPT).
 *
 * @param {string} query
 * @param {{
 *   sourceType?: 'area_guide'|'faq'|'both',
 *   skipGuards?: boolean,
 * }} [options]
 */
const prepareKnowledgeRagContext = async (query, options = {}) => {
  const totalStarted = Date.now();

  if (query === undefined || query === null) {
    throw new KnowledgeVectorSearchError('Message is required.', {
      statusCode: 400,
      category: 'invalid_query',
    });
  }

  if (typeof query !== 'string') {
    throw new KnowledgeVectorSearchError('Message must be a string.', {
      statusCode: 400,
      category: 'invalid_query',
    });
  }

  const trimmed = query.trim();
  if (!trimmed) {
    throw new KnowledgeVectorSearchError('Message cannot be empty.', {
      statusCode: 400,
      category: 'invalid_query',
    });
  }

  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new KnowledgeVectorSearchError(
      `Message must be at most ${MAX_QUERY_LENGTH} characters.`,
      { statusCode: 400, category: 'invalid_query' }
    );
  }

  if (!options.skipGuards) {
    const confidential = detectConfidentialRequest(trimmed);
    if (confidential.blocked) {
      return {
        mode: 'immediate',
        answer: CONFIDENTIAL_REFUSAL,
        sources: [],
        system: null,
        userPrompt: null,
        sourceSelection: 'blocked_confidential',
        timings: {
          embeddingMs: 0,
          vectorSearchMs: 0,
          prepareMs: Date.now() - totalStarted,
        },
      };
    }

    if (isDynamicDataQuestion(trimmed)) {
      return {
        mode: 'immediate',
        answer: DYNAMIC_DATA_ANSWER,
        sources: [],
        system: null,
        userPrompt: null,
        sourceSelection: 'blocked_dynamic',
        timings: {
          embeddingMs: 0,
          vectorSearchMs: 0,
          prepareMs: Date.now() - totalStarted,
        },
      };
    }
  }

  const ragConfig = getRagConfig();
  const forced = options.sourceType;
  const sourceSelection =
    forced === 'area_guide' || forced === 'faq' || forced === 'both'
      ? forced
      : selectKnowledgeSource(trimmed);

  console.log('[KnowledgeRAG] request started', {
    queryLength: trimmed.length,
    sourceSelection,
    maxContextChunks: ragConfig.maxContextChunks,
  });

  let searchResult;
  try {
    searchResult = await retrieveKnowledge(trimmed, sourceSelection);
  } catch (error) {
    if (
      error instanceof KnowledgeVectorSearchError ||
      error instanceof OpenAIServiceError
    ) {
      throw error;
    }
    throw new KnowledgeVectorSearchError('Knowledge retrieval failed.', {
      statusCode: 502,
      category: 'retrieval_error',
    });
  }

  const relevantChunks = selectRelevantChunks(searchResult.results, ragConfig);

  console.log('[KnowledgeRAG] retrieval completed', {
    retrieved: searchResult.results.length,
    selected: relevantChunks.length,
    embeddingMs: searchResult.timings.embeddingMs,
    vectorSearchMs: searchResult.timings.vectorSearchMs,
  });

  if (!relevantChunks.length) {
    return {
      mode: 'immediate',
      answer: NO_CONTEXT_ANSWER,
      sources: [],
      system: null,
      userPrompt: null,
      sourceSelection,
      timings: {
        embeddingMs: searchResult.timings.embeddingMs,
        vectorSearchMs: searchResult.timings.vectorSearchMs,
        prepareMs: Date.now() - totalStarted,
      },
    };
  }

  return {
    mode: 'gpt',
    answer: null,
    sources: mapSources(relevantChunks),
    system: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(trimmed, buildContextBlock(relevantChunks)),
    sourceSelection,
    timings: {
      embeddingMs: searchResult.timings.embeddingMs,
      vectorSearchMs: searchResult.timings.vectorSearchMs,
      prepareMs: Date.now() - totalStarted,
    },
  };
};

/**
 * Knowledge RAG: Area Guide / FAQ only.
 * Does NOT call Blog RAG. Does NOT touch properties/leads/contacts.
 *
 * @param {string} query
 * @param {{
 *   sourceType?: 'area_guide'|'faq'|'both',
 *   skipGuards?: boolean,
 * }} [options]
 */
const generateKnowledgeAnswer = async (query, options = {}) => {
  const totalStarted = Date.now();
  const prepared = await prepareKnowledgeRagContext(query, options);

  if (prepared.mode === 'immediate') {
    const totalMs = Date.now() - totalStarted;
    if (
      prepared.sourceSelection !== 'blocked_confidential' &&
      prepared.sourceSelection !== 'blocked_dynamic'
    ) {
      console.log('[KnowledgeRAG] no useful context; skipping GPT', { totalMs });
    }
    return {
      answer: prepared.answer,
      sources: prepared.sources,
      timings: {
        embeddingMs: prepared.timings.embeddingMs,
        vectorSearchMs: prepared.timings.vectorSearchMs,
        gptMs: 0,
        totalMs,
      },
      usedGpt: false,
      sourceSelection: prepared.sourceSelection,
    };
  }

  let gptResult;
  try {
    gptResult = await generateText(prepared.userPrompt, { system: prepared.system });
  } catch (error) {
    if (error instanceof OpenAIServiceError) throw error;
    throw new OpenAIServiceError('AI service is temporarily unavailable.', {
      statusCode: 502,
      category: 'provider_error',
    });
  }

  const totalMs = Date.now() - totalStarted;
  console.log('[KnowledgeRAG] request completed', {
    usedGpt: true,
    embeddingMs: prepared.timings.embeddingMs,
    vectorSearchMs: prepared.timings.vectorSearchMs,
    gptMs: gptResult.durationMs,
    totalMs,
  });

  return {
    answer: gptResult.text,
    sources: prepared.sources,
    timings: {
      embeddingMs: prepared.timings.embeddingMs,
      vectorSearchMs: prepared.timings.vectorSearchMs,
      gptMs: gptResult.durationMs,
      totalMs,
    },
    usedGpt: true,
    sourceSelection: prepared.sourceSelection,
  };
};

module.exports = {
  generateKnowledgeAnswer,
  prepareKnowledgeRagContext,
  selectKnowledgeSource,
  selectRelevantChunks,
  buildContextBlock,
  mapSources,
  getRagConfig,
  isDynamicDataQuestion,
  SYSTEM_PROMPT,
  NO_CONTEXT_ANSWER,
  DYNAMIC_DATA_ANSWER,
  MAX_QUERY_LENGTH,
};
