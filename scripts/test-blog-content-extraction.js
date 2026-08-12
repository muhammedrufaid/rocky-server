/**
 * Step 2 test: extract & normalize blog content from MongoDB.
 *
 * Usage:
 *   node scripts/test-blog-content-extraction.js
 *   node scripts/test-blog-content-extraction.js --slug=flexi-rent-dubai-land-department
 *   node scripts/test-blog-content-extraction.js --preview
 *
 * No embeddings. No vector search. No chunking.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const {
  extractAllBlogContent,
  extractBlogContentBySlug,
  extractBlockText,
  normalizeBlogContent,
} = require('../src/services/blogContentService');

const args = process.argv.slice(2);
const slugArg = args.find((a) => a.startsWith('--slug='));
const slug = slugArg ? slugArg.slice('--slug='.length) : null;
const preview = args.includes('--preview');

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const runUnitChecks = () => {
  assert(
    extractBlockText({ type: 'paragraph', text: '  Hello  ' })?.text === 'Hello',
    'paragraph extraction failed'
  );
  assert(
    extractBlockText({ type: 'heading2', text: 'Title' })?.text === 'Title',
    'heading2 extraction failed'
  );
  assert(
    extractBlockText({ type: 'list', items: ['A', '  ', 'B'] })?.text === '- A\n- B',
    'list extraction failed'
  );
  assert(
    extractBlockText({
      type: 'image',
      src: '/x.webp',
      alt: 'Alt text',
      caption: 'Caption',
    })?.text === 'Alt text\nCaption',
    'image extraction failed'
  );
  assert(
    extractBlockText({ type: 'image', src: '/x.webp', alt: '', caption: '' }) === null,
    'empty image should be skipped'
  );
  assert(
    extractBlockText({ type: 'paragraph', text: '   ' }) === null,
    'whitespace paragraph should be skipped'
  );

  const normalized = normalizeBlogContent({
    _id: '000000000000000000000001',
    slug: 'demo',
    title: 'Demo Title',
    category: 'Insights',
    subtitle: 'Sub',
    description: 'Desc',
    content: [
      { type: 'paragraph', text: 'Intro' },
      { type: 'heading2', text: 'Section' },
      { type: 'list', items: ['One', 'Two'] },
      { type: 'image', src: '/a.webp', alt: 'Photo', caption: 'Credit' },
    ],
    isActive: true,
  });

  assert(normalized.plainText.includes('Demo Title'), 'plainText missing title');
  assert(normalized.plainText.includes('Category: Insights'), 'plainText missing category');
  assert(normalized.plainText.includes('Intro'), 'plainText missing paragraph');
  assert(normalized.plainText.includes('- One'), 'plainText missing list');
  assert(normalized.plainText.includes('Photo'), 'plainText missing image alt');
  assert(!normalized.plainText.includes('/a.webp'), 'plainText must not include image src');
  assert(normalized.stats.extractedBlockCount === 4, 'expected 4 extracted blocks');
  assert(normalized.stats.wordCount > 0, 'expected wordCount > 0');

  console.log('Unit checks: PASS');
};

(async () => {
  runUnitChecks();

  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected');

  const docs = slug
    ? [await extractBlogContentBySlug(slug)].filter(Boolean)
    : await extractAllBlogContent();

  if (slug && docs.length === 0) {
    console.error(`No blog found for slug: ${slug}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const summary = docs.map((doc) => ({
    slug: doc.slug,
    title: doc.title,
    category: doc.category,
    rawBlockCount: doc.stats.rawBlockCount,
    extractedBlockCount: doc.stats.extractedBlockCount,
    skippedBlockCount: doc.stats.skippedBlockCount,
    charCount: doc.stats.charCount,
    wordCount: doc.stats.wordCount,
    knownTypeCoverage: doc.stats.knownTypeCoverage,
    blockTypes: doc.blocks.map((b) => b.type),
  }));

  const totals = summary.reduce(
    (acc, row) => {
      acc.blogs += 1;
      acc.rawBlocks += row.rawBlockCount;
      acc.extractedBlocks += row.extractedBlockCount;
      acc.skippedBlocks += row.skippedBlockCount;
      acc.chars += row.charCount;
      acc.words += row.wordCount;
      if (!row.knownTypeCoverage) acc.unknownTypeBlogs += 1;
      return acc;
    },
    {
      blogs: 0,
      rawBlocks: 0,
      extractedBlocks: 0,
      skippedBlocks: 0,
      chars: 0,
      words: 0,
      unknownTypeBlogs: 0,
    }
  );

  console.log('\nExtraction summary:');
  console.log(JSON.stringify({ totals, blogs: summary }, null, 2));

  if (preview) {
    const sample = docs.find((d) => d.slug === 'flexi-rent-dubai-land-department') || docs[0];
    console.log('\nNormalized preview:');
    console.log(
      JSON.stringify(
        {
          slug: sample.slug,
          title: sample.title,
          stats: sample.stats,
          blocks: sample.blocks.slice(0, 6),
          plainTextPreview: sample.plainText.slice(0, 900) + (sample.plainText.length > 900 ? '…' : ''),
        },
        null,
        2
      )
    );
  }

  // Data integrity assertions against live MongoDB
  assert(totals.blogs > 0, 'expected at least one blog');
  assert(totals.extractedBlocks > 0, 'expected extracted text blocks');
  assert(totals.skippedBlocks === 0, 'unexpected skipped blocks in current dataset');
  assert(totals.unknownTypeBlogs === 0, 'unexpected unknown content block types');

  const flexi = docs.find((d) => d.slug === 'flexi-rent-dubai-land-department');
  if (flexi) {
    assert(flexi.plainText.toLowerCase().includes('flexi rent'), 'Flexi Rent text missing');
    assert(flexi.plainText.includes('Rocky Real Estate'), 'Rocky Real Estate mention missing');
    assert(!flexi.plainText.includes('/assets/blogs/'), 'image src leaked into plainText');
  }

  console.log('\nLive MongoDB extraction: PASS');
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error('\nExtraction test FAILED:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
