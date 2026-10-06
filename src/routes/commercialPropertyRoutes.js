const express = require('express');
const router = express.Router();

const { getCommercialProperties } = require('../controllers/commercialPropertyController');

// GET /api/commercial-properties?propertyPurpose=Buy|Rent
router.get('/', getCommercialProperties);

module.exports = router;
