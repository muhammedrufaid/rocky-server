const propertyService = require('../services/propertyService');
const { parsePaginationParams } = require('../utils/paginationUtils');

/**
 * GET /properties - Fetches and returns all properties from Salesforce feed
 * Query params: page (default: 1), limit (default: 10)
 */
const getAllProperties = async (req, res) => {
    try {
        const { page, limit } = parsePaginationParams(req);
        const { properties, total, pagination } = await propertyService.fetchAllProperties({ page, limit });
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
        const { properties, total, pagination } = await propertyService.fetchOffPlanProperties({ page, limit });
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
        const { properties, total, pagination } = await propertyService.fetchReadyProperties({ page, limit });
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
        const { properties, total, pagination } = await propertyService.fetchBuyProperties({ page, limit });
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
        const { properties, total, pagination } = await propertyService.fetchRentProperties({ page, limit });
        res.status(200).json({ properties, total, pagination });
    } catch (error) {
        console.error('getRentProperties error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch rent properties'
        });
    }
};

module.exports = {
    getAllProperties,
    getAllOffPlanProperties,
    getAllReadyProperties,
    getBuyProperties,
    getRentProperties
};
