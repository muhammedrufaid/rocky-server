const GoogleBusinessProfileReview = require('../models/GoogleBusinessProfileReview');
const {
  getAuthenticatedClient,
  getGoogleBusinessLocation,
  getSafeConnectionStatus,
} = require('./googleBusinessProfileService');

const REVIEWS_PAGE_SIZE = 50;
const STAR_RATING_MAP = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

function toReviewsParent(accountName, locationName) {
  if (!accountName || !locationName) {
    throw new Error('Google Business Profile account and location names are required');
  }

  if (locationName.includes('/locations/')) {
    return locationName;
  }

  const locationId = String(locationName).replace(/^locations\//, '');
  return `${accountName}/locations/${locationId}`;
}

function parseStarRating(value) {
  if (typeof value === 'number' && value >= 1 && value <= 5) return value;
  if (typeof value === 'string' && STAR_RATING_MAP[value]) return STAR_RATING_MAP[value];
  return null;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function googleReviewIdFrom(review) {
  if (review?.reviewId) return String(review.reviewId);
  if (typeof review?.name === 'string' && review.name.includes('/reviews/')) {
    return review.name.split('/reviews/').pop();
  }
  return null;
}

function normalizeGoogleReview(review, { accountName, locationName } = {}) {
  const googleReviewId = googleReviewIdFrom(review);
  if (!googleReviewId) return null;

  return {
    googleReviewId,
    reviewerName: review.reviewer?.displayName || null,
    reviewerPhotoUrl: review.reviewer?.profilePhotoUrl || null,
    starRating: parseStarRating(review.starRating),
    comment: review.comment || null,
    createTime: parseDate(review.createTime),
    updateTime: parseDate(review.updateTime) || parseDate(review.createTime),
    reviewReply: review.reviewReply?.comment || null,
    reviewReplyUpdateTime: parseDate(review.reviewReply?.updateTime),
    locationName: locationName || null,
    accountName: accountName || null,
  };
}

function contentUnchanged(existing, incoming) {
  const sameDate = (left, right) => {
    const leftTime = left ? new Date(left).getTime() : null;
    const rightTime = right ? new Date(right).getTime() : null;
    return leftTime === rightTime;
  };

  return (
    existing.reviewerName === incoming.reviewerName &&
    existing.reviewerPhotoUrl === incoming.reviewerPhotoUrl &&
    existing.starRating === incoming.starRating &&
    existing.comment === incoming.comment &&
    existing.reviewReply === incoming.reviewReply &&
    sameDate(existing.createTime, incoming.createTime) &&
    sameDate(existing.updateTime, incoming.updateTime) &&
    sameDate(existing.reviewReplyUpdateTime, incoming.reviewReplyUpdateTime) &&
    existing.locationName === incoming.locationName &&
    existing.accountName === incoming.accountName
  );
}

async function fetchReviewPage(auth, parent, pageToken) {
  try {
    const response = await auth.request({
      url: `https://mybusiness.googleapis.com/v4/${parent}/reviews`,
      params: {
        pageSize: REVIEWS_PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    return response.data || {};
  } catch (error) {
    const status = error.response?.status || error.code;
    const googleMessage = error.response?.data?.error?.message || error.message;
    throw new Error(
      status
        ? `Google reviews API failed (${status}): ${googleMessage}`
        : `Google reviews API failed: ${googleMessage}`
    );
  }
}

async function getGoogleReviews() {
  const resolved = await getGoogleBusinessLocation();
  const parent = toReviewsParent(resolved.accountName, resolved.locationName);
  const auth = await getAuthenticatedClient();

  const reviews = [];
  let pageToken;

  do {
    const data = await fetchReviewPage(auth, parent, pageToken);
    reviews.push(...(data.reviews || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return {
    accountName: resolved.accountName,
    locationName: resolved.locationName,
    locationTitle: resolved.locationTitle,
    reviews: reviews
      .map((review) =>
        normalizeGoogleReview(review, {
          accountName: resolved.accountName,
          locationName: resolved.locationName,
        })
      )
      .filter(Boolean),
  };
}

async function syncGoogleBusinessProfileReviews() {
  const connection = await getSafeConnectionStatus();
  if (!connection.connected) {
    return {
      skipped: true,
      reason: 'Google Business Profile is not connected',
      fetched: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
    };
  }

  console.log('[google-reviews] Starting review sync...');
  const { accountName, locationName, locationTitle, reviews } = await getGoogleReviews();
  console.log('[google-reviews] Reviews fetched:', reviews.length);

  const fetchedAt = new Date();
  const reviewIds = reviews.map((review) => review.googleReviewId);
  const existing = reviewIds.length
    ? await GoogleBusinessProfileReview.find({ googleReviewId: { $in: reviewIds } })
    : [];
  const existingById = new Map(existing.map((review) => [review.googleReviewId, review]));

  const ops = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const review of reviews) {
    const current = existingById.get(review.googleReviewId);
    const payload = { ...review, fetchedAt };

    if (!current) {
      inserted += 1;
      ops.push({ insertOne: { document: payload } });
      continue;
    }

    if (contentUnchanged(current, review)) {
      unchanged += 1;
      ops.push({
        updateOne: {
          filter: { googleReviewId: review.googleReviewId },
          update: { $set: { fetchedAt } },
        },
      });
      continue;
    }

    updated += 1;
    ops.push({
      updateOne: {
        filter: { googleReviewId: review.googleReviewId },
        update: { $set: payload },
      },
    });
  }

  if (ops.length) {
    await GoogleBusinessProfileReview.bulkWrite(ops, { ordered: false });
  }

  const stats = {
    skipped: false,
    fetched: reviews.length,
    inserted,
    updated,
    unchanged,
  };

  console.log(
    `[google-reviews] Sync finished: inserted=${inserted} updated=${updated} unchanged=${unchanged}`
  );

  return stats;
}

async function listStoredGoogleReviews({ page = 1, limit = 20, rating } = {}) {
  const filter = {};
  if (rating !== undefined) {
    filter.starRating = rating;
  }

  const skip = (page - 1) * limit;
  const [total, reviews] = await Promise.all([
    GoogleBusinessProfileReview.countDocuments(filter),
    GoogleBusinessProfileReview.find(filter)
      .sort({ updateTime: -1, createTime: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  return {
    reviews,
    total,
    page,
    limit,
    pages: total > 0 ? Math.ceil(total / limit) : 0,
  };
}

module.exports = {
  getGoogleReviews,
  syncGoogleBusinessProfileReviews,
  listStoredGoogleReviews,
};
