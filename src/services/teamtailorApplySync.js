const { ApplyError } = require('./teamtailorApplyValidation');

/**
 * Teamtailor and MongoDB cannot share one transaction.
 * IDs are saved as soon as Teamtailor returns them. A later retry sees those
 * IDs and does not create another candidate, upload, or job application.
 */
async function synchronizeApplication(record, gateway) {
  record.syncStatus = 'processing';
  record.syncError = null;
  await gateway.save(record);

  const resumeUrl = await gateway.createResumeUrl(record.resumeStorageKey);

  let candidate = null;
  if (record.teamtailorCandidateId) {
    candidate = {
      id: String(record.teamtailorCandidateId),
      existed: true,
      hasResume: true,
    };
  } else {
    candidate = await gateway.findCandidateByEmail(record.email);
  }

  if (!candidate) {
    candidate = await gateway.createCandidate({
      firstName: record.firstName,
      lastName: record.lastName,
      email: record.email,
      phone: record.phone,
      resumeUrl,
    });
    candidate.existed = false;
  }

  record.teamtailorCandidateId = String(candidate.id);
  await gateway.save(record);

  if (candidate.existed && !candidate.hasResume) {
    await gateway.attachResume(record.teamtailorCandidateId, resumeUrl);
  }

  if (!record.teamtailorUploadId) {
    const upload = await gateway.createUpload({
      url: resumeUrl,
      fileName: record.resumeOriginalName,
      candidateId: record.teamtailorCandidateId,
    });
    if (!upload?.id) {
      throw new ApplyError("We couldn't attach your CV. Please try again.", {
        status: 502,
        code: 'resume_unconfirmed',
        retryable: true,
      });
    }
    record.teamtailorUploadId = String(upload.id);
    await gateway.save(record);
  }

  if (!record.teamtailorApplicationId) {
    const existingId = await gateway.findJobApplicationId(
      record.teamtailorCandidateId,
      record.teamtailorJobId
    );
    const created = existingId
      ? { id: existingId }
      : await gateway.createJobApplication({
          candidateId: record.teamtailorCandidateId,
          jobId: record.teamtailorJobId,
        });
    const verified = await gateway.getJobApplication(created.id);
    if (!verified?.id) {
      throw new ApplyError("We couldn't confirm your application. Please try again.", {
        status: 502,
        code: 'application_unconfirmed',
        retryable: true,
      });
    }
    record.teamtailorApplicationId = String(verified.id);
    await gateway.save(record);
  } else {
    const verified = await gateway.getJobApplication(record.teamtailorApplicationId);
    if (!verified?.id) {
      throw new ApplyError("We couldn't confirm your application. Please try again.", {
        status: 502,
        code: 'application_unconfirmed',
        retryable: true,
      });
    }
  }

  record.syncStatus = 'synced';
  record.syncError = null;
  record.processingStartedAt = null;
  try {
    await gateway.save(record);
  } catch (error) {
    try {
      await gateway.save(record);
    } catch (retryError) {
      throw new ApplyError('Please retry your application.', {
        status: 503,
        code: 'sync_persist',
        retryable: true,
        logDetail: retryError.message,
      });
    }
  }

  return record;
}

module.exports = {
  synchronizeApplication,
};
