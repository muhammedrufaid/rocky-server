/**
 * Prompt Service
 * Responsibility: Load and assemble prompt fragments from ai/prompts/.
 */

const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '../prompts');

/**
 * Read a prompt markdown file from ai/prompts/.
 * @param {string} filename
 * @returns {string}
 */
const readPromptFile = (filename) => {
  const filePath = path.join(PROMPTS_DIR, filename);
  return fs.readFileSync(filePath, 'utf8');
};

/**
 * System prompt — assistant role and high-level behavior.
 * @returns {string}
 */
const getSystemPrompt = () => {
  // TODO: Cache file contents in memory for production
  // TODO: Support versioned / locale-specific overlays
  return readPromptFile('system.md');
};

/**
 * Business rules prompt fragment.
 * @returns {string}
 */
const getBusinessRules = () => {
  // TODO: Cache file contents in memory for production
  return readPromptFile('business-rules.md');
};

/**
 * Tool instructions prompt fragment.
 * @returns {string}
 */
const getToolInstructions = () => {
  // TODO: Cache file contents in memory for production
  // TODO: Optionally merge with live tool registry descriptions
  return readPromptFile('tools.md');
};

/**
 * Combine system + business rules + tools into one system prompt.
 * @returns {string}
 */
const buildFullPrompt = () => {
  return [getSystemPrompt(), getBusinessRules(), getToolInstructions()].join('\n\n');
};

module.exports = {
  getSystemPrompt,
  getBusinessRules,
  getToolInstructions,
  buildFullPrompt,
};
