const express = require('express');
const router = express.Router();

const { migrateFromFeed, migrateFromRawXml } = require('../controllers/salesforceController');

// Fetch from BASE_URL_SALESFORCE and upsert into MongoDB
router.post('/migrate', migrateFromFeed);

// Post raw XML and upsert into MongoDB (testing / manual migrations)
router.post('/migrate-xml', migrateFromRawXml);

module.exports = router;

