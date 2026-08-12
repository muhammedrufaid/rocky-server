const Service = require('../../models/Service');

const PUBLIC_SERVICE_FIELDS = [
  'slug',
  'title',
  'description',
  'overviewHeading',
  'overview',
  'subservices',
  'image',
  'icon',
  'isActive',
];

const sanitizeSubservice = (sub) => {
  if (!sub || typeof sub !== 'object') return null;
  return {
    id: typeof sub.id === 'number' ? sub.id : undefined,
    title: sub.title || null,
    icon: sub.icon || null,
    description: sub.description || null,
    points: Array.isArray(sub.points) ? sub.points.filter((p) => typeof p === 'string') : undefined,
  };
};

/**
 * Sanitize a service document to public AI-safe fields only.
 * @param {object} doc
 * @returns {object|null}
 */
const sanitizeService = (doc) => {
  if (!doc) return null;
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : doc;

  return {
    slug: raw.slug || null,
    title: raw.title || null,
    description: raw.description || null,
    overviewHeading: raw.overviewHeading || null,
    overview: Array.isArray(raw.overview) ? raw.overview : undefined,
    subservices: Array.isArray(raw.subservices)
      ? raw.subservices.map(sanitizeSubservice).filter(Boolean)
      : [],
    image: raw.image || null,
    icon: raw.icon || null,
    isActive: raw.isActive !== false,
  };
};

/**
 * Assert sanitized payload has no forbidden keys.
 * @param {object|object[]} data
 */
const assertNoPrivateServiceFields = (data) => {
  const forbidden = ['_id', 'createdAt', 'updatedAt', '__v'];
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const key of forbidden) {
      if (Object.prototype.hasOwnProperty.call(item, key)) {
        throw new Error(`Service sanitization leaked field: ${key}`);
      }
    }
  }
};

/**
 * Fixed tool: active public services only.
 * Collection allowlist: services
 *
 * @returns {Promise<{ data: object[], collection: string }>}
 */
const getActiveServices = async () => {
  const docs = await Service.find({ isActive: true })
    .select(PUBLIC_SERVICE_FIELDS.join(' '))
    .sort({ createdAt: 1 })
    .lean();

  const data = docs.map(sanitizeService).filter(Boolean);
  assertNoPrivateServiceFields(data);
  return { data, collection: 'services' };
};

/**
 * Fixed tool: one active service by slug or title match.
 * @param {string} query
 * @returns {Promise<{ data: object|null, collection: string }>}
 */
const findActiveService = async (query) => {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { data: null, collection: 'services' };

  const docs = await Service.find({ isActive: true })
    .select(PUBLIC_SERVICE_FIELDS.join(' '))
    .lean();

  const scored = docs
    .map((doc) => {
      const title = String(doc.title || '').toLowerCase();
      const slug = String(doc.slug || '').toLowerCase();
      let score = 0;
      if (slug === q || title === q) score = 100;
      else if (title.includes(q) || slug.includes(q.replace(/\s+/g, '-'))) score = 80;
      else if (q.includes(title) || q.includes(slug.replace(/-/g, ' '))) score = 60;
      return { doc, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const data = scored[0] ? sanitizeService(scored[0].doc) : null;
  if (data) assertNoPrivateServiceFields(data);
  return { data, collection: 'services' };
};

/**
 * Extract a likely service name from a user question.
 * @param {string} message
 * @returns {string|null}
 */
const extractServiceQuery = (message) => {
  const text = String(message || '');
  const known = [
    'property management',
    'professional inspection',
    'brokerage',
    'mortgage',
    'property listing & marketing',
    'property listing and marketing',
    'after sales support',
    'after-sales support',
  ];

  const lower = text.toLowerCase();
  for (const name of known) {
    if (lower.includes(name)) return name;
  }

  const about = text.match(
    /\b(?:tell\s+me\s+about|about|regarding)\s+(?:your\s+)?(.+?)(?:\s+service|\s+services)?[.?!]?$/i
  );
  if (about?.[1]) return about[1].trim();

  return null;
};

module.exports = {
  getActiveServices,
  findActiveService,
  extractServiceQuery,
  sanitizeService,
  PUBLIC_SERVICE_FIELDS,
};
