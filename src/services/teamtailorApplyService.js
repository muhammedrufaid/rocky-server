const TeamTailorJob = require('../models/TeamTailorJob');
const TeamTailorApplication = require('../models/TeamTailorApplication');
const { uploadFile, deleteFile, getSignedUrl } = require('./s3Service');
const { ApplyError, validateApplicant, isEligibleJob, redactForLog } = require('./teamtailorApplyValidation');
const { synchronizeApplication } = require('./teamtailorApplySync');
const { createTeamtailorGateway } = require('./teamtailorApplyClient');

const STALE_PROCESSING_MS = 2 * 60 * 1000;
const RESUME_URL_TTL_SECONDS = (() => {
  const parsed = Number(process.env.TEAMTAILOR_RESUME_URL_TTL_SECONDS);
  if (!Number.isFinite(parsed) || parsed < 60) return 600;
  return Math.min(parsed, 900);
})();

async function safeDelete(key) {
  if (!key) return;
  try {
    await deleteFile(key);
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: 'teamtailor-apply',
        event: 'cv_delete_failed',
        detail: redactForLog(error.message),
      })
    );
  }
}

async function claimApplication(input) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
  const filter = { email: input.email, teamtailorJobId: input.teamtailorJobId };
  let existing = await TeamTailorApplication.findOne(filter);

  if (!existing) {
    try {
      const created = await TeamTailorApplication.create({
        ...input,
        syncStatus: 'processing',
        processingStartedAt: now,
      });
      return { application: created, discardKey: null };
    } catch (error) {
      if (error.code !== 11000) throw error;
      existing = await TeamTailorApplication.findOne(filter);
      if (!existing) throw error;
    }
  }

  if (existing.syncStatus === 'synced') {
    throw new ApplyError('An application for this job has already been submitted.', {
      status: 409,
      code: 'duplicate',
    });
  }

  const hasRemoteIds = Boolean(existing.teamtailorApplicationId && existing.teamtailorUploadId);
  const freshProcessing =
    existing.syncStatus === 'processing' &&
    existing.processingStartedAt &&
    existing.processingStartedAt > staleBefore;

  if (freshProcessing && !hasRemoteIds) {
    throw new ApplyError('An application for this job is already being submitted.', {
      status: 409,
      code: 'in_progress',
    });
  }

  if (hasRemoteIds) {
    existing.syncStatus = 'processing';
    existing.processingStartedAt = now;
    existing.syncError = null;
    await existing.save();
    return { application: existing, discardKey: input.resumeStorageKey };
  }

  const previousKey = existing.resumeStorageKey;
  existing.set({
    fullName: input.fullName,
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone,
    jobTitle: input.jobTitle,
    resumeStorageKey: input.resumeStorageKey,
    resumeOriginalName: input.resumeOriginalName,
    resumeMimeType: input.resumeMimeType,
    syncStatus: 'processing',
    processingStartedAt: now,
    syncError: null,
  });
  await existing.save();

  return {
    application: existing,
    discardKey: previousKey && previousKey !== input.resumeStorageKey ? previousKey : null,
  };
}

function createLiveGateway() {
  const teamtailor = createTeamtailorGateway();
  return {
    ...teamtailor,
    async createResumeUrl(storageKey) {
      const signed = await getSignedUrl(storageKey, { expiresIn: RESUME_URL_TTL_SECONDS });
      return signed.url;
    },
    async save(record) {
      await record.save();
    },
  };
}

function markFailed(application, error) {
  if (!application || application.syncStatus === 'synced') return Promise.resolve();
  application.syncStatus = 'failed';
  application.syncError = redactForLog(error.logDetail || error.code || 'sync_failed');
  application.processingStartedAt = undefined;
  return application.save().catch(() => {});
}

async function submitTeamtailorApplication({ body, file }) {
  if (body && String(body.company_website || '').trim()) {
    throw new ApplyError('Invalid submission.', { status: 400, code: 'spam' });
  }

  const applicant = validateApplicant(body);
  if (!file) {
    throw new ApplyError("Please upload your CV file using form-data key 'cv'", {
      status: 400,
      code: 'missing_resume',
    });
  }

  const job = await TeamTailorJob.findOne({ teamtailorId: applicant.teamtailorJobId });

  if (!job) {
    throw new ApplyError('Job not found.', { status: 404, code: 'job_not_found' });
  }
  if (!isEligibleJob(job)) {
    throw new ApplyError('This job is not accepting applications.', {
      status: 422,
      code: 'job_closed',
    });
  }

  let uploaded;
  try {
    uploaded = await uploadFile(file, 'cvs');
  } catch (error) {
    throw new ApplyError("We couldn't store your CV. Please try again.", {
      status: 500,
      code: 'cv_storage_failed',
      logDetail: redactForLog(error.message),
    });
  }

  let adopted = false;
  try {
    const { application, discardKey } = await claimApplication({
      ...applicant,
      jobTitle: job.title,
      resumeStorageKey: uploaded.key,
      resumeOriginalName: file.originalname,
      resumeMimeType: file.mimetype,
      source: 'Rocky Website',
    });
    adopted = true;
    if (discardKey) await safeDelete(discardKey);

    try {
      await synchronizeApplication(application, createLiveGateway());
    } catch (error) {
      await markFailed(application, error);
      throw error;
    }

    return application;
  } catch (error) {
    if (!adopted) await safeDelete(uploaded.key);
    throw error;
  }
}

function toPublicApplication(application) {
  return {
    applicationId: String(application._id),
    teamtailorJobId: application.teamtailorJobId,
    status: 'submitted',
  };
}

module.exports = {
  submitTeamtailorApplication,
  toPublicApplication,
  claimApplication,
};
