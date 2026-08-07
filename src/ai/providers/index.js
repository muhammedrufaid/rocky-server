/**
 * AI Provider registry
 * Maps LLM_PROVIDER env values → provider constructors.
 * Add OpenAI / Gemini / Claude here later without changing ChatService.
 */

const GroqProvider = require('./groq.provider');
const { AIProviderError } = require('./errors');

/** Supported providers and the env var that holds their API key */
const PROVIDER_REGISTRY = {
  groq: {
    Provider: GroqProvider,
    apiKeyEnv: 'GROQ_API_KEY',
  },
  // openai: { Provider: OpenAIProvider, apiKeyEnv: 'OPENAI_API_KEY' },
  // gemini: { Provider: GeminiProvider, apiKeyEnv: 'GEMINI_API_KEY' },
  // claude: { Provider: ClaudeProvider, apiKeyEnv: 'ANTHROPIC_API_KEY' },
};

/**
 * Resolve and construct the active provider from environment config.
 * @returns {import('./base.provider')}
 */
const createProviderFromEnv = () => {
  const providerName = (process.env.LLM_PROVIDER || '').trim().toLowerCase();

  if (!providerName) {
    throw new AIProviderError(
      'AI provider is not configured. Please set LLM_PROVIDER.',
      { code: 'MISSING_PROVIDER', statusCode: 500 }
    );
  }

  const entry = PROVIDER_REGISTRY[providerName];

  if (!entry) {
    const supported = Object.keys(PROVIDER_REGISTRY).join(', ');
    throw new AIProviderError(
      `Unsupported AI provider "${providerName}". Supported providers: ${supported}.`,
      { code: 'UNSUPPORTED_PROVIDER', statusCode: 500 }
    );
  }

  const apiKey = (process.env[entry.apiKeyEnv] || '').trim();

  if (!apiKey) {
    throw new AIProviderError(
      `AI provider "${providerName}" is missing its API key. Please set ${entry.apiKeyEnv}.`,
      { code: 'MISSING_API_KEY', statusCode: 500 }
    );
  }

  return new entry.Provider({ apiKey });
};

module.exports = {
  PROVIDER_REGISTRY,
  createProviderFromEnv,
};
