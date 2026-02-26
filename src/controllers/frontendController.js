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

module.exports = {
    getAllProperties
};
