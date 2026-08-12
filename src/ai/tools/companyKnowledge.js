const fs = require('fs');
const path = require('path');

const COMPANY_MD_PATH = path.join(__dirname, '..', 'company.md');

let cachedContent = null;
let cachedMtimeMs = null;

/**
 * Load verified public company knowledge from company.md.
 * Does not query MongoDB. Does not invent facts.
 *
 * @returns {string}
 */
const getCompanyKnowledgeText = () => {
  const stat = fs.statSync(COMPANY_MD_PATH);
  if (cachedContent !== null && cachedMtimeMs === stat.mtimeMs) {
    return cachedContent;
  }

  const content = fs.readFileSync(COMPANY_MD_PATH, 'utf8').trim();
  if (!content) {
    throw new Error('Company knowledge file is empty');
  }

  cachedContent = content;
  cachedMtimeMs = stat.mtimeMs;
  return cachedContent;
};

module.exports = {
  getCompanyKnowledgeText,
  getCompanyKnowledgePath: () => COMPANY_MD_PATH,
};
