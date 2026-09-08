const { parsePaginationParams } = require('../utils/paginationUtils');
const { listStoredGoogleReviews } = require('../services/googleBusinessProfileReviewService');
const { inspectGoogleBusinessProfiles } = require('../services/googleBusinessProfileService');

function toPublicReview(review) {
  return {
    id: review.googleReviewId,
    reviewerName: review.reviewerName,
    reviewerPhotoUrl: review.reviewerPhotoUrl,
    starRating: review.starRating,
    comment: review.comment,
    createTime: review.createTime,
    updateTime: review.updateTime,
    reviewReply: review.reviewReply,
  };
}

function parseRatingFilter(value) {
  if (value === undefined || value === null || value === '') return undefined;

  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    const error = new Error('rating must be an integer between 1 and 5');
    error.statusCode = 400;
    throw error;
  }

  return rating;
}

// GET /api/reviews/google
const getGoogleBusinessProfileReviews = async (req, res) => {
  try {
    if (req.query.accountId || req.query.locationId || req.query.accountName || req.query.locationName) {
      return res.status(400).json({
        success: false,
        message: 'Google account and location cannot be selected by the client',
      });
    }

    const { page, limit } = parsePaginationParams(req, { defaultLimit: 20 });
    const rating = parseRatingFilter(req.query.rating);
    const result = await listStoredGoogleReviews({ page, limit, rating });

    return res.status(200).json({
      success: true,
      data: result.reviews.map(toPublicReview),
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        pages: result.pages,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({
      success: false,
      message: error.message || 'Failed to fetch Google Business Profile reviews',
    });
  }
};

// GET /api/reviews/google/business-profiles
const getGoogleBusinessProfiles = async (req, res) => {
  try {
    const result = await inspectGoogleBusinessProfiles();
    const status = result.connected ? 200 : 409;
    return res.status(status).json({
      success: Boolean(result.success),
      accounts: result.accounts,
      locations: result.locations,
      message: result.message,
      diagnostics: result.diagnostics,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to list Google Business Profile accounts and locations',
      accounts: [],
    });
  }
};

module.exports = {
  getGoogleBusinessProfileReviews,
  getGoogleBusinessProfiles,
};
