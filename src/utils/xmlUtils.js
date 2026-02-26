/**
 * Extracts text value from parsed XML node (handles CDATA, plain text, and primitives)
 * Note: fast-xml-parser with parseTagValue converts numeric strings to numbers
 */
const extractText = (node) => {
    if (node == null || node === undefined) return null;
    if (typeof node === 'string') return node.trim();
    if (typeof node === 'number' || typeof node === 'boolean') return String(node);
    if (typeof node === 'object' && node['#text'] !== undefined) return String(node['#text']).trim();
    if (typeof node === 'object' && node['#cdata-section'] !== undefined) return String(node['#cdata-section']).trim();
    return null;
};

/**
 * Ensures value is always an array (handles single vs multiple elements)
 */
const toArray = (value) => {
    if (value == null || value === undefined) return [];
    if (Array.isArray(value)) return value;
    return [value];
};

/**
 * Removes duplicates from array while preserving order (first occurrence wins)
 */
const deduplicate = (arr) => [...new Set(arr)];

module.exports = {
    extractText,
    toArray,
    deduplicate
};
