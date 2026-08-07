/**
 * Tool Service
 * Responsibility: Tool registry and future tool execution dispatcher.
 * No tool implementations and no MongoDB access in this phase.
 */

const searchProperties = require('../tools/searchProperties');
const getProperty = require('../tools/getProperty');
const createLead = require('../tools/createLead');

/** Empty registry — tools are registered by name for future OpenAI tool calling */
const toolRegistry = {
  searchProperties,
  getProperty,
  createLead,
};

/**
 * List registered tool names.
 * @returns {string[]}
 */
const listTools = () => Object.keys(toolRegistry);

/**
 * Get a tool definition/executor by name.
 * @param {string} name
 * @returns {object|null}
 */
const getTool = (name) => toolRegistry[name] || null;

/**
 * Execute a tool by name.
 * Scaffold only — throws until Phase 2+.
 *
 * @param {string} name
 * @param {object} args
 */
const execute = async (name, args) => {
  // TODO: Validate tool name exists in registry
  // TODO: Validate args against tool schema
  // TODO: Call tool.execute(args) — tools must call existing services, never MongoDB
  // TODO: Normalize success/error payloads for the model
  void args;

  const tool = getTool(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  throw new Error(`Tool "${name}" execution is not implemented yet`);
};

/**
 * Build OpenAI-compatible tool definitions from the registry (future).
 * @returns {Array}
 */
const getToolDefinitions = () => {
  // TODO: Map registry entries to provider tool/function schemas
  return Object.values(toolRegistry).map((tool) => ({
    name: tool.name,
    description: tool.description,
    // parameters: tool.parameters,
  }));
};

module.exports = {
  toolRegistry,
  listTools,
  getTool,
  execute,
  getToolDefinitions,
};
