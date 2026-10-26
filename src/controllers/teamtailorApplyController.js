const rateLimit = require('express-rate-limit');
const { ApplyError } = require('../services/teamtailorApplyValidation');
const {
  submitTeamtailorApplication,
  toPublicApplication,
} = require('../services/teamtailorApplyService');

const applyRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many applications. Please wait a few minutes and try again.',
  },
});

function logApplyFailure(error) {
  console.error(
    JSON.stringify({
      scope: 'teamtailor-apply',
      code: error.code || 'apply_error',
      status: error.status || 500,
      detail: error.logDetail || undefined,
    })
  );
}

/**
 * POST /api/teamtailor/apply
 * Stores the application, then creates the Teamtailor candidate, CV upload,
 * and job application. Success is returned only after Teamtailor confirms
 * the job application id.
 */
const applyForJob = async (req, res) => {
  try {
    const application = await submitTeamtailorApplication({
      body: req.body,
      file: req.file,
    });

    if (application.syncStatus !== 'synced') {
      throw new ApplyError("We couldn't submit your application. Please try again.", {
        status: 502,
        code: 'not_synced',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Application submitted successfully',
      data: toPublicApplication(application),
    });
  } catch (error) {
    logApplyFailure(error);

    if (error instanceof ApplyError) {
      return res.status(error.status).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: "We couldn't submit your application. Please try again.",
    });
  }
};

module.exports = {
  applyRateLimit,
  applyForJob,
};
