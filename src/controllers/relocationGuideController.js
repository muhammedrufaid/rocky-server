const rateLimit = require('express-rate-limit');
const { ApplyError } = require('../services/teamtailorApplyValidation');
const { submitRelocationGuide, toPublicSubmission } = require('../services/relocationGuideService');

const relocationGuideRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many relocation guide requests. Please wait a few minutes and try again.',
  },
});

function logRelocationGuideFailure(error) {
  console.error(
    JSON.stringify({
      scope: 'relocation-guide',
      code: error.code || 'relocation_guide_error',
      status: error.status || 500,
      detail: error.logDetail || undefined,
    })
  );
}

/**
 * POST /api/relocation-guide
 * Saves the enquiry, records the Teamtailor outcome, then emails the guide.
 * A Teamtailor failure does not stop the email.
 */
const requestRelocationGuide = async (req, res) => {
  try {
    const outcome = await submitRelocationGuide({ body: req.body, file: req.file });

    return res.status(outcome.created ? 201 : 200).json({
      success: true,
      message: 'Relocation guide request submitted successfully',
      data: toPublicSubmission(outcome.record),
    });
  } catch (error) {
    logRelocationGuideFailure(error);

    if (error instanceof ApplyError) {
      return res.status(error.status).json({
        success: false,
        message: error.message,
        ...(error.publicData ? { data: error.publicData } : {}),
      });
    }

    return res.status(500).json({
      success: false,
      message: "We couldn't submit your relocation guide request. Please try again.",
    });
  }
};

module.exports = {
  relocationGuideRateLimit,
  requestRelocationGuide,
};
