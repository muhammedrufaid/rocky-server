/**
 * Intent router (rules only).
 *
 * Priority (after confidential guard / active flows):
 * GREETING → CONVERSION → PROPERTY_COUNT → SELL_PROPERTY → PROPERTY_SEARCH
 * → COMPANY → SERVICES → TEAM → BLOG → AREA_GUIDE / FAQ / KNOWLEDGE_BOTH → UNSUPPORTED
 */

const COMPANY_PATTERNS = [
  /\b(who\s+(is|are)\s+(the\s+)?)?(owner|founder|director)\b/i,
  /\bwho\s+owns\b(?!\s+(?:this|the|a|an|my|our)\b)/i,
  /\b(founded|established|founded\s+by|established\s+in|since\s+when|when\s+was\s+.{0,40}established)\b/i,
  /\b(head\s*office|headquarters|hq|where\s+(are|is)\s+you\s+(based|located)|office\s+address|where\s+is\s+your\s+office)\b/i,
  /\b(tell\s+me\s+about|what\s+is|who\s+is)\s+rocky(\s+real\s+estate)?\b/i,
  /\brocky\s+real\s+estate\b.{0,40}\b(about|overview|history|company)\b/i,
  /\b(company\s+name|key\s+strengths|website)\b/i,
  /\b(about\s+(the\s+)?company|company\s+overview)\b/i,
];

const SERVICE_PATTERNS = [
  /\bwhat\s+services\b/i,
  /\bservices\s+(do|does|are|available|offered|provide|you)\b/i,
  /\byour\s+services\b/i,
  /\b(offer|provide|available)\b.{0,40}\bservices?\b/i,
  /\btell\s+me\s+about\s+(?:your\s+)?services\b/i,
  /\bwhat\s+does\s+rocky.{0,30}\bdo\b/i,
  /\b(property\s+management|professional\s+inspection|brokerage|mortgage|after[\s-]?sales|property\s+listing\s*(?:&|and)?\s*marketing)\b/i,
  /\btell\s+me\s+about\s+(?:your\s+)?(property\s+management|brokerage|mortgage|inspection|listing)\b/i,
  /\bdo\s+you\s+(provide|offer)\b/i,
];

const TEAM_PATTERNS = [
  /\bwho\s+is\s+(?:the\s+)?(ceo|general\s+manager|head\s+of\b)/i,
  /\bwho\s+are\s+(?:the\s+)?(property\s+consultants?|agents?)\b/i,
  /\bproperty\s+consultants?\b/i,
  /\bwho\s+works\s+in\b/i,
  /\btell\s+me\s+about\s+(?!rocky\b)(?!dubai\b|jumeirah\b|arabian\b|business\b|emaar\b|madinat\b|the\s+springs\b|the\s+greens\b|jebel\b|palm\b|marina\b)([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)+)\b/i,
  /\bwho\s+is\s+(?!the\s+(?:owner|founder|director)\b)(?!rocky\b)(?!dubai\b|jumeirah\b|arabian\b|business\b|emaar\b|madinat\b)([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)+)\b/i,
  /\bhead\s+of\s+[a-z]/i,
  /\b(ceo|general\s+manager)\b/i,
];

const PROPERTY_COUNT_TYPE =
  'properties|listings|homes|units|apartments?|villas?|townhouses?|penthouses?|offices?';

const PROPERTY_COUNT_PATTERNS = [
  new RegExp(`\\bhow\\s+many\\s+(${PROPERTY_COUNT_TYPE})\\b`, 'i'),
  new RegExp(`\\bhow\\s+many\\s+.{0,40}\\b(${PROPERTY_COUNT_TYPE})\\b`, 'i'),
  /\b(property|listing)\s+count\b/i,
  new RegExp(`\\bnumber\\s+of\\s+(${PROPERTY_COUNT_TYPE})\\b`, 'i'),
];

const PROPERTY_SEARCH_PATTERNS = [
  /\b(show|find|list|search|get)\b.{0,40}\b(apartments?|villas?|townhouses?|penthouses?|offices?|properties|listings|homes)\b/i,
  /\b(apartments?|villas?|townhouses?|penthouses?)\s+in\b/i,
  /\bproperties?\s+(under|below|less\s+than|above|over|in|at|for)\b/i,
  /\blistings?\s+(under|below|in|at|for)\b/i,
  /\b(under|below)\s+(?:aed\s*)?[\d,.]+\s*(million|m)?\b.{0,20}\b(propert|listing|apartment|villa)/i,
  /\b(current|live)?\s*price\s+of\b.{0,50}\b(apartment|villa|property|townhouse)\b/i,
  /\b(apartment|villa|property)\s+(?:current\s+)?price\b/i,
  /\bhow\s+much\s+(?:is|for|does)\b.{0,40}\b(apartment|villa|property)\b/i,
  /\b\d[\d\s-]*bedroom/i,
  /\b(want\s+to|looking\s+to|i\s+want\s+to)\s+(rent|buy)\b/i,
  /\b(rent|buy)\s+a\s+(apartment|villa|townhouse|property|penthouse)\b/i,
  /^(buy|rent|off[\s-]?plan)(\s+a\s+property|\s+properties)?$/i,
  /^buy\s+a\s+property$/i,
  /^rent\s+a\s+property$/i,
  /^off[\s-]?plan(\s+properties)?$/i,
  /\bview\s+(more\s+)?propert/i,
  /\bchange\s+(search|area|budget)\b/i,
];

const SELL_PROPERTY_PATTERNS = [
  /\b(i\s+want\s+to\s+sell|looking\s+to\s+sell|want\s+to\s+sell)\b/i,
  /\bsell\s+my\s+(apartment|villa|townhouse|property|home|office|penthouse)\b/i,
  /\b(list|listing)\s+my\s+(apartment|villa|townhouse|property|home)\b/i,
  /^sell\s+my\s+property$/i,
];

const CONVERSION_PATTERNS = [
  /\btalk\s+to\s+(an\s+)?agent\b/i,
  /\bspeak\s+(to|with)\s+(an\s+)?agent\b/i,
  /\bwhatsapp\s+rocky\b/i,
  /\bschedule\s+a\s+viewing\b/i,
  /\bi\s+like\s+the\s+(first|second|third|fourth|fifth|\d+)/i,
  /\bi\s+like\s+(this|that)\s+propert/i,
  /\bcan\s+i\s+view\s+(this|it|that)\b/i,
  /\bcan\s+i\s+book\s+a\s+viewing\b/i,
  /\bis\s+(it|this)\s+(still\s+)?available\b/i,
  /\bi\s+need\s+an\s+agent\b/i,
  /\bcan\s+someone\s+contact\s+me\b/i,
  /\bcan\s+i\s+speak\s+to\s+someone\b/i,
  /^contact\s+rocky$/i,
  /^contact\s+property\s+management$/i,
];

const BLOG_PATTERNS = [
  /\b(blog|articles?|guides?\s+and\s+articles?)\b/i,
  /\b(latest|recent)\s+.{0,40}\b(articles?|blogs?|posts?)\b/i,
  /\bproperty\s+investment\s+articles?\b/i,
  /\bflexi\s*rent\b/i,
  /\bfreehold\s+vs\s+leasehold\b/i,
  /\b(difference\s+between\s+)?freehold\s+and\s+leasehold\b/i,
  /\bwhat\s+is\s+freehold\b/i,
];

const AREA_GUIDE_PATTERNS = [
  /\b(what\s+is|tell\s+me\s+about|where\s+is|living\s+in|highlights?\s+of|what\s+are\s+the\s+highlights)\b.{0,80}\b(dubai\s+marina|dubai\s+south|arabian\s+ranches|dubai\s+media\s+city|jumeirah\s+village\s+circle|\bjvc\b|business\s+bay|the\s+springs|the\s+greens|emaar\s+beachfront|dubai\s+creek|jebel\s+ali|madinat\s+jumeirah|jumeirah\s+golf)\b/i,
  /\b(dubai\s+marina|dubai\s+south|arabian\s+ranches|dubai\s+media\s+city|jumeirah\s+village\s+circle|\bjvc\b|business\s+bay|the\s+springs|the\s+greens|emaar\s+beachfront|dubai\s+creek\s+harbour|jebel\s+ali\s+village|madinat\s+jumeirah|jumeirah\s+golf\s+estates)\b.{0,40}\b(like|overview|highlights?|community|area)\b/i,
  /\bwhat\s+is\s+.{0,40}\s+like\b/i,
  /\barea\s+guide\b/i,
  /\bbest\s+areas?\s+to\s+(live|buy|invest)\b/i,
  /\bareas?\s+(good|best)\s+for\s+(investment|living|families)\b/i,
  /\bbest\s+areas?\s+in\s+dubai\b/i,
  /\bexplore\s+dubai\s+areas\b/i,
];

const FAQ_PATTERNS = [
  /\b(faq|frequently\s+asked)\b/i,
  /\b(buying\s+process|costs?\s+involved|can\s+foreigners\s+buy|golden\s+visa|snagging|why\s+should\s+i\s+choose\s+rocky)\b/i,
  /\b(is\s+it\s+safe\s+to\s+buy\s+off[\s-]?plan|sell\s+my\s+off[\s-]?plan|off[\s-]?plan\s+(process|property|buyers?))\b/i,
  /\bcan\s+foreigners\s+buy\s+property\b/i,
  /\bwhat\s+are\s+the\s+costs?\s+involved\b/i,
  /\bhow\s+long\s+does\s+the\s+buying\s+process\b/i,
  /\bcommon\s+questions?\b/i,
  /\b(how\s+much\s+)?deposit\b/i,
  /\bdown\s+payment\b/i,
];

const KNOWLEDGE_BOTH_PATTERNS = [
  /\b(areas?|communities?).{0,80}\b(buying\s+process|how\s+to\s+buy|foreigners\s+buy)\b/i,
  /\b(investment|invest).{0,80}\b(buying\s+process|how\s+to\s+buy|faq)\b/i,
  /\b(buying\s+process|how\s+to\s+buy).{0,80}\b(areas?|communities?|investment)\b/i,
];

const matchesAny = (text, patterns) => patterns.some((re) => re.test(text));

/**
 * Greeting / casual openers (no RAG / property / OpenAI).
 * @param {string} text
 */
const isGreetingMessage = (text) => {
  const t = String(text || '').trim();
  if (!t || t.length > 48) return false;
  return /^(hi|hello|hey|hi\s+there|hey\s+there|good\s+morning|good\s+afternoon|good\s+evening|how\s+are\s+you|how's\s+it\s+going|how\s+are\s+you\s+doing)([\s,!.?]*)$/i.test(
    t
  );
};

/**
 * @param {string} message
 * @returns {string}
 */
const classifyIntent = (message) => {
  const text = String(message || '').trim();
  if (!text) return 'UNSUPPORTED';

  if (isGreetingMessage(text)) return 'GREETING';
  if (matchesAny(text, CONVERSION_PATTERNS)) return 'CONVERSION';
  if (matchesAny(text, PROPERTY_COUNT_PATTERNS)) return 'PROPERTY_COUNT';
  // Sell before property search so "sell my apartment in X" is not misrouted
  if (matchesAny(text, SELL_PROPERTY_PATTERNS)) return 'SELL_PROPERTY';
  if (matchesAny(text, PROPERTY_SEARCH_PATTERNS)) return 'PROPERTY_SEARCH';
  if (matchesAny(text, COMPANY_PATTERNS)) return 'COMPANY_INFO';
  if (matchesAny(text, SERVICE_PATTERNS)) return 'SERVICE_INFO';
  if (matchesAny(text, TEAM_PATTERNS)) return 'TEAM_INFO';
  if (matchesAny(text, KNOWLEDGE_BOTH_PATTERNS)) return 'KNOWLEDGE_BOTH';
  if (matchesAny(text, BLOG_PATTERNS)) return 'BLOG';

  const area = matchesAny(text, AREA_GUIDE_PATTERNS);
  const faq = matchesAny(text, FAQ_PATTERNS);
  if (area && faq) return 'KNOWLEDGE_BOTH';
  if (area) return 'AREA_GUIDE';
  if (faq) return 'FAQ';

  return 'UNSUPPORTED';
};

module.exports = {
  classifyIntent,
  isGreetingMessage,
};
