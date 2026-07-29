require('dotenv').config();
const TeamTailorJob = require('../models/TeamTailorJob');

const DEFAULT_BASE_URL = 'https://api.teamtailor.com/v1';
const DEFAULT_API_VERSION = '20240404';

const normalizeApiToken = (rawToken) => {
  if (!rawToken) return '';

  // Allow either raw token or full "Token token=..." value in .env
  return String(rawToken)
    .trim()
    .replace(/^Token\s+token=/i, '')
    .trim();
};

const getConfig = () => {
  const apiToken = normalizeApiToken(process.env.TEAMTAILOR_API_TOKEN);
  const baseUrl = (process.env.TEAMTAILOR_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const apiVersion = process.env.TEAMTAILOR_API_VERSION || DEFAULT_API_VERSION;

  if (!apiToken) {
    throw new Error('TEAMTAILOR_API_TOKEN is not configured in .env');
  }

  return { apiToken, baseUrl, apiVersion };
};

const getHeaders = () => {
  const { apiToken, apiVersion } = getConfig();

  return {
    Authorization: `Token token=${apiToken}`,
    'X-Api-Version': apiVersion,
    Accept: 'application/vnd.api+json',
  };
};

/**
 * Maps a TeamTailor JSON:API job resource into a flat document for MongoDB.
 */
const transformJob = (job) => {
  if (!job) return null;

  const attributes = job.attributes || {};
  const links = job.links || {};
  const picture = attributes.picture || {};

  return {
    teamtailorId: String(job.id),
    title: attributes.title || '',
    internalName: attributes['internal-name'] || null,
    body: attributes.body || null,
    pitch: attributes.pitch || null,
    status: attributes.status || null,
    humanStatus: attributes['human-status'] || null,
    internal: Boolean(attributes.internal),
    pinned: Boolean(attributes.pinned),
    picture: {
      original: picture.original || null,
      standard: picture.standard || null,
      thumb: picture.thumb || null,
    },
    tags: Array.isArray(attributes.tags) ? attributes.tags : [],
    remoteStatus: attributes['remote-status'] || null,
    languageCode: attributes['language-code'] || null,
    startDate: attributes['start-date'] ? new Date(attributes['start-date']) : null,
    endDate: attributes['end-date'] ? new Date(attributes['end-date']) : null,
    applyButtonText: attributes['apply-button-text'] || null,
    externalApplicationUrl: attributes['external-application-url'] || null,
    careersiteJobUrl: links['careersite-job-url'] || null,
    careersiteJobApplyUrl: links['careersite-job-apply-url'] || null,
    careersiteJobApplyIframeUrl: links['careersite-job-apply-iframe-url'] || null,
    nameRequirement: attributes['name-requirement'] || null,
    resumeRequirement: attributes['resume-requirement'] || null,
    additionalFilesRequirement: attributes['additional-files-requirement'] || null,
    coverLetterRequirement: attributes['cover-letter-requirement'] || null,
    phoneRequirement: attributes['phone-requirement'] || null,
    candidateLocationRequirement: attributes['candidate-location-requirement'] || null,
    recruiterEmail: attributes['recruiter-email'] || null,
    mailbox: attributes.mailbox || null,
    currency: attributes.currency || null,
    templateName: attributes['template-name'] || null,
    sharingImageLayout: attributes['sharing-image-layout'] || null,
    teamtailorCreatedAt: attributes['created-at'] ? new Date(attributes['created-at']) : null,
    teamtailorUpdatedAt: attributes['updated-at'] ? new Date(attributes['updated-at']) : null,
  };
};

/**
 * Fetches jobs from TeamTailor API (GET /v1/jobs).
 * Follows pagination links when present.
 */
const fetchJobsFromApi = async () => {
  const { baseUrl } = getConfig();
  const headers = getHeaders();
  const jobs = [];
  let nextUrl = `${baseUrl}/jobs`;

  while (nextUrl) {
    const response = await fetch(nextUrl, { headers });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `Failed to fetch TeamTailor jobs: ${response.status} ${response.statusText}${
          errorBody ? ` - ${errorBody}` : ''
        }`
      );
    }

    const payload = await response.json();
    const pageJobs = Array.isArray(payload.data) ? payload.data : [];
    jobs.push(...pageJobs);

    nextUrl = payload.links?.next || null;
  }

  return jobs.map(transformJob).filter(Boolean);
};

/**
 * Fetches a single job from TeamTailor API (GET /v1/jobs/:id).
 */
const fetchJobByIdFromApi = async (id) => {
  const { baseUrl } = getConfig();
  const headers = getHeaders();
  const response = await fetch(`${baseUrl}/jobs/${id}`, { headers });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `Failed to fetch TeamTailor job ${id}: ${response.status} ${response.statusText}${
        errorBody ? ` - ${errorBody}` : ''
      }`
    );
  }

  const payload = await response.json();
  return transformJob(payload.data);
};

/**
 * Remove MongoDB jobs that are no longer present in the TeamTailor API.
 * Only runs when the API returned at least one job (avoids wiping DB on empty/error responses).
 */
const removeStaleJobs = async (feedIds) => {
  if (!feedIds.length) {
    return { deleted: 0, staleIds: [] };
  }

  const staleDocs = await TeamTailorJob.find(
    { teamtailorId: { $nin: feedIds } },
    { teamtailorId: 1 }
  ).lean();

  if (!staleDocs.length) {
    return { deleted: 0, staleIds: [] };
  }

  const staleIds = staleDocs.map((doc) => doc.teamtailorId);
  const deleteResult = await TeamTailorJob.deleteMany({
    teamtailorId: { $in: staleIds },
  });

  return {
    deleted: deleteResult.deletedCount || 0,
    staleIds,
  };
};

/**
 * Full sync: upsert jobs from TeamTailor, then delete any MongoDB jobs missing from the API.
 * - Added jobs → inserted
 * - Updated jobs → modified
 * - Removed jobs → deleted
 */
const syncJobsToDb = async () => {
  const jobs = await fetchJobsFromApi();
  const feedIds = jobs.map((job) => job.teamtailorId).filter(Boolean);

  if (!jobs.length) {
    return {
      count: 0,
      upserted: 0,
      modified: 0,
      deleted: 0,
      staleIds: [],
    };
  }

  const ops = jobs.map((job) => ({
    updateOne: {
      filter: { teamtailorId: job.teamtailorId },
      update: { $set: job },
      upsert: true,
    },
  }));

  const result = await TeamTailorJob.bulkWrite(ops, { ordered: false });
  const { deleted, staleIds } = await removeStaleJobs(feedIds);

  return {
    count: jobs.length,
    upserted: result.upsertedCount || 0,
    modified: result.modifiedCount || 0,
    deleted,
    staleIds,
  };
};

module.exports = {
  transformJob,
  fetchJobsFromApi,
  fetchJobByIdFromApi,
  syncJobsToDb,
};
