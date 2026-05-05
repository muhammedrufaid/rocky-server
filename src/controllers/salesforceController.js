const propertyService = require('../services/propertyService');
const { runMigrationFromFeed, migrateProperties } = require('../services/salesforceMigrateService');
const { XMLParser } = require('fast-xml-parser');
const { toArray } = require('../utils/xmlUtils');

const XML_PARSER_OPTIONS = {
  ignoreAttributes: false,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
};

/**
 * POST /api/salesforce/migrate
 * Fetches XML from BASE_URL_SALESFORCE and upserts properties into MongoDB.
 * Manual trigger always runs a full upsert (no skip-if-unchanged).
 */
const migrateFromFeed = async (req, res) => {
  try {
    const outcome = await runMigrationFromFeed({ skipIfUnchanged: false });

    if (outcome.skipped) {
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: outcome.reason,
        count: outcome.count,
      });
    }

    if (!outcome.count) {
      return res.status(200).json({
        success: true,
        message: outcome.message || 'No properties found in feed',
        count: 0,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Migration completed',
      count: outcome.count,
      result: outcome.result,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
};

/**
 * POST /api/salesforce/migrate-xml
 * Accepts raw XML in the request body and upserts to MongoDB.
 *
 * Useful for testing: curl -H "Content-Type: application/xml" --data-binary @file.xml ...
 */
const migrateFromRawXml = async (req, res) => {
  try {
    const xmlText = typeof req.body === 'string' ? req.body : '';
    if (!xmlText.trim()) {
      return res.status(400).json({ success: false, message: 'XML body is required' });
    }

    let parsed;
    try {
      parsed = new XMLParser(XML_PARSER_OPTIONS).parse(xmlText);
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid XML' });
    }

    const propertiesRoot = parsed?.Properties;
    const rawList = propertiesRoot?.Property;

    if (!propertiesRoot || rawList === undefined || rawList === null) {
      return res.status(400).json({
        success: false,
        message: 'XML did not contain Properties.Property nodes (unexpected format)',
      });
    }

    const rawProperties = toArray(rawList);
    const properties = rawProperties.map(propertyService.transformProperty).filter(Boolean);

    const outcome = await migrateProperties({ properties, skipIfUnchanged: false });

    res.status(200).json({
      success: true,
      message: 'Migration completed',
      parsedCount: properties.length,
      count: outcome.count,
      result: outcome.result,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
};

module.exports = {
  migrateFromFeed,
  migrateFromRawXml,
};
