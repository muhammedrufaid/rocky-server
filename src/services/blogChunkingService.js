/**
 * Semantic blog chunking for future embeddings (text-embedding-3-small).
 *
 * Consumes normalized output from blogContentService.js.
 * Does NOT call OpenAI. Does NOT write to MongoDB. Does NOT create embeddings.
 *
 * Config (env, with safe defaults):
 *   BLOG_CHUNK_SIZE     – soft max characters per chunk (default 1200)
 *   BLOG_CHUNK_OVERLAP  – overlap chars when splitting oversized sections (default 120)
 *   BLOG_CHUNK_MIN_SIZE – merge tiny trailing fragments below this (default 80)
 *
 * Defaults rationale (based on current Rocky blogs):
 * - Active blogs average ~3.1k chars / ~21 blocks / ~5–8 headings.
 * - Heading2 sections typically land in the 400–900 char range.
 * - 1200 keeps most sections intact as one retrieval unit while still
 *   fitting comfortably under text-embedding-3-small token limits.
 * - 120-char overlap is only used when a single section must be split;
 *   it preserves sentence continuity without duplicating whole sections.
 */

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 120;
const DEFAULT_CHUNK_MIN_SIZE = 80;

// Detect leaked local asset image paths (src values), not general web mentions.
const IMAGE_URL_PATTERN =
  /\/assets\/[^\s"'()]+?\.(?:webp|png|jpe?g|gif|svg)\b/i;

/**
 * @returns {{ chunkSize: number, chunkOverlap: number, minChunkSize: number }}
 */
const getChunkConfig = () => {
  const chunkSize = parsePositiveInt(process.env.BLOG_CHUNK_SIZE, DEFAULT_CHUNK_SIZE);
  const chunkOverlap = parseNonNegativeInt(
    process.env.BLOG_CHUNK_OVERLAP,
    DEFAULT_CHUNK_OVERLAP
  );
  const minChunkSize = parseNonNegativeInt(
    process.env.BLOG_CHUNK_MIN_SIZE,
    DEFAULT_CHUNK_MIN_SIZE
  );

  // Overlap must stay meaningfully smaller than chunk size
  const safeOverlap =
    chunkSize > 1 ? Math.min(chunkOverlap, Math.floor(chunkSize / 3)) : 0;

  return {
    chunkSize,
    chunkOverlap: safeOverlap,
    minChunkSize,
  };
};

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
const parsePositiveInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
const parseNonNegativeInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * @param {unknown} value
 * @returns {string}
 */
const asTrimmedString = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

/**
 * @param {string} text
 * @returns {number}
 */
const countWords = (text) => {
  const trimmed = asTrimmedString(text);
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
};

/**
 * Split text into sentences without cutting mid-sentence when possible.
 * @param {string} text
 * @returns {string[]}
 */
const splitIntoSentences = (text) => {
  const trimmed = asTrimmedString(text);
  if (!trimmed) return [];

  // Keep punctuation attached to the sentence.
  const parts = trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g);
  if (!parts) return [trimmed];
  return parts.map((p) => p.trim()).filter(Boolean);
};

/**
 * Pack units into groups that stay under maxChars, preferring not to split units.
 * @param {string[]} units
 * @param {number} maxChars
 * @param {string} joiner
 * @returns {string[]}
 */
const packUnits = (units, maxChars, joiner = '\n\n') => {
  const groups = [];
  let current = [];
  let currentLen = 0;

  const flush = () => {
    if (!current.length) return;
    groups.push(current.join(joiner).trim());
    current = [];
    currentLen = 0;
  };

  for (const unit of units) {
    const piece = asTrimmedString(unit);
    if (!piece) continue;

    if (piece.length > maxChars) {
      flush();
      // Oversized single unit → sentence-split fallback
      const sentences = splitIntoSentences(piece);
      if (sentences.length <= 1) {
        groups.push(piece);
        continue;
      }
      const packedSentences = packUnits(sentences, maxChars, ' ');
      groups.push(...packedSentences);
      continue;
    }

    const nextLen = currentLen === 0 ? piece.length : currentLen + joiner.length + piece.length;
    if (currentLen > 0 && nextLen > maxChars) {
      flush();
    }

    current.push(piece);
    currentLen = currentLen === 0 ? piece.length : currentLen + joiner.length + piece.length;
  }

  flush();
  return groups.filter(Boolean);
};

/**
 * Apply small overlap between adjacent text parts of the same section.
 * @param {string[]} parts
 * @param {number} overlap
 * @returns {string[]}
 */
const applyOverlap = (parts, overlap) => {
  if (!overlap || parts.length <= 1) return parts;

  const result = [parts[0]];
  for (let i = 1; i < parts.length; i += 1) {
    const prev = parts[i - 1];
    const curr = parts[i];

    // Prefer overlapping at a sentence / word boundary from the previous part
    let prefix = '';
    if (prev.length <= overlap) {
      prefix = prev;
    } else {
      const window = prev.slice(-overlap * 2);
      const sentences = splitIntoSentences(window);
      if (sentences.length > 1) {
        prefix = sentences[sentences.length - 1];
      } else {
        const words = window.trim().split(/\s+/);
        prefix = words.slice(-Math.max(3, Math.floor(words.length / 2))).join(' ');
      }
      if (prefix.length > overlap) {
        prefix = prefix.slice(-overlap).trim();
      }
    }

    if (prefix && !curr.startsWith(prefix)) {
      result.push(`${prefix}\n\n${curr}`.trim());
    } else {
      result.push(curr);
    }
  }

  return result;
};

/**
 * Build headingContext string from active h2/h3.
 * @param {string|null} heading2
 * @param {string|null} heading3
 * @returns {string|null}
 */
const formatHeadingContext = (heading2, heading3) => {
  const h2 = asTrimmedString(heading2);
  const h3 = asTrimmedString(heading3);
  if (h2 && h3) return `${h2} > ${h3}`;
  if (h2) return h2;
  if (h3) return h3;
  return null;
};

/**
 * Group normalized blocks into semantic sections.
 * Prefer heading2 as primary boundary; heading3 creates nested context.
 *
 * @param {Array<{ index: number, type: string, text: string }>} blocks
 * @param {{ title?: string|null }} meta
 * @returns {Array<object>}
 */
const buildSections = (blocks, meta = {}) => {
  const sections = [];
  let current = null;
  let activeHeading2 = null;
  let activeHeading3 = null;

  const startSection = (heading2, heading3, seedBlock = null) => {
    current = {
      heading2: heading2 || null,
      heading3: heading3 || null,
      headingContext: formatHeadingContext(heading2, heading3),
      blocks: seedBlock ? [seedBlock] : [],
    };
    sections.push(current);
  };

  const ensureSection = () => {
    if (!current) {
      // Intro / pre-heading material — use blog title as soft context
      startSection(asTrimmedString(meta.title) || null, null);
    }
  };

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const type = asTrimmedString(block.type);
    const text = asTrimmedString(block.text);
    if (!text) continue;

    if (type === 'heading2') {
      activeHeading2 = text;
      activeHeading3 = null;
      startSection(activeHeading2, null, block);
      continue;
    }

    if (type === 'heading3') {
      activeHeading3 = text;
      // New subsection under the current h2 (or alone if no h2 yet)
      startSection(activeHeading2, activeHeading3, block);
      continue;
    }

    ensureSection();
    current.blocks.push(block);
  }

  return sections.filter((s) => s.blocks.length > 0);
};

/**
 * Convert one section into one or more content strings under size limits.
 * @param {object} section
 * @param {{ chunkSize: number, chunkOverlap: number }} config
 * @returns {Array<{ content: string, sourceBlockStart: number, sourceBlockEnd: number, headingContext: string|null }>}
 */
const chunkSection = (section, config) => {
  const { chunkSize, chunkOverlap } = config;
  const blocks = section.blocks || [];
  if (!blocks.length) return [];

  const blockTexts = blocks.map((b) => asTrimmedString(b.text)).filter(Boolean);
  const fullContent = blockTexts.join('\n\n').trim();
  if (!fullContent) return [];

  const sourceBlockStart = blocks[0].index;
  const sourceBlockEnd = blocks[blocks.length - 1].index;
  const headingContext = section.headingContext || null;

  if (fullContent.length <= chunkSize) {
    return [
      {
        content: fullContent,
        sourceBlockStart,
        sourceBlockEnd,
        headingContext,
      },
    ];
  }

  // Prefer paragraph/list/image block boundaries first
  let parts = packUnits(blockTexts, chunkSize, '\n\n');

  // If still oversized (rare), packUnits already fell back to sentences
  parts = applyOverlap(parts, chunkOverlap);

  // Map approximate source ranges by greedily consuming blocks for each part
  const results = [];
  let blockCursor = 0;

  for (const part of parts) {
    if (!asTrimmedString(part)) continue;

    let start = blocks[Math.min(blockCursor, blocks.length - 1)].index;
    let end = start;
    let covered = '';

    while (blockCursor < blocks.length) {
      const block = blocks[blockCursor];
      const nextText = asTrimmedString(block.text);
      const candidate = covered ? `${covered}\n\n${nextText}` : nextText;

      // Stop if adding this block clearly overshoots and we already have content,
      // unless the part still contains this block's text (overlap cases).
      if (
        covered &&
        candidate.length > part.length * 1.2 &&
        !part.includes(nextText.slice(0, Math.min(40, nextText.length)))
      ) {
        break;
      }

      covered = candidate;
      end = block.index;
      blockCursor += 1;

      if (covered.length >= part.length * 0.85) {
        break;
      }
    }

    if (blockCursor === 0) {
      start = blocks[0].index;
      end = blocks[0].index;
    }

    results.push({
      content: part.trim(),
      sourceBlockStart: start,
      sourceBlockEnd: end,
      headingContext,
    });
  }

  return results;
};

/**
 * Merge extremely tiny chunks into the previous chunk when they share context.
 * @param {Array<object>} rawChunks
 * @param {number} minChunkSize
 * @returns {Array<object>}
 */
const mergeTinyChunks = (rawChunks, minChunkSize) => {
  if (!rawChunks.length || minChunkSize <= 0) return rawChunks;

  const merged = [];
  for (const chunk of rawChunks) {
    const content = asTrimmedString(chunk.content);
    if (!content) continue;

    const prev = merged[merged.length - 1];
    const isTiny = content.length < minChunkSize;
    const sameHeading =
      prev &&
      asTrimmedString(prev.headingContext) === asTrimmedString(chunk.headingContext);

    if (prev && isTiny && sameHeading) {
      prev.content = `${prev.content}\n\n${content}`.trim();
      prev.sourceBlockEnd = chunk.sourceBlockEnd;
      continue;
    }

    // Orphan heading-only chunk: try merge forward by deferring into next if possible
    merged.push({ ...chunk, content });
  }

  // Second pass: heading-only / tiny leading chunk merge into next sibling
  const refined = [];
  for (let i = 0; i < merged.length; i += 1) {
    const chunk = merged[i];
    const next = merged[i + 1];
    const isHeadingOnly =
      chunk.content.length < minChunkSize &&
      !chunk.content.includes('\n') &&
      chunk.headingContext &&
      chunk.content === chunk.headingContext;

    if (isHeadingOnly && next) {
      next.content = `${chunk.content}\n\n${next.content}`.trim();
      next.sourceBlockStart = Math.min(chunk.sourceBlockStart, next.sourceBlockStart);
      next.headingContext = next.headingContext || chunk.headingContext;
      continue;
    }

    refined.push(chunk);
  }

  return refined;
};

/**
 * Prepend description to the first section when present and not already included.
 * Keeps description with the opening/intro material for retrieval quality.
 *
 * @param {Array<object>} sections
 * @param {string|null} description
 * @returns {Array<object>}
 */
const attachDescriptionToIntro = (sections, description) => {
  const desc = asTrimmedString(description);
  if (!desc || !sections.length) return sections;

  const first = sections[0];
  const alreadyPresent = first.blocks.some((b) => asTrimmedString(b.text) === desc);
  if (alreadyPresent) return sections;

  // Synthetic block index just before the first real block
  const firstIndex =
    typeof first.blocks[0]?.index === 'number' ? first.blocks[0].index : 0;

  first.blocks = [
    {
      index: Math.max(0, firstIndex),
      type: 'paragraph',
      text: desc,
      synthetic: true,
    },
    ...first.blocks,
  ];

  return sections;
};

/**
 * Chunk one normalized blog from blogContentService.
 *
 * @param {object} normalizedBlog
 * @param {{ chunkSize?: number, chunkOverlap?: number, minChunkSize?: number }} [options]
 * @returns {Array<object>}
 */
const chunkBlog = (normalizedBlog, options = {}) => {
  if (!normalizedBlog || typeof normalizedBlog !== 'object') {
    throw new Error('normalizedBlog is required');
  }

  const envConfig = getChunkConfig();
  const config = {
    chunkSize: options.chunkSize || envConfig.chunkSize,
    chunkOverlap:
      options.chunkOverlap !== undefined ? options.chunkOverlap : envConfig.chunkOverlap,
    minChunkSize:
      options.minChunkSize !== undefined ? options.minChunkSize : envConfig.minChunkSize,
  };

  const blocks = Array.isArray(normalizedBlog.blocks) ? normalizedBlog.blocks : [];
  if (!blocks.length && !asTrimmedString(normalizedBlog.description)) {
    return [];
  }

  let sections = buildSections(blocks, { title: normalizedBlog.title });
  sections = attachDescriptionToIntro(sections, normalizedBlog.description);

  const rawPieces = [];
  for (const section of sections) {
    const pieces = chunkSection(section, config);
    rawPieces.push(...pieces);
  }

  const merged = mergeTinyChunks(rawPieces, config.minChunkSize);

  return merged.map((piece, chunkIndex) => {
    const content = asTrimmedString(piece.content);
    return {
      blogId: normalizedBlog.id || null,
      slug: normalizedBlog.slug || null,
      title: normalizedBlog.title || null,
      category: normalizedBlog.category || null,
      chunkIndex,
      content,
      headingContext: piece.headingContext || null,
      sourceBlockStart: piece.sourceBlockStart,
      sourceBlockEnd: piece.sourceBlockEnd,
      charCount: content.length,
      wordCount: countWords(content),
    };
  });
};

/**
 * Chunk many normalized blogs.
 * @param {object[]} normalizedBlogs
 * @param {object} [options]
 * @returns {Array<object>}
 */
const chunkBlogs = (normalizedBlogs, options = {}) => {
  if (!Array.isArray(normalizedBlogs)) {
    throw new Error('normalizedBlogs must be an array');
  }

  const all = [];
  for (const blog of normalizedBlogs) {
    all.push(...chunkBlog(blog, options));
  }
  return all;
};

/**
 * Detect likely image URL leakage in chunk text.
 * @param {string} content
 * @returns {boolean}
 */
const containsImageUrl = (content) => IMAGE_URL_PATTERN.test(String(content || ''));

module.exports = {
  chunkBlog,
  chunkBlogs,
  getChunkConfig,
  buildSections,
  containsImageUrl,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_MIN_SIZE,
};
