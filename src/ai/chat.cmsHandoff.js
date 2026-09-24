/**
 * CMS / blog community recommendations → property-search handoff.
 * Persists recommendedLocations and drives Buy/Rent/Off-plan → community inventory → bedrooms.
 */
const propertyDbService = require('../services/propertyDbService');
const { formatAed } = require('./chat.format');

const CMS_HANDOFF_PURPOSE = 'cmsHandoffPurpose';
const CMS_HANDOFF_LOCATION = 'cmsHandoffLocation';
const SEARCH_SOURCE_CMS = 'cms_recommendation';
const SEARCH_SOURCE_DIRECT = 'direct_property_search';

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

/**
 * Extract property-relevant communities from CMS/RAG chunks (not from assistant prose).
 */
function extractRecommendedLocationsFromChunks(chunks = []) {
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

  return false;
}

function hasRecommendedLocations(profile = {}) {
  return copyRecommendedLocations(profile.recommendedLocations || []).length > 0;
}

function isCmsHandoffAwaiting(awaiting) {
  return awaiting === CMS_HANDOFF_PURPOSE || awaiting === CMS_HANDOFF_LOCATION;
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
  return { count: 0, startingPrice: null, averagePrice: null };
}

async function probeLocationSegment(locationRow, purpose) {
  const terms = locationSearchTerms(locationRow);
  const search = terms[0] || locationRow.name;
  const filters = { propertyStatus: 'Live' };
  let forced = {};
  if (purpose === 'Buy') forced = { propertyPurpose: 'Buy', offPlan: 'No' };
  else if (purpose === 'Rent') forced = { propertyPurpose: 'Rent', offPlan: 'No' };
  else if (purpose === 'Off-plan') forced = { offPlan: 'Yes' };
  else return emptySegmentStats();

  try {
    const stats = await propertyDbService.getPropertyMarketStats({
      search,
      filters,
      forced,
    });
    return {
      count: Number(stats.totalAvailable) || 0,
      startingPrice: Number.isFinite(stats.minimumPrice) ? stats.minimumPrice : null,
      averagePrice: Number.isFinite(stats.averagePrice) ? stats.averagePrice : null,
      ...(purpose === 'Rent' ? { rentFrequency: 'year' } : {}),
    };
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
      return {
        location: loc.name,
        shortName: loc.shortName || null,
        searchValue: loc.searchValue,
        aliases: loc.aliases,
        buy,
        rent,
        offPlan,
      };
    })
  );
  return rows;
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
      return {
        name: row.location,
        shortName: row.shortName || null,
        searchValue: row.searchValue || slugifyLocation(row.location),
        count: Number(seg.count) || 0,
        startingPrice: seg.startingPrice ?? null,
        averagePrice: seg.averagePrice ?? null,
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
    const from = formatPriceLabel(loc.startingPrice, { rent: isRent });
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
      averagePrice: loc.averagePrice,
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

function cmsHandoffIntroReply(recommendedLocations = []) {
  const names = copyRecommendedLocations(recommendedLocations).map((r) => r.shortName || r.name);
  let areas = 'these communities';
  if (names.length === 1) areas = names[0];
  else if (names.length === 2) areas = `${names[0]} and ${names[1]}`;
  else if (names.length > 2) {
    areas = `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  }
  return `Absolutely. I can check current listings across ${areas}. How would you like to explore them?`;
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

function parseCmsAllAreasChoice(text, recommendedLocations = []) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '');
  if (!raw) return null;
  const n = copyRecommendedLocations(recommendedLocations).length;
  if (/^__all_\d+__$/.test(raw)) return copyRecommendedLocations(recommendedLocations);
  if (/^all(\s+\d+)?(\s+areas?)?$/.test(raw)) return copyRecommendedLocations(recommendedLocations);
  if (n && new RegExp(`^all\\s+${n}\\s+areas?$`).test(raw)) {
    return copyRecommendedLocations(recommendedLocations);
  }
  if (/^(all\s+(of\s+)?(them|these|those)|entire\s+list|all\s+communities)$/.test(raw)) {
    return copyRecommendedLocations(recommendedLocations);
  }
  return null;
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
    return next;
  }
  if (locs.length === 1) {
    next.location = locs[0].name;
    next.locations = [locs[0].name];
    next.locationAny = false;
    return next;
  }
  next.location = locs.map((l) => l.name).join(', ');
  next.locations = locs.map((l) => l.name);
  next.locationAny = false;
  return next;
}

function describeCmsLocations(filters = {}) {
  if (Array.isArray(filters.locations) && filters.locations.length > 1) {
    const names = filters.locations.map((n) => String(n).trim()).filter(Boolean);
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
  SEARCH_SOURCE_CMS,
  SEARCH_SOURCE_DIRECT,
  CMS_COMMUNITY_CATALOG,
  copyRecommendedLocation,
  copyRecommendedLocations,
  extractRecommendedLocationsFromChunks,
  isCmsPropertyHandoffMessage,
  hasRecommendedLocations,
  isCmsHandoffAwaiting,
  isCmsSearchSource,
  probeCmsLocationInventory,
  inventoryTotals,
  purposeOptionFromInventory,
  locationInventoryPayload,
  locationInventoryOptions,
  cmsHandoffIntroReply,
  cmsHandoffLocationReply,
  parseCmsAllAreasChoice,
  matchRecommendedLocation,
  applyCmsLocationsToFilters,
  describeCmsLocations,
  slugifyLocation,
};
