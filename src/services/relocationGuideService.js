const RelocationGuide = require('../models/RelocationGuide');
const { uploadFile, deleteFile } = require('./s3Service');
const { sendRelocationGuideEmail } = require('./relocationGuideEmailService');
const { syncRelocationEnquiry } = require('./relocationGuideTeamtailor');
const {
  ApplyError,
  normalizePersonName,
  normalizeEmail,
  isValidEmail,
  isValidPhone,
  redactForLog,
} = require('./teamtailorApplyValidation');

const STALE_PROCESSING_MS = 2 * 60 * 1000;

function normalizeLocation(value) {
  const location = String(value || '').trim().replace(/\s+/g, ' ');
  if (!location) {
    throw new ApplyError('Location is required.', { status: 400, code: 'missing_location' });
  }
  if (location.length > 80) {
    throw new ApplyError('Location is too long.', { status: 400, code: 'invalid_location' });
  }
  if (!/^[\p{L}\p{M}0-9 .,'’()-]+$/u.test(location)) {
    throw new ApplyError('Please enter a valid location or country.', {
      status: 400,
      code: 'invalid_location',
    });
  }
  return location;
}

function readLocation(body) {
  const location = body.location == null ? '' : String(body.location);
  const country = body.country == null ? '' : String(body.country);
  const hasLocation = location.trim() !== '';
  const hasCountry = country.trim() !== '';

  if (hasLocation && hasCountry && location.trim().toLowerCase() !== country.trim().toLowerCase()) {
    throw new ApplyError('Please provide one location.', {
      status: 400,
      code: 'conflicting_location',
    });
  }

  return normalizeLocation(hasLocation ? location : country);
}

function validateRelocationGuide(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApplyError('Please provide firstName, lastName, email, phone and location.', {
      status: 400,
      code: 'invalid_body',
    });
  }

  const firstName = normalizePersonName(body.firstName, 'First name', 'missing_first_name');
  const lastName = normalizePersonName(body.lastName, 'Last name', 'missing_last_name');
  const email = normalizeEmail(body.email);
  const phone = String(body.phone || '').trim();
  const location = readLocation(body);

  if (!email) {
    throw new ApplyError('Email is required.', { status: 400, code: 'missing_email' });
  }
  if (!isValidEmail(email)) {
    throw new ApplyError('Please enter a valid email address.', {
      status: 400,
      code: 'invalid_email',
    });
  }

  if (!phone) {
    throw new ApplyError('Phone number is required.', { status: 400, code: 'missing_phone' });
  }
  if (!isValidPhone(phone)) {
    throw new ApplyError('Please enter a valid phone number, including the country code.', {
      status: 400,
      code: 'invalid_phone',
    });
  }

  if (body.privacyAccepted != null && String(body.privacyAccepted) !== 'true') {
    throw new ApplyError('Please accept the privacy notice before continuing.', {
      status: 400,
      code: 'consent_required',
    });
  }

  return {
    fullName: `${firstName} ${lastName}`,
    firstName,
    lastName,
    email,
    phone,
    location,
  };
}

function toPublicSubmission(record) {
  return {
    id: String(record._id),
    teamtailorStatus: record.teamtailorStatus,
    emailStatus: record.emailStatus,
  };
}

function teamtailorFinished(status) {
  return status === 'skipped' || status === 'synced';
}

function cvRecord(file, uploaded) {
  return {
    cv: {
      key: uploaded.key,
      fileName: file.originalname,
    },
    cvFileName: file.originalname,
    cvType: file.mimetype,
    cvSize: file.size,
  };
}

async function safeDeleteCv(key) {
  if (!key) return;
  try {
    await deleteFile(key);
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: 'relocation-guide',
        event: 'cv_delete_failed',
        detail: redactForLog(error.message),
      })
    );
  }
}

async function claimSubmission(model, input, now) {
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
  const filter = { email: input.email };
  let existing = await model.findOne(filter);

  if (!existing) {
    try {
      const created = await model.create({
        ...input,
        teamtailorStatus: 'pending',
        teamtailorError: null,
        emailStatus: 'pending',
        processingStartedAt: now,
      });
      return { record: created, created: true, sendEmail: true, syncTeamtailor: true };
    } catch (error) {
      if (error.code !== 11000) throw error;
      existing = await model.findOne(filter);
      if (!existing) throw error;
    }
  }

  const emailDone = existing.emailStatus === 'accepted';
  const syncDone = teamtailorFinished(existing.teamtailorStatus);
  if (emailDone && syncDone) {
    return { record: existing, created: false, alreadyComplete: true };
  }

  const freshProcessing =
    existing.processingStartedAt &&
    existing.processingStartedAt > staleBefore &&
    existing.emailStatus !== 'failed' &&
    existing.teamtailorStatus !== 'failed';

  if (freshProcessing) {
    throw new ApplyError('A relocation guide request is already being submitted.', {
      status: 409,
      code: 'in_progress',
    });
  }

  const previousKey = existing.cv?.key;
  existing.set({
    fullName: input.fullName,
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone,
    location: input.location,
    cv: input.cv,
    cvFileName: input.cvFileName,
    cvType: input.cvType,
    cvSize: input.cvSize,
    processingStartedAt: now,
  });
  if (!emailDone) {
    existing.emailStatus = 'pending';
    existing.emailError = null;
  }
  if (!syncDone) {
    existing.teamtailorStatus = 'pending';
    existing.teamtailorError = null;
  }
  await existing.save();

  return {
    record: existing,
    created: false,
    sendEmail: !emailDone,
    syncTeamtailor: !syncDone,
    discardKey: previousKey && previousKey !== input.cv?.key ? previousKey : null,
  };
}

async function applyTeamtailorSync(record, syncTeamtailor) {
  try {
    const result = await syncTeamtailor(record);
    record.teamtailorStatus = result?.status || 'failed';
    record.teamtailorRecordId = result?.recordId || undefined;
    record.teamtailorError = result?.error || null;
    if (!['pending', 'skipped', 'synced', 'failed'].includes(record.teamtailorStatus)) {
      record.teamtailorStatus = 'failed';
      record.teamtailorError = 'teamtailor_unconfirmed';
    }
  } catch (error) {
    record.teamtailorStatus = 'failed';
    record.teamtailorError = redactForLog(error.logDetail || error.code || error.message || 'teamtailor_failed');
    console.error(
      JSON.stringify({
        scope: 'relocation-guide',
        event: 'teamtailor_failed',
        id: String(record._id),
        code: error.code || 'teamtailor_failed',
      })
    );
  }

  if (record.teamtailorStatus === 'skipped') {
    console.log(
      JSON.stringify({
        scope: 'relocation-guide',
        event: 'teamtailor_skipped',
        reason: 'recruitment_only',
        id: String(record._id),
      })
    );
  }

  await record.save().catch(() => {});
}

async function submitRelocationGuide({
  body,
  file,
  model = RelocationGuide,
  sendEmail = sendRelocationGuideEmail,
  syncTeamtailor = syncRelocationEnquiry,
  uploadCv = (cvFile) => uploadFile(cvFile, 'cvs'),
  deleteCv = safeDeleteCv,
  now = () => new Date(),
} = {}) {
  if (body && String(body.company_website || '').trim()) {
    throw new ApplyError('Invalid submission.', { status: 400, code: 'spam' });
  }

  const input = validateRelocationGuide(body);
  if (!file) {
    throw new ApplyError("Please upload your CV file using form-data key 'cv'", {
      status: 400,
      code: 'missing_resume',
    });
  }

  let uploaded;
  try {
    uploaded = await uploadCv(file);
  } catch (error) {
    throw new ApplyError("We couldn't store your CV. Please try again.", {
      status: 500,
      code: 'cv_storage_failed',
      logDetail: redactForLog(error.message),
    });
  }

  let adopted = false;
  try {
    const claimed = await claimSubmission(model, { ...input, ...cvRecord(file, uploaded) }, now());
    adopted = true;
    const record = claimed.record;

    if (claimed.alreadyComplete) {
      if (record.cv?.key !== uploaded.key) await deleteCv(uploaded.key);
      return { record, created: false };
    }

    if (claimed.discardKey) await deleteCv(claimed.discardKey);

    if (claimed.syncTeamtailor) {
      await applyTeamtailorSync(record, syncTeamtailor);
    }

    if (!claimed.sendEmail) {
      record.processingStartedAt = null;
      await record.save().catch(() => {});
      return { record, created: false };
    }

    try {
      const sent = await sendEmail({
        to: record.email,
        firstName: record.firstName,
        idempotencyKey: `relocation-guide:${record._id}`,
      });
      record.emailStatus = 'accepted';
      record.resendEmailId = sent.id;
      record.emailError = null;
      record.processingStartedAt = null;
      try {
        await record.save();
      } catch (error) {
        await record.save();
      }
      return { record, created: claimed.created };
    } catch (error) {
      if (record.emailStatus === 'accepted' && record.resendEmailId) {
        throw new ApplyError('Please retry your relocation guide request.', {
          status: 503,
          code: 'email_persist',
          retryable: true,
          logDetail: redactForLog(error.message),
          publicData: toPublicSubmission(record),
        });
      }

      record.emailStatus = 'failed';
      record.emailError = redactForLog(error.logDetail || error.code || error.message || 'email_failed');
      record.processingStartedAt = null;
      await record.save().catch(() => {});

      const failure = error instanceof ApplyError
        ? error
        : new ApplyError("We couldn't send your relocation guide. Please try again.", {
            status: 502,
            code: 'email_failed',
            retryable: true,
            logDetail: redactForLog(error.message),
          });
      failure.publicData = toPublicSubmission(record);
      throw failure;
    }
  } catch (error) {
    if (!adopted) await deleteCv(uploaded.key);
    throw error;
  }
}

module.exports = {
  submitRelocationGuide,
  toPublicSubmission,
  validateRelocationGuide,
};
