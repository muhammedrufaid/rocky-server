/**
 * CMS / blog community recommendations → property-search handoff.
 * Persists recommendedLocations and drives Buy/Rent/Off-plan → community inventory → bedrooms.
 */
const propertyDbService = require('../services/propertyDbService');
const { formatAed } = require('./chat.format');

const CMS_HANDOFF_PURPOSE = 'cmsHandoffPurpose';
const CMS_HANDOFF_LOCATION = 'cmsHandoffLocation';
const CMS_HANDOFF_PROPERTY_TYPE = 'cmsHandoffPropertyType';
const SEARCH_SOURCE_CMS = 'cms_recommendation';
const SEARCH_SOURCE_DIRECT = 'direct_property_search';
/** Show listings immediately (any bedrooms) when match count is at or below this. */
const CMS_IMMEDIATE_LISTING_THRESHOLD = 6;

/** Structured FE badge action for topic-scoped multi-community property discovery. */
const VIEW_CONTEXT_COMMUNITY_PROPERTIES = 'VIEW_CONTEXT_COMMUNITY_PROPERTIES';
const VIEW_CONTEXT_COMMUNITIES_LABEL = 'View properties in these 3 communities';

/**
 * Fixed community scopes for known CMS articles.
 * When matched, property search must use ONLY these areas (never Dubai-wide).
 */
const CMS_TOPIC_SCOPES = [
  {
    id: 'best-communities-for-families-dubai',
    titlePatterns: [/best\s+communities?\s+for\s+families(?:\s+in\s+dubai)?/i],
    slugPatterns: [/best-communities-for-families/i],
    areaNames: ['Dubai Hills Estate', 'Jumeirah Village Circle', 'Al Furjan'],
  },
];

function normalizeActionName(action) {
  return String(action || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

function isViewContextCommunityPropertiesAction(action) {
  const name = normalizeActionName(action);
  return (
    name === VIEW_CONTEXT_COMMUNITY_PROPERTIES ||
    name === 'VIEW_CONTEXT_COMMUNITIES' ||
    name === 'VIEW_THESE_COMMUNITIES'
  );
}

function isViewContextCommunitiesMessage(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '');
  if (!raw) return false;
  if (raw === VIEW_CONTEXT_COMMUNITIES_LABEL.toLowerCase()) return true;
  return (
    /\bview\s+propert(?:y|ies)\s+in\s+these\s+(\d+\s+)?communit(?:y|ies)\b/.test(raw) ||
    /\bexplore\s+propert(?:y|ies)\s+in\s+these\s+(\d+\s+)?communit(?:y|ies)\b/.test(raw)
  );
}

/**
 * Force the canonical community list for a known contextKey.
 * Never trust a single stale location (e.g. "Dubai Hills") to replace the topic scope.
 */
function communitiesForContextKey(contextKey, fallbackCommunities = []) {
  const key = String(contextKey || '').trim();
  if (key) {
    const topic =
      CMS_TOPIC_SCOPES.find((t) => normalizeLocKey(t.id) === normalizeLocKey(key)) ||
      matchCmsTopicScopeFromText({ title: key, slug: key, source: key });
    if (topic) return locationsForTopicScope(topic);
  }
  const fallback = copyRecommendedLocations(
    (fallbackCommunities || []).map((c) => (typeof c === 'string' ? { name: c } : c))
  );
  return fallback;
}

/**
 * Structured quick-action badge for the FE (click sends action + communities, not free text).
 */
function buildViewContextCommunitiesAction(topicOrId, communities = []) {
  const topicId =
    typeof topicOrId === 'string'
      ? topicOrId
      : topicOrId?.id || 'best-communities-for-families-dubai';
  const locs = communitiesForContextKey(topicId, communities);
  const names = locs.map((l) => l.name);
  const n = names.length || 3;
  const label =
    n === 3 ? VIEW_CONTEXT_COMMUNITIES_LABEL : `View properties in these ${n} communities`;
  return {
    type: 'action',
    action: VIEW_CONTEXT_COMMUNITY_PROPERTIES,
    label,
    value: label,
    contextKey: topicId,
    communities: names,
  };
}

function bedroomChipLabel(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v === 0) return 'Studio';
  if (v === 1) return '1 Bed';
  if (v >= 5) return '5+ Beds';
  return `${v} Beds`;
}

/** Known Dubai communities for CMS entity extraction (aliases → canonical search name). */
const CMS_COMMUNITY_CATALOG = [
  {
    name: 'Dubai Hills Estate',
    shortName: null,
    aliases: ['Dubai Hills Estate', 'Dubai Hills', 'DHE'],
    searchValue: 'dubai-hills-estate',
  },
  {
    name: 'Jumeirah Village Circle',
    shortName: 'JVC',
    aliases: [
      'Jumeirah Village Circle',
      'Jumeirah Village Circle (JVC)',
      'JVC',
      'Jumeirah Village Circle JVC',
    ],
    searchValue: 'jumeirah-village-circle',
  },
  {
    name: 'Al Furjan',
    shortName: null,
    aliases: ['Al Furjan', 'Furjan'],
    searchValue: 'al-furjan',
  },
  {
    name: 'Arabian Ranches',
    shortName: null,
    aliases: ['Arabian Ranches', 'Arabian Ranches 2', 'Arabian Ranches II'],
    searchValue: 'arabian-ranches',
  },
  {
    name: 'Dubai Marina',
    shortName: null,
    aliases: ['Dubai Marina', 'The Marina'],
    searchValue: 'dubai-marina',
  },
  {
    name: 'Business Bay',
    shortName: null,
    aliases: ['Business Bay'],
    searchValue: 'business-bay',
  },
  {
    name: 'Downtown Dubai',
    shortName: null,
    aliases: ['Downtown Dubai', 'Downtown'],
    searchValue: 'downtown-dubai',
  },
  {
    name: 'Palm Jumeirah',
    shortName: null,
    aliases: ['Palm Jumeirah', 'The Palm'],
    searchValue: 'palm-jumeirah',
  },
  {
    name: 'Jumeirah Beach Residence',
    shortName: 'JBR',
    aliases: ['Jumeirah Beach Residence', 'JBR'],
    searchValue: 'jumeirah-beach-residence',
  },
  {
    name: 'Dubai South',
    shortName: null,
    aliases: ['Dubai South', 'Dubai South (DWC)'],
    searchValue: 'dubai-south',
  },
  {
    name: 'Jebel Ali',
    shortName: null,
    aliases: ['Jebel Ali', 'Jebel Ali Village'],
    searchValue: 'jebel-ali',
  },
  {
    name: 'Mudon',
    shortName: null,
    aliases: ['Mudon'],
    searchValue: 'mudon',
  },
  {
    name: 'Town Square',
    shortName: null,
    aliases: ['Town Square'],
    searchValue: 'town-square',
  },
  {
    name: 'Damac Hills',
    shortName: null,
    aliases: ['Damac Hills', 'DAMAC Hills'],
    searchValue: 'damac-hills',
  },
  {
    name: 'Motor City',
    shortName: null,
    aliases: ['Motor City'],
    searchValue: 'motor-city',
  },
  {
    name: 'Sports City',
    shortName: null,
    aliases: ['Sports City', 'Dubai Sports City'],
    searchValue: 'sports-city',
  },
  {
    name: 'Dubai Hills',
    shortName: null,
    aliases: ['Dubai Hills'],
    searchValue: 'dubai-hills',
  },
  {
    name: 'Meydan',
    shortName: null,
    aliases: ['Meydan', 'Meydan City'],
    searchValue: 'meydan',
  },
  {
    name: 'Tilal Al Ghaf',
    shortName: null,
    aliases: ['Tilal Al Ghaf'],
    searchValue: 'tilal-al-ghaf',
  },
  {
    name: 'The Valley',
    shortName: null,
    aliases: ['The Valley'],
    searchValue: 'the-valley',
  },
  {
    name: 'Dubai Creek Harbour',
    shortName: null,
    aliases: ['Dubai Creek Harbour', 'Creek Harbour'],
    searchValue: 'dubai-creek-harbour',
  },
  {
    name: 'Bluewaters Island',
    shortName: null,
    aliases: ['Bluewaters', 'Bluewaters Island'],
    searchValue: 'bluewaters-island',
  },
  {
    name: 'City Walk',
    shortName: null,
    aliases: ['City Walk'],
    searchValue: 'city-walk',
  },
  {
    name: 'Al Barsha',
    shortName: null,
    aliases: ['Al Barsha', 'Barsha'],
    searchValue: 'al-barsha',
  },
  {
    name: 'Jumeirah Village Triangle',
    shortName: 'JVT',
    aliases: ['Jumeirah Village Triangle', 'JVT'],
    searchValue: 'jumeirah-village-triangle',
  },
  {
    name: 'Remraam',
    shortName: null,
    aliases: ['Remraam'],
    searchValue: 'remraam',
  },
  {
    name: 'Dubailand',
    shortName: null,
    aliases: ['Dubailand'],
    searchValue: 'dubailand',
  },
];

function slugifyLocation(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeLocKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function copyRecommendedLocation(row = {}) {
  const name = String(row.name || '').trim();
  if (!name) return null;
  const aliases = Array.isArray(row.aliases)
    ? [...new Set(row.aliases.map((a) => String(a || '').trim()).filter(Boolean))]
    : [];
  const shortName = row.shortName ? String(row.shortName).trim() : null;
  return {
    name,
    shortName,
    aliases,
    searchValue: row.searchValue || slugifyLocation(name),
  };
}

function copyRecommendedLocations(list = []) {
  const out = [];
  const seen = new Set();
  for (const row of list || []) {
    const copied = copyRecommendedLocation(row);
    if (!copied) continue;
    const key = normalizeLocKey(copied.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(copied);
  }
  return out;
}

function catalogLocationByName(name) {
  const key = normalizeLocKey(name);
  const hit = CMS_COMMUNITY_CATALOG.find(
    (row) =>
      normalizeLocKey(row.name) === key ||
      (row.shortName && normalizeLocKey(row.shortName) === key) ||
      (row.aliases || []).some((a) => normalizeLocKey(a) === key)
  );
  return hit ? copyRecommendedLocation(hit) : copyRecommendedLocation({ name });
}

function locationsForTopicScope(topic) {
  if (!topic || !Array.isArray(topic.areaNames)) return [];
  return copyRecommendedLocations(topic.areaNames.map((name) => catalogLocationByName(name)));
}

function matchCmsTopicScopeFromText({ title = '', slug = '', source = '' } = {}) {
  const t = String(title || '');
  const s = String(slug || source || '');
  for (const topic of CMS_TOPIC_SCOPES) {
    if ((topic.titlePatterns || []).some((re) => re.test(t))) return topic;
    if ((topic.slugPatterns || []).some((re) => re.test(s))) return topic;
    if (topic.id && normalizeLocKey(source) === normalizeLocKey(topic.id)) return topic;
  }
  return null;
}

function matchCmsTopicScopeFromChunks(chunks = []) {
  for (const chunk of chunks || []) {
    const hit = matchCmsTopicScopeFromText({
      title: chunk?.title,
      slug: chunk?.slug || chunk?.url,
      source: chunk?.source,
    });
    if (hit) return hit;
  }
  return null;
}

function matchCmsTopicScopeFromProfile(profile = {}) {
  const ctx = copySourceContext(profile.sourceContext);
  if (!ctx) return null;
  return matchCmsTopicScopeFromText({
    title: ctx.title,
    slug: ctx.slug,
    source: ctx.source,
  });
}

/**
 * Extract property-relevant communities from CMS/RAG chunks (not from assistant prose).
 * Known topic articles (e.g. Best Communities for Families) force a fixed area list.
 */
function extractRecommendedLocationsFromChunks(chunks = []) {
  const topic = matchCmsTopicScopeFromChunks(chunks);
  if (topic) return locationsForTopicScope(topic);

  const haystack = (chunks || [])
    .map((c) =>
      [c?.title, c?.excerpt, c?.content, ...(Array.isArray(c?.headings) ? c.headings : [])]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n');
  if (!haystack.trim()) return [];

  const found = [];
  const seen = new Set();
  // Longer aliases first so "Dubai Hills Estate" wins over "Dubai Hills".
  const ranked = CMS_COMMUNITY_CATALOG.map((row) => ({
    ...row,
    aliases: [...row.aliases].sort((a, b) => b.length - a.length),
  })).sort((a, b) => {
    const aMax = Math.max(...a.aliases.map((x) => x.length));
    const bMax = Math.max(...b.aliases.map((x) => x.length));
    return bMax - aMax;
  });

  for (const row of ranked) {
    for (const alias of row.aliases) {
      const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i');
      if (!re.test(haystack)) continue;
      const key = normalizeLocKey(row.name);
      if (seen.has(key)) break;
      // Prefer Estate over bare Hills when both could match
      if (row.name === 'Dubai Hills' && seen.has(normalizeLocKey('Dubai Hills Estate'))) break;
      seen.add(key);
      found.push(copyRecommendedLocation(row));
      break;
    }
  }

  // Drop bare "Dubai Hills" if Estate was also found
  const hasEstate = found.some((r) => normalizeLocKey(r.name) === normalizeLocKey('Dubai Hills Estate'));
  return found
    .filter((r) => !(hasEstate && normalizeLocKey(r.name) === normalizeLocKey('Dubai Hills')))
    .slice(0, 8);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCmsPropertyHandoffMessage(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '');
  if (!raw) return false;

  if (
    /\b(explore|compare|check)\s+(these|those|the)\s+(areas?|communities|locations)\b/.test(raw)
  ) {
    return true;
  }

  if (
    /\b(show|pull|find|get|explore|compare|check|list)\b[\s\S]{0,40}\b(propert(?:y|ies)|listing(?:s)?|option(?:s)?|inventory)\b/.test(
      raw
    ) &&
    /\b(there|these|those|them|the(?:se|ose)?\s+(?:location|area|communit)|based\s+on|across|in\s+(?:these|those))\b/.test(
      raw
    )
  ) {
    return true;
  }

  if (
    /\b(based\s+on|from|in)\s+(these|those|the)\s+(location|locations|area|areas|communit(?:y|ies))\b/.test(
      raw
    )
  ) {
    return true;
  }

  if (
    /^(yes|yeah|yep|sure|ok|okay|please|alright|all right)(,|\s)+.*(show|pull|find|explore|propert|listing|option)/.test(
      raw
    )
  ) {
    return true;
  }

  if (
    /^(show|pull|find|explore|compare)\s+(me\s+)?(propert(?:y|ies)|listing(?:s)?|option(?:s)?)(\s+(there|here))?$/.test(
      raw
    )
  ) {
    return true;
  }

  if (
    /\b(show|pull|explore)\s+(listings?|propert(?:y|ies))\s+in\s+(these|those)\s+(areas?|communities|locations)\b/.test(
      raw
    )
  ) {
    return true;
  }

  // "Yes, show me properties in these three communities."
  if (
    /\b(propert(?:y|ies)|listing(?:s)?|option(?:s)?)\b/.test(raw) &&
    /\b(these|those)\s+(three|3|\d+)?\s*(areas?|communities|locations)?\b/.test(raw)
  ) {
    return true;
  }

  if (isViewContextCommunitiesMessage(raw)) return true;

  return false;
}

function hasRecommendedLocations(profile = {}) {
  return copyRecommendedLocations(profile.recommendedLocations || []).length > 0;
}

function isCmsHandoffAwaiting(awaiting) {
  return (
    awaiting === CMS_HANDOFF_PURPOSE ||
    awaiting === CMS_HANDOFF_LOCATION ||
    awaiting === CMS_HANDOFF_PROPERTY_TYPE
  );
}

function isCmsSearchSource(filtersOrProfile = {}) {
  const source =
    filtersOrProfile.searchSource ||
    filtersOrProfile.source ||
    filtersOrProfile.lastSearchFilters?.source;
  return source === SEARCH_SOURCE_CMS;
}

function locationSearchTerms(loc) {
  const terms = new Set();
  const name = String(loc?.name || '').trim();
  if (name) terms.add(name);
  if (loc?.shortName) terms.add(String(loc.shortName).trim());
  for (const a of loc?.aliases || []) {
    const t = String(a || '').trim();
    if (t) terms.add(t);
  }
  return [...terms];
}

function emptySegmentStats() {
  return {
    count: 0,
    minPrice: null,
    averagePrice: null,
    startingPrice: null,
    propertyTypes: [],
    bedrooms: [],
  };
}

function purposeForcedFilters(purpose) {
  if (purpose === 'Buy') return { propertyPurpose: 'Buy', offPlan: 'No' };
  if (purpose === 'Rent') return { propertyPurpose: 'Rent', offPlan: 'No' };
  if (purpose === 'Off-plan') return { offPlan: 'Yes' };
  return null;
}

function normalizeSegmentSummary(stats = {}) {
  const count = Number(stats.count) || 0;
  const minPrice = Number.isFinite(stats.minPrice)
    ? stats.minPrice
    : Number.isFinite(stats.startingPrice)
      ? stats.startingPrice
      : null;
  const averagePrice = Number.isFinite(stats.averagePrice) ? stats.averagePrice : null;
  const propertyTypes = Array.isArray(stats.propertyTypes)
    ? stats.propertyTypes.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  const bedrooms = Array.isArray(stats.bedrooms)
    ? stats.bedrooms.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0)
    : [];
  return {
    count,
    minPrice,
    averagePrice,
    startingPrice: minPrice,
    propertyTypes,
    bedrooms,
  };
}

async function probeLocationSegment(locationRow, purpose, extraFilters = {}) {
  const terms = locationSearchTerms(locationRow);
  const search = terms[0] || locationRow.name;
  const filters = { propertyStatus: 'Live', ...(extraFilters || {}) };
  const forced = purposeForcedFilters(purpose);
  if (!forced) return emptySegmentStats();

  try {
    const stats = await propertyDbService.getInventorySegmentSummary({
      search,
      filters,
      forced,
    });
    return normalizeSegmentSummary(stats);
  } catch (err) {
    console.error('probeLocationSegment failed:', err?.message || err);
    return emptySegmentStats();
  }
}

/**
 * Live inventory for each recommended community across Buy / Rent / Off-plan.
 */
async function probeCmsLocationInventory(recommendedLocations = []) {
  const locations = copyRecommendedLocations(recommendedLocations);
  const rows = await Promise.all(
    locations.map(async (loc) => {
      const [buy, rent, offPlan] = await Promise.all([
        probeLocationSegment(loc, 'Buy'),
        probeLocationSegment(loc, 'Rent'),
        probeLocationSegment(loc, 'Off-plan'),
      ]);
      const totalCount =
        (Number(buy.count) || 0) + (Number(rent.count) || 0) + (Number(offPlan.count) || 0);
      return {
        area: loc.name,
        location: loc.name,
        shortName: loc.shortName || null,
        searchValue: loc.searchValue,
        aliases: loc.aliases,
        totalCount,
        buy,
        rent,
        offPlan,
      };
    })
  );
  return rows;
}

/**
 * Facets for a narrowed CMS filter set (selected areas + optional property type).
 */
async function probeCmsSegmentFacets({
  locations = [],
  purpose,
  propertyType = null,
} = {}) {
  const forced = purposeForcedFilters(purpose);
  if (!forced) return emptySegmentStats();
  const locNames = (locations || [])
    .map((loc) => (typeof loc === 'string' ? loc : loc?.name))
    .map((n) => String(n || '').trim())
    .filter(Boolean);
  if (!locNames.length) return emptySegmentStats();

  const filters = { propertyStatus: 'Live' };
  if (propertyType) {
    filters.propertyType = Array.isArray(propertyType) ? propertyType : [propertyType];
  }

  try {
    if (locNames.length > 1) {
      filters.locations = locNames;
      const stats = await propertyDbService.getInventorySegmentSummary({
        search: '',
        filters,
        forced,
      });
      return normalizeSegmentSummary(stats);
    }
    const stats = await propertyDbService.getInventorySegmentSummary({
      search: locNames[0],
      filters,
      forced,
    });
    return normalizeSegmentSummary(stats);
  } catch (err) {
    console.error('probeCmsSegmentFacets failed:', err?.message || err);
    return emptySegmentStats();
  }
}

function inventoryTotals(inventory = []) {
  return {
    buy: inventory.reduce((n, row) => n + (Number(row?.buy?.count) || 0), 0),
    rent: inventory.reduce((n, row) => n + (Number(row?.rent?.count) || 0), 0),
    offPlan: inventory.reduce((n, row) => n + (Number(row?.offPlan?.count) || 0), 0),
  };
}

function formatPriceLabel(price, { rent = false } = {}) {
  const formatted = formatAed(price);
  if (!formatted) return null;
  return rent ? `${formatted}/year` : formatted;
}

function purposeOptionFromInventory(inventory = []) {
  const totals = inventoryTotals(inventory);
  const mk = (label, key, count) => {
    if (count > 0) {
      return {
        label,
        value: label,
        type: 'purpose',
        enabled: true,
        count,
      };
    }
    return {
      label: `${label} — No current listings`,
      value: label,
      type: 'purpose',
      enabled: false,
      count: 0,
    };
  };
  return [
    mk('Buy', 'buy', totals.buy),
    mk('Rent', 'rent', totals.rent),
    mk('Off-plan', 'offPlan', totals.offPlan),
  ];
}

function segmentForPurpose(row, purpose) {
  const p = String(purpose || '').toLowerCase();
  if (p === 'rent') return row.rent || emptySegmentStats();
  if (p === 'off-plan' || p === 'offplan') return row.offPlan || emptySegmentStats();
  return row.buy || emptySegmentStats();
}

function locationInventoryPayload(intent, inventory = []) {
  const purpose =
    intent === 'rent' || intent === 'Rent'
      ? 'Rent'
      : intent === 'offplan' || intent === 'Off-plan' || intent === 'off-plan'
        ? 'Off-plan'
        : 'Buy';
  const intentKey =
    purpose === 'Rent' ? 'rent' : purpose === 'Off-plan' ? 'offplan' : 'buy';
  const isRent = purpose === 'Rent';

  const locations = (inventory || [])
    .map((row) => {
      const seg = segmentForPurpose(row, purpose);
      const minPrice = seg.minPrice ?? seg.startingPrice ?? null;
      return {
        name: row.location || row.area,
        shortName: row.shortName || null,
        searchValue: row.searchValue || slugifyLocation(row.location || row.area),
        count: Number(seg.count) || 0,
        startingPrice: minPrice,
        minPrice,
        averagePrice: seg.averagePrice ?? null,
        propertyTypes: Array.isArray(seg.propertyTypes) ? seg.propertyTypes.slice() : [],
        bedrooms: Array.isArray(seg.bedrooms) ? seg.bedrooms.slice() : [],
        ...(isRent ? { rentFrequency: 'year' } : {}),
      };
    })
    .filter((row) => row.count > 0);

  return {
    type: 'location_inventory',
    intent: intentKey,
    purpose,
    locations,
  };
}

function locationInventoryOptions(intent, inventory = []) {
  const payload = locationInventoryPayload(intent, inventory);
  const isRent = payload.purpose === 'Rent';
  const options = payload.locations.map((loc) => {
    const display = loc.shortName || loc.name;
    const from = formatPriceLabel(loc.minPrice ?? loc.startingPrice, { rent: isRent });
    const avg = formatPriceLabel(loc.averagePrice, { rent: isRent });
    const countPart =
      loc.count === 1 ? '1 property' : `${loc.count} properties`;
    let label = `${display} · ${countPart}`;
    if (from) label += ` · from ${from}`;
    const secondary = [from ? `From ${from}` : null, avg ? `Avg ${avg}` : null]
      .filter(Boolean)
      .join(' · ');
    return {
      type: 'location_inventory',
      label,
      value: loc.name,
      name: loc.name,
      shortName: loc.shortName,
      count: loc.count,
      startingPrice: loc.startingPrice,
      minPrice: loc.minPrice,
      averagePrice: loc.averagePrice,
      propertyTypes: loc.propertyTypes,
      bedrooms: loc.bedrooms,
      secondary,
      enabled: true,
    };
  });

  const n = payload.locations.length;
  if (n > 1) {
    options.push({
      type: 'location_inventory',
      label: `All ${n} areas`,
      value: `__ALL_${n}__`,
      name: `All ${n} areas`,
      allAreas: true,
      count: payload.locations.reduce((s, l) => s + l.count, 0),
      enabled: true,
    });
  }
  return { options, locationInventory: payload };
}

function formatSegmentLine(label, seg, { rent = false } = {}) {
  const count = Number(seg?.count) || 0;
  if (count <= 0) return null;
  const countPart = count === 1 ? '1 property' : `${count} properties`;
  const from = formatPriceLabel(seg.minPrice ?? seg.startingPrice, { rent });
  const avg = formatPriceLabel(seg.averagePrice, { rent });
  let line = `${label} — ${countPart}`;
  if (from) line += ` · From ${from}`;
  if (avg) line += ` · Avg ${avg}`;
  return line;
}

/**
 * Structured multi-community inventory summary from live MongoDB counts/prices.
 */
function cmsHandoffInventorySummaryReply(inventory = []) {
  const rows = (inventory || []).filter((row) => {
    const total =
      Number(row?.totalCount) ||
      (Number(row?.buy?.count) || 0) +
        (Number(row?.rent?.count) || 0) +
        (Number(row?.offPlan?.count) || 0);
    return total > 0;
  });

  if (!rows.length) {
    return [
      "I couldn't find live listings in those communities right now.",
      '',
      'Would you like to explore Buy, Rent, or Off-plan properties across these communities?',
    ].join('\n');
  }

  const blocks = rows.map((row) => {
    const title = row.location || row.area || row.shortName;
    const beds = new Set();
    let startingPrice = null;
    for (const seg of [row.buy, row.rent, row.offPlan]) {
      for (const b of seg?.bedrooms || []) {
        const n = Number(b);
        if (Number.isFinite(n) && n >= 0) beds.add(n);
      }
      const min = seg?.minPrice ?? seg?.startingPrice;
      if (Number.isFinite(min) && min > 0 && (startingPrice == null || min < startingPrice)) {
        startingPrice = min;
      }
    }
    const bedLabels = [...beds]
      .sort((a, b) => a - b)
      .map((n) => (n === 0 ? 'Studio' : String(n)));
    const lines = [
      `- Buy: ${Number(row?.buy?.count) || 0} properties`,
      `- Rent: ${Number(row?.rent?.count) || 0} properties`,
      `- Off-plan: ${Number(row?.offPlan?.count) || 0} properties`,
    ];
    if (bedLabels.length) lines.push(`- Bedroom options: ${bedLabels.join(', ')}`);
    if (startingPrice != null) {
      const price = formatAed(startingPrice);
      if (price) lines.push(`- Starting price: ${price}`);
    }
    return `${title}\n${lines.join('\n')}`;
  });

  return [
    blocks.join('\n\n'),
    '',
    'Would you like to explore Buy, Rent, or Off-plan properties across these communities?',
  ].join('\n');
}

function areaInventorySummaryPayload(inventory = []) {
  return {
    type: 'area_inventory_summary',
    areas: (inventory || []).map((row) => ({
      area: row.location || row.area,
      shortName: row.shortName || null,
      totalCount:
        Number(row.totalCount) ||
        (Number(row?.buy?.count) || 0) +
          (Number(row?.rent?.count) || 0) +
          (Number(row?.offPlan?.count) || 0),
      buy: normalizeSegmentSummary(row.buy || {}),
      rent: normalizeSegmentSummary(row.rent || {}),
      offPlan: normalizeSegmentSummary(row.offPlan || {}),
    })),
  };
}

function communitySummariesFromInventory(inventory = []) {
  return (inventory || []).map((row) => {
    const beds = new Set();
    let startingPrice = null;
    let count = 0;
    for (const seg of [row.buy, row.rent, row.offPlan]) {
      count += Number(seg?.count) || 0;
      for (const b of seg?.bedrooms || []) {
        const n = Number(b);
        if (Number.isFinite(n) && n >= 0) beds.add(n);
      }
      const min = seg?.minPrice ?? seg?.startingPrice;
      if (Number.isFinite(min) && min > 0 && (startingPrice == null || min < startingPrice)) {
        startingPrice = min;
      }
    }
    const community = row.location || row.area;
    const catalog = CMS_COMMUNITY_CATALOG.find(
      (c) =>
        normalizeLocKey(c.name) === normalizeLocKey(community) ||
        (c.aliases || []).some((a) => normalizeLocKey(a) === normalizeLocKey(community))
    );
    return {
      community,
      shortName: row.shortName || catalog?.shortName || null,
      count: Number(row.totalCount) || count,
      bedrooms: [...beds].sort((a, b) => a - b),
      startingPrice,
      currency: 'AED',
      buy: normalizeSegmentSummary(row.buy || {}),
      rent: normalizeSegmentSummary(row.rent || {}),
      offPlan: normalizeSegmentSummary(row.offPlan || {}),
    };
  });
}

function formatBedroomsAvailability(bedrooms = []) {
  const nums = (bedrooms || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0);
  if (!nums.length) return null;
  const labels = [...new Set(nums.map((n) => bedroomChipLabel(n)).filter(Boolean))];
  if (!labels.length) return null;
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]}, ${labels[1]}`;
  return labels.join(', ');
}

function cmsCommunityPreviewReply(summaries = []) {
  const rows = Array.isArray(summaries) ? summaries : [];
  if (!rows.length || rows.every((s) => !(Number(s.count) > 0))) {
    return [
      "I couldn't find any current listings in Dubai Hills Estate, JVC, or Al Furjan.",
      '',
      'What would you like to explore?',
    ].join('\n');
  }

  const blocks = ["Here's what is currently available in these family-friendly communities:", ''];
  for (const s of rows) {
    const title = s.shortName ? `${s.community} (${s.shortName})` : s.community;
    blocks.push(title);
    if (!(Number(s.count) > 0)) {
      blocks.push('No matching properties currently available.');
      blocks.push('');
      continue;
    }
    blocks.push(
      `${s.count} ${s.count === 1 ? 'property' : 'properties'} available`
    );
    const beds = formatBedroomsAvailability(s.bedrooms);
    if (beds) blocks.push(`Bedrooms: ${beds}`);
    if (s.startingPrice != null) {
      const price = formatAed(s.startingPrice);
      if (price) blocks.push(`Starting from ${price}`);
    }
    blocks.push('');
  }
  blocks.push('What would you like to explore?');
  return blocks.join('\n');
}

function propertyMatchesCommunity(property, locationRow) {
  if (!property || !locationRow) return false;
  const candidates = [
    locationRow.name,
    locationRow.shortName,
    ...(locationRow.aliases || []),
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  const fields = [
    property.locality,
    property.subLocality,
    property.towerName,
    property.city,
    property.propertyTitle,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  if (!fields.length || !candidates.length) return false;

  for (const field of fields) {
    const fieldKey = normalizeLocKey(field);
    for (const cand of candidates) {
      const candKey = normalizeLocKey(cand);
      if (!candKey) continue;
      if (fieldKey === candKey || fieldKey.includes(candKey) || candKey.includes(fieldKey)) {
        return true;
      }
    }
  }
  return false;
}

function filterPropertiesToActiveCommunities(properties = [], locations = []) {
  const locs = copyRecommendedLocations(locations);
  if (!locs.length) return [];
  return (properties || []).filter((p) => locs.some((loc) => propertyMatchesCommunity(p, loc)));
}

/**
 * Live preview listings for each locked community (properties collection only).
 */
async function fetchCmsCommunityPreviewProperties(recommendedLocations = [], { perCommunity = 3 } = {}) {
  const locations = copyRecommendedLocations(recommendedLocations);
  const listingsByCommunity = {};
  let matchedTotal = 0;

  await Promise.all(
    locations.map(async (loc) => {
      try {
        const result = await propertyDbService.fetchAllProperties({
          page: 1,
          limit: Math.max(perCommunity * 3, 12),
          search: loc.name,
          filters: { propertyStatus: 'Live' },
        });
        const matched = filterPropertiesToActiveCommunities(result.properties || [], [loc]);
        matchedTotal += matched.length;
        listingsByCommunity[loc.name] = matched.slice(0, perCommunity);
      } catch (err) {
        console.error('fetchCmsCommunityPreviewProperties failed:', loc.name, err?.message || err);
        listingsByCommunity[loc.name] = [];
      }
    })
  );

  return { listingsByCommunity, matchedTotal };
}

function cmsHandoffIntroReply(recommendedLocations = [], inventory = null) {
  if (Array.isArray(inventory) && inventory.length) {
    return cmsHandoffInventorySummaryReply(inventory);
  }
  const names = copyRecommendedLocations(recommendedLocations).map((r) => r.shortName || r.name);
  let areas = 'these communities';
  if (names.length === 1) areas = names[0];
  else if (names.length === 2) areas = `${names[0]} and ${names[1]}`;
  else if (names.length > 2) {
    areas = `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  }
  return `I can search across ${areas}.\n\nWhat would you like to explore?`;
}

function cmsHandoffLocationReply(purpose) {
  const p = String(purpose || '');
  if (p === 'Rent') {
    return 'Here are the current rental options in the communities we discussed:';
  }
  if (p === 'Off-plan') {
    return 'Here are the current off-plan options in the communities we discussed:';
  }
  return 'Here are the current purchase options in the communities we discussed:';
}

const PREFERRED_PROPERTY_TYPE_ORDER = ['Apartment', 'Villa', 'Townhouse', 'Penthouse'];

function propertyTypeOptionsFromInventory(inventory = [], purpose, selectedLocationNames = []) {
  const selected = new Set(
    (selectedLocationNames || []).map((n) => String(n || '').trim().toLowerCase()).filter(Boolean)
  );
  const types = new Set();
  for (const row of inventory || []) {
    const name = String(row.location || row.area || '').trim().toLowerCase();
    const short = String(row.shortName || '').trim().toLowerCase();
    if (selected.size && !selected.has(name) && !(short && selected.has(short))) continue;
    const seg = segmentForPurpose(row, purpose);
    for (const t of seg.propertyTypes || []) {
      const cleaned = String(t || '').trim();
      if (cleaned) types.add(cleaned);
    }
  }
  const list = [...types];
  list.sort((a, b) => {
    const ia = PREFERRED_PROPERTY_TYPE_ORDER.indexOf(a);
    const ib = PREFERRED_PROPERTY_TYPE_ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
  return list.map((t) => ({ label: t, value: t, type: 'propertyType', enabled: true }));
}

function bedroomLabelFromValue(n) {
  const beds = Number(n);
  if (!Number.isFinite(beds) || beds < 0) return null;
  if (beds === 0) return 'Studio';
  if (beds === 1) return '1 Bed';
  if (beds >= 5) return '5+ Beds';
  return `${beds} Beds`;
}

function bedroomOptionsFromValues(bedrooms = [], { includeAny = true } = {}) {
  const nums = [
    ...new Set(
      (bedrooms || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0)
    ),
  ].sort((a, b) => a - b);

  const opts = [];
  let fivePlus = false;
  for (const n of nums) {
    if (n >= 5) {
      fivePlus = true;
      continue;
    }
    const label = bedroomLabelFromValue(n);
    if (label && !opts.includes(label)) opts.push(label);
  }
  if (fivePlus && !opts.includes('5+ Beds')) opts.push('5+ Beds');
  if (includeAny) opts.push('Any');
  return opts;
}

function cmsHandoffPropertyTypeReply(locations = [], purpose) {
  const names = (locations || [])
    .map((loc) => (typeof loc === 'string' ? loc : loc?.shortName || loc?.name))
    .filter(Boolean);
  let place = 'these communities';
  if (names.length === 1) place = names[0];
  else if (names.length === 2) place = `${names[0]} and ${names[1]}`;
  else if (names.length > 2) {
    place = `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  }
  const purposeLabel =
    purpose === 'Rent' ? 'rentals' : purpose === 'Off-plan' ? 'off-plan homes' : 'homes for sale';
  return `Which property type should I show for ${purposeLabel} in ${place}?`;
}

function cmsHandoffBedroomsReply(filters = {}, facet = {}) {
  const count = Number(facet.count) || 0;
  const types = Array.isArray(filters.types)
    ? filters.types
    : filters.type
      ? [filters.type]
      : [];
  const typeLabel = types.length === 1 ? String(types[0]).toLowerCase() : 'homes';
  const place =
    Array.isArray(filters.locations) && filters.locations.length === 1
      ? filters.locations[0]
      : Array.isArray(filters.locations) && filters.locations.length > 1
        ? 'these communities'
        : filters.location || 'these communities';
  if (count > 0) {
    return `I found ${count} ${typeLabel}${count === 1 ? '' : 's'} in ${place}. Which bedroom configuration should I use?`;
  }
  return 'Which bedroom configuration should I use?';
}

function parseCmsAllAreasChoice(text, recommendedLocations = []) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '');
  if (!raw) return null;
  const list = copyRecommendedLocations(recommendedLocations);
  const n = list.length;
  if (!n) return null;
  if (/^__all_\d+__$/.test(raw)) return list;
  if (/^all(\s+\d+)?(\s+areas?)?$/.test(raw)) return list;
  if (n && new RegExp(`^all\\s+${n}\\s+areas?$`).test(raw)) return list;
  if (/^(all\s+(of\s+)?(them|these|those)|entire\s+list|all\s+communities)$/.test(raw)) return list;
  // "these three communities", "all three", "show all three", "in these areas"
  if (
    /\b(all|these|those)\s+(three|3|\d+)\b/.test(raw) ||
    /\b(these|those|the)\s+(areas?|communities|locations)\b/.test(raw) ||
    /\bshow\s+(me\s+)?(all\s+)?(three|3)\b/.test(raw) ||
    /\bcompare\s+all\b/.test(raw)
  ) {
    return list;
  }
  // User named 2+ of the recommended communities with a property intent.
  if (/\b(propert(?:y|ies)|listing(?:s)?|available|show|find|explore)\b/.test(raw)) {
    const mentioned = list.filter((loc) => {
      const aliases = [loc.name, loc.shortName, ...(loc.aliases || [])].filter(Boolean);
      return aliases.some((alias) => {
        const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i');
        return re.test(raw);
      });
    });
    if (mentioned.length >= 2) return list;
  }
  return null;
}

/**
 * Ensure CMS recommended communities are on the active search filters.
 * Never clears an existing explicit area selection.
 */
function ensureCmsAreasOnFilters(filters = {}, recommendedLocations = [], sourceContext = null) {
  const next = { ...filters };
  if (next.locationAny === true) return next;

  let locs = copyRecommendedLocations(recommendedLocations);
  if (!locs.length && sourceContext) {
    const names = sourceContext.areas || sourceContext.suggestedLocations || [];
    if (Array.isArray(names) && names.length) {
      locs = copyRecommendedLocations(names.map((name) => ({ name })));
    }
  }

  const canonicalizeName = (name) => {
    const raw = String(name || '').trim();
    if (!raw) return null;
    const fromRecommended = locs.find(
      (l) =>
        normalizeLocKey(l.name) === normalizeLocKey(raw) ||
        (l.shortName && normalizeLocKey(l.shortName) === normalizeLocKey(raw)) ||
        (l.aliases || []).some((a) => normalizeLocKey(a) === normalizeLocKey(raw))
    );
    if (fromRecommended) return fromRecommended.name;
    const fromCatalog = catalogLocationByName(raw);
    return fromCatalog?.name || raw;
  };

  if (Array.isArray(next.locations) && next.locations.filter(Boolean).length > 0) {
    next.source = next.source || SEARCH_SOURCE_CMS;
    next.locations = next.locations.map(canonicalizeName).filter(Boolean);
    const seen = new Set();
    next.locations = next.locations.filter((n) => {
      const key = normalizeLocKey(n);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    next.location =
      next.locations.length === 1 ? next.locations[0] : next.locations.join(', ');
    if (next.locations.length > 1) next.areaScopeLocked = true;
    return next;
  }
  if (String(next.location || '').trim()) {
    next.source = next.source || SEARCH_SOURCE_CMS;
    const canonical = canonicalizeName(next.location);
    next.location = canonical;
    if (!Array.isArray(next.locations) || !next.locations.length) {
      next.locations = canonical ? [canonical] : [];
    }
    return next;
  }
  if (!locs.length) return next;
  return applyCmsLocationsToFilters(next, locs);
}

function buildSourceContextFromRecommended(recommendedLocations = [], meta = {}) {
  const locs = copyRecommendedLocations(recommendedLocations);
  const areas = locs.map((l) => l.name);
  const topic =
    meta.topic ||
    matchCmsTopicScopeFromText({ title: meta.title, slug: meta.slug, source: meta.source });
  return {
    type: meta.type || 'community_group',
    source: topic?.id || meta.source || null,
    title: meta.title || null,
    slug: meta.slug || topic?.id || null,
    areas,
    suggestedLocations: areas,
    areaScopeLocked: true,
  };
}

function copySourceContext(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const areas = Array.isArray(raw.areas)
    ? raw.areas.map((v) => String(v || '').trim()).filter(Boolean)
    : Array.isArray(raw.suggestedLocations)
      ? raw.suggestedLocations.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
  return {
    type: raw.type || raw.contextType || null,
    source: raw.source || null,
    title: raw.title || null,
    slug: raw.slug || null,
    areas,
    suggestedLocations: areas,
    areaScopeLocked: raw.areaScopeLocked !== false && areas.length > 0,
  };
}

function emptyPropertySearch() {
  return {
    areas: [],
    activeAreas: [],
    areaScopeLocked: false,
    location: null,
    purpose: null,
    propertyType: null,
    bedrooms: null,
    minPrice: null,
    maxPrice: null,
  };
}

function copyPropertySearch(raw = {}) {
  if (!raw || typeof raw !== 'object') return emptyPropertySearch();
  const areas = Array.isArray(raw.areas)
    ? raw.areas.map((v) => String(v || '').trim()).filter(Boolean)
    : Array.isArray(raw.activeAreas)
      ? raw.activeAreas.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
  return {
    areas,
    activeAreas: areas.slice(),
    areaScopeLocked: raw.areaScopeLocked === true && areas.length > 0,
    location: raw.location != null ? String(raw.location).trim() || null : areas[0] || null,
    purpose: raw.purpose != null ? String(raw.purpose).trim() || null : null,
    propertyType: raw.propertyType != null ? String(raw.propertyType).trim() || null : null,
    bedrooms: Number.isFinite(Number(raw.bedrooms)) ? Number(raw.bedrooms) : null,
    minPrice: Number.isFinite(Number(raw.minPrice)) ? Number(raw.minPrice) : null,
    maxPrice: Number.isFinite(Number(raw.maxPrice)) ? Number(raw.maxPrice) : null,
  };
}

function propertySearchFromFilters(filters = {}) {
  const types = Array.isArray(filters.types) ? filters.types : [];
  const areas =
    Array.isArray(filters.locations) && filters.locations.length
      ? filters.locations.map((v) => String(v || '').trim()).filter(Boolean)
      : String(filters.location || '').trim()
        ? [String(filters.location).trim()]
        : [];
  return {
    areas,
    activeAreas: areas.slice(),
    areaScopeLocked: filters.areaScopeLocked === true && areas.length > 0,
    location: areas[0] || null,
    purpose: filters.purpose || null,
    propertyType: filters.type || types[0] || null,
    bedrooms:
      filters.bedrooms != null
        ? Number(filters.bedrooms)
        : filters.bedroomsMin != null
          ? Number(filters.bedroomsMin)
          : null,
    minPrice: filters.budgetMin ?? null,
    maxPrice: filters.budgetMax ?? null,
  };
}

function getActiveAreas(profileOrFilters = {}) {
  const topic = matchCmsTopicScopeFromProfile(profileOrFilters);
  if (topic) return topic.areaNames.slice();

  const filters = profileOrFilters.lastSearchFilters || profileOrFilters;
  if (Array.isArray(filters.locations) && filters.locations.length) {
    return filters.locations.map((v) => String(v || '').trim()).filter(Boolean);
  }
  const fromSearch = profileOrFilters.propertySearch?.activeAreas || profileOrFilters.propertySearch?.areas;
  if (Array.isArray(fromSearch) && fromSearch.length) {
    return fromSearch.map((v) => String(v || '').trim()).filter(Boolean);
  }
  const recommended = recommendedLocationsFromProfile(profileOrFilters);
  if (recommended.length) return recommended.map((r) => r.name);
  const ctx = copySourceContext(profileOrFilters.sourceContext);
  if (ctx?.areas?.length) return ctx.areas.slice();
  const single = String(filters.location || '').trim();
  return single ? [single] : [];
}

function isAreaScopeLocked(profileOrFilters = {}) {
  const filters = profileOrFilters.lastSearchFilters || profileOrFilters;
  if (filters.locationAny === true) return false;
  const recommended = recommendedLocationsFromProfile(profileOrFilters);
  // Multi-community recommendations are always locked.
  if (recommended.length > 1) return true;
  const active = getActiveAreas(profileOrFilters);
  if (filters.areaScopeLocked === true && (active.length > 0 || recommended.length > 0)) return true;
  if (profileOrFilters.propertySearch?.areaScopeLocked === true && active.length > 0) return true;
  const ctx = copySourceContext(profileOrFilters.sourceContext);
  if (ctx?.areaScopeLocked !== false && (ctx?.areas || []).length > 1) return true;
  return false;
}

/**
 * Re-apply locked/recommended communities onto filters. Never widens to Dubai-wide
 * while the scope is locked. Does NOT lock ordinary single-area searches.
 */
function ensureActiveAreaScope(profile = {}, filters = {}) {
  const next = { ...(filters || {}) };
  if (next.locationAny === true) return next;

  const recommended = recommendedLocationsFromProfile(profile);
  const locked = isAreaScopeLocked({ ...profile, lastSearchFilters: next });
  const needsSeed =
    recommended.length > 0 &&
    (!Array.isArray(next.locations) || !next.locations.length) &&
    !String(next.location || '').trim() &&
    (locked ||
      recommended.length > 1 ||
      profile.searchSource === SEARCH_SOURCE_CMS ||
      next.source === SEARCH_SOURCE_CMS);

  if (!locked && !needsSeed) return next;

  const active = getActiveAreas({ ...profile, lastSearchFilters: next });
  const locs = (active.length ? active : recommended.map((r) => r.name)).map(
    (name) => matchRecommendedLocation(name, recommended) || { name }
  );
  if (!locs.length) return next;

  const restored = applyCmsLocationsToFilters(next, locs);
  restored.areaScopeLocked = true;
  restored.locationAny = false;
  if (!restored.source) restored.source = SEARCH_SOURCE_CMS;
  return restored;
}

/**
 * Recover recommended locations from sourceContext when the array was lost.
 * Known topic scopes always win (exact community list).
 */
function recommendedLocationsFromProfile(profile = {}) {
  const topic = matchCmsTopicScopeFromProfile(profile);
  if (topic) return locationsForTopicScope(topic);

  const existing = copyRecommendedLocations(profile.recommendedLocations || []);
  if (existing.length) return existing;
  const ctx = copySourceContext(profile.sourceContext);
  const names = ctx?.areas || ctx?.suggestedLocations || [];
  if (names.length) {
    return copyRecommendedLocations(names.map((name) => catalogLocationByName(name)));
  }
  const preferred = Array.isArray(profile.preferredAreas)
    ? profile.preferredAreas.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  // Only recover from preferredAreas when they cover a known topic scope
  // (avoid treating accumulated old areas as the active multi-community set).
  for (const topic of CMS_TOPIC_SCOPES) {
    const topicLocs = locationsForTopicScope(topic);
    if (topicLocs.length < 2) continue;
    const allPresent = topicLocs.every((loc) =>
      preferred.some(
        (p) =>
          normalizeLocKey(p) === normalizeLocKey(loc.name) ||
          (loc.shortName && normalizeLocKey(p) === normalizeLocKey(loc.shortName)) ||
          (loc.aliases || []).some((a) => normalizeLocKey(a) === normalizeLocKey(p))
      )
    );
    if (allPresent) return topicLocs;
  }
  const fromSearch =
    profile.propertySearch?.activeAreas || profile.propertySearch?.areas || [];
  if (Array.isArray(fromSearch) && fromSearch.length >= 2) {
    return copyRecommendedLocations(fromSearch.map((name) => catalogLocationByName(name)));
  }
  const filterLocs = profile.lastSearchFilters?.locations;
  if (Array.isArray(filterLocs) && filterLocs.length >= 2) {
    return copyRecommendedLocations(filterLocs.map((name) => catalogLocationByName(name)));
  }
  return [];
}

/**
 * Recover multi-community scope when recommendedLocations/sourceContext were dropped
 * (common after blog answers if persistence failed). Uses profile, message, and history.
 */
function recoverRecommendedLocations(profile = {}, { message = '', history = [] } = {}) {
  let locs = recommendedLocationsFromProfile(profile);
  if (locs.length) return locs;

  const texts = [
    message,
    profile.sourceContext?.title,
    profile.sourceContext?.source,
    profile.sourceContext?.slug,
    ...((history || []).slice(-12).map((m) => m?.content || m?.message || '')),
  ]
    .map((t) => String(t || '').trim())
    .filter(Boolean);

  for (const text of texts) {
    const topic = matchCmsTopicScopeFromText({ title: text, slug: text, source: text });
    if (topic) return locationsForTopicScope(topic);
  }

  // Message naming 2+ catalog communities (e.g. DHE, JVC, Al Furjan).
  const named = [];
  const seen = new Set();
  const haystack = String(message || '');
  if (haystack) {
    for (const row of CMS_COMMUNITY_CATALOG) {
      const aliases = [row.name, row.shortName, ...(row.aliases || [])].filter(Boolean);
      for (const alias of aliases) {
        const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i');
        if (!re.test(haystack)) continue;
        const key = normalizeLocKey(row.name);
        if (seen.has(key)) break;
        seen.add(key);
        named.push(copyRecommendedLocation(row));
        break;
      }
    }
  }
  if (named.length >= 2) return copyRecommendedLocations(named);

  return [];
}

function matchRecommendedLocation(text, recommendedLocations = []) {
  const raw = String(text || '')
    .trim()
    .replace(/[.!?]+$/g, '');
  if (!raw) return null;
  const key = normalizeLocKey(raw);
  const list = copyRecommendedLocations(recommendedLocations);
  for (const loc of list) {
    const candidates = [loc.name, loc.shortName, ...(loc.aliases || [])].filter(Boolean);
    for (const c of candidates) {
      if (normalizeLocKey(c) === key) return loc;
    }
  }
  // Partial: "Dubai Hills" matching "Dubai Hills Estate"
  for (const loc of list) {
    const candidates = [loc.name, loc.shortName, ...(loc.aliases || [])].filter(Boolean);
    for (const c of candidates) {
      const ck = normalizeLocKey(c);
      if (ck.includes(key) || key.includes(ck)) return loc;
    }
  }
  return null;
}

function applyCmsLocationsToFilters(filters, selectedLocations = []) {
  const next = { ...filters };
  const locs = copyRecommendedLocations(selectedLocations);
  next.source = SEARCH_SOURCE_CMS;
  if (locs.length === 0) {
    next.location = null;
    next.locations = [];
    next.locationAny = false;
    next.areaScopeLocked = false;
    return next;
  }
  if (locs.length === 1) {
    next.location = locs[0].name;
    next.locations = [locs[0].name];
    next.locationAny = false;
    next.areaScopeLocked = true;
    return next;
  }
  next.location = locs.map((l) => l.name).join(', ');
  next.locations = locs.map((l) => l.name);
  next.locationAny = false;
  next.areaScopeLocked = true;
  return next;
}

function describeCmsLocations(filters = {}) {
  if (Array.isArray(filters.locations) && filters.locations.length > 1) {
    const names = filters.locations
      .map((n) => {
        const raw = String(n || '').trim();
        if (!raw) return '';
        const entry = CMS_COMMUNITY_CATALOG.find(
          (c) =>
            normalizeLocKey(c.name) === normalizeLocKey(raw) ||
            (c.aliases || []).some((a) => normalizeLocKey(a) === normalizeLocKey(raw))
        );
        // Prefer short aliases in copy (e.g. JVC) when available.
        if (entry?.shortName && /jumeirah village circle/i.test(entry.name)) {
          return entry.shortName;
        }
        return entry?.name || raw;
      })
      .filter(Boolean);
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    if (names.length > 2) {
      return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
    }
  }
  return String(filters.location || '').trim();
}

module.exports = {
  CMS_HANDOFF_PURPOSE,
  CMS_HANDOFF_LOCATION,
  CMS_HANDOFF_PROPERTY_TYPE,
  CMS_IMMEDIATE_LISTING_THRESHOLD,
  SEARCH_SOURCE_CMS,
  SEARCH_SOURCE_DIRECT,
  VIEW_CONTEXT_COMMUNITY_PROPERTIES,
  VIEW_CONTEXT_COMMUNITIES_LABEL,
  CMS_COMMUNITY_CATALOG,
  CMS_TOPIC_SCOPES,
  copyRecommendedLocation,
  copyRecommendedLocations,
  extractRecommendedLocationsFromChunks,
  matchCmsTopicScopeFromChunks,
  matchCmsTopicScopeFromProfile,
  matchCmsTopicScopeFromText,
  locationsForTopicScope,
  isCmsPropertyHandoffMessage,
  isViewContextCommunityPropertiesAction,
  isViewContextCommunitiesMessage,
  communitiesForContextKey,
  buildViewContextCommunitiesAction,
  hasRecommendedLocations,
  isCmsHandoffAwaiting,
  isCmsSearchSource,
  probeCmsLocationInventory,
  probeCmsSegmentFacets,
  inventoryTotals,
  purposeOptionFromInventory,
  locationInventoryPayload,
  locationInventoryOptions,
  areaInventorySummaryPayload,
  communitySummariesFromInventory,
  cmsCommunityPreviewReply,
  propertyMatchesCommunity,
  filterPropertiesToActiveCommunities,
  fetchCmsCommunityPreviewProperties,
  cmsHandoffInventorySummaryReply,
  cmsHandoffIntroReply,
  cmsHandoffLocationReply,
  cmsHandoffPropertyTypeReply,
  cmsHandoffBedroomsReply,
  propertyTypeOptionsFromInventory,
  bedroomOptionsFromValues,
  bedroomLabelFromValue,
  parseCmsAllAreasChoice,
  matchRecommendedLocation,
  applyCmsLocationsToFilters,
  ensureCmsAreasOnFilters,
  ensureActiveAreaScope,
  getActiveAreas,
  isAreaScopeLocked,
  describeCmsLocations,
  buildSourceContextFromRecommended,
  copySourceContext,
  emptyPropertySearch,
  copyPropertySearch,
  propertySearchFromFilters,
  recommendedLocationsFromProfile,
  recoverRecommendedLocations,
  slugifyLocation,
};
