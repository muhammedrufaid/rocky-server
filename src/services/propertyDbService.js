const Property = require('../models/Property');

const SEARCH_FIELDS = [
  'propertyTitle',
  'city',
  'locality',
  'subLocality',
  'towerName',
  'propertyType',
  'propertyRefNo',
];

const normalizeToLower = (value) =>
  value === undefined || value === null ? '' : value.toString().trim().toLowerCase();

const normalizeStringList = (value) => {
  if (value === undefined || value === null) return null;
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const normalized = parts.map((v) => normalizeToLower(v)).filter(Boolean);
  return normalized.length ? normalized : null;
};

const parseOptionalNumber = (value) => {
  if (value === undefined || value === null) return null;
  const s = value.toString().replace(/,/g, '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildStringListMatch = (field, valuesLower) => {
  if (!valuesLower || !valuesLower.length) return null;
  // Case-insensitive exact-match using regex; keeps behavior close to the old in-memory normalization.
  return {
    [field]: { $in: valuesLower.map((v) => new RegExp(`^${escapeRegex(v)}$`, 'i')) },
  };
};

const numberExprFromStringField = (field) => {
  // Convert "12,345" -> 12345; on error -> null
  return {
    $convert: {
      input: {
        $replaceAll: {
          input: { $ifNull: [`$${field}`, ''] },
          find: ',',
          replacement: '',
        },
      },
      to: 'double',
      onError: null,
      onNull: null,
    },
  };
};

const buildCommonPipeline = ({ search = '', filters = {}, forced = {} }) => {
  const q = normalizeToLower(search);

  const nf = {
    propertyType: normalizeStringList(filters.propertyType),
    city: normalizeStringList(filters.city),
    locality: normalizeStringList(filters.locality),
    subLocality: normalizeStringList(filters.subLocality),
    towerName: normalizeStringList(filters.towerName),
    listingAgent: normalizeStringList(filters.listingAgent),
    furnished: normalizeStringList(filters.furnished),
    offPlan: normalizeStringList(filters.offPlan),
    propertyStatus: normalizeStringList(filters.propertyStatus),
    bedrooms: parseOptionalNumber(filters.bedrooms),
    bathrooms: parseOptionalNumber(filters.bathrooms),
    priceMin: parseOptionalNumber(filters.priceMin),
    priceMax: parseOptionalNumber(filters.priceMax),
    propertySizeMin: parseOptionalNumber(filters.propertySizeMin),
    propertySizeMax: parseOptionalNumber(filters.propertySizeMax),
  };

  const match = [];

  const listMatches = [
    buildStringListMatch('propertyType', nf.propertyType),
    buildStringListMatch('city', nf.city),
    buildStringListMatch('locality', nf.locality),
    buildStringListMatch('subLocality', nf.subLocality),
    buildStringListMatch('towerName', nf.towerName),
    buildStringListMatch('listingAgent', nf.listingAgent),
    buildStringListMatch('furnished', nf.furnished),
    buildStringListMatch('offPlan', nf.offPlan),
    buildStringListMatch('propertyStatus', nf.propertyStatus),
  ].filter(Boolean);
  if (listMatches.length) match.push(...listMatches);

  // Forced constraints (offPlan / propertyPurpose etc)
  Object.entries(forced).forEach(([key, value]) => {
    match.push({ [key]: value });
  });

  const addFields = {
    __priceNum: numberExprFromStringField('price'),
    __sizeNum: numberExprFromStringField('propertySize'),
    __bedroomsNum: numberExprFromStringField('bedrooms'),
    __bathroomsNum: numberExprFromStringField('bathrooms'),
  };

  const numericMatch = {};
  if (nf.bedrooms !== null) numericMatch.__bedroomsNum = nf.bedrooms;
  if (nf.bathrooms !== null) numericMatch.__bathroomsNum = nf.bathrooms;

  if (nf.priceMin !== null || nf.priceMax !== null) {
    numericMatch.__priceNum = {};
    if (nf.priceMin !== null) numericMatch.__priceNum.$gte = nf.priceMin;
    if (nf.priceMax !== null) numericMatch.__priceNum.$lte = nf.priceMax;
  }

  if (nf.propertySizeMin !== null || nf.propertySizeMax !== null) {
    numericMatch.__sizeNum = {};
    if (nf.propertySizeMin !== null) numericMatch.__sizeNum.$gte = nf.propertySizeMin;
    if (nf.propertySizeMax !== null) numericMatch.__sizeNum.$lte = nf.propertySizeMax;
  }

  const pipeline = [];

  // Search across fields (contains, case-insensitive)
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    pipeline.push({
      $match: {
        $or: SEARCH_FIELDS.map((f) => ({ [f]: re })),
      },
    });
  }

  if (match.length) {
    pipeline.push({ $match: { $and: match } });
  }

  // Numeric filters need computed fields
  pipeline.push({ $addFields: addFields });
  if (Object.keys(numericMatch).length) {
    pipeline.push({ $match: numericMatch });
  }

  return pipeline;
};

const paginateAggregation = async ({ basePipeline, page = 1, limit = 10, sort = { _id: -1 } }) => {
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  const skip = (safePage - 1) * safeLimit;

  const pipeline = [
    ...basePipeline,
    { $sort: sort },
    {
      $facet: {
        items: [{ $skip: skip }, { $limit: safeLimit }],
        meta: [{ $count: 'total' }],
      },
    },
  ];

  const [out] = await Property.aggregate(pipeline).allowDiskUse(true);
  const items = out?.items || [];
  const total = out?.meta?.[0]?.total || 0;

  const totalPages = safeLimit ? Math.ceil(total / safeLimit) : 1;
  const pagination = {
    page: safePage,
    limit: safeLimit,
    totalPages,
    hasNextPage: safePage < totalPages,
    hasPrevPage: safePage > 1,
  };

  // remove internal computed fields
  const cleaned = items.map((doc) => {
    // docs are plain objects here
    delete doc.__priceNum;
    delete doc.__sizeNum;
    delete doc.__bedroomsNum;
    delete doc.__bathroomsNum;
    return doc;
  });

  return { properties: cleaned, total, pagination };
};

const fetchAllProperties = async (opts = {}) => {
  const { page, limit, search = '', filters = {} } = opts;
  const basePipeline = buildCommonPipeline({ search, filters });
  return paginateAggregation({ basePipeline, page, limit });
};

const fetchOffPlanProperties = async (opts = {}) => {
  const { page, limit, search = '', filters = {} } = opts;
  const basePipeline = buildCommonPipeline({ search, filters, forced: { offPlan: 'Yes' } });
  return paginateAggregation({ basePipeline, page, limit });
};

const fetchReadyProperties = async (opts = {}) => {
  const { page, limit, search = '', filters = {} } = opts;
  const basePipeline = buildCommonPipeline({ search, filters, forced: { offPlan: 'No' } });
  return paginateAggregation({ basePipeline, page, limit });
};

const fetchBuyProperties = async (opts = {}) => {
  const { page, limit, search = '', filters = {} } = opts;
  const basePipeline = buildCommonPipeline({ search, filters, forced: { propertyPurpose: 'Buy' } });
  return paginateAggregation({ basePipeline, page, limit });
};

const fetchRentProperties = async (opts = {}) => {
  const { page, limit, search = '', filters = {} } = opts;
  const basePipeline = buildCommonPipeline({ search, filters, forced: { propertyPurpose: 'Rent' } });
  return paginateAggregation({ basePipeline, page, limit });
};

const {
  FEATURED_DUBAI_SOUTH_PROPERTY_REF_NOS,
} = require('../constants/featuredDubaiSouthProperties');
const {
  FEATURED_JEBEL_ALI_VILLAGE_PROPERTY_REF_NOS,
} = require('../constants/featuredJebelAliVillageProperties');

const fetchFeaturedDubaiSouthProperties = async () => {
  const docs = await Property.find({
    propertyRefNo: { $in: FEATURED_DUBAI_SOUTH_PROPERTY_REF_NOS },
  }).lean();

  const byRefNo = new Map(docs.map((doc) => [doc.propertyRefNo, doc]));
  const properties = [];
  const missingRefs = [];

  for (const refNo of FEATURED_DUBAI_SOUTH_PROPERTY_REF_NOS) {
    const doc = byRefNo.get(refNo);
    if (doc) {
      properties.push(doc);
    } else {
      missingRefs.push(refNo);
    }
  }

  if (missingRefs.length) {
    console.warn(
      '[featured-dubai-south] Missing from MongoDB (not in Salesforce feed or never synced):',
      missingRefs.join(', ')
    );
  }

  return { properties, total: properties.length, missingRefs };
};

const fetchFeaturedJebelAliVillageProperties = async () => {
  const docs = await Property.find({
    propertyRefNo: { $in: FEATURED_JEBEL_ALI_VILLAGE_PROPERTY_REF_NOS },
  }).lean();

  const byRefNo = new Map(docs.map((doc) => [doc.propertyRefNo, doc]));
  const properties = [];
  const missingRefs = [];

  for (const refNo of FEATURED_JEBEL_ALI_VILLAGE_PROPERTY_REF_NOS) {
    const doc = byRefNo.get(refNo);
    if (doc) {
      properties.push(doc);
    } else {
      missingRefs.push(refNo);
    }
  }

  if (missingRefs.length) {
    console.warn(
      '[featured-jebel-ali-village] Missing from MongoDB (not in Salesforce feed or never synced):',
      missingRefs.join(', ')
    );
  }

  return { properties, total: properties.length, missingRefs };
};

const fetchPropertyByRefNo = async (propertyRefNo) => {
  if (!propertyRefNo || typeof propertyRefNo !== 'string') return null;
  return Property.findOne({ propertyRefNo: propertyRefNo.trim() }).lean();
};

const fetchUniquePropertyTypes = async () => {
  const types = await Property.distinct('propertyType', { propertyType: { $nin: [null, ''] } });
  return (types || []).map((t) => (t || '').trim()).filter(Boolean).sort();
};

const fetchUniquePropertyTypesInOrder = async () => {
  const rows = await Property.aggregate([
    { $match: { propertyType: { $nin: [null, ''] } } },
    { $sort: { _id: 1 } },
    { $group: { _id: '$propertyType', firstId: { $first: '$_id' } } },
    { $sort: { firstId: 1 } },
    { $project: { _id: 0, type: '$_id' } },
  ]);
  return rows.map((r) => (r.type || '').trim()).filter(Boolean);
};

const toSuggestionShape = (property) => ({
  propertyRefNo: property.propertyRefNo,
  towerName: property.towerName,
  propertyPurpose: property.propertyPurpose,
  propertyType: property.propertyType,
  locality: property.locality,
  subLocality: property.subLocality,
});

const fetchSearchSuggestions = async (opts = {}) => {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 10, 1), 20);
  const q = (opts.q || '').trim();
  const filters = opts.filters || {};
  if (!q) return { suggestions: [] };

  const basePipeline = buildCommonPipeline({ search: q, filters });

  const items = await Property.aggregate([
    ...basePipeline,
    { $sort: { _id: -1 } },
    { $limit: limit },
    {
      $project: {
        propertyRefNo: 1,
        towerName: 1,
        propertyPurpose: 1,
        propertyType: 1,
        locality: 1,
        subLocality: 1,
      },
    },
  ]);

  const suggestions = (items || []).map(toSuggestionShape);
  return { suggestions };
};

const AREA_SUGGESTION_TYPE = {
  CITY: 'city',
  LOCALITY: 'locality',
  SUB_LOCALITY: 'subLocality',
  TOWER: 'tower',
};

const toComparableText = (value) => (value || '').toString().trim().toLowerCase();

const getMatchPriority = (value, query, opts = {}) => {
  const { allowContains = true } = opts;
  const normalizedValue = toComparableText(value);
  if (!normalizedValue || !query) return Number.POSITIVE_INFINITY;
  if (normalizedValue === query) return 0;
  if (normalizedValue.startsWith(query)) return 1;
  if (allowContains && normalizedValue.includes(query)) return 2;
  return Number.POSITIVE_INFINITY;
};

const getTypePriorityMap = ({ isShortQuery, isExactCityQuery }) => {
  if (isShortQuery) {
    return {
      [AREA_SUGGESTION_TYPE.CITY]: 0,
      [AREA_SUGGESTION_TYPE.LOCALITY]: 1,
      [AREA_SUGGESTION_TYPE.SUB_LOCALITY]: 2,
      [AREA_SUGGESTION_TYPE.TOWER]: 3,
    };
  }

  if (isExactCityQuery) {
    return {
      [AREA_SUGGESTION_TYPE.CITY]: 0,
      [AREA_SUGGESTION_TYPE.LOCALITY]: 1,
      [AREA_SUGGESTION_TYPE.SUB_LOCALITY]: 2,
      [AREA_SUGGESTION_TYPE.TOWER]: 3,
    };
  }

  return {
    [AREA_SUGGESTION_TYPE.LOCALITY]: 0,
    [AREA_SUGGESTION_TYPE.SUB_LOCALITY]: 1,
    [AREA_SUGGESTION_TYPE.TOWER]: 2,
    [AREA_SUGGESTION_TYPE.CITY]: 3,
  };
};

const formatSubLocalityFull = (subLocality, locality, city) => {
  const sub = (subLocality || '').trim();
  const loc = (locality || '').trim();
  const c = (city || '').trim();
  if (!sub) return '';
  if (loc && c) return `${sub} (${loc}, ${c})`;
  if (loc) return `${sub} (${loc})`;
  if (c) return `${sub} (${c})`;
  return sub;
};

const formatLocalityFull = (locality, city) => {
  const loc = (locality || '').trim();
  const c = (city || '').trim();
  if (!loc) return '';
  if (c) return `${loc} (${c})`;
  return loc;
};

const formatTowerFull = (towerName, subLocality, locality, city) => {
  const tower = (towerName || '').trim();
  const parts = [subLocality, locality, city].map((p) => (p || '').trim()).filter(Boolean);
  if (!tower) return '';
  if (!parts.length) return tower;
  return `${tower} (${parts.join(', ')})`;
};

const addUniqueSuggestion = (collection, seen, type, label, full) => {
  const normalizedLabel = toComparableText(label);
  if (!normalizedLabel) return;

  const key = `${type}:${normalizedLabel}`;
  if (seen.has(key)) return;

  seen.add(key);
  collection.push({
    type,
    label: label.trim(),
    full: (full || label).trim(),
  });
};

const fetchSearchByAreaSuggestions = async (opts = {}) => {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 10, 1), 20);
  const query = toComparableText(opts.q);
  const filters = opts.filters || {};
  if (!query) return { suggestions: [] };

  const basePipeline = buildCommonPipeline({ search: opts.q, filters });

  // Pull a capped set of docs and compute suggestions in JS to preserve the old ranking behavior.
  const docs = await Property.aggregate([
    ...basePipeline,
    { $sort: { _id: -1 } },
    { $limit: 500 },
    { $project: { city: 1, locality: 1, subLocality: 1, towerName: 1 } },
  ]);

  const isShortQuery = query.length <= 2;
  const isExactCityQuery = docs.some((d) => toComparableText(d.city) === query);
  const typePriorityMap = getTypePriorityMap({ isShortQuery, isExactCityQuery });
  const allowContains = !isShortQuery;

  const seen = new Set();
  const suggestions = [];

  docs.forEach((property) => {
    const city = (property.city || '').trim();
    const locality = (property.locality || '').trim();
    const subLocality = (property.subLocality || '').trim();
    const towerName = (property.towerName || '').trim();

    const cityPriority = getMatchPriority(city, query, { allowContains });
    const localityPriority = getMatchPriority(locality, query, { allowContains });
    const subLocalityPriority = getMatchPriority(subLocality, query, { allowContains });
    const towerPriority = getMatchPriority(towerName, query, { allowContains });

    const hasAnyMatch =
      cityPriority !== Number.POSITIVE_INFINITY ||
      localityPriority !== Number.POSITIVE_INFINITY ||
      subLocalityPriority !== Number.POSITIVE_INFINITY ||
      towerPriority !== Number.POSITIVE_INFINITY;

    if (!hasAnyMatch) return;

    if (cityPriority !== Number.POSITIVE_INFINITY) {
      addUniqueSuggestion(suggestions, seen, AREA_SUGGESTION_TYPE.CITY, city, city);
    }
    if (localityPriority !== Number.POSITIVE_INFINITY) {
      addUniqueSuggestion(suggestions, seen, AREA_SUGGESTION_TYPE.LOCALITY, locality, formatLocalityFull(locality, city));
    }
    if (subLocalityPriority !== Number.POSITIVE_INFINITY) {
      addUniqueSuggestion(
        suggestions,
        seen,
        AREA_SUGGESTION_TYPE.SUB_LOCALITY,
        subLocality,
        formatSubLocalityFull(subLocality, locality, city)
      );
    }
    if (towerPriority !== Number.POSITIVE_INFINITY) {
      addUniqueSuggestion(
        suggestions,
        seen,
        AREA_SUGGESTION_TYPE.TOWER,
        towerName,
        formatTowerFull(towerName, subLocality, locality, city)
      );
    }
  });

  suggestions.sort((a, b) => {
    const typePriorityDiff = (typePriorityMap[a.type] ?? 99) - (typePriorityMap[b.type] ?? 99);
    if (typePriorityDiff !== 0) return typePriorityDiff;

    const priorityDiff =
      getMatchPriority(a.label, query, { allowContains }) - getMatchPriority(b.label, query, { allowContains });
    if (priorityDiff !== 0) return priorityDiff;

    return a.label.localeCompare(b.label);
  });

  return { suggestions: suggestions.slice(0, limit) };
};

module.exports = {
  fetchAllProperties,
  fetchOffPlanProperties,
  fetchReadyProperties,
  fetchBuyProperties,
  fetchRentProperties,
  fetchFeaturedDubaiSouthProperties,
  fetchFeaturedJebelAliVillageProperties,
  fetchPropertyByRefNo,
  fetchSearchSuggestions,
  fetchSearchByAreaSuggestions,
  fetchUniquePropertyTypes,
  fetchUniquePropertyTypesInOrder,
};

