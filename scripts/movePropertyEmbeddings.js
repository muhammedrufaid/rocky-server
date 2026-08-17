/**
 * Move embedding / embeddingHash off Property documents into property_embeddings.
 * Listing APIs stay fast because Mongo no longer reads ~1500-dim vectors on every query.
 *
 * Usage:
 *   node scripts/movePropertyEmbeddings.js
 *   node scripts/movePropertyEmbeddings.js --dry-run
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Property = require('../src/models/Property');
const PropertyEmbedding = require('../src/models/PropertyEmbedding');

const BATCH_SIZE = 25;
const dryRun = process.argv.includes('--dry-run');

const run = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is required');
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to database: ${mongoose.connection.name}`);

  const totalWithEmbedding = await Property.countDocuments({ embedding: { $exists: true } });
  console.log(`Properties with embedding: ${totalWithEmbedding}`);

  if (!totalWithEmbedding) {
    console.log('Nothing to move');
    await mongoose.disconnect();
    return;
  }

  if (dryRun) {
    console.log('[dry-run] skipping copy and $unset');
    await mongoose.disconnect();
    return;
  }

  const cursor = Property.find(
    { embedding: { $exists: true } },
    { propertyRefNo: 1, embedding: 1, embeddingHash: 1 }
  )
    .lean()
    .cursor({ batchSize: BATCH_SIZE });

  let copied = 0;
  let ops = [];

  const flush = async () => {
    if (!ops.length) return;
    await PropertyEmbedding.bulkWrite(ops, { ordered: false });
    copied += ops.length;
    console.log(`Copied ${copied}/${totalWithEmbedding}`);
    ops = [];
  };

  for await (const doc of cursor) {
    const propertyRefNo = (doc.propertyRefNo || '').trim();
    if (!propertyRefNo || !Array.isArray(doc.embedding) || !doc.embedding.length) continue;

    ops.push({
      updateOne: {
        filter: { propertyRefNo },
        update: {
          $set: {
            propertyRefNo,
            embedding: doc.embedding,
            embeddingHash: doc.embeddingHash || '',
          },
        },
        upsert: true,
      },
    });

    if (ops.length >= BATCH_SIZE) await flush();
  }

  await flush();

  const unsetResult = await Property.updateMany(
    { $or: [{ embedding: { $exists: true } }, { embeddingHash: { $exists: true } }] },
    { $unset: { embedding: '', embeddingHash: '' } }
  );

  console.log(`Copied embeddings: ${copied}`);
  console.log(`Unset from properties: ${unsetResult.modifiedCount || 0}`);

  await mongoose.disconnect();
  console.log('Done');
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
