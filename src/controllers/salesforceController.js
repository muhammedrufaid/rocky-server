const Property = require('../models/Property');
const propertyService = require('../services/propertyService');
const { XMLParser } = require('fast-xml-parser');

const buildBulkUpserts = ({ properties, source = 'salesforce' }) => {
  const ops = [];

  properties.forEach((p) => {
    if (!p) return;
    const sourceId = (p.propertyRefNo || '').trim();
    if (!sourceId) return;

    ops.push({
      updateOne: {
        filter: { source, sourceId },
        update: {
          $set: {
            source,
            sourceId,
            propertyRefNo: p.propertyRefNo || null,
            permitNumber: p.permitNumber || null,
            propertyStatus: p.propertyStatus || null,
            propertyPurpose: p.propertyPurpose || null,
            propertyType: p.propertyType || null,
            propertySize: p.propertySize || null,
            propertySizeUnit: p.propertySizeUnit || null,
            bedrooms: p.bedrooms || null,
            bathrooms: p.bathrooms || null,
            offPlan: p.offPlan || null,
            lastUpdated: p.lastUpdated || null,
            city: p.city || null,
            locality: p.locality || null,
            subLocality: p.subLocality || null,
            towerName: p.towerName || null,
            propertyTitle: p.propertyTitle || null,
            propertyDescription: p.propertyDescription || null,
            price: p.price || null,
            furnished: p.furnished || null,
            rentFrequency: p.rentFrequency || null,
            listingAgentEmail: p.listingAgentEmail || null,
            listingAgent: p.listingAgent || null,
            listingAgentPhone: p.listingAgentPhone || null,
            features: Array.isArray(p.features) ? p.features : [],
            portals: Array.isArray(p.portals) ? p.portals : [],
            images: Array.isArray(p.images) ? p.images : [],
            data: p,
          },
        },
        upsert: true,
      },
    });
  });

  return ops;
};

/**
 * POST /api/salesforce/migrate
 * Fetches XML from BASE_URL_SALESFORCE and upserts properties into MongoDB.
 */
const migrateFromFeed = async (req, res) => {
  try {
    const { properties } = await propertyService.fetchAndTransformProperties();
    const ops = buildBulkUpserts({ properties });

    if (!ops.length) {
      return res.status(200).json({
        success: true,
        message: 'No properties found in feed',
        count: 0,
      });
    }

    const result = await Property.bulkWrite(ops, { ordered: false });

    res.status(200).json({
      success: true,
      message: 'Migration completed',
      count: ops.length,
      result: {
        inserted: result.insertedCount || 0,
        upserted: result.upsertedCount || 0,
        modified: result.modifiedCount || 0,
        matched: result.matchedCount || 0,
      },
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

    const parser = new XMLParser({
      ignoreAttributes: false,
      trimValues: true,
      parseTagValue: false,
      parseAttributeValue: false,
    });
    const parsed = parser.parse(xmlText);
    const propertiesRoot = parsed?.Properties;
    const rawList = propertiesRoot?.Property;

    // Reuse the same transformer the frontend uses.
    // If the XML isn't in the expected Salesforce feed shape, we fail clearly.
    if (!propertiesRoot || !rawList) {
      return res.status(400).json({
        success: false,
        message: 'XML did not contain Properties.Property nodes (unexpected format)',
      });
    }

    const { toArray } = require('../utils/xmlUtils');
    const rawProperties = toArray(rawList);
    const properties = rawProperties.map(propertyService.transformProperty).filter(Boolean);

    const ops = buildBulkUpserts({ properties });
    const result = ops.length ? await Property.bulkWrite(ops, { ordered: false }) : null;

    res.status(200).json({
      success: true,
      message: 'Migration completed',
      count: ops.length,
      result: result
        ? {
            inserted: result.insertedCount || 0,
            upserted: result.upsertedCount || 0,
            modified: result.modifiedCount || 0,
            matched: result.matchedCount || 0,
          }
        : { inserted: 0, upserted: 0, modified: 0, matched: 0 },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
};

module.exports = {
  migrateFromFeed,
  migrateFromRawXml,
};

