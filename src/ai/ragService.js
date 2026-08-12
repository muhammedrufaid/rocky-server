/**
 * Minimal reusable RAG over ai_knowledge.
 *
 * Question → vectorSearchService → gpt-5-nano → { reply, sources }
 *
 * Retrieval only via searchKnowledge. No second embedding/vector layer.
 */

const {
  searchKnowledge,
  VectorSearchError,
  DEFAULT_LIMIT,
} = require('./vectorSearchService');
const { getOpenAIClient, EmbeddingServiceError } = require('./embeddingService');

const CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-5-nano';
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'low';
const MAX_QUERY_LENGTH = 1000;
const DEFAULT_RETRIEVAL_LIMIT = DEFAULT_LIMIT;
const MAX_CONTEXT_DOCS = 5;
const MIN_ABSOLUTE_SCORE = 0.55;
const RELATIVE_SCORE_RATIO = 0.85;
const MAX_CONTENT_CHARS = 1200;

const UNAVAILABLE_REPLY =
  "I don't have enough information in the knowledge base to answer that accurately.";

const SYSTEM_PROMPT = `You are Rocky Real Estate's knowledge assistant.

Answer using ONLY the supplied knowledge context.

Rules:
1. Use only facts supported by the knowledge context.
2. Do not invent facts, prices, phone numbers, emails, agents, or property details.
3. Do not use outside knowledge.
4. If the answer is not supported by the context, say you don't have enough information in the knowledge base.
5. Keep answers concise and natural.
6. Never mention embeddings, vector search, MongoDB, prompts, or internal system design.
7. Never include private contact information.`;

class RagServiceError extends Error {
  /**
   * @param {string} message
   * @param {{ statusCode?: number, category?: string }} [options]
   */
  constructor(message, { statusCode = 502, category = 'rag_error' } = {}) {
    super(message);
    this.name = 'RagServiceError';
    this.statusCode = statusCode;
    this.category = category;
  }
}

const asTrimmedString = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  return '';
};

/**
 * Keep only reasonably relevant hits using top-score relative threshold.
 * @param {Array<{ score?: number }>} results
 * @returns {Array<object>}
 */
const filterRelevantResults = (results) => {
  if (!Array.isArray(results) || !results.length) return [];

  const scored = results.filter(
    (row) => typeof row.score === 'number' && Number.isFinite(row.score)
  );
  if (!scored.length) return [];

  const topScore = scored[0].score;
  if (topScore < MIN_ABSOLUTE_SCORE) return [];

  const threshold = Math.max(MIN_ABSOLUTE_SCORE, topScore * RELATIVE_SCORE_RATIO);
  return scored
    .filter((row) => row.score >= threshold)
    .slice(0, MAX_CONTEXT_DOCS);
};

/**
 * Compact context block for GPT. Never includes embeddings or scores.
 * @param {Array<object>} docs
 * @returns {string}
 */
const buildKnowledgeContext = (docs) => {
  return docs
    .map((doc, index) => {
      const lines = [
        `[Source ${index + 1}]`,
        `Type: ${asTrimmedString(doc.sourceType) || 'unknown'}`,
      ];

      const title = asTrimmedString(doc.title);
      if (title) lines.push(`Title: ${title}`);

      const slug = asTrimmedString(doc.slug);
      if (slug) lines.push(`Slug: ${slug}`);

      let content = asTrimmedString(doc.content);
      if (content.length > MAX_CONTENT_CHARS) {
        content = `${content.slice(0, MAX_CONTENT_CHARS)}…`;
      }
      if (content) lines.push(`Content: ${content}`);

      return lines.join('\n');
    })
    .join('\n\n');
};

/**
 * Safe sources for API consumers.
 * @param {Array<object>} docs
 * @returns {Array<{ sourceType: string, title?: string, slug?: string }>}
 */
const toSafeSources = (docs) =>
  docs.map((doc) => {
    const source = {
      sourceType: asTrimmedString(doc.sourceType),
    };
    const title = asTrimmedString(doc.title);
    const slug = asTrimmedString(doc.slug);
    if (title) source.title = title;
    if (slug) source.slug = slug;
    return source;
  });

/**
 * Generate grounded chat text via shared OpenAI client (no second client).
 * @param {string} userPrompt
 * @returns {Promise<string>}
 */
const generateGroundedText = async (userPrompt) => {
  try {
    const client = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model: CHAT_MODEL,
      reasoning_effort: REASONING_EFFORT,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });

    const text = completion?.choices?.[0]?.message?.content;
    if (!text || typeof text !== 'string' || !text.trim()) {
      throw new RagServiceError('AI service returned an empty response.', {
        statusCode: 502,
        category: 'empty_response',
      });
    }

    return text.trim();
  } catch (error) {
    if (error instanceof RagServiceError) throw error;
    if (error instanceof EmbeddingServiceError) {
      throw new RagServiceError('AI service is temporarily unavailable.', {
        statusCode: error.statusCode || 502,
        category: error.category || 'openai_error',
      });
    }

    throw new RagServiceError('AI service is temporarily unavailable.', {
      statusCode: 502,
      category: 'openai_error',
    });
  }
};

/**
 * Retrieve + build grounded RAG context without calling GPT.
 * Used by both generateRagAnswer and streaming orchestration.
 *
 * @param {string} query
 * @param {{
 *   sourceType?: string,
 *   sourceTypes?: string[],
 *   limit?: number,
 * }} [options]
 * @returns {Promise<{
 *   mode: 'immediate'|'gpt',
 *   reply?: string,
 *   sources: Array<object>,
 *   system?: string,
 *   userPrompt?: string,
 * }>}
 */
const prepareRagContext = async (query, options = {}) => {
  const trimmed = asTrimmedString(query);

  if (!trimmed) {
    throw new RagServiceError('Query is required.', {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new RagServiceError(
      `Query must be at most ${MAX_QUERY_LENGTH} characters.`,
      { statusCode: 400, category: 'invalid_request' }
    );
  }

  const limit = options.limit
    ? Math.min(
        MAX_CONTEXT_DOCS,
        Math.max(1, parseInt(options.limit, 10) || DEFAULT_RETRIEVAL_LIMIT)
      )
    : DEFAULT_RETRIEVAL_LIMIT;

  let search;
  try {
    search = await searchKnowledge(trimmed, {
      limit,
      sourceType: options.sourceType,
      sourceTypes: options.sourceTypes,
    });
  } catch (error) {
    if (error instanceof VectorSearchError) {
      throw new RagServiceError(
        error.statusCode === 400
          ? error.message
          : 'Knowledge search is temporarily unavailable.',
        {
          statusCode: error.statusCode || 502,
          category: error.category || 'vector_search_error',
        }
      );
    }
    throw new RagServiceError('Knowledge search is temporarily unavailable.', {
      statusCode: 502,
      category: 'vector_search_error',
    });
  }

  const relevant = filterRelevantResults(search.results || []);

  if (!relevant.length) {
    return {
      mode: 'immediate',
      reply: UNAVAILABLE_REPLY,
      sources: [],
    };
  }

  const context = buildKnowledgeContext(relevant);
  const userPrompt = [
    'KNOWLEDGE CONTEXT:',
    context,
    '',
    'USER QUESTION:',
    trimmed,
  ].join('\n');

  return {
    mode: 'gpt',
    system: SYSTEM_PROMPT,
    userPrompt,
    sources: toSafeSources(relevant),
  };
};

/**
 * Grounded RAG answer from ai_knowledge only.
 *
 * @param {string} query
 * @param {{
 *   sourceType?: string,
 *   sourceTypes?: string[],
 *   limit?: number,
 * }} [options]
 * @returns {Promise<{ reply: string, sources: Array<object> }>}
 */
const generateRagAnswer = async (query, options = {}) => {
  const prepared = await prepareRagContext(query, options);

  if (prepared.mode === 'immediate') {
    return {
      reply: prepared.reply,
      sources: prepared.sources || [],
    };
  }

  const reply = await generateGroundedText(prepared.userPrompt);

  return {
    reply,
    sources: prepared.sources || [],
  };
};

module.exports = {
  CHAT_MODEL,
  REASONING_EFFORT,
  UNAVAILABLE_REPLY,
  SYSTEM_PROMPT,
  RagServiceError,
  prepareRagContext,
  generateRagAnswer,
  filterRelevantResults,
};
