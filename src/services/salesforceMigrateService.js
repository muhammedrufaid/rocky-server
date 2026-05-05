const crypto = require('crypto');
const Property = require('../models/Property');
const propertyService = require('./propertyService');

const logPrefix = '[salesforce-migrate]';

const log = (msg, extra) => {
  const ts = new Date().toISOString();
  if (extra !== undefined) {
    console.log(`${ts} ${logPrefix} ${msg}`, extra);
  } else {
    console.log(`${ts} ${logPrefix} ${msg}`);
  }
};

/**
 * @param {object[]} properties
 * @param {string} [source]
 */
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

let lastContentHash = null;

const hashXml = (xmlText) =>
  crypto.createHash('sha256').update(xmlText, 'utf8').digest('hex');

/**
 * Upserts transformed properties. Same logic used by HTTP migrate and the scheduler.
 *
 * @param {object} opts
 * @param {object[]} opts.properties
 * @param {boolean} [opts.skipIfUnchanged]
 * @param {string} [opts.xmlText] - when skipIfUnchanged, hash this to detect unchanged feed
 * @returns {Promise<object>}
 */
const migrateProperties = async ({ properties, skipIfUnchanged = false, xmlText = null }) => {
  let contentHash = null;
  if (skipIfUnchanged && xmlText != null) {
    contentHash = hashXml(xmlText);
    if (lastContentHash !== null && contentHash === lastContentHash) {
      log('Skipping migrate: XML body unchanged since last successful run');
      return {
        skipped: true,
        reason: 'unchanged-xml',
        count: 0,
        result: null,
      };
    }
  }

  const ops = buildBulkUpserts({ properties });

  if (!ops.length) {
    log('No upsert operations (no properties with Property_Ref_No)');
    if (contentHash !== null) {
      lastContentHash = contentHash;
    }
    return {
      skipped: false,
      count: 0,
      result: null,
      message: 'No properties found',
    };
  }

  const result = await Property.bulkWrite(ops, { ordered: false });

  if (contentHash !== null) {
    lastContentHash = contentHash;
  }

  log('Bulk upsert finished', {
    ops: ops.length,
    inserted: result.insertedCount || 0,
    upserted: result.upsertedCount || 0,
    modified: result.modifiedCount || 0,
    matched: result.matchedCount || 0,
  });

  return {
    skipped: false,
    count: ops.length,
    result: {
      inserted: result.insertedCount || 0,
      upserted: result.upsertedCount || 0,
      modified: result.modifiedCount || 0,
      matched: result.matchedCount || 0,
    },
  };
};

/**
 * Fetch Salesforce XML, transform, upsert. Used by cron and POST /migrate.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.skipIfUnchanged] - skip DB work when XML body matches last run (in-memory)
 */
const runMigrationFromFeed = async (opts = {}) => {
  const skipIfUnchanged = opts.skipIfUnchanged === true;

  log(`Fetch + migrate from Salesforce feed started (skipIfUnchanged=${skipIfUnchanged})`);

  const { xmlText } = await propertyService.fetchSalesforceXml();
  const { properties } = propertyService.parseXmlToProperties(xmlText);

  return migrateProperties({
    properties,
    skipIfUnchanged,
    xmlText,
  });
};

module.exports = {
  buildBulkUpserts,
  runMigrationFromFeed,
  migrateProperties,
  logPrefix,
};
