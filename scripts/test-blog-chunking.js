/**
 * Step 3 test: semantic blog chunking (no OpenAI, no MongoDB writes).
 *
 * Usage:
 *   node scripts/test-blog-chunking.js
 *   node scripts/test-blog-chunking.js --slug=flexi-rent-dubai-land-department
 *
 * Flow:
 *   MongoDB → Blog model → blogContentService → blogChunkingService → preview
 */
require('dotenv').config();
const mongoose = require('mongoose');
const {
  extractAllBlogContent,
  extractBlogContentBySlug,
} = require('../src/services/blogContentService');
const {
  chunkBlog,
  getChunkConfig,
  containsImageUrl,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_MIN_SIZE,
} = require('../src/services/blogChunkingService');

const FLEXI_SLUG = 'flexi-rent-dubai-land-department';
const REQUIRED_FIELDS = [
  'blogId',
  'slug',
  'title',
  'category',
  'chunkIndex',
  'content',
  'headingContext',
  'sourceBlockStart',
  'sourceBlockEnd',
  'charCount',
  'wordCount',
];

const args = process.argv.slice(2);
const slugArg = args.find((a) => a.startsWith('--slug='));
const onlySlug = slugArg ? slugArg.slice('--slug='.length) : null;

const avg = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0);
const min = (nums) => (nums.length ? Math.min(...nums) : 0);
const max = (nums) => (nums.length ? Math.max(...nums) : 0);

const looksLikeBrokenSentence = (content) => {
  const text = String(content || '').trim();
  if (!text) return true;
  // Starts mid-word lowercase after a cut, or ends with dangling connector
  if (/^[a-z]/.test(text) && !/^(i|a|an|the|and|or|but|for|to|of|in|on|at)\b/i.test(text)) {
    // Allow list items
    if (!text.startsWith('-')) return true;
  }
  if (/\b(the|and|or|but|with|for|to|of|in|a|an)\s*$/i.test(text)) return true;
  return false;
};

const isOrphanHeading = (chunk) => {
  const content = String(chunk.content || '').trim();
  const heading = String(chunk.headingContext || '').trim();
  if (!heading) return false;
  // Heading only, no body under it
  if (content === heading) return true;
  // headingContext "H2 > H3" but content is only the leaf heading
  if (heading.includes(' > ')) {
    const leaf = heading.split(' > ').pop().trim();
    if (content === leaf) return true;
  }
  return false;
};

const runQualityTests = (blogsWithChunks) => {
  const allChunks = blogsWithChunks.flatMap((b) => b.chunks);
  const results = [];

  const noEmpty = allChunks.every((c) => typeof c.content === 'string' && c.content.length > 0);
  results.push({ name: 'No empty chunks', pass: noEmpty });

  const noWhitespaceOnly = allChunks.every((c) => c.content.trim().length > 0);
  results.push({ name: 'No whitespace-only chunks', pass: noWhitespaceOnly });

  const noImageUrls = allChunks.every((c) => !containsImageUrl(c.content));
  results.push({ name: 'No image URLs', pass: noImageUrls });

  const noUnknownTypes = blogsWithChunks.every((b) => b.normalized.stats.knownTypeCoverage === true);
  results.push({ name: 'No unknown block types (from Step 2)', pass: noUnknownTypes });

  const contents = allChunks.map((c) => c.content.trim());
  const unique = new Set(contents);
  results.push({
    name: 'No duplicate chunk content',
    pass: unique.size === contents.length,
  });

  const noOrphans = allChunks.every((c) => !isOrphanHeading(c));
  results.push({ name: 'No orphaned headings', pass: noOrphans });

  const broken = allChunks.filter((c) => looksLikeBrokenSentence(c.content));
  results.push({
    name: 'No obviously broken sentences (heuristic)',
    pass: broken.length === 0,
    details: broken.slice(0, 3).map((c) => ({
      slug: c.slug,
      chunkIndex: c.chunkIndex,
      preview: c.content.slice(0, 80),
    })),
  });

  const metadataOk = allChunks.every((c) =>
    REQUIRED_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(c, field))
  );
  results.push({ name: 'All chunks have required metadata', pass: metadataOk });

  const indexesOk = blogsWithChunks.every((b) =>
    b.chunks.every((c, i) => c.chunkIndex === i)
  );
  results.push({ name: 'chunkIndex is contiguous per blog', pass: indexesOk });

  return results;
};

const printFlexiPreview = (chunks) => {
  console.log('\n==============================');
  console.log('FLEXI RENT CHUNK PREVIEW');
  console.log('==============================\n');

  for (const chunk of chunks) {
    console.log(`--- Chunk ${chunk.chunkIndex} ---`);
    console.log(`Heading: ${chunk.headingContext || '(none)'}`);
    console.log(`Blocks: ${chunk.sourceBlockStart}-${chunk.sourceBlockEnd}`);
    console.log(`Words: ${chunk.wordCount}`);
    console.log(`Characters: ${chunk.charCount}`);
    console.log('\nContent:\n');
    console.log(chunk.content);
    console.log('\n');
  }
};

(async () => {
  const config = getChunkConfig();
  console.log('Chunk config:', {
    ...config,
    defaults: {
      BLOG_CHUNK_SIZE: DEFAULT_CHUNK_SIZE,
      BLOG_CHUNK_OVERLAP: DEFAULT_CHUNK_OVERLAP,
      BLOG_CHUNK_MIN_SIZE: DEFAULT_CHUNK_MIN_SIZE,
    },
  });
  console.log('OpenAI calls: NONE (Step 3)');
  console.log('MongoDB writes: NONE (read-only)\n');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected (read-only test)');

  const normalizedBlogs = onlySlug
    ? [await extractBlogContentBySlug(onlySlug)].filter(Boolean)
    : await extractAllBlogContent();

  if (!normalizedBlogs.length) {
    throw new Error(onlySlug ? `No blog found for slug: ${onlySlug}` : 'No active blogs found');
  }

  const blogsWithChunks = normalizedBlogs.map((normalized) => ({
    normalized,
    chunks: chunkBlog(normalized),
  }));

  const perBlogCounts = blogsWithChunks.map((b) => b.chunks.length);
  const allChunks = blogsWithChunks.flatMap((b) => b.chunks);
  const charCounts = allChunks.map((c) => c.charCount);
  const wordCounts = allChunks.map((c) => c.wordCount);

  const stats = {
    totalBlogsProcessed: blogsWithChunks.length,
    totalChunksGenerated: allChunks.length,
    averageChunksPerBlog: Number(avg(perBlogCounts).toFixed(2)),
    minChunksPerBlog: min(perBlogCounts),
    maxChunksPerBlog: max(perBlogCounts),
    averageChunkCharCount: Math.round(avg(charCounts)),
    minChunkCharCount: min(charCounts),
    maxChunkCharCount: max(charCounts),
    averageChunkWordCount: Math.round(avg(wordCounts)),
    minChunkWordCount: min(wordCounts),
    maxChunkWordCount: max(wordCounts),
  };

  console.log('\nChunk statistics:');
  console.log(JSON.stringify(stats, null, 2));

  console.log('\nPer-blog chunk counts:');
  console.log(
    JSON.stringify(
      blogsWithChunks.map((b) => ({
        slug: b.normalized.slug,
        blocks: b.normalized.stats.extractedBlockCount,
        chunks: b.chunks.length,
        avgChunkChars: Math.round(avg(b.chunks.map((c) => c.charCount))),
      })),
      null,
      2
    )
  );

  const flexi =
    blogsWithChunks.find((b) => b.normalized.slug === FLEXI_SLUG) ||
    (onlySlug ? blogsWithChunks[0] : null);

  if (flexi) {
    printFlexiPreview(flexi.chunks);
  } else {
    console.log('\nFlexi Rent blog not in current result set (skipped preview).');
  }

  const quality = runQualityTests(blogsWithChunks);
  console.log('\nQuality tests:');
  for (const result of quality) {
    const mark = result.pass ? 'PASS' : 'FAIL';
    console.log(`- ${result.name}: ${mark}`);
    if (!result.pass && result.details) {
      console.log('  details:', JSON.stringify(result.details, null, 2));
    }
  }

  const allPass = quality.every((q) => q.pass);
  console.log(`\nOverall quality: ${allPass ? 'PASS' : 'FAIL'}`);
  console.log('OpenAI embedding API called: NO');
  console.log('MongoDB modified: NO');

  await mongoose.disconnect();
  process.exit(allPass ? 0 : 1);
})().catch(async (error) => {
  console.error('\nChunking test FAILED:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
