const propertyService = require('../services/propertyService');

/**
 * GET /properties - Fetches and returns all properties from Salesforce feed
 */
const getAllProperties = async (req, res) => {
    try {
        const { properties, total } = await propertyService.fetchAndTransformProperties();
        res.status(200).json({ properties, total });
    } catch (error) {
        console.error('getAllProperties error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch and transform properties'
        });
    }
};

/**
 * GET /properties/off-plan - Fetches and returns only off-plan properties (offPlan === "Yes")
 */
const getAllOffPlanProperties = async (req, res) => {
    try {
        const { properties, total } = await propertyService.fetchOffPlanProperties();
        res.status(200).json({ properties, total });
    } catch (error) {
        console.error('getAllOffPlanProperties error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch off-plan properties'
        });
    }
};

module.exports = {
    getAllProperties,
    getAllOffPlanProperties
};
