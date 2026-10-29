function buildCandidateCreateBody({ firstName, lastName, email, phone, resumeUrl, pitch }) {
  return {
    data: {
      type: 'candidates',
      attributes: {
        'first-name': firstName,
        'last-name': lastName,
        email,
        phone,
        resume: resumeUrl,
        ...(pitch ? { pitch } : {}),
        'send-welcome-message': false,
      },
    },
  };
}

function buildResumePatchBody(candidateId, resumeUrl) {
  return {
    data: {
      id: String(candidateId),
      type: 'candidates',
      attributes: {
        resume: resumeUrl,
      },
    },
  };
}

function buildUploadBody({ url, fileName, candidateId }) {
  return {
    data: {
      type: 'uploads',
      attributes: {
        url,
        'file-name': fileName,
      },
      relationships: {
        candidate: {
          data: {
            id: String(candidateId),
            type: 'candidates',
          },
        },
      },
    },
  };
}

function buildJobApplicationBody({ candidateId, jobId }) {
  return {
    data: {
      type: 'job-applications',
      attributes: {
        sourced: false,
        'send-user-notifications': false,
        'send-default-reply': false,
      },
      relationships: {
        candidate: {
          data: {
            id: String(candidateId),
            type: 'candidates',
          },
        },
        job: {
          data: {
            id: String(jobId),
            type: 'jobs',
          },
        },
      },
    },
  };
}

function jobIdFromApplication(resource) {
  const id = resource?.relationships?.job?.data?.id;
  return id == null ? null : String(id);
}

function findJobApplicationId(payload, jobId) {
  const rows = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];
  const match = rows.find((row) => jobIdFromApplication(row) === String(jobId) && row.id != null);
  return match ? String(match.id) : null;
}

function candidateHasResume(resource) {
  const attributes = resource?.attributes || {};
  return Boolean(attributes.resume || attributes['original-resume']);
}

module.exports = {
  buildCandidateCreateBody,
  buildResumePatchBody,
  buildUploadBody,
  buildJobApplicationBody,
  findJobApplicationId,
  candidateHasResume,
};
