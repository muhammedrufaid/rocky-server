/**
 * Unset legacy denormalized / leftover fields from `properties`.
 *
 * Does NOT touch:
 * - chatbot_knowledge / vector search
 * - Buy / Rent / Off-plan filter fields (propertyPurpose, offPlan, price, etc.)
 * - property listing search logic
 *
 * Usage:
 *   node scripts/cleanupLegacyPropertyFields.js --dry-run   # counts only
 *   node scripts/cleanupLegacyPropertyFields.js             # $unset
 *   node scripts/cleanupLegacyPropertyFields.js --validate  # post-check only
 */
require('dotenv').config();
const mongoose = require('mongoose');

const LEGACY_FIELDS = [
  'currencyNormalized',
  'currencyVerified',
  'furnishingNormalized',
  'offPlanNormalized',
  'offPlanSlug',
  'poolAccess',
  'priceAmount',
  'propertyPurposeNormalized',
  'propertyStatusNormalized',
  'rentFrequencyNormalized',
  'embedding',
  'embeddingHash',
];

const dryRun = process.argv.includes('--dry-run');
const validateOnly = process.argv.includes('--validate');

const countLegacyFields = async () => {
  const col = mongoose.connection.db.collection('properties');
  const counts = {};
  for (const field of LEGACY_FIELDS) {
    counts[field] = await col.countDocuments({ [field]: { $exists: true } });
  }
  return counts;
};

const printCounts = (counts, label) => {
  console.log(`\n=== ${label} ===`);
  for (const field of LEGACY_FIELDS) {
    console.log(`${field}: ${counts[field]} documents`);
  }
};

const unsetLegacyFields = async () => {
  const unset = Object.fromEntries(LEGACY_FIELDS.map((f) => [f, '']));
  if (dryRun) {
    console.log('[dry-run] skipping $unset');
    return { matchedCount: 0, modifiedCount: 0 };
  }

  // Native driver — Mongoose can strip $unset keys that are not in the schema.
  const result = await mongoose.connection.db.collection('properties').updateMany({}, { $unset: unset });
  console.log(`\n$unset matched: ${result.matchedCount || 0}`);
  console.log(`$unset modified: ${result.modifiedCount || 0}`);
  return result;
};

const validateCleanup = async () => {
  const counts = await countLegacyFields();
  const orQuery = {
    $or: LEGACY_FIELDS.map((field) => ({ [field]: { $exists: true } })),
  };
  const leftoverDocs = await mongoose.connection.db.collection('properties').countDocuments(orQuery);

  printCounts(counts, 'Post-validation counts');
  console.log(`\nDocuments with any legacy field: ${leftoverDocs}`);

  if (leftoverDocs !== 0) {
    throw new Error(`Legacy fields still present on ${leftoverDocs} property documents`);
  }
  return { counts, leftoverDocs };
};

const smokeSearchCounts = async () => {
  const col = mongoose.connection.db.collection('properties');
  const buy = await col.countDocuments({
    propertyPurpose: { $regex: /^Buy$/i },
    offPlan: { $regex: /^No$/i },
  });
  const rent = await col.countDocuments({
    propertyPurpose: { $regex: /^Rent$/i },
    offPlan: { $regex: /^No$/i },
  });
  const offPlan = await col.countDocuments({ offPlan: { $regex: /^Yes$/i } });
  console.log('\n=== Search inventory smoke counts ===');
  console.log(`Buy (ready): ${buy}`);
  console.log(`Rent (ready): ${rent}`);
  console.log(`Off-plan: ${offPlan}`);
  return { buy, rent, offPlan };
};

const run = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is required');
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to database: ${mongoose.connection.name}`);
  console.log(`Mode: ${validateOnly ? 'validate' : dryRun ? 'dry-run' : 'execute'}`);

  const before = await countLegacyFields();
  printCounts(before, 'Live field counts (before)');
  console.log(`Total properties: ${await mongoose.connection.db.collection('properties').countDocuments()}`);

  if (validateOnly) {
    await validateCleanup();
    await smokeSearchCounts();
    await mongoose.disconnect();
    return;
  }

  const unsetStats = await unsetLegacyFields();
  const after = await validateCleanup();
  const smoke = await smokeSearchCounts();

  console.log('\n=== Summary ===');
  console.log(JSON.stringify({ before, unsetStats, after, smoke }, null, 2));

  await mongoose.disconnect();
  console.log('\nDone');
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
