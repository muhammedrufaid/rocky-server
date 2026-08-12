const TeamMember = require('../../models/TeamMember');

const PUBLIC_TEAM_FIELDS = [
  'name',
  'slug',
  'department',
  'designation',
  'image',
  'languages',
  'experience',
  'order',
  'isAgent',
  'isActive',
];

const FORBIDDEN_TEAM_FIELDS = [
  'phone',
  'email',
  'whatsapp',
  'businessCardPdf',
  '_id',
  'createdAt',
  'updatedAt',
  'isAdmin',
  '__v',
];

/**
 * Sanitize a team member to public AI-safe fields only.
 * Never includes phone/email/whatsapp/businessCardPdf/isAdmin/_id/timestamps.
 * @param {object} doc
 * @returns {object|null}
 */
const sanitizeTeamMember = (doc) => {
  if (!doc) return null;
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : doc;

  return {
    name: raw.name || null,
    slug: raw.slug || null,
    department: raw.department || null,
    designation: raw.designation || null,
    image: raw.image || null,
    languages: Array.isArray(raw.languages) ? raw.languages : undefined,
    experience: Array.isArray(raw.experience) ? raw.experience : undefined,
    order: typeof raw.order === 'number' ? raw.order : null,
    isAgent: Boolean(raw.isAgent),
    isActive: raw.isActive !== false,
  };
};

/**
 * @param {object|object[]} data
 */
const assertNoPrivateTeamFields = (data) => {
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const key of FORBIDDEN_TEAM_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(item, key)) {
        throw new Error(`Team sanitization leaked field: ${key}`);
      }
    }
  }
};

/**
 * Fixed tool: active team members by designation (case-insensitive contains).
 * @param {string} designation
 * @returns {Promise<{ data: object[], collection: string }>}
 */
const getActiveTeamMembersByDesignation = async (designation) => {
  const q = String(designation || '').trim();
  if (!q) return { data: [], collection: 'teammembers' };

  const docs = await TeamMember.find({
    isActive: true,
    designation: { $regex: new RegExp(escapeRegex(q), 'i') },
  })
    .select(PUBLIC_TEAM_FIELDS.join(' '))
    .sort({ order: 1 })
    .lean();

  const data = docs.map(sanitizeTeamMember).filter(Boolean);
  assertNoPrivateTeamFields(data);
  return { data, collection: 'teammembers' };
};

/**
 * Fixed tool: active team members by department.
 * @param {string} department
 */
const getActiveTeamMembersByDepartment = async (department) => {
  const q = String(department || '').trim();
  if (!q) return { data: [], collection: 'teammembers' };

  const docs = await TeamMember.find({
    isActive: true,
    department: { $regex: new RegExp(escapeRegex(q), 'i') },
  })
    .select(PUBLIC_TEAM_FIELDS.join(' '))
    .sort({ order: 1 })
    .lean();

  const data = docs.map(sanitizeTeamMember).filter(Boolean);
  assertNoPrivateTeamFields(data);
  return { data, collection: 'teammembers' };
};

/**
 * Fixed tool: active public team member by name (fuzzy contains).
 * @param {string} name
 */
const getPublicTeamMemberByName = async (name) => {
  const q = String(name || '').trim();
  if (!q) return { data: null, collection: 'teammembers' };

  const docs = await TeamMember.find({
    isActive: true,
    name: { $regex: new RegExp(escapeRegex(q), 'i') },
  })
    .select(PUBLIC_TEAM_FIELDS.join(' '))
    .sort({ order: 1 })
    .lean();

  const data = docs[0] ? sanitizeTeamMember(docs[0]) : null;
  if (data) assertNoPrivateTeamFields(data);
  return { data, collection: 'teammembers', matches: docs.map(sanitizeTeamMember) };
};

/**
 * Property consultants / agents list.
 */
const getActivePropertyConsultants = async () => {
  const docs = await TeamMember.find({
    isActive: true,
    $or: [
      { designation: { $regex: /property\s+consultant/i } },
      { department: { $regex: /property\s+consultant/i } },
      { isAgent: true, designation: { $regex: /consultant/i } },
    ],
  })
    .select(PUBLIC_TEAM_FIELDS.join(' '))
    .sort({ order: 1 })
    .lean();

  const data = docs.map(sanitizeTeamMember).filter(Boolean);
  assertNoPrivateTeamFields(data);
  return { data, collection: 'teammembers' };
};

/**
 * @param {string} s
 */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Infer team lookup from a user question.
 * @param {string} message
 * @returns {{ type: string, value?: string }}
 */
const extractTeamQuery = (message) => {
  const text = String(message || '').trim();

  if (/property\s+consultants?/i.test(text)) {
    return { type: 'property_consultants' };
  }

  const roleMatch = text.match(
    /\b(?:who\s+is\s+(?:the\s+)?|who\s+are\s+(?:the\s+)?)(ceo|general\s+manager|head\s+of\s+[\w\s&/-]+|managing\s+director)\b/i
  );
  if (roleMatch?.[1]) {
    return { type: 'designation', value: roleMatch[1].trim() };
  }

  const worksIn = text.match(/\b(?:who\s+works\s+in|team\s+in)\s+([a-z0-9\s&/-]+)\b/i);
  if (worksIn?.[1]) {
    return { type: 'department', value: worksIn[1].trim() };
  }

  const aboutPerson = text.match(
    /\b(?:tell\s+me\s+about|who\s+is)\s+(?!rocky\b)(?!the\s+(?:owner|founder|director)\b)([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)+)\b/i
  );
  if (aboutPerson?.[1]) {
    return { type: 'name', value: aboutPerson[1].trim() };
  }

  const headOf = text.match(/\bhead\s+of\s+([a-z0-9\s&/-]+)\b/i);
  if (headOf?.[1]) {
    return { type: 'designation', value: `Head of ${headOf[1].trim()}` };
  }

  return { type: 'unknown' };
};

/**
 * Resolve team data for a classified TEAM intent message.
 * @param {string} message
 */
const resolveTeamContext = async (message) => {
  const query = extractTeamQuery(message);

  if (query.type === 'property_consultants') {
    return getActivePropertyConsultants();
  }

  if (query.type === 'designation') {
    return getActiveTeamMembersByDesignation(query.value);
  }

  if (query.type === 'department') {
    return getActiveTeamMembersByDepartment(query.value);
  }

  if (query.type === 'name') {
    const result = await getPublicTeamMemberByName(query.value);
    return {
      data: result.matches?.length ? result.matches : result.data ? [result.data] : [],
      collection: 'teammembers',
    };
  }

  // Fallback: try designation keywords present in message
  if (/\bceo\b/i.test(message)) {
    return getActiveTeamMembersByDesignation('CEO');
  }
  if (/general\s+manager/i.test(message)) {
    return getActiveTeamMembersByDesignation('General Manager');
  }

  return { data: [], collection: 'teammembers' };
};

module.exports = {
  getActiveTeamMembersByDesignation,
  getActiveTeamMembersByDepartment,
  getPublicTeamMemberByName,
  getActivePropertyConsultants,
  resolveTeamContext,
  sanitizeTeamMember,
  extractTeamQuery,
  PUBLIC_TEAM_FIELDS,
  FORBIDDEN_TEAM_FIELDS,
};
