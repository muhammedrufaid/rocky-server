const { ApplyError } = require('./teamtailorApplyValidation');
const { createTeamtailorGateway } = require('./teamtailorApplyClient');
const { getSignedUrl } = require('./s3Service');

const RESUME_URL_TTL_SECONDS = 600;

/**
 * Creates a Teamtailor candidate for a relocation-guide request and attaches the CV.
 * Candidate records have no location field, so the country is stored in the pitch.
 * This does not create a job application.
 */
async function syncRelocationEnquiry(record, deps = {}) {
  if (!record?.email || !record?.cv?.key) {
    throw new ApplyError("We couldn't submit your application. Please try again.", {
      status: 502,
      code: 'teamtailor_rejected',
      logDetail: 'Relocation record is missing the candidate email or CV',
    });
  }

  const gateway = deps.gateway || createTeamtailorGateway();
  const resumeUrl = deps.createResumeUrl
    ? await deps.createResumeUrl(record.cv.key)
    : (await getSignedUrl(record.cv.key, { expiresIn: RESUME_URL_TTL_SECONDS })).url;

  let candidate = record.teamtailorRecordId
    ? { id: String(record.teamtailorRecordId), existed: true, hasResume: true }
    : await gateway.findCandidateByEmail(record.email);

  if (!candidate) {
    candidate = await gateway.createCandidate({
      firstName: record.firstName,
      lastName: record.lastName,
      email: record.email,
      phone: record.phone,
      resumeUrl,
      pitch: record.location ? `Relocation guide request. Location: ${record.location}` : undefined,
    });
  } else if (!candidate.hasResume) {
    await gateway.attachResume(candidate.id, resumeUrl);
  }

  const upload = await gateway.createUpload({
    url: resumeUrl,
    fileName: record.cvFileName || record.cv.fileName,
    candidateId: candidate.id,
  });
  if (!upload?.id) {
    throw new ApplyError("We couldn't attach your CV. Please try again.", {
      status: 502,
      code: 'resume_unconfirmed',
      retryable: true,
    });
  }

  return { status: 'synced', recordId: String(candidate.id), error: null };
}

module.exports = {
  syncRelocationEnquiry,
};
