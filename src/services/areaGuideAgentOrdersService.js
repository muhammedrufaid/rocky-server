const AreaGuide = require('../models/AreaGuide');
const Property = require('../models/Property');
const TeamMember = require('../models/TeamMember');

const LOCATION_FIELDS = ['locality', 'subLocality', 'towerName', 'city'];

const escapeRegex = (value) =>
  String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeText = (value) =>
  value === undefined || value === null ? '' : String(value).trim();

const normalizeEmail = (value) => normalizeText(value).toLowerCase();

/**
 * Search terms for an area guide:
 * prefer listingsSearch; fall back to title when inventory uses the area name directly.
 */
const getSearchTermsForGuide = (guide) => {
  const fromListings = Array.isArray(guide?.listingsSearch)
    ? guide.listingsSearch.map(normalizeText).filter(Boolean)
    : [];

  if (fromListings.length) return fromListings;

  const title = normalizeText(guide?.title);
  return title ? [title] : [];
};

const buildPropertyMatchForTerms = (terms) => {
  const cleaned = (Array.isArray(terms) ? terms : [])
    .map(normalizeText)
    .filter(Boolean);

  if (!cleaned.length) return null;

  const or = [];
  cleaned.forEach((term) => {
    const re = new RegExp(`^${escapeRegex(term)}$`, 'i');
    LOCATION_FIELDS.forEach((field) => {
      or.push({ [field]: re });
    });
  });

  return { $or: or };
};

const propertyMatchesTerms = (property, terms) => {
  const cleaned = (Array.isArray(terms) ? terms : [])
    .map((t) => normalizeText(t).toLowerCase())
    .filter(Boolean);
  if (!cleaned.length || !property) return false;

  const locationValues = LOCATION_FIELDS.map((field) =>
    normalizeText(property[field]).toLowerCase()
  ).filter(Boolean);

  return cleaned.some((term) => locationValues.includes(term));
};

/**
 * Resolve TeamMember.order values for listing agents on matching properties.
 * Match by email first, then by name. Deduped, sorted by order.
 */
const resolveAgentOrdersFromProperties = async (terms) => {
  const match = buildPropertyMatchForTerms(terms);
  if (!match) {
    return { terms: [], agentOrders: [], listingAgents: [] };
  }

  const properties = await Property.find(match)
    .select('listingAgent listingAgentEmail locality subLocality towerName city')
    .lean();

  const emails = [
    ...new Set(
      properties.map((p) => normalizeEmail(p.listingAgentEmail)).filter(Boolean)
    ),
  ];
  const names = [
    ...new Set(properties.map((p) => normalizeText(p.listingAgent)).filter(Boolean)),
  ];

  if (!emails.length && !names.length) {
    return {
      terms: (Array.isArray(terms) ? terms : []).map(normalizeText).filter(Boolean),
      agentOrders: [],
      listingAgents: [],
    };
  }

  const memberFilter = {
    isActive: true,
    isAgent: true,
    $or: [],
  };

  if (emails.length) {
    memberFilter.$or.push({
      email: {
        $in: emails.map((email) => new RegExp(`^${escapeRegex(email)}$`, 'i')),
      },
    });
  }

  if (names.length) {
    memberFilter.$or.push({
      name: {
        $in: names.map((name) => new RegExp(`^${escapeRegex(name)}$`, 'i')),
      },
    });
  }

  const members = await TeamMember.find(memberFilter)
    .select('order name email')
    .sort({ order: 1 })
    .lean();

  const byEmail = new Map(
    members
      .filter((m) => normalizeEmail(m.email))
      .map((m) => [normalizeEmail(m.email), m])
  );
  const byName = new Map(
    members
      .filter((m) => normalizeText(m.name))
      .map((m) => [normalizeText(m.name).toLowerCase(), m])
  );

  const listingAgents = [];
  const seenOrders = new Set();
  const agentOrders = [];

  properties.forEach((property) => {
    const email = normalizeEmail(property.listingAgentEmail);
    const name = normalizeText(property.listingAgent);
    const member =
      (email && byEmail.get(email)) ||
      (name && byName.get(name.toLowerCase())) ||
      null;

    if (!member) return;

    listingAgents.push({
      listingAgent: name || null,
      listingAgentEmail: email || null,
      order: member.order,
    });

    if (!seenOrders.has(member.order)) {
      seenOrders.add(member.order);
      agentOrders.push(member.order);
    }
  });

  // Stable numeric order for newly discovered sets
  agentOrders.sort((a, b) => a - b);

  return {
    terms: (Array.isArray(terms) ? terms : []).map(normalizeText).filter(Boolean),
    agentOrders,
    listingAgents,
  };
};

/** Preserve existing order; append newly discovered orders (no duplicates). */
const mergeAgentOrders = (existing = [], discovered = []) => {
  const current = Array.isArray(existing)
    ? existing.filter((n) => typeof n === 'number' && !Number.isNaN(n))
    : [];
  const seen = new Set(current);
  const merged = [...current];

  (Array.isArray(discovered) ? discovered : []).forEach((order) => {
    if (typeof order !== 'number' || Number.isNaN(order) || seen.has(order)) {
      return;
    }
    seen.add(order);
    merged.push(order);
  });

  return merged;
};

const sameOrders = (a = [], b = []) => {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
};

/**
 * Sync one area guide's agentOrders from property listings.
 * @param {object} guide - AreaGuide doc or plain object with _id
 * @param {{ rebuild?: boolean, persist?: boolean }} [options]
 *   - rebuild: replace agentOrders with discovered set (sorted)
 *   - persist: write to DB (default true)
 */
const syncAreaGuideAgentOrders = async (guide, options = {}) => {
  const rebuild = options.rebuild === true;
  const persist = options.persist !== false;

  const terms = getSearchTermsForGuide(guide);
  const resolved = await resolveAgentOrdersFromProperties(terms);
  const existing = Array.isArray(guide.agentOrders) ? guide.agentOrders : [];
  const nextOrders = rebuild
    ? resolved.agentOrders
    : mergeAgentOrders(existing, resolved.agentOrders);

  const changed = !sameOrders(existing, nextOrders);

  if (changed && persist && guide._id) {
    await AreaGuide.updateOne(
      { _id: guide._id },
      { $set: { agentOrders: nextOrders } }
    );
    if (typeof guide.set === 'function') {
      guide.set('agentOrders', nextOrders);
    } else {
      guide.agentOrders = nextOrders;
    }
  } else if (changed && !persist) {
    guide.agentOrders = nextOrders;
  }

  return {
    guideId: guide._id,
    slug: guide.slug,
    terms: resolved.terms,
    discovered: resolved.agentOrders,
    previous: existing,
    agentOrders: nextOrders,
    changed,
  };
};

/** Sync all active area guides (or all when includeInactive). */
const syncAllAreaGuideAgentOrders = async (options = {}) => {
  const filter = options.includeInactive === true ? {} : { isActive: true };
  const guides = await AreaGuide.find(filter).sort({ order: 1 });
  const results = [];

  for (const guide of guides) {
    results.push(await syncAreaGuideAgentOrders(guide, options));
  }

  return {
    count: results.length,
    changedCount: results.filter((r) => r.changed).length,
    results,
  };
};

/**
 * After a property create/update: find related area guides and append the agent.
 * Lightweight path for single-property changes.
 */
const syncAgentOrdersForProperty = async (property, options = {}) => {
  if (!property) {
    return { matchedGuides: 0, changedCount: 0, results: [] };
  }

  const locationValues = LOCATION_FIELDS.map((field) =>
    normalizeText(property[field])
  ).filter(Boolean);

  if (!locationValues.length) {
    return { matchedGuides: 0, changedCount: 0, results: [] };
  }

  const guides = await AreaGuide.find(
    options.includeInactive === true ? {} : { isActive: true }
  ).sort({ order: 1 });

  const matched = guides.filter((guide) =>
    propertyMatchesTerms(property, getSearchTermsForGuide(guide))
  );

  if (!matched.length) {
    return { matchedGuides: 0, changedCount: 0, results: [] };
  }

  const results = [];
  for (const guide of matched) {
    results.push(await syncAreaGuideAgentOrders(guide, options));
  }

  return {
    matchedGuides: matched.length,
    changedCount: results.filter((r) => r.changed).length,
    results,
  };
};

/**
 * Preview agents for arbitrary listingsSearch / area terms (no DB write).
 */
const previewAgentOrdersForTerms = async (terms) =>
  resolveAgentOrdersFromProperties(terms);

module.exports = {
  LOCATION_FIELDS,
  getSearchTermsForGuide,
  buildPropertyMatchForTerms,
  resolveAgentOrdersFromProperties,
  mergeAgentOrders,
  syncAreaGuideAgentOrders,
  syncAllAreaGuideAgentOrders,
  syncAgentOrdersForProperty,
  previewAgentOrdersForTerms,
};
