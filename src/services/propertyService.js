require('dotenv').config();
const { XMLParser } = require('fast-xml-parser');
const { extractText, toArray, deduplicate } = require('../utils/xmlUtils');
const { paginate } = require('../utils/paginationUtils');

/**
 * Transforms a raw XML Property node to a clean JSON property object
 * Deduplicates features, portals, and images to match XML source without duplicates
 */
const transformProperty = (prop) => {
    if (!prop) return null;

    const features = deduplicate(toArray(prop.Features?.Feature).map((f) => extractText(f)).filter(Boolean));
    const portals = deduplicate(toArray(prop.portals?.portal).map((p) => extractText(p)).filter(Boolean));
    const images = deduplicate(toArray(prop.Images?.Image).map((i) => extractText(i)).filter(Boolean));

    return {
        propertyRefNo: extractText(prop.Property_Ref_No),
        permitNumber: extractText(prop.Permit_Number),
        propertyStatus: extractText(prop.Property_Status),
        propertyPurpose: extractText(prop.Property_purpose),
        propertyType: extractText(prop.Property_Type),
        propertySize: extractText(prop.Property_Size),
        propertySizeUnit: extractText(prop.Property_Size_Unit),
        bedrooms: extractText(prop.Bedrooms),
        bathrooms: extractText(prop.Bathrooms),
        offPlan: extractText(prop.Off_plan),
        lastUpdated: extractText(prop.Last_Updated),
        city: extractText(prop.City),
        locality: extractText(prop.Locality),
        subLocality: extractText(prop.Sub_Locality),
        towerName: extractText(prop.Tower_Name),
        propertyTitle: extractText(prop.Property_Title),
        propertyDescription: extractText(prop.Property_Description),
        price: extractText(prop.Price),
        furnished: extractText(prop.Furnished),
        rentFrequency: extractText(prop.Rent_Frequency),
        listingAgentEmail: extractText(prop.Listing_Agent_Email),
        listingAgent: extractText(prop.Listing_Agent),
        listingAgentPhone: extractText(prop.Listing_Agent_Phone),
        features,
        portals,
        images
    };
};

/**
 * Fetches properties from Salesforce XML feed and returns transformed JSON
 */
const fetchAndTransformProperties = async () => {
    const baseUrl = process.env.BASE_URL_SALESFORCE;
    if (!baseUrl) {
        throw new Error('BASE_URL_SALESFORCE is not configured in .env');
    }

    const response = await fetch(baseUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch from Salesforce: ${response.status} ${response.statusText}`);
    }

    const xmlText = await response.text();
    const parser = new XMLParser({
        ignoreAttributes: false,
        trimValues: true,
        parseTagValue: false,
        parseAttributeValue: false
    });

    const parsed = parser.parse(xmlText);
    const propertiesRoot = parsed?.Properties;

    if (!propertiesRoot) {
        return { properties: [], total: 0 };
    }

    const rawProperties = toArray(propertiesRoot.Property);
    const properties = rawProperties.map(transformProperty).filter(Boolean);

    return { properties };
};

/**
 * Fetches all properties with optional pagination
 * @param {object} opts - { page, limit } for pagination
 */
const fetchAllProperties = async (opts = {}) => {
    const { properties } = await fetchAndTransformProperties();
    const { items, total, pagination } = paginate(properties, opts.page, opts.limit);
    return { properties: items, total, pagination };
};

/**
 * Fetches all properties and returns only those with offPlan === "Yes"
 * Supports pagination via { page, limit }
 */
const fetchOffPlanProperties = async (opts = {}) => {
    const { properties } = await fetchAndTransformProperties();
    const offPlanProperties = properties.filter((p) => p.offPlan === 'Yes');
    const { items, total, pagination } = paginate(offPlanProperties, opts.page, opts.limit);
    return { properties: items, total, pagination };
};

/**
 * Fetches all properties and returns only those with offPlan === "No" (ready properties)
 * Supports pagination via { page, limit }
 */
const fetchReadyProperties = async (opts = {}) => {
    const { properties } = await fetchAndTransformProperties();
    const readyProperties = properties.filter((p) => p.offPlan === 'No');
    const { items, total, pagination } = paginate(readyProperties, opts.page, opts.limit);
    return { properties: items, total, pagination };
};

/**
 * Fetches all properties and returns only those with propertyPurpose === "Buy"
 * Supports pagination via { page, limit }
 */
const fetchBuyProperties = async (opts = {}) => {
    const { properties } = await fetchAndTransformProperties();
    const buyProperties = properties.filter((p) => (p.propertyPurpose || '').trim() === 'Buy');
    const { items, total, pagination } = paginate(buyProperties, opts.page, opts.limit);
    return { properties: items, total, pagination };
};

/**
 * Fetches all properties and returns only those with propertyPurpose === "Rent"
 * Supports pagination via { page, limit }
 */
const fetchRentProperties = async (opts = {}) => {
    const { properties } = await fetchAndTransformProperties();
    const rentProperties = properties.filter((p) => (p.propertyPurpose || '').trim() === 'Rent');
    const { items, total, pagination } = paginate(rentProperties, opts.page, opts.limit);
    return { properties: items, total, pagination };
};

/**
 * Fetches a single property by propertyRefNo
 * Works for both Buy and Rent properties
 * @param {string} propertyRefNo - The property reference number (e.g. "RO-S-02800")
 * @returns {Promise<object|null>} The full property object or null if not found
 */
const fetchPropertyByRefNo = async (propertyRefNo) => {
    if (!propertyRefNo || typeof propertyRefNo !== 'string') return null;
    const { properties } = await fetchAndTransformProperties();
    return properties.find((p) => (p.propertyRefNo || '').trim() === propertyRefNo.trim()) || null;
};

/**
 * Search fields used for matching
 */
const SEARCH_FIELDS = [
    'propertyTitle',
    'city',
    'locality',
    'subLocality',
    'towerName',
    'propertyType',
    'propertyRefNo'
];

/**
 * Checks if a property matches the search query (case-insensitive) on any search field
 */
const propertyMatchesQuery = (property, query) => {
    const q = query.toLowerCase().trim();
    if (!q) return false;

    return SEARCH_FIELDS.some((field) => {
        const value = (property[field] || '').toString().toLowerCase();
        return value.includes(q);
    });
};

/**
 * Picks minimal fields for search suggestions
 */
const toSuggestionShape = (property) => ({
    propertyRefNo: property.propertyRefNo,
    towerName: property.towerName,
    propertyPurpose: property.propertyPurpose,
    propertyType: property.propertyType,
    locality: property.locality,
    subLocality: property.subLocality
});

/**
 * Searches properties and returns limited suggestions for autocomplete
 * @param {object} opts - { q: search query, limit (default: 10) }
 * @returns {Promise<{ suggestions: object[] }>}
 */
const fetchSearchSuggestions = async (opts = {}) => {
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 10, 1), 20);
    const query = (opts.q || '').trim();

    const { properties } = await fetchAndTransformProperties();

    if (!query) {
        return { suggestions: [] };
    }

    const suggestions = properties
        .filter((p) => propertyMatchesQuery(p, query))
        .slice(0, limit)
        .map(toSuggestionShape);

    return { suggestions };
};

const AREA_SUGGESTION_TYPE = {
    CITY: 'city',
    AREA: 'area',
    SUBAREA: 'subarea',
    TOWER: 'tower'
};

const toComparableText = (value) => (value || '').toString().trim().toLowerCase();

const getMatchPriority = (value, query) => {
    const normalizedValue = toComparableText(value);
    if (!normalizedValue || !query) return Number.POSITIVE_INFINITY;
    if (normalizedValue === query) return 0;
    if (normalizedValue.startsWith(query)) return 1;
    if (normalizedValue.includes(query)) return 2;
    return Number.POSITIVE_INFINITY;
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
        full: (full || label).trim()
    });
};

/**
 * Returns autocomplete suggestions from city/area/subarea/tower fields.
 * @param {object} opts - { q: search query, limit (default: 10) }
 * @returns {Promise<{ suggestions: { type: string, label: string, full: string }[] }>}
 */
const fetchSearchByAreaSuggestions = async (opts = {}) => {
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 10, 1), 20);
    const query = toComparableText(opts.q);

    if (!query) {
        return { suggestions: [] };
    }

    const { properties } = await fetchAndTransformProperties();
    const seen = new Set();
    const suggestions = [];

    properties.forEach((property) => {
        const city = (property.city || '').trim();
        const locality = (property.locality || '').trim();
        const subLocality = (property.subLocality || '').trim();
        const towerName = (property.towerName || '').trim();

        if (getMatchPriority(city, query) !== Number.POSITIVE_INFINITY) {
            addUniqueSuggestion(suggestions, seen, AREA_SUGGESTION_TYPE.CITY, city, city);
        }

        if (getMatchPriority(locality, query) !== Number.POSITIVE_INFINITY) {
            const full = city ? `${locality}, ${city}` : locality;
            addUniqueSuggestion(suggestions, seen, AREA_SUGGESTION_TYPE.AREA, locality, full);
        }

        if (getMatchPriority(subLocality, query) !== Number.POSITIVE_INFINITY) {
            const full = locality ? `${subLocality} (${locality})` : subLocality;
            addUniqueSuggestion(suggestions, seen, AREA_SUGGESTION_TYPE.SUBAREA, subLocality, full);
        }

        if (getMatchPriority(towerName, query) !== Number.POSITIVE_INFINITY) {
            const full = subLocality ? `${towerName} (${subLocality})` : towerName;
            addUniqueSuggestion(suggestions, seen, AREA_SUGGESTION_TYPE.TOWER, towerName, full);
        }
    });

    suggestions.sort((a, b) => {
        const priorityDiff = getMatchPriority(a.label, query) - getMatchPriority(b.label, query);
        if (priorityDiff !== 0) return priorityDiff;
        return a.label.localeCompare(b.label);
    });

    return { suggestions: suggestions.slice(0, limit) };
};

/**
 * Fetches all properties and returns unique propertyType values
 * @returns {Promise<string[]>} Sorted array of unique property types
 */
const fetchUniquePropertyTypes = async () => {
    const { properties } = await fetchAndTransformProperties();
    const types = properties
        .map((p) => (p.propertyType || '').trim())
        .filter(Boolean);
    return [...new Set(types)].sort();
};

module.exports = {
    fetchAndTransformProperties,
    fetchAllProperties,
    fetchOffPlanProperties,
    fetchReadyProperties,
    fetchBuyProperties,
    fetchRentProperties,
    fetchPropertyByRefNo,
    fetchSearchSuggestions,
    fetchSearchByAreaSuggestions,
    fetchUniquePropertyTypes,
    transformProperty
};
