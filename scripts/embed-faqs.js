/**
 * Rebuild chatbot embeddings (FAQs, company info, area guides) into `chatbotchunks`.
 *
 * Usage:
 *   node scripts/embed-faqs.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { reindex } = require('../src/lib/chatbot');

const run = async () => {
  await connectDB();
  const { chunks, bySource } = await reindex();
  console.log(`Embedded ${chunks} chunks`, bySource);
};

run()
  .catch((err) => {
    console.error('Embedding failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
