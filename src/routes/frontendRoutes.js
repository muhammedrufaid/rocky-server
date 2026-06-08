const express = require('express');
const router = express.Router();
const {
    getAllProperties,
    getAllOffPlanProperties,
    getAllReadyProperties,
    getBuyProperties,
    getRentProperties,
    getDubaiSouthProperties,
    getFeaturedDubaiSouthProperties,
    getPropertyByRefNo,
    searchProperties,
    searchPropertiesByArea,
    getUniquePropertyTypes,
    getUniquePropertyTypesByCategory,
} = require('../controllers/frontendController');

router.get('/properties', getAllProperties);
router.get('/properties/search', searchProperties);
router.get('/properties/search-by-area', searchPropertiesByArea);
router.get('/properties/types', getUniquePropertyTypes);
router.get('/properties/types-by-category', getUniquePropertyTypesByCategory);
router.get('/properties/off-plan', getAllOffPlanProperties);
router.get('/properties/ready', getAllReadyProperties);
router.get('/properties/buy', getBuyProperties);
router.get('/properties/rent', getRentProperties);
router.get('/properties/dubai-south', getDubaiSouthProperties);
router.get('/properties/featured-dubai-south', getFeaturedDubaiSouthProperties);
router.get('/properties/:propertyRefNo', getPropertyByRefNo);

module.exports = router;
