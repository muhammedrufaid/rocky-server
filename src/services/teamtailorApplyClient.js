const { ApplyError, redactForLog } = require('./teamtailorApplyValidation');
const {
  buildCandidateCreateBody,
  buildResumePatchBody,
  buildUploadBody,
  buildJobApplicationBody,
  findJobApplicationId,
  candidateHasResume,
} = require('./teamtailorApplyPayload');

const DEFAULT_BASE_URL = 'https://api.teamtailor.com/v1';
const DEFAULT_APPLY_API_VERSION = '20240904';
const REQUEST_TIMEOUT_MS = 20000;

function normalizeApiToken(rawToken) {
  if (!rawToken) return '';
  return String(rawToken)
    .trim()
    .replace(/^Token\s+token=/i, '')
    .trim();
}

function getApplyConfig() {
  const apiToken = normalizeApiToken(
    process.env.TEAMTAILOR_API_KEY || process.env.TEAMTAILOR_API_TOKEN
  );
  const baseUrl = (
    process.env.TEAMTAILOR_API_URL ||
    process.env.TEAMTAILOR_API_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/$/, '');
  const apiVersion = process.env.TEAMTAILOR_APPLY_API_VERSION || DEFAULT_APPLY_API_VERSION;

  if (!apiToken) {
    throw new ApplyError('Applications are temporarily unavailable. Please try again later.', {
      status: 503,
      code: 'teamtailor_auth',
      logDetail: 'Teamtailor API token is not configured',
    });
  }

  return { apiToken, baseUrl, apiVersion };
}

function safeErrorDetail(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const text = errors
    .map((error) => error?.title || error?.detail || '')
    .filter(Boolean)
    .join(' ');
  return redactForLog(text);
}

function isDuplicateApplication(status, detail) {
  return status === 422 && /already/i.test(detail);
}

async function requestTeamtailor(path, options, deps) {
  const config = deps.config || getApplyConfig();
  const fetchImpl = deps.fetch || fetch;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const url = `${config.baseUrl}${path}`;

  const send = async () => {
    const timeout = deps.timeoutMs || REQUEST_TIMEOUT_MS;
    const response = await fetchImpl(url, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Token token=${config.apiToken}`,
        'X-Api-Version': config.apiVersion,
        Accept: 'application/vnd.api+json',
        ...(options.body ? { 'Content-Type': 'application/vnd.api+json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        payload = null;
      }
    }
    return { response, payload };
  };

  let result;
  try {
    result = await send();
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new ApplyError("We couldn't submit your application. Please try again.", {
      status: 504,
      code: timedOut ? 'teamtailor_timeout' : 'teamtailor_network',
      retryable: true,
      logDetail: redactForLog(error.message),
    });
  }

  if (result.response.status === 429 && !options.retried) {
    const resetSeconds = Number(result.response.headers.get('x-rate-limit-reset'));
    const waitMs = Number.isFinite(resetSeconds) ? Math.min(Math.max(resetSeconds, 0), 5) * 1000 : 1000;
    await sleep(waitMs);
    return requestTeamtailor(path, { ...options, retried: true }, deps);
  }

  if (result.response.status === 401 || result.response.status === 403) {
    throw new ApplyError('Applications are temporarily unavailable. Please try again later.', {
      status: 503,
      code: 'teamtailor_auth',
      logDetail: `Teamtailor returned ${result.response.status}`,
    });
  }

  if (!result.response.ok) {
    const detail = safeErrorDetail(result.payload);
    const error = new ApplyError("We couldn't submit your application. Please try again.", {
      status: 502,
      code: 'teamtailor_rejected',
      retryable: result.response.status >= 500,
      logDetail: detail || `Teamtailor returned ${result.response.status}`,
    });
    error.upstreamStatus = result.response.status;
    error.upstreamDetail = detail;
    throw error;
  }

  return result.payload;
}

function createTeamtailorGateway(deps = {}) {
  const request = (path, options = {}) => requestTeamtailor(path, options, deps);

  return {
    async findCandidateByEmail(email) {
      const payload = await request(
        `/candidates?filter[email]=${encodeURIComponent(email)}&page[size]=1`
      );
      const candidate = Array.isArray(payload?.data) ? payload.data[0] : null;
      if (!candidate?.id) return null;
      return {
        id: String(candidate.id),
        existed: true,
        hasResume: candidateHasResume(candidate),
      };
    },

    async createCandidate(input) {
      try {
        const payload = await request('/candidates', {
          method: 'POST',
          body: buildCandidateCreateBody(input),
        });
        const id = payload?.data?.id;
        if (!id) {
          throw new ApplyError("We couldn't submit your application. Please try again.", {
            status: 502,
            code: 'candidate_unconfirmed',
            retryable: true,
          });
        }
        return { id: String(id), existed: false, hasResume: true };
      } catch (error) {
        if (error.upstreamStatus !== 422) throw error;
        const existing = await this.findCandidateByEmail(input.email);
        if (!existing) throw error;
        return existing;
      }
    },

    async attachResume(candidateId, resumeUrl) {
      await request(`/candidates/${encodeURIComponent(candidateId)}`, {
        method: 'PATCH',
        body: buildResumePatchBody(candidateId, resumeUrl),
      });
    },

    async createUpload(input) {
      const payload = await request('/uploads', {
        method: 'POST',
        body: buildUploadBody(input),
      });
      return { id: payload?.data?.id ? String(payload.data.id) : null };
    },

    async findJobApplicationId(candidateId, jobId) {
      const payload = await request(
        `/candidates/${encodeURIComponent(candidateId)}/job-applications?include=job&page[size]=30`
      );
      return findJobApplicationId(payload, jobId);
    },

    async createJobApplication(input) {
      try {
        const payload = await request('/job-applications', {
          method: 'POST',
          body: buildJobApplicationBody(input),
        });
        const id = payload?.data?.id;
        if (!id) {
          throw new ApplyError("We couldn't confirm your application. Please try again.", {
            status: 502,
            code: 'application_unconfirmed',
            retryable: true,
          });
        }
        return { id: String(id) };
      } catch (error) {
        if (!isDuplicateApplication(error.upstreamStatus, error.upstreamDetail || '')) throw error;
        const existingId = await this.findJobApplicationId(input.candidateId, input.jobId);
        if (!existingId) throw error;
        return { id: existingId };
      }
    },

    async getJobApplication(id) {
      const payload = await request(`/job-applications/${encodeURIComponent(id)}`);
      const applicationId = payload?.data?.id;
      return applicationId ? { id: String(applicationId) } : null;
    },
  };
}

module.exports = {
  getApplyConfig,
  requestTeamtailor,
  createTeamtailorGateway,
};
