'use strict';

const {
  parsePurposeFromMessage,
  parseLocationFromMessage,
  parseLocationReply,
  parsePropertyTypesFromMessage,
  parseBedroomChoice,
  parseBudgetFromMessage,
  parseFurnishedFromMessage,
  typesFromFilters,
  applyTypesToFilters,
  applyBedroomChoice,
  applyBudgetChoice,
  copySearchFilters,
  emptySearchFilters,
  hasExecutedListingSearch,
  isShowMoreRequest,
  isSimilarPropertyRequest,
} = require('./chat.tools');

const CORE = ['purpose', 'propertyType', 'location', 'beds', 'budget'];
const RENT_ORDER = ['purpose', 'propertyType', 'location', 'beds', 'budget', 'furnished', 'moveIn', 'mustHaves'];
const BUY_ORDER = ['purpose', 'propertyType', 'budget', 'location', 'beds', 'usage', 'focus', 'readiness'];
const SLOT_KEYS = [
  'purpose',
  'propertyType',
  'location',
  'beds',
  'budget',
  'furnished',
  'moveIn',
  'mustHaves',
  'usage',
  'focus',
  'readiness',
];
/** Blocking questions asked before the first search. */
const QUESTION_CAP = 3;
/** Nice-to-have questions appended after results. */
const OPTIONAL_CAP = 2;
const AREA_OPTIONS = ['Dubai Marina', 'Downtown Dubai', 'JVC', 'Business Bay', 'Any'];
const BEDROOM_OPTIONS = ['Studio', '1 BR', '2 BR', '3 BR', '4+ BR', 'Any'];
const TYPE_OPTIONS = ['Apartment', 'Villa', 'Townhouse', 'Any'];

/** Asked like an agent would, and worded per purpose (rent vs buy). */
const QUESTIONS = {
  purpose: {
    question: 'Are you looking to rent or to buy?',
    options: ['Rent', 'Buy'],
  },
  propertyType: {
    question: 'What type of property are you looking for — an apartment, villa, or townhouse?',
    buy: { question: 'What are you looking to buy — an apartment, villa, or townhouse?' },
    options: TYPE_OPTIONS,
  },
  location: {
    question: 'Which areas do you prefer?',
    buy: { question: 'Which areas are you considering?' },
    options: AREA_OPTIONS,
  },
  beds: {
    question: 'How many bedrooms do you need?',
    options: BEDROOM_OPTIONS,
  },
  budget: {
    question: "What is your annual rental budget?",
    options: ['Up to 60k', '60k - 100k', '100k - 150k', '150k+', 'Any'],
    buy: {
      question: "What budget range are you working with?",
      options: ['Up to 1M', '1M - 2M', '2M - 5M', '5M+', 'Any'],
    },
  },
  furnished: {
    question: 'Do you prefer furnished or unfurnished?',
    options: ['Furnished', 'Unfurnished', 'Either'],
  },
  moveIn: {
    question: 'When are you looking to move in?',
    options: ['Immediately', 'Next month', 'Flexible'],
  },
  mustHaves: {
    question: 'Are there any must-have requirements I should keep in mind?',
    options: ['Parking', 'Balcony', 'Sea view', 'No must-haves'],
  },
  usage: {
    question: 'Is this mainly for investment or personal use?',
    options: ['Investment', 'Personal use', 'Either'],
  },
  focus: {
    question: 'Are you focused more on rental yield or long-term capital growth?',
    options: ['Rental yield', 'Capital growth', 'Either'],
  },
  readiness: {
    question: 'Do you prefer a ready property or off-plan?',
    options: ['Ready', 'Off-plan', 'Either'],
  },
};

function questionFor(slot, purpose) {
  const entry = QUESTIONS[slot];
  if (!entry) return null;
  const override = purpose === 'buy' ? entry.buy : entry.rent;
  return {
    slot,
    question: override?.question || entry.question,
    options: [...(override?.options || entry.options || [])],
  };
}

function emptySlots() {
  return {
    purpose: null,
    propertyType: null,
    location: null,
    beds: null,
    budget: null,
    furnished: null,
    moveIn: null,
    mustHaves: null,
    usage: null,
    focus: null,
    readiness: null,
    askedCount: 0,
    askedOptional: 0,
  };
}

function copyBudget(value) {
  if (value === 'any') return 'any';
  if (!value || typeof value !== 'object') return null;
  return {
    min: value.min ?? null,
    max: value.max ?? null,
    period: value.period || null,
  };
}

function copySlots(source = {}) {
  const slots = emptySlots();
  for (const key of SLOT_KEYS) {
    if (key === 'budget') slots.budget = copyBudget(source.budget);
    else if (source[key] !== undefined && source[key] !== null) slots[key] = source[key];
  }
  slots.askedCount = Number(source.askedCount) || 0;
  slots.askedOptional = Number(source.askedOptional) || 0;
  return slots;
}

function isFilled(value) {
  return value !== undefined && value !== null;
}

/** Merge src into dest. Never null out a filled slot (including 'any'). */
function mergeSlots(dest, src, { onlyNulls = false } = {}) {
  const out = copySlots(dest);
  const incoming = src || {};
  for (const key of SLOT_KEYS) {
    if (!isFilled(incoming[key])) continue;
    if (onlyNulls && isFilled(out[key])) continue;
    out[key] = key === 'budget' ? copyBudget(incoming[key]) : incoming[key];
  }
  // Counters only ever move forward, so a merge can never re-open a question.
  out.askedCount = Math.max(Number(dest?.askedCount) || 0, Number(incoming.askedCount) || 0);
  out.askedOptional = Math.max(Number(dest?.askedOptional) || 0, Number(incoming.askedOptional) || 0);
  return out;
}

function lastOfRole(messages = [], role) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === role) return String(messages[i].content || '').trim();
  }
  return '';
}

function isAnyPhrase(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]/g, '');
  return /^(any|either|none|flexible|open|whatever|skip|n\/?a|doesn'?t matter|does not matter|not sure|you decide|no preference|don'?t care)$/i.test(
    raw
  );
}

function budgetPeriod(purpose) {
  return purpose === 'rent' ? 'year' : 'total';
}

function moneyAmount(num, unit) {
  const n = Number(String(num || '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = String(unit || '').toLowerCase();
  if (u === 'k' || u === 'thousand') return n * 1_000;
  if (u === 'm' || u === 'mn' || u === 'million') return n * 1_000_000;
  return n;
}

/** "120k" and "2M" have no word boundary before the unit, so match the digit too. */
const MONEY_UNIT = /\b(aed|dirhams?|million|thousand|budget|price|rent)\b|\d\s*(k|m|mn)\b/i;
const AMOUNT = String.raw`(\d[\d,]*(?:\.\d+)?)\s*(k|m|mn|million|thousand)?`;
const RANGE_RE = new RegExp(`${AMOUNT}\\s*(?:-|–|—|to|and)\\s*${AMOUNT}`, 'i');
const MIN_ONLY_RE = new RegExp(
  `(?:^|\\s)(?:over|above|more than|from|starting (?:at|from)|at least)\\s+${AMOUNT}|${AMOUNT}\\s*\\+`,
  'i'
);
const MAX_ONLY_RE = new RegExp(
  `(?:under|below|up\\s+to|max(?:imum)?|less\\s+than|within|no\\s+more\\s+than|budget\\s+(?:of|is)|around|about)\\s*(?:aed\\s*)?${AMOUNT}`,
  'i'
);

/**
 * Understands the budget chips ("60k - 100k", "150k+", "Up to 1M") as well as
 * free text. period is annual for rent and total for buy.
 */
function parseBudgetSlot(text, { purpose, requireContext = false } = {}) {
  const raw = String(text || '')
    .trim()
    .replace(/,/g, '');
  if (!raw) return null;
  const period = budgetPeriod(purpose);
  const hasMoneyContext = MONEY_UNIT.test(raw) || requireContext;
  // "2 - 3 bedrooms" must never be read as a price range.
  if (!hasMoneyContext) return null;
  if (parseBedroomChoice(raw) && !MONEY_UNIT.test(raw)) return null;

  const range = raw.match(RANGE_RE);
  if (range) {
    const unit = range[4] || range[2];
    const min = moneyAmount(range[1], range[2] || unit);
    const max = moneyAmount(range[3], unit);
    if (min || max) return { min: min || null, max: max || null, period };
  }

  const minOnly = raw.match(MIN_ONLY_RE);
  if (minOnly) {
    const min = moneyAmount(minOnly[1] ?? minOnly[3], minOnly[2] ?? minOnly[4]);
    if (min) return { min, max: null, period };
  }

  const maxOnly = raw.match(MAX_ONLY_RE);
  if (maxOnly) {
    const max = moneyAmount(maxOnly[1], maxOnly[2]);
    if (max) return { min: null, max, period };
  }

  const parsed = parseBudgetFromMessage(raw, { requireBudgetContext: requireContext });
  if (!parsed) return null;
  if (parsed.any) return 'any';
  return { min: parsed.budgetMin ?? null, max: parsed.budgetMax ?? null, period };
}

function parseBedsSlot(text) {
  const choice = parseBedroomChoice(text);
  if (!choice) return null;
  if (choice.any) return 'any';
  if (choice.exact === 0) return 'studio';
  if (choice.exact != null) return choice.exact;
  if (choice.min != null) return choice.min;
  return null;
}

function parseTypeSlot(text) {
  const types = parsePropertyTypesFromMessage(text);
  if (!types.length) return null;
  return String(types[0]).trim().toLowerCase();
}

function parsePurposeSlot(text) {
  const purpose = parsePurposeFromMessage(text);
  if (purpose === 'Rent') return { purpose: 'rent' };
  if (purpose === 'Buy') return { purpose: 'buy' };
  if (purpose === 'Off-plan') return { purpose: 'buy', readiness: 'offplan' };
  return null;
}

function parseFurnishedSlot(text) {
  const raw = String(text || '').toLowerCase();
  if (/\bunfurnished\b/.test(raw)) return 'unfurnished';
  const parsed = parseFurnishedFromMessage(text);
  if (!parsed) return null;
  if (/unfurnished/i.test(parsed)) return 'unfurnished';
  return 'furnished';
}

function parseReadinessSlot(text) {
  const raw = String(text || '').toLowerCase();
  if (/\b(off[\s-_]*plan|handover)\b/.test(raw)) return 'offplan';
  if (/\b(ready(\s+to\s+move)?|completed)\b/.test(raw)) return 'ready';
  return null;
}

function parseUsageSlot(text) {
  const raw = String(text || '').toLowerCase();
  if (/\b(to live in|for myself|end[\s-]?use|personal|own use)\b/.test(raw)) return 'personal';
  if (/\b(investment|invest|to let)\b/.test(raw)) return 'investment';
  return null;
}

function parseFocusSlot(text) {
  const raw = String(text || '').toLowerCase();
  if (/\b(yield|rental income)\b/.test(raw)) return 'yield';
  if (/\b(capital growth|appreciation|growth)\b/.test(raw)) return 'growth';
  return null;
}

function parseMoveInSlot(text) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  if (/\b(immediately|asap|right away|now)\b/.test(lower)) return 'immediately';
  if (/\bnext month\b/.test(lower)) return 'next month';
  const month = raw.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i
  );
  if (month) return month[1];
  const dated = raw.match(/\b(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/);
  if (dated) return dated[1];
  return null;
}

function parseMustHavesSlot(text) {
  const raw = String(text || '').trim();
  if (/\b(must[\s-]?haves?|need(?:s)? a (?:pool|parking|gym|balcony|maid|garden|view)|with a (?:pool|parking|gym|balcony))\b/i.test(raw)) {
    return raw.replace(/\s+/g, ' ').trim();
  }
  return null;
}

function slotsFromFilters(filters = {}) {
  const slots = emptySlots();
  const purpose = String(filters.purpose || '').trim();
  if (purpose === 'Rent') slots.purpose = 'rent';
  else if (purpose === 'Buy') slots.purpose = 'buy';
  else if (purpose === 'Off-plan') {
    slots.purpose = 'buy';
    slots.readiness = 'offplan';
  }
  const types = typesFromFilters(filters);
  if (types.length) slots.propertyType = String(types[0]).trim().toLowerCase();
  if (filters.location) slots.location = String(filters.location).trim();
  if (filters.bedroomsAny) slots.beds = 'any';
  else if (filters.bedrooms === 0) slots.beds = 'studio';
  else if (filters.bedrooms != null && filters.bedrooms !== '') slots.beds = Number(filters.bedrooms);
  else if (filters.bedroomsMin != null && filters.bedroomsMin !== '') slots.beds = Number(filters.bedroomsMin);
  if (filters.budgetMin != null || filters.budgetMax != null) {
    slots.budget = {
      min: filters.budgetMin ?? null,
      max: filters.budgetMax ?? null,
      period: budgetPeriod(slots.purpose),
    };
  }
  const furnished = parseFurnishedSlot(filters.furnished || '');
  if (furnished) slots.furnished = furnished;
  return slots;
}

function hydrateSlots(prevSlots, filters) {
  return mergeSlots(mergeSlots(emptySlots(), prevSlots), slotsFromFilters(filters), { onlyNulls: true });
}

function slotsFromProfileHints(profile = {}) {
  const slots = emptySlots();
  const purposeValue = profile.purpose || profile.lastSearchFilters?.purpose;
  if (purposeValue === 'Rent' || purposeValue === 'rent') slots.purpose = 'rent';
  else if (purposeValue === 'Buy' || purposeValue === 'buy') slots.purpose = 'buy';
  else if (purposeValue === 'Off-plan') {
    slots.purpose = 'buy';
    slots.readiness = 'offplan';
  }
  if (profile.bedrooms === 0) slots.beds = 'studio';
  else if (profile.bedrooms != null && profile.bedrooms !== '') slots.beds = Number(profile.bedrooms);
  const budget = profile.budget || {};
  if (budget.min != null || budget.max != null) {
    slots.budget = {
      min: budget.min ?? null,
      max: budget.max ?? null,
      period: budgetPeriod(slots.purpose),
    };
  }
  const area = (profile.preferredAreas || []).find((value) => String(value || '').trim());
  if (area) slots.location = String(area).trim();
  return slots;
}

/**
 * Rebuild qualification slots from everything already stored on the session:
 * saved answers, last search filters, and top-level profile hints.
 * Filled values are never dropped here — later user text can still replace them.
 */
function rememberedSlots(profile = {}) {
  const stored = copySlots(profile.qualificationSlots || emptySlots());
  const withFilters = syncSlotsWithFilters(stored, profile.lastSearchFilters || emptySearchFilters());
  return mergeSlots(withFilters, slotsFromProfileHints(profile), { onlyNulls: true });
}

/**
 * Search filters are the source of truth once the deterministic pipeline has run,
 * so a slot inferred earlier can never override a filter resolved this turn.
 */
function syncSlotsWithFilters(slots, filters) {
  return mergeSlots(copySlots(slots), slotsFromFilters(filters));
}

function nextQuestion(slots = {}) {
  const order = slots.purpose === 'buy' ? BUY_ORDER : RENT_ORDER;
  for (const slot of order) {
    if (!isFilled(slots[slot])) return questionFor(slot, slots.purpose);
  }
  return null;
}

function nextQuestionForProfile(profile = {}) {
  return nextQuestion(rememberedSlots(profile));
}

function listingPurposeKey(slots = {}) {
  if (slots.purpose === 'rent') return 'rent';
  if (slots.purpose === 'buy' && slots.readiness === 'offplan') return 'offplan';
  if (slots.purpose === 'buy') return 'buy';
  return null;
}

function sameBudgetValue(left, right) {
  if (left === 'any' && right === 'any') return true;
  if (!isFilled(left) && !isFilled(right)) return true;
  if (!isFilled(left) || !isFilled(right)) return false;
  if (left === 'any' || right === 'any') return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  return left.min == right.min && left.max == right.max;
}

/**
 * Rent / buy / off-plan budgets are not interchangeable. Keep type, beds, and
 * location, but drop a budget that was only known for the previous purpose.
 */
function dropCarriedBudgetOnPurposeSwitch(slots, previousSlots = {}) {
  const next = copySlots(slots);
  const from = listingPurposeKey(previousSlots);
  const to = listingPurposeKey(next);
  if (from && to && from !== to && sameBudgetValue(previousSlots.budget, next.budget)) {
    next.budget = null;
  }
  return next;
}

function retainSlotsForListingIntent(slots, intent = '') {
  const previous = copySlots(slots);
  const next = copySlots(slots);
  const detected = String(intent || '').toUpperCase();
  if (detected === 'RENT') {
    next.purpose = 'rent';
    next.readiness = null;
  } else if (detected === 'OFF_PLAN') {
    next.purpose = 'buy';
    next.readiness = 'offplan';
  } else if (detected === 'BUY') {
    next.purpose = 'buy';
    if (next.readiness === 'offplan') next.readiness = null;
  }
  return dropCarriedBudgetOnPurposeSwitch(next, previous);
}

/**
 * Overlay this turn's message on everything already stored, then write the
 * result back onto search filters. Current-turn answers replace a slot;
 * missing answers keep the previous value.
 */
function applyRememberedTurn(profile = {}, message = '', history = []) {
  const previous = rememberedSlots(profile);
  const slots = dropCarriedBudgetOnPurposeSwitch(
    deriveSlots([...(history || []), { role: 'user', content: message }], previous),
    previous
  );
  const filters = applySlotsToSearchFilters(
    profile.lastSearchFilters || emptySearchFilters(),
    slots,
    { unblocking: false }
  );
  if (!isFilled(slots.budget)) {
    const purposeChanged =
      listingPurposeKey(previous) &&
      listingPurposeKey(slots) &&
      listingPurposeKey(previous) !== listingPurposeKey(slots);
    if (purposeChanged) {
      filters.budgetMin = null;
      filters.budgetMax = null;
    }
  }
  return { slots, filters };
}

function isCoreMissing(slots = {}) {
  return CORE.some((key) => !isFilled(slots[key]));
}

function shouldBlockQualification(slots = {}, profile = {}, message = '') {
  if (isShowMoreRequest(message) || isSimilarPropertyRequest(message)) return false;
  if (hasExecutedListingSearch(profile)) return false;
  return isCoreMissing(slots) && (Number(slots.askedCount) || 0) < QUESTION_CAP;
}

function deriveSlots(messages = [], prevSlots = {}) {
  const slots = copySlots(prevSlots);
  const text = lastOfRole(messages, 'user');
  if (!text) return slots;
  const lastAssistant = lastOfRole(messages, 'assistant');
  const pending = nextQuestion(slots);

  if (isAnyPhrase(text) && pending) {
    slots[pending.slot] = 'any';
    return slots;
  }

  const purposeHit = parsePurposeSlot(text);
  if (purposeHit?.purpose) slots.purpose = purposeHit.purpose;
  if (purposeHit?.readiness) slots.readiness = purposeHit.readiness;

  const typeHit = parseTypeSlot(text);
  if (typeHit) slots.propertyType = typeHit;

  const fromIn = parseLocationFromMessage(text);
  const locReply =
    fromIn ||
    (/area|location|search/i.test(lastAssistant) || pending?.slot === 'location'
      ? parseLocationReply(text)
      : null);
  if (locReply && !isAnyPhrase(locReply)) slots.location = locReply;

  const bedsHit = parseBedsSlot(text);
  if (bedsHit != null) slots.beds = bedsHit;

  const budgetHit = parseBudgetSlot(text, {
    purpose: slots.purpose,
    requireContext: /budget/i.test(lastAssistant) || pending?.slot === 'budget',
  });
  if (budgetHit) slots.budget = budgetHit;

  const furnishedHit = parseFurnishedSlot(text);
  if (furnishedHit) slots.furnished = furnishedHit;

  const readyHit = parseReadinessSlot(text);
  if (readyHit) slots.readiness = readyHit;

  const usageHit = parseUsageSlot(text);
  if (usageHit) slots.usage = usageHit;

  const focusHit = parseFocusSlot(text);
  if (focusHit) slots.focus = focusHit;

  const moveHit = parseMoveInSlot(text);
  if (moveHit && (pending?.slot === 'moveIn' || /\b(move in|moving|immediately|next month)\b/i.test(text))) {
    slots.moveIn = moveHit;
  }

  const mustHit = parseMustHavesSlot(text);
  if (mustHit) slots.mustHaves = mustHit;
  else if (pending?.slot === 'mustHaves' && text && !isAnyPhrase(text)) slots.mustHaves = text;

  return slots;
}

function applySlotsToSearchFilters(filters = {}, slots = {}, { unblocking = false } = {}) {
  const next = copySearchFilters(filters || emptySearchFilters());
  if (slots.purpose === 'rent') next.purpose = 'Rent';
  else if (slots.purpose === 'buy') {
    next.purpose = slots.readiness === 'offplan' || next.purpose === 'Off-plan' ? 'Off-plan' : 'Buy';
    if (slots.readiness === 'ready') next.purpose = 'Buy';
  }

  if (slots.propertyType === 'any') applyTypesToFilters(next, []);
  else if (slots.propertyType) {
    const label = String(slots.propertyType).replace(/^\w/, (c) => c.toUpperCase());
    applyTypesToFilters(next, [label]);
  }

  if (slots.location === 'any') next.location = null;
  else if (typeof slots.location === 'string' && slots.location.trim()) next.location = slots.location.trim();

  if (slots.beds === 'any' || (unblocking && slots.beds == null)) applyBedroomChoice(next, { any: true });
  else if (slots.beds === 'studio') applyBedroomChoice(next, { exact: 0 });
  else if (typeof slots.beds === 'number') applyBedroomChoice(next, { exact: slots.beds });

  if (slots.budget === 'any') {
    next.budgetMin = null;
    next.budgetMax = null;
  } else if (slots.budget && typeof slots.budget === 'object') {
    applyBudgetChoice(next, { budgetMin: slots.budget.min, budgetMax: slots.budget.max });
  }

  if (slots.furnished === 'furnished') next.furnished = 'Furnished';
  else if (slots.furnished === 'unfurnished') next.furnished = 'Unfurnished';
  else if (slots.furnished === 'any') next.furnished = null;

  return next;
}

/**
 * After results, add at most one nice-to-have question, and only while we are
 * under OPTIONAL_CAP — the conversation must not turn into a questionnaire.
 */
function appendOptionalFollowUp(reply, slots = {}) {
  const current = copySlots(slots);
  const question = nextQuestion(current);
  if (!question || CORE.includes(question.slot) || current.askedOptional >= OPTIONAL_CAP) {
    return { reply, question: null, slots: current };
  }
  const base = String(reply || '')
    .replace(/\s*(?:Would you like the details|Shall I take you through them)\??\s*$/i, '')
    .trim();
  // One question per turn: never append to a reply that already asks something
  // (e.g. the no-results copy offering a different area).
  if (base.endsWith('?')) return { reply, question: null, slots: current };
  current.askedOptional += 1;
  return {
    reply: `${base} ${question.question}`.replace(/\s+/g, ' ').trim(),
    question,
    slots: current,
  };
}

module.exports = {
  CORE,
  RENT_ORDER,
  BUY_ORDER,
  QUESTION_CAP,
  OPTIONAL_CAP,
  questionFor,
  emptySlots,
  copySlots,
  mergeSlots,
  slotsFromFilters,
  hydrateSlots,
  rememberedSlots,
  slotsFromProfileHints,
  syncSlotsWithFilters,
  deriveSlots,
  listingPurposeKey,
  dropCarriedBudgetOnPurposeSwitch,
  retainSlotsForListingIntent,
  applyRememberedTurn,
  nextQuestion,
  nextQuestionForProfile,
  isCoreMissing,
  shouldBlockQualification,
  applySlotsToSearchFilters,
  appendOptionalFollowUp,
};
