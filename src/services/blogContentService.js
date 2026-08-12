const Blog = require('../models/Blog');

/**
 * Known content block types from the Rocky Blog model / live data.
 * Unknown types are still handled via best-effort text extraction.
 */
const TEXT_BLOCK_TYPES = new Set(['paragraph', 'heading2', 'heading3', 'list', 'image']);

/**
 * @param {unknown} value
 * @returns {string}
 */
const asTrimmedString = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

/**
 * Extract meaningful plain text from a single content[] block.
 * Skips decorative/non-textual fields (e.g. image src URLs).
 *
 * @param {object} block
 * @returns {{ type: string, text: string } | null}
 */
const extractBlockText = (block) => {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return null;
  }

  const type = asTrimmedString(block.type) || 'unknown';

  if (type === 'paragraph' || type === 'heading2' || type === 'heading3') {
    const text = asTrimmedString(block.text);
    return text ? { type, text } : null;
  }

  if (type === 'list') {
    const items = Array.isArray(block.items) ? block.items : [];
    const lines = items
      .map((item) => asTrimmedString(item))
      .filter(Boolean)
      .map((item) => `- ${item}`);

    if (!lines.length) return null;
    return { type, text: lines.join('\n') };
  }

  if (type === 'image') {
    const parts = [asTrimmedString(block.alt), asTrimmedString(block.caption)].filter(
      Boolean
    );
    if (!parts.length) return null;
    return { type, text: parts.join('\n') };
  }

  // Future / unknown blocks: best-effort without failing extraction
  const fallbackParts = [];
  const directText = asTrimmedString(block.text);
  if (directText) fallbackParts.push(directText);

  if (Array.isArray(block.items)) {
    for (const item of block.items) {
      const line = asTrimmedString(item);
      if (line) fallbackParts.push(`- ${line}`);
    }
  }

  const alt = asTrimmedString(block.alt);
  const caption = asTrimmedString(block.caption);
  if (alt) fallbackParts.push(alt);
  if (caption) fallbackParts.push(caption);

  if (!fallbackParts.length) return null;
  return { type, text: fallbackParts.join('\n') };
};

/**
 * Build a single plain-text document from metadata + extracted blocks.
 * Suitable for later chunking (not performed here).
 *
 * @param {{ title?: string, category?: string, subtitle?: string, description?: string }} meta
 * @param {Array<{ type: string, text: string }>} blocks
 * @returns {string}
 */
const buildPlainText = (meta, blocks) => {
  const parts = [];

  const title = asTrimmedString(meta.title);
  const category = asTrimmedString(meta.category);
  const subtitle = asTrimmedString(meta.subtitle);
  const description = asTrimmedString(meta.description);

  if (title) parts.push(title);
  if (category) parts.push(`Category: ${category}`);
  if (subtitle) parts.push(subtitle);
  if (description) parts.push(description);

  for (const block of blocks) {
    if (!block?.text) continue;

    if (block.type === 'heading2' || block.type === 'heading3') {
      parts.push(block.text);
    } else {
      parts.push(block.text);
    }
  }

  return parts.join('\n\n').trim();
};

/**
 * Count whitespace-separated words in plain text.
 * @param {string} text
 * @returns {number}
 */
const countWords = (text) => {
  const trimmed = asTrimmedString(text);
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
};

/**
 * Normalize one Blog document into a text-focused representation.
 * Does not create embeddings, chunks, or vector indexes.
 *
 * @param {object} blog - Mongoose doc or lean object
 * @returns {object}
 */
const normalizeBlogContent = (blog) => {
  if (!blog || typeof blog !== 'object') {
    throw new Error('Blog document is required');
  }

  const rawContent = Array.isArray(blog.content) ? blog.content : [];
  const blocks = [];

  rawContent.forEach((rawBlock, index) => {
    const extracted = extractBlockText(rawBlock);
    if (!extracted) return;
    blocks.push({
      index,
      type: extracted.type,
      text: extracted.text,
    });
  });

  const meta = {
    title: blog.title,
    category: blog.category,
    subtitle: blog.subtitle,
    description: blog.description,
  };

  const plainText = buildPlainText(meta, blocks);

  return {
    id: blog._id ? String(blog._id) : null,
    slug: blog.slug || null,
    title: asTrimmedString(blog.title) || null,
    category: asTrimmedString(blog.category) || null,
    subtitle: asTrimmedString(blog.subtitle) || null,
    description: asTrimmedString(blog.description) || null,
    isFeatured: Boolean(blog.isFeatured),
    isActive: blog.isActive !== false,
    blocks,
    plainText,
    stats: {
      rawBlockCount: rawContent.length,
      extractedBlockCount: blocks.length,
      skippedBlockCount: rawContent.length - blocks.length,
      charCount: plainText.length,
      wordCount: countWords(plainText),
      knownTypeCoverage: rawContent.every((b) =>
        TEXT_BLOCK_TYPES.has(asTrimmedString(b?.type))
      ),
    },
  };
};

/**
 * Load active blogs from MongoDB and return normalized representations.
 *
 * @param {{ includeInactive?: boolean, slug?: string }} [options]
 * @returns {Promise<object[]>}
 */
const extractAllBlogContent = async (options = {}) => {
  const { includeInactive = false, slug } = options;

  const filter = {};
  if (!includeInactive) {
    filter.isActive = true;
  }
  if (slug) {
    filter.slug = String(slug).trim().toLowerCase();
  }

  const blogs = await Blog.find(filter).sort({ createdAt: -1 }).lean();
  return blogs.map(normalizeBlogContent);
};

/**
 * Extract/normalize a single blog by slug.
 *
 * @param {string} slug
 * @param {{ includeInactive?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
const extractBlogContentBySlug = async (slug, options = {}) => {
  const results = await extractAllBlogContent({
    ...options,
    slug,
  });
  return results[0] || null;
};

module.exports = {
  extractBlockText,
  buildPlainText,
  normalizeBlogContent,
  extractAllBlogContent,
  extractBlogContentBySlug,
  TEXT_BLOCK_TYPES,
};
