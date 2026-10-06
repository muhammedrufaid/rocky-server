const propertyService = require('../services/propertyDbService');
const { parsePaginationParams } = require('../utils/paginationUtils');

const PROPERTY_PURPOSES = ['Buy', 'Rent'];

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
  'propertySizeMax',
];

const listingPageFilters = (query) => {
  const positive = (value) => (Number(value) > 0 ? Number(value) : undefined);
  const beds = query.beds !== undefined && query.beds !== '' && Number(query.beds) >= 0 ? Number(query.beds) : undefined;
  return Object.fromEntries(
    Object.entries({
      priceMin: positive(query.min),
      priceMax: positive(query.max),
      beds,
      baths: positive(query.baths),
    }).filter(([, value]) => value !== undefined)
  );
};

// GET /api/commercial-properties?propertyPurpose=Buy|Rent
const getCommercialProperties = async (req, res) => {
  try {
    const propertyPurpose = (req.query.propertyPurpose || '').toString().trim();
    if (!PROPERTY_PURPOSES.includes(propertyPurpose)) {
      return res.status(400).json({
        message: 'Query parameter "propertyPurpose" must be Buy or Rent',
      });
    }

    const { page, limit } = parsePaginationParams(req, { maxLimit: propertyService.LISTING_WINDOW_LIMIT });
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
          message: 'Invalid "filters" JSON payload',
        });
      }
    }

    const directFilters = {};
    FILTER_QUERY_KEYS.forEach((key) => {
      if (req.query[key] !== undefined) directFilters[key] = req.query[key];
    });

    const mergedFilters = { ...listingPageFilters(req.query), ...directFilters, ...filters };
    const { properties, total, pagination } = await propertyService.fetchCommercialProperties({
      page,
      limit,
      search,
      filters: mergedFilters,
      propertyPurpose,
    });

    return res.status(200).json({ properties, total, pagination });
  } catch (error) {
    console.error('getCommercialProperties error:', error);
    return res.status(500).json({
      message: error.message || 'Failed to fetch commercial properties',
    });
  }
};

module.exports = {
  getCommercialProperties,
};
