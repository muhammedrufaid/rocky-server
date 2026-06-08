const propertyService = require('../services/propertyDbService');
const { parsePaginationParams } = require('../utils/paginationUtils');
const { DUBAI_SOUTH_LOCALITY } = require('../constants/dubaiSouth');

const DEFAULT_SEARCH_LIMIT = 10;

const FILTER_QUERY_KEYS = [
    'propertyType',
    'city',
    'locality',
    'subLocality',
    'towerName',
    'bedrooms',
    'bathrooms',
    'furnished',
    'offPlan',
    'propertyStatus',
    'priceMin',
    'priceMax',
    'propertySizeMin',
    'propertySizeMax'
];

const parsePropertyListQuery = (req) => {
    const { page, limit } = parsePaginationParams(req);
    const search = (req.query.search || '').toString().trim();

    let filters = {};
    if (req.query.filters !== undefined) {
        if (typeof req.query.filters === 'string') {
            filters = JSON.parse(req.query.filters);
        } else if (typeof req.query.filters === 'object' && req.query.filters !== null) {
            filters = req.query.filters;
        } else {
            filters = {};
        }
    }

    const directFilters = {};
    FILTER_QUERY_KEYS.forEach((key) => {
        if (req.query[key] !== undefined) directFilters[key] = req.query[key];
    });

    const mergedFilters = { ...directFilters, ...filters };

    return { page, limit, search, filters: mergedFilters };
};

const handleDubaiSouthPropertyList = async (req, res) => {
    try {
        let parsed;
        try {
            parsed = parsePropertyListQuery(req);
        } catch (err) {
            return res.status(400).json({
                message: 'Invalid "filters" JSON payload'
            });
        }

        const { page, limit, search, filters } = parsed;
        const mergedFilters = { ...filters, locality: DUBAI_SOUTH_LOCALITY };

        const { properties, total, pagination } = await propertyService.fetchAllProperties({
            page,
            limit,
            search,
            filters: mergedFilters
        });
        res.status(200).json({ properties, total, pagination });
    } catch (error) {
        console.error('getDubaiSouthProperties error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch Dubai South properties'
        });
    }
};

const RESIDENTIAL_PROPERTY_TYPES = new Set([
    'Apartment',
    'Pent House',
    'Residential Land',
    'Townhouse',
    'Villa',
]);

/**
 * GET /properties - Fetches and returns all properties from Salesforce feed
 * Query params: page (default: 1), limit (default: 10)
 */
const getAllProperties = async (req, res) => {
    try {
        const { page, limit } = parsePaginationParams(req);
        const search = (req.query.search || '').toString().trim();

        let filters = {};
        if (req.query.filters !== undefined) {
            try {
                if (typeof req.query.filters === 'string') {
                    filters = JSON.parse(req.query.filters);
                } else if (typeof req.query.filters === 'object' && req.query.filters !== null) {
                    filters = req.query.filters;
                } else {
                    filters = {};
                }
            } catch (err) {
                return res.status(400).json({
                    message: 'Invalid "filters" JSON payload'
                });
            }
        }

        const filterQueryKeys = [
            'propertyType',
            'city',
            'locality',
            'subLocality',
            'towerName',
            'bedrooms',
            'bathrooms',
            'furnished',
            'offPlan',
            'propertyStatus',
            'priceMin',
            'priceMax',
            'propertySizeMin',
            'propertySizeMax'
        ];

        const directFilters = {};
        filterQueryKeys.forEach((key) => {
            if (req.query[key] !== undefined) directFilters[key] = req.query[key];
        });

        const mergedFilters = { ...directFilters, ...filters };

        const { properties, total, pagination } = await propertyService.fetchAllProperties({
            page,
            limit,
            search,
            filters: mergedFilters
        });
        res.status(200).json({ properties, total, pagination });
    } catch (error) {
        console.error('getAllProperties error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch and transform properties'
        });
    }
};

/**
 * GET /properties/off-plan - Fetches and returns only off-plan properties (offPlan === "Yes")
 * Query params: page (default: 1), limit (default: 10)
 */
const getAllOffPlanProperties = async (req, res) => {
    try {
        const { page, limit } = parsePaginationParams(req);
        const search = (req.query.search || '').toString().trim();

        let filters = {};
        if (req.query.filters !== undefined) {
            try {
                if (typeof req.query.filters === 'string') {
                    filters = JSON.parse(req.query.filters);
                } else if (typeof req.query.filters === 'object' && req.query.filters !== null) {
                    filters = req.query.filters;
                } else {
                    filters = {};
                }
            } catch (err) {
                return res.status(400).json({
                    message: 'Invalid "filters" JSON payload'
                });
            }
        }

        const filterQueryKeys = [
            'propertyType',
            'city',
            'locality',
            'subLocality',
            'towerName',
            'bedrooms',
            'bathrooms',
            'furnished',
            'offPlan',
            'propertyStatus',
            'priceMin',
            'priceMax',
            'propertySizeMin',
            'propertySizeMax'
        ];

        const directFilters = {};
        filterQueryKeys.forEach((key) => {
            if (req.query[key] !== undefined) directFilters[key] = req.query[key];
        });

        const mergedFilters = { ...directFilters, ...filters };

        const { properties, total, pagination } = await propertyService.fetchOffPlanProperties({
            page,
            limit,
            search,
            filters: mergedFilters
        });
        res.status(200).json({ properties, total, pagination });
    } catch (error) {
        console.error('getAllOffPlanProperties error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch off-plan properties'
        });
    }
};

/**
 * GET /properties/ready - Fetches and returns only ready properties (offPlan === "No")
 * Query params: page (default: 1), limit (default: 10)
 */
const getAllReadyProperties = async (req, res) => {
    try {
        const { page, limit } = parsePaginationParams(req);
        const search = (req.query.search || '').toString().trim();

        let filters = {};
        if (req.query.filters !== undefined) {
            try {
                if (typeof req.query.filters === 'string') {
                    filters = JSON.parse(req.query.filters);
                } else if (typeof req.query.filters === 'object' && req.query.filters !== null) {
                    filters = req.query.filters;
                } else {
                    filters = {};
                }
            } catch (err) {
                return res.status(400).json({
                    message: 'Invalid "filters" JSON payload'
                });
            }
        }

        const filterQueryKeys = [
            'propertyType',
            'city',
            'locality',
            'subLocality',
            'towerName',
            'bedrooms',
            'bathrooms',
            'furnished',
            'offPlan',
            'propertyStatus',
            'priceMin',
            'priceMax',
            'propertySizeMin',
            'propertySizeMax'
        ];

        const directFilters = {};
        filterQueryKeys.forEach((key) => {
            if (req.query[key] !== undefined) directFilters[key] = req.query[key];
        });

        const mergedFilters = { ...directFilters, ...filters };

        const { properties, total, pagination } = await propertyService.fetchReadyProperties({
            page,
            limit,
            search,
            filters: mergedFilters
        });
        res.status(200).json({ properties, total, pagination });
    } catch (error) {
        console.error('getAllReadyProperties error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch ready properties'
        });
    }
};

/**
 * GET /properties/buy - Fetches and returns only Buy properties (propertyPurpose === "Buy")
 * Query params: page (default: 1), limit (default: 10)
 */
const getBuyProperties = async (req, res) => {
    try {
        const { page, limit } = parsePaginationParams(req);
        const search = (req.query.search || '').toString().trim();

        let filters = {};
        if (req.query.filters !== undefined) {
            try {
                if (typeof req.query.filters === 'string') {
                    filters = JSON.parse(req.query.filters);
                } else if (typeof req.query.filters === 'object' && req.query.filters !== null) {
                    filters = req.query.filters;
                } else {
                    filters = {};
                }
            } catch (err) {
                return res.status(400).json({
                    message: 'Invalid "filters" JSON payload'
                });
            }
        }

        const filterQueryKeys = [
            'propertyType',
            'city',
            'locality',
            'subLocality',
            'towerName',
            'bedrooms',
            'bathrooms',
            'furnished',
            'offPlan',
            'propertyStatus',
            'priceMin',
            'priceMax',
            'propertySizeMin',
            'propertySizeMax'
        ];

        const directFilters = {};
        filterQueryKeys.forEach((key) => {
            if (req.query[key] !== undefined) directFilters[key] = req.query[key];
        });

        const mergedFilters = { ...directFilters, ...filters };

        const { properties, total, pagination } = await propertyService.fetchBuyProperties({
            page,
            limit,
            search,
            filters: mergedFilters
        });
        res.status(200).json({ properties, total, pagination });
    } catch (error) {
        console.error('getBuyProperties error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch buy properties'
        });
    }
};

/**
 * GET /properties/rent - Fetches and returns only Rent properties (propertyPurpose === "Rent")
 * Query params: page (default: 1), limit (default: 10)
 */
const getRentProperties = async (req, res) => {
    try {
        const { page, limit } = parsePaginationParams(req);
        const search = (req.query.search || '').toString().trim();

        let filters = {};
        if (req.query.filters !== undefined) {
            try {
                if (typeof req.query.filters === 'string') {
                    filters = JSON.parse(req.query.filters);
                } else if (typeof req.query.filters === 'object' && req.query.filters !== null) {
                    filters = req.query.filters;
                } else {
                    filters = {};
                }
            } catch (err) {
                return res.status(400).json({
                    message: 'Invalid "filters" JSON payload'
                });
            }
        }

        // Support either a JSON `filters` payload or flat query params.
        // If both are provided, the JSON `filters` wins.
        const filterQueryKeys = [
            'propertyType',
            'city',
            'locality',
            'subLocality',
            'towerName',
            'bedrooms',
            'bathrooms',
            'furnished',
            'offPlan',
            'propertyStatus',
            'priceMin',
            'priceMax',
            'propertySizeMin',
            'propertySizeMax'
        ];

        const directFilters = {};
        filterQueryKeys.forEach((key) => {
            if (req.query[key] !== undefined) directFilters[key] = req.query[key];
        });

        const mergedFilters = { ...directFilters, ...filters };

        const { properties, total, pagination } = await propertyService.fetchRentProperties({
            page,
            limit,
            search,
            filters: mergedFilters
        });
        res.status(200).json({ properties, total, pagination });
    } catch (error) {
        console.error('getRentProperties error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch rent properties'
        });
    }
};

/**
 * GET /properties/dubai-south - All Dubai South listings (off-plan, buy, rent) in one response
 */
const getDubaiSouthProperties = (req, res) => handleDubaiSouthPropertyList(req, res);

/**
 * GET /properties/dubai-south/by-listing-agent - Dubai South listings for a specific agent
 * Query params: listingAgent (required), page, limit, search, and other optional filters
 */
const getDubaiSouthPropertiesByListingAgent = async (req, res) => {
    const listingAgent = (req.query.listingAgent || '').toString().trim();
    if (!listingAgent) {
        return res.status(400).json({
            message: 'Query parameter "listingAgent" is required'
        });
    }

    try {
        let parsed;
        try {
            parsed = parsePropertyListQuery(req);
        } catch (err) {
            return res.status(400).json({
                message: 'Invalid "filters" JSON payload'
            });
        }

        const { page, limit, search, filters } = parsed;
        const mergedFilters = {
            ...filters,
            locality: DUBAI_SOUTH_LOCALITY,
            listingAgent
        };

        const { properties, total, pagination } = await propertyService.fetchAllProperties({
            page,
            limit,
            search,
            filters: mergedFilters
        });
        res.status(200).json({ properties, total, pagination, listingAgent });
    } catch (error) {
        console.error('getDubaiSouthPropertiesByListingAgent error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch Dubai South properties by listing agent'
        });
    }
};

/**
 * GET /properties/featured-dubai-south - Returns the fixed featured Dubai South properties
 * Returns: { properties, total }
 */
const getFeaturedDubaiSouthProperties = async (req, res) => {
    try {
        const { properties, total, missingRefs } = await propertyService.fetchFeaturedDubaiSouthProperties();
        res.status(200).json({ properties, total, missingRefs });
    } catch (error) {
        console.error('getFeaturedDubaiSouthProperties error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch featured Dubai South properties'
        });
    }
};

/**
 * GET /properties/:propertyRefNo - Fetches and returns a single property by reference number
 * Works for both Buy and Rent properties
 */
const getPropertyByRefNo = async (req, res) => {
    try {
        const { propertyRefNo } = req.params;
        const property = await propertyService.fetchPropertyByRefNo(propertyRefNo);
        if (!property) {
            return res.status(404).json({
                message: `Property with reference number "${propertyRefNo}" not found`
            });
        }
        res.status(200).json(property);
    } catch (error) {
        console.error('getPropertyByRefNo error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch property'
        });
    }
};

/**
 * GET /properties/search - Returns search suggestions for autocomplete
 * Query params: q (required), limit (optional, default: 10, max: 20)
 * Returns: { suggestions: [{ propertyRefNo, towerName, propertyPurpose, propertyType, locality, subLocality }] }
 */
const searchProperties = async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        const limit = Math.min(
            parseInt(req.query.limit, 10) || DEFAULT_SEARCH_LIMIT,
            20
        );

        let filters = {};
        if (req.query.filters !== undefined) {
            try {
                if (typeof req.query.filters === 'string') {
                    filters = JSON.parse(req.query.filters);
                } else if (typeof req.query.filters === 'object' && req.query.filters !== null) {
                    filters = req.query.filters;
                } else {
                    filters = {};
                }
            } catch (err) {
                return res.status(400).json({
                    message: 'Invalid "filters" JSON payload'
                });
            }
        }

        const filterQueryKeys = [
            'propertyType',
            'city',
            'locality',
            'subLocality',
            'towerName',
            'bedrooms',
            'bathrooms',
            'furnished',
            'offPlan',
            'propertyStatus',
            'priceMin',
            'priceMax',
            'propertySizeMin',
            'propertySizeMax'
        ];

        const directFilters = {};
        filterQueryKeys.forEach((key) => {
            if (req.query[key] !== undefined) directFilters[key] = req.query[key];
        });

        const mergedFilters = { ...directFilters, ...filters };

        const { suggestions } = await propertyService.fetchSearchSuggestions({ q, limit, filters: mergedFilters });
        res.status(200).json({ suggestions });
    } catch (error) {
        console.error('searchProperties error:', error);
        res.status(500).json({
            message: error.message || 'Failed to search properties'
        });
    }
};

/**
 * GET /properties/search-by-area - Returns search suggestions for area autocomplete
 * Query params: q (required), limit (optional, default: 10, max: 20)
 * Returns: { suggestions: [{ type: city|locality|subLocality|tower, label, full }] }
 */
const searchPropertiesByArea = async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q) {
            return res.status(400).json({
                message: 'Query parameter "q" is required'
            });
        }

        const limit = Math.min(
            parseInt(req.query.limit, 10) || DEFAULT_SEARCH_LIMIT,
            20
        );

        let filters = {};
        if (req.query.filters !== undefined) {
            try {
                if (typeof req.query.filters === 'string') {
                    filters = JSON.parse(req.query.filters);
                } else if (typeof req.query.filters === 'object' && req.query.filters !== null) {
                    filters = req.query.filters;
                } else {
                    filters = {};
                }
            } catch (err) {
                return res.status(400).json({
                    message: 'Invalid "filters" JSON payload'
                });
            }
        }

        const filterQueryKeys = [
            'propertyType',
            'city',
            'locality',
            'subLocality',
            'towerName',
            'bedrooms',
            'bathrooms',
            'furnished',
            'offPlan',
            'propertyStatus',
            'priceMin',
            'priceMax',
            'propertySizeMin',
            'propertySizeMax'
        ];

        const directFilters = {};
        filterQueryKeys.forEach((key) => {
            if (req.query[key] !== undefined) directFilters[key] = req.query[key];
        });

        const mergedFilters = { ...directFilters, ...filters };

        const { suggestions } = await propertyService.fetchSearchByAreaSuggestions({ q, limit, filters: mergedFilters });
        res.status(200).json({ suggestions });
    } catch (error) {
        console.error('searchPropertiesByArea error:', error);
        res.status(500).json({
            message: error.message || 'Failed to search properties by area'
        });
    }
};

/**
 * GET /properties/types - Returns unique propertyType values from all property data
 */
const getUniquePropertyTypes = async (req, res) => {
    try {
        const propertyTypes = await propertyService.fetchUniquePropertyTypes();
        res.status(200).json(propertyTypes);
    } catch (error) {
        console.error('getUniquePropertyTypes error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch property types'
        });
    }
};

/**
 * GET /properties/types-by-category - Returns unique propertyType values with category
 * Category rules:
 * - Residential: Apartment, Penthouse, Residential Land, Townhouse, Villa
 * - Commercial: everything else (including unknown/new)
 * Output preserves original order of property types.
 */
const getUniquePropertyTypesByCategory = async (req, res) => {
    try {
        const propertyTypes = await propertyService.fetchUniquePropertyTypesInOrder();
        const typesWithCategory = propertyTypes.map((type) => ({
            type,
            category: RESIDENTIAL_PROPERTY_TYPES.has(type) ? 'Residential' : 'Commercial'
        }));

        res.status(200).json(typesWithCategory);
    } catch (error) {
        console.error('getUniquePropertyTypesByCategory error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch property types by category'
        });
    }
};

module.exports = {
    getAllProperties,
    getAllOffPlanProperties,
    getAllReadyProperties,
    getBuyProperties,
    getRentProperties,
    getDubaiSouthProperties,
    getDubaiSouthPropertiesByListingAgent,
    getFeaturedDubaiSouthProperties,
    getPropertyByRefNo,
    searchProperties,
    searchPropertiesByArea,
    getUniquePropertyTypes,
    getUniquePropertyTypesByCategory
};
