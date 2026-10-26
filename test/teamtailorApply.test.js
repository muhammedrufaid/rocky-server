const test = require('node:test');
const assert = require('node:assert/strict');
const {
  splitFullName,
  validateApplicant,
  isEligibleJob,
  redactForLog,
  ApplyError,
} = require('../src/services/teamtailorApplyValidation');
const {
  buildCandidateCreateBody,
  buildJobApplicationBody,
  buildUploadBody,
  findJobApplicationId,
} = require('../src/services/teamtailorApplyPayload');
const { synchronizeApplication } = require('../src/services/teamtailorApplySync');
const { requestTeamtailor, createTeamtailorGateway } = require('../src/services/teamtailorApplyClient');

function httpResponse(status, body, headerValue = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => headerValue },
    text: async () => (body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const config = {
  apiToken: 'test-token',
  baseUrl: 'https://api.teamtailor.com/v1',
  apiVersion: '20240904',
};

test('splits multi-part names and rejects a single word', () => {
  assert.deepEqual(splitFullName('  Mary Ann Smith '), {
    fullName: 'Mary Ann Smith',
    firstName: 'Mary',
    lastName: 'Ann Smith',
  });
  assert.throws(() => splitFullName('Madonna'), (error) => error.code === 'invalid_name');
});

test('validates required applicant fields', () => {
  const valid = validateApplicant({
    fullName: 'Test Candidate',
    email: ' Test@Example.com ',
    phone: '+971501234567',
    teamtailorJobId: '8094033',
  });
  assert.equal(valid.email, 'test@example.com');
  assert.equal(valid.firstName, 'Test');
  assert.equal(valid.lastName, 'Candidate');

  assert.throws(
    () => validateApplicant({ email: 'test@example.com', phone: '+971501234567', teamtailorJobId: '1' }),
    (error) => error.code === 'missing_name'
  );
  assert.throws(
    () =>
      validateApplicant({
        fullName: 'Test Candidate',
        email: 'not-an-email',
        phone: '+971501234567',
        teamtailorJobId: '1',
      }),
    (error) => error.code === 'invalid_email'
  );
  assert.throws(
    () =>
      validateApplicant({
        fullName: 'Test Candidate',
        email: 'test@example.com',
        teamtailorJobId: '1',
      }),
    (error) => error.code === 'missing_phone'
  );
});

test('allows only open published external jobs', () => {
  assert.equal(
    isEligibleJob({ status: 'open', humanStatus: 'published', internal: false }),
    true
  );
  assert.equal(
    isEligibleJob({ status: 'archived', humanStatus: 'published', internal: false }),
    false
  );
  assert.equal(
    isEligibleJob({ status: 'open', humanStatus: 'draft', internal: false }),
    false
  );
  assert.equal(
    isEligibleJob({ status: 'open', humanStatus: 'published', internal: true }),
    false
  );
});

test('candidate and job-application payloads do not merge profiles or send emails', () => {
  const candidate = buildCandidateCreateBody({
    firstName: 'Test',
    lastName: 'Candidate',
    email: 'test@example.com',
    phone: '+971501234567',
    resumeUrl: 'https://files.example/cv.pdf',
  });
  assert.equal(candidate.data.attributes.merge, undefined);
  assert.equal(candidate.data.attributes['send-welcome-message'], false);
  assert.equal(candidate.data.attributes.resume, 'https://files.example/cv.pdf');

  const application = buildJobApplicationBody({ candidateId: '55', jobId: '8094033' });
  assert.equal(application.data.attributes['send-user-notifications'], false);
  assert.equal(application.data.attributes['send-default-reply'], false);
  assert.equal(application.data.attributes.sourced, false);
  assert.equal(application.data.relationships.job.data.id, '8094033');

  const upload = buildUploadBody({
    url: 'https://files.example/cv.pdf',
    fileName: 'cv.pdf',
    candidateId: '55',
  });
  assert.equal(upload.data.attributes.url, 'https://files.example/cv.pdf');
  assert.equal(upload.data.relationships.candidate.data.id, '55');
  assert.equal(upload.data.relationships.job, undefined);
});

test('matches an existing job application by job id', () => {
  const id = findJobApplicationId(
    {
      data: [
        { id: '9', relationships: { job: { data: { id: '111', type: 'jobs' } } } },
        { id: '10', relationships: { job: { data: { id: '8094033', type: 'jobs' } } } },
      ],
    },
    '8094033'
  );
  assert.equal(id, '10');
});

test('sync creates a candidate, confirms the CV upload, then the job application', async () => {
  const calls = [];
  const record = {
    email: 'test@example.com',
    phone: '+971501234567',
    firstName: 'Test',
    lastName: 'Candidate',
    teamtailorJobId: '8094033',
    resumeStorageKey: 'cvs/cv.pdf',
    resumeOriginalName: 'cv.pdf',
  };
  const gateway = {
    async save(saved) {
      calls.push(['save', saved.syncStatus, saved.teamtailorCandidateId, saved.teamtailorApplicationId]);
    },
    async createResumeUrl(key) {
      assert.equal(key, 'cvs/cv.pdf');
      return 'https://files.example/cv.pdf?sig=1';
    },
    async findCandidateByEmail() {
      calls.push(['find']);
      return null;
    },
    async createCandidate(input) {
      calls.push(['createCandidate', input.firstName, input.resumeUrl]);
      return { id: 'cand-1' };
    },
    async attachResume() {
      throw new Error('should not patch a new candidate');
    },
    async createUpload(input) {
      calls.push(['upload', input.candidateId]);
      return { id: 'upload-1' };
    },
    async findJobApplicationId() {
      return null;
    },
    async createJobApplication(input) {
      calls.push(['apply', input.candidateId, input.jobId]);
      return { id: 'app-1' };
    },
    async getJobApplication(id) {
      return { id };
    },
  };

  await synchronizeApplication(record, gateway);
  assert.equal(record.syncStatus, 'synced');
  assert.equal(record.teamtailorCandidateId, 'cand-1');
  assert.equal(record.teamtailorUploadId, 'upload-1');
  assert.equal(record.teamtailorApplicationId, 'app-1');
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['save', 'find', 'createCandidate', 'save', 'upload', 'save', 'apply', 'save', 'save']
  );
});

test('an existing candidate is not overwritten and an existing application is reused', async () => {
  const calls = [];
  const record = {
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'Candidate',
    phone: '+971501234567',
    teamtailorJobId: '8094033',
    resumeStorageKey: 'cvs/cv.pdf',
    resumeOriginalName: 'cv.pdf',
  };
  await synchronizeApplication(record, {
    async save() {},
    async createResumeUrl() {
      return 'https://files.example/cv.pdf';
    },
    async findCandidateByEmail() {
      return { id: 'cand-9', existed: true, hasResume: true };
    },
    async createCandidate() {
      calls.push('createCandidate');
    },
    async attachResume() {
      calls.push('attachResume');
    },
    async createUpload() {
      return { id: 'upload-9' };
    },
    async findJobApplicationId() {
      return 'app-9';
    },
    async createJobApplication() {
      calls.push('createJobApplication');
    },
    async getJobApplication(id) {
      return { id };
    },
  });

  assert.deepEqual(calls, []);
  assert.equal(record.teamtailorCandidateId, 'cand-9');
  assert.equal(record.teamtailorApplicationId, 'app-9');
});

test('a failed final save is retried once and does not create another application', async () => {
  let applications = 0;
  let syncedSaves = 0;
  const record = {
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'Candidate',
    phone: '+971501234567',
    teamtailorJobId: '8094033',
    resumeStorageKey: 'cvs/cv.pdf',
    resumeOriginalName: 'cv.pdf',
    teamtailorCandidateId: 'cand-1',
    teamtailorUploadId: 'upload-1',
    teamtailorApplicationId: 'app-1',
  };

  await synchronizeApplication(record, {
    async save(saved) {
      if (saved.syncStatus !== 'synced') return;
      syncedSaves += 1;
      if (syncedSaves === 1) throw new Error('mongo down');
    },
    async createResumeUrl() {
      return 'https://files.example/cv.pdf';
    },
    async createUpload() {
      throw new Error('upload should be skipped');
    },
    async findJobApplicationId() {
      throw new Error('lookup should be skipped');
    },
    async createJobApplication() {
      applications += 1;
    },
    async getJobApplication(id) {
      return { id };
    },
  });

  assert.equal(applications, 0);
  assert.equal(syncedSaves, 2);
  assert.equal(record.syncStatus, 'synced');
});

test('Teamtailor auth, timeout, and rate-limit responses stay safe', async () => {
  const auth = await assert.rejects(
    () =>
      requestTeamtailor('/candidates', { method: 'GET' }, {
        config,
        fetch: async () => httpResponse(403, ''),
      }),
    (error) => error instanceof ApplyError && error.code === 'teamtailor_auth'
  );
  assert.equal(auth, undefined);
  await assert.rejects(
    () =>
      requestTeamtailor('/candidates', { method: 'POST', body: { data: {} } }, {
        config,
        fetch: async () => {
          const error = new Error('The operation was aborted');
          error.name = 'TimeoutError';
          throw error;
        },
      }),
    (error) =>
      error.code === 'teamtailor_timeout' &&
      !error.message.includes('test-token') &&
      !error.message.includes('aborted')
  );

  let attempts = 0;
  const payload = await requestTeamtailor('/candidates', { method: 'GET' }, {
    config,
    sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) return httpResponse(429, '', '0');
      return httpResponse(200, { data: { id: '1', type: 'candidates' } });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(payload.data.id, '1');
});

test('a duplicate Teamtailor application is reused instead of created again', async () => {
  const gateway = createTeamtailorGateway({
    config,
    fetch: async (url, options = {}) => {
      if (options.method === 'POST') {
        return httpResponse(422, {
          errors: [{ title: 'Candidate has already applied to this job' }],
        });
      }
      return httpResponse(200, {
        data: [
          {
            id: '77',
            type: 'job-applications',
            relationships: { job: { data: { id: '8094033', type: 'jobs' } } },
          },
        ],
      });
    },
  });

  const result = await gateway.createJobApplication({ candidateId: '5', jobId: '8094033' });
  assert.equal(result.id, '77');
});

test('logs redact email addresses and phone numbers', () => {
  const text = redactForLog('failed for test@example.com phone +971501234567');
  assert.equal(text.includes('test@example.com'), false);
  assert.equal(text.includes('+971501234567'), false);
});
