/**
 * FAQ public knowledge extraction (Phase 4 Step 2).
 * READ-ONLY. No OpenAI. No confidential careers collection access.
 *
 * Phase 4 include pages: home, off-plan (+ future area-guide when present)
 * Phase 4 exclude pages: careers
 */

const Faq = require('../models/Faq');

const FAQ_INCLUDE_PAGES = new Set(['home', 'off-plan', 'area-guide']);
const FAQ_EXCLUDE_PAGES = new Set(['careers']);

const FORBIDDEN_OUTPUT_KEYS = ['createdAt', 'updatedAt', '__v'];

/**
 * @param {unknown} value
 * @returns {string}
 */
const asTrimmedString = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

/**
 * Normalize template placeholders in FAQ text without inventing values.
 * {{DIRHAM}} → removed (currency marker only; no fabricated amount).
 *
 * @param {string} text
 * @returns {{ text: string, placeholders: string[] }}
 */
const normalizePlaceholders = (text) => {
  const raw = asTrimmedString(text);
  const placeholders = [];

  // Capture known template tokens before removal
  const tokenRe = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  let match;
  while ((match = tokenRe.exec(raw)) !== null) {
    placeholders.push(match[0]);
  }

  // Remove {{DIRHAM}} / similar tokens; collapse leftover double spaces
  let cleaned = raw.replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, '');
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();

  return { text: cleaned, placeholders };
};

/**
 * @param {object} doc
 * @returns {boolean}
 */
const isFaqInPhase4Scope = (doc) => {
  if (!doc || doc.isActive === false) return false;
  const page = asTrimmedString(doc.page);
  if (FAQ_EXCLUDE_PAGES.has(page)) return false;
  return FAQ_INCLUDE_PAGES.has(page);
};

/**
 * Normalize one FAQ into a public knowledge unit.
 * @param {object} doc
 * @returns {{ unit: object|null, skipped?: string, placeholders?: string[] }}
 */
const normalizeFaq = (doc) => {
  if (!doc || typeof doc !== 'object') {
    return { unit: null, skipped: 'invalid' };
  }

  if (doc.isActive === false) {
    return { unit: null, skipped: 'inactive' };
  }

  const page = asTrimmedString(doc.page);
  if (FAQ_EXCLUDE_PAGES.has(page)) {
    return { unit: null, skipped: 'excluded_page_careers' };
  }
  if (!FAQ_INCLUDE_PAGES.has(page)) {
    return { unit: null, skipped: `excluded_page_${page || 'unknown'}` };
  }

  const question = asTrimmedString(doc.question);
  const answerRaw = asTrimmedString(doc.answer);
  if (!question || !answerRaw) {
    return { unit: null, skipped: 'missing_question_or_answer' };
  }

  const { text: answer, placeholders } = normalizePlaceholders(answerRaw);
  if (!answer) {
    return { unit: null, skipped: 'empty_answer_after_normalize', placeholders };
  }

  const plainText = `Q: ${question}\nA: ${answer}`.trim();

  const unit = {
    sourceType: 'faq',
    sourceId: String(doc._id),
    page,
    slug: doc.slug ? asTrimmedString(doc.slug) : null,
    question,
    answer,
    order: typeof doc.order === 'number' ? doc.order : 0,
    plainText,
    stats: {
      questionLength: question.length,
      answerLength: answer.length,
      plainTextLength: plainText.length,
      placeholdersNormalized: placeholders,
    },
  };

  assertNoForbiddenFields(unit);
  return { unit, placeholders };
};

/**
 * @param {object} unit
 */
const assertNoForbiddenFields = (unit) => {
  for (const key of FORBIDDEN_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(unit, key)) {
      throw new Error(`FAQ knowledge leaked forbidden field: ${key}`);
    }
  }
};

/**
 * Load Phase-4-scoped active FAQs from the Faq model only.
 * @returns {Promise<{ units: object[], excluded: object, placeholderHits: object[] }>}
 */
const extractActiveFaqKnowledge = async () => {
  const docs = await Faq.find({ isActive: true })
    .select('page slug question answer order isActive')
    .sort({ page: 1, order: 1 })
    .lean();

  const units = [];
  const excluded = {
    careers: 0,
    otherPages: 0,
    inactiveOrInvalid: 0,
  };
  const placeholderHits = [];

  for (const doc of docs) {
    const result = normalizeFaq(doc);
    if (!result.unit) {
      if (result.skipped === 'excluded_page_careers') excluded.careers += 1;
      else if (String(result.skipped || '').startsWith('excluded_page_')) excluded.otherPages += 1;
      else excluded.inactiveOrInvalid += 1;
      continue;
    }

    if (result.placeholders?.length) {
      placeholderHits.push({
        sourceId: result.unit.sourceId,
        page: result.unit.page,
        question: result.unit.question,
        placeholders: result.placeholders,
      });
    }

    units.push(result.unit);
  }

  return { units, excluded, placeholderHits };
};

module.exports = {
  normalizeFaq,
  normalizePlaceholders,
  extractActiveFaqKnowledge,
  isFaqInPhase4Scope,
  FAQ_INCLUDE_PAGES,
  FAQ_EXCLUDE_PAGES,
  FORBIDDEN_OUTPUT_KEYS,
};
