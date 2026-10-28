const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const RelocationGuide = require('../src/models/RelocationGuide');
const { ApplyError } = require('../src/services/teamtailorApplyValidation');
const {
  SUBJECT,
  buildRelocationGuideEmail,
  sendRelocationGuideEmail,
} = require('../src/services/relocationGuideEmailService');
const { syncRelocationEnquiry } = require('../src/services/relocationGuideTeamtailor');
const {
  submitRelocationGuide,
  toPublicSubmission,
  validateRelocationGuide,
} = require('../src/services/relocationGuideService');

const GUIDE_URL = 'https://cdn.example.com/guides/dubai-relocation.pdf';
const EMAIL_CONFIG = {
  apiKey: 'test-resend-key',
  fromEmail: 'relocation@rockyrealestate.com',
  fromName: 'Rocky Real Estate',
  guideUrl: GUIDE_URL,
  apiUrl: 'https://api.resend.com/emails',
};

function validBody(overrides = {}) {
  return {
    firstName: 'Amina',
    lastName: 'Rahman',
    email: ' Amina@Example.com ',
    phone: '+971501234567',
    location: 'United Kingdom',
    guideUrl: 'https://evil.example/phish.pdf',
    ...overrides,
  };
}

function httpResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => (body == null ? '' : JSON.stringify(body)),
  };
}

function createMemoryModel() {
  const docs = [];
  let seq = 0;

  function wrap(doc) {
    return new Proxy(doc, {
      get(target, prop) {
        if (prop === 'set') return (values) => Object.assign(target, values);
        if (prop === 'save') {
          return async () => {
            if (target.saveError) throw target.saveError;
            return wrap(target);
          };
        }
        return target[prop];
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    });
  }

  return {
    docs,
    async findOne(filter) {
      const found = docs.find((doc) => doc.email === filter.email);
      return found ? wrap(found) : null;
    },
    async create(data) {
      if (docs.some((doc) => doc.email === data.email)) {
        const error = new Error('E11000 duplicate key');
        error.code = 11000;
        throw error;
      }
      seq += 1;
      const doc = { ...data, _id: `guide-${seq}`, createdAt: new Date() };
      docs.push(doc);
      return wrap(doc);
    },
  };
}

function createHarness(responses, syncTeamtailor = syncRelocationEnquiry) {
  const model = createMemoryModel();
  const calls = [];
  const queue = responses.slice();
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('unexpected network');
  };

  const fetchImpl = async (url, options) => {
    calls.push({ url, options: { ...options, body: JSON.parse(options.body) } });
    const next = queue.shift();
    if (!next) throw new Error('no mock response');
    if (next instanceof Error) throw next;
    return next;
  };

  const uploads = [];
  const deleted = [];
  const file = {
    originalname: 'amina-rahman.pdf',
    mimetype: 'application/pdf',
    size: 1200,
    buffer: Buffer.from('pdf'),
  };

  return {
    model,
    calls,
    uploads,
    deleted,
    restore() {
      global.fetch = originalFetch;
    },
    submit(body, now, cvFile = file) {
      return submitRelocationGuide({
        body,
        file: cvFile,
        model,
        syncTeamtailor,
        now: now || (() => new Date()),
        uploadCv: async () => {
          const key = `cvs/test-${uploads.length + 1}.pdf`;
          uploads.push(key);
          return { key, fileName: 'stored.pdf' };
        },
        deleteCv: async (key) => {
          deleted.push(key);
        },
        sendEmail: (input) =>
          sendRelocationGuideEmail(input, {
            fetch: fetchImpl,
            config: EMAIL_CONFIG,
            sleep: async () => {},
          }),
      });
    },
  };
}

test('MongoDB schema stores the enquiry, statuses, and submission time', () => {
  const schema = RelocationGuide.schema;
  for (const field of ['fullName', 'firstName', 'lastName', 'email', 'phone', 'location']) {
    assert.equal(schema.path(field).isRequired, true);
  }
  assert.equal(schema.path('cv.key').isRequired, true);
  assert.equal(schema.path('cv.fileName').isRequired, true);
  assert.equal(schema.path('cvFileName').isRequired, true);
  assert.equal(schema.path('teamtailorJobId'), undefined);
  assert.equal(schema.options.timestamps, true);
  assert.ok(schema.path('createdAt'));
  assert.ok(schema.path('teamtailorRecordId'));
  assert.ok(schema.path('resendEmailId'));
  assert.deepEqual(schema.path('teamtailorStatus').enumValues, ['pending', 'skipped', 'synced', 'failed']);
  assert.deepEqual(schema.path('emailStatus').enumValues, ['pending', 'accepted', 'failed']);
  assert.ok(schema.indexes().some(([fields, options]) => fields.email === 1 && options.unique === true));
});

test('route is registered without changing the Teamtailor apply route', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/relocationGuideRoutes.js'), 'utf8');
  assert.match(routes, /uploadCV/);
  assert.match(source, /app\.use\('\/api\/relocation-guide', relocationGuideRoutes\)/);
  assert.match(source, /app\.use\('\/api\/teamtailor', teamtailorRoutes\)/);
});

test('location and country share one stored field', () => {
  assert.equal(validateRelocationGuide(validBody()).location, 'United Kingdom');
  assert.equal(
    validateRelocationGuide(validBody({ location: undefined, country: 'India' })).location,
    'India'
  );
  assert.throws(
    () => validateRelocationGuide(validBody({ location: 'India', country: 'France' })),
    (error) => error.code === 'conflicting_location'
  );
});

test('missing fields and an invalid email are rejected before MongoDB or email', async () => {
  const harness = createHarness([]);
  try {
    await assert.rejects(() => harness.submit({ email: 'amina@example.com' }), (error) => error.code === 'missing_first_name');
    await assert.rejects(
      () => harness.submit(validBody({ email: 'not-an-email' })),
      (error) => error.code === 'invalid_email'
    );
    await assert.rejects(
      () => harness.submit(validBody({ location: '', country: '' })),
      (error) => error.code === 'missing_location'
    );
    await assert.rejects(() => harness.submit(validBody(), undefined, null), (error) => error.code === 'missing_resume');
    assert.equal(harness.model.docs.length, 0);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.uploads.length, 0);
  } finally {
    harness.restore();
  }
});

test('valid submission saves the lead, skips Teamtailor, and emails the configured PDF', async () => {
  const harness = createHarness([httpResponse(200, { id: 'email_123' })]);
  try {
    const outcome = await harness.submit(validBody());
    const saved = harness.model.docs[0];

    assert.equal(outcome.created, true);
    assert.equal(saved.email, 'amina@example.com');
    assert.equal(saved.location, 'United Kingdom');
    assert.equal(saved.phone, '+971501234567');
    assert.ok(saved.createdAt instanceof Date);
    assert.equal(saved.teamtailorStatus, 'skipped');
    assert.equal(saved.teamtailorRecordId, undefined);
    assert.equal(saved.teamtailorError, null);
    assert.equal(saved.emailStatus, 'accepted');
    assert.equal(saved.resendEmailId, 'email_123');
    assert.equal(saved.guideUrl, undefined);
    assert.equal(saved.cv.key, 'cvs/test-1.pdf');
    assert.equal(saved.cv.fileName, 'amina-rahman.pdf');
    assert.equal(saved.cvType, 'application/pdf');
    assert.equal(toPublicSubmission(saved).cv, undefined);
    assert.deepEqual(syncRelocationEnquiry(), { status: 'skipped', recordId: null, error: null });

    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].url, 'https://api.resend.com/emails');
    assert.equal(harness.calls[0].options.headers['Idempotency-Key'], 'relocation-guide:guide-1');
    assert.equal(harness.calls[0].options.body.from, 'Rocky Real Estate <relocation@rockyrealestate.com>');
    assert.equal(harness.calls[0].options.body.subject, SUBJECT);
    assert.match(harness.calls[0].options.body.html, /Download Relocation Guide/);
    assert.match(harness.calls[0].options.body.html, /cdn\.example\.com/);
    assert.doesNotMatch(harness.calls[0].options.body.html, /evil\.example/);
    assert.match(harness.calls[0].options.body.text, /cdn\.example\.com/);
    assert.deepEqual(toPublicSubmission(saved), {
      id: 'guide-1',
      teamtailorStatus: 'skipped',
      emailStatus: 'accepted',
    });
  } finally {
    harness.restore();
  }
});

test('a Teamtailor failure is stored and does not block the guide email', async () => {
  const harness = createHarness([httpResponse(200, { id: 'email_456' })], async () => {
    throw new ApplyError('Teamtailor unavailable', {
      status: 502,
      code: 'teamtailor_rejected',
      logDetail: 'Teamtailor returned 502',
    });
  });
  try {
    const outcome = await harness.submit(validBody({ email: 'amina.fail@example.com' }));
    assert.equal(outcome.record.teamtailorStatus, 'failed');
    assert.equal(outcome.record.teamtailorError, 'Teamtailor returned 502');
    assert.equal(outcome.record.emailStatus, 'accepted');
    assert.equal(outcome.record.resendEmailId, 'email_456');
    assert.equal(harness.calls.length, 1);

    const retried = await harness.submit(validBody({ email: 'amina.fail@example.com' }));
    assert.equal(retried.created, false);
    assert.equal(retried.record.resendEmailId, 'email_456');
    assert.equal(harness.calls.length, 1);
  } finally {
    harness.restore();
  }
});

test('a failed email can be retried, and an accepted email is not sent again', async () => {
  const harness = createHarness([
    httpResponse(500, { message: 'mailbox unavailable' }),
    httpResponse(200, { id: 'email_retry' }),
    httpResponse(200, { id: 'email_should_not_send' }),
  ]);
  try {
    await assert.rejects(() => harness.submit(validBody()), (error) => {
      assert.equal(error.code, 'resend_rejected');
      assert.equal(error.publicData.teamtailorStatus, 'skipped');
      assert.equal(error.publicData.emailStatus, 'failed');
      return true;
    });
    const retried = await harness.submit(validBody({ phone: '+971509998877' }));
    assert.equal(retried.record.emailStatus, 'accepted');
    assert.equal(retried.record.resendEmailId, 'email_retry');
    assert.equal(retried.record.phone, '+971509998877');

    const duplicate = await harness.submit(validBody());
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.record.resendEmailId, 'email_retry');
    assert.equal(harness.calls.length, 2);
    assert.equal(harness.model.docs.length, 1);
  } finally {
    harness.restore();
  }
});

test('a submission already being processed is rejected', async () => {
  const harness = createHarness([httpResponse(200, { id: 'email_should_not_send' })]);
  const now = new Date();
  harness.model.docs.push({
    _id: 'guide-existing',
    email: 'amina@example.com',
    emailStatus: 'pending',
    teamtailorStatus: 'pending',
    processingStartedAt: now,
  });

  try {
    await assert.rejects(() => harness.submit(validBody(), () => now), (error) => error.code === 'in_progress');
    assert.equal(harness.calls.length, 0);
  } finally {
    harness.restore();
  }
});

test('honeypot submissions are rejected', async () => {
  const harness = createHarness([]);
  try {
    await assert.rejects(
      () => harness.submit(validBody({ company_website: 'https://spam.example' })),
      (error) => error instanceof ApplyError && error.code === 'spam'
    );
    assert.equal(harness.model.docs.length, 0);
  } finally {
    harness.restore();
  }
});

test('email content escapes the name and keeps the plain-text alternative', () => {
  const content = buildRelocationGuideEmail({
    firstName: 'Amina <script>',
    guideUrl: GUIDE_URL,
  });
  assert.equal(content.subject, 'Your Free Dubai Relocation Guide | Rocky Real Estate');
  assert.match(content.html, /Dear Amina &lt;script&gt;,/);
  assert.match(content.html, /Your Free Rocky Real Estate Relocation Guide/);
  assert.match(content.html, /alt="Rocky Real Estate"/);
  assert.match(content.html, /alt="Dubai relocation guide"/);
  assert.match(content.html, /width="240"/);
  assert.match(content.html, /width="600"/);
  assert.match(content.html, /Download Relocation Guide/);
  assert.doesNotMatch(content.html, /Best regards/);
  assert.doesNotMatch(content.html, /If the button does not open/);
  assert.equal((content.html.match(/cdn\.example\.com/g) || []).length, 1);
  assert.match(content.text, /Dear Amina <script>,/);
  assert.match(content.text, new RegExp(GUIDE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const withoutImages = buildRelocationGuideEmail({
    firstName: 'Amina',
    guideUrl: GUIDE_URL,
    logoUrl: 'http://insecure.example/logo.png',
    brochureUrl: 'not-a-url',
  });
  assert.doesNotMatch(withoutImages.html, /alt="Rocky Real Estate"/);
  assert.doesNotMatch(withoutImages.html, /alt="Dubai relocation guide"/);
  assert.match(withoutImages.html, /alt="Facebook"/);
  assert.match(withoutImages.html, /href="https:\/\/cdn\.example\.com\/guides\/dubai-relocation\.pdf"/);
});

test('missing guide URL or Resend credentials fail before a request is sent', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return httpResponse(200, { id: 'email_should_not_send' });
  };

  await assert.rejects(
    () =>
      sendRelocationGuideEmail(
        { to: 'amina@example.com', firstName: 'Amina', idempotencyKey: 'relocation-guide:1' },
        { fetch: fetchImpl, config: { ...EMAIL_CONFIG, guideUrl: '' } }
      ),
    (error) => error.code === 'guide_url_missing'
  );
  await assert.rejects(
    () =>
      sendRelocationGuideEmail(
        { to: 'amina@example.com', firstName: 'Amina', idempotencyKey: 'relocation-guide:1' },
        { fetch: fetchImpl, config: { ...EMAIL_CONFIG, apiKey: '' } }
      ),
    (error) => error.code === 'resend_auth'
  );
  assert.equal(calls.length, 0);
});
