const cron = require('node-cron');
const { syncGoogleBusinessProfileReviews } = require('../services/googleBusinessProfileReviewService');

/**
 * Starts optional cron-based Google Business Profile review sync.
 *
 * Env:
 * - GOOGLE_REVIEWS_SYNC_ENABLED — default true; set to "false" to disable
 * - GOOGLE_REVIEWS_SYNC_CRON — cron expression, default every 30 minutes
 * - GOOGLE_REVIEWS_SYNC_ON_START — default true; set "false" to skip startup sync
 * - GOOGLE_REVIEWS_SYNC_TZ — optional timezone for node-cron (e.g. Asia/Dubai)
 */
const startGoogleReviewsSyncScheduler = () => {
  const enabled = process.env.GOOGLE_REVIEWS_SYNC_ENABLED !== 'false';
  const schedule = process.env.GOOGLE_REVIEWS_SYNC_CRON || '*/30 * * * *';
  const runOnStart = process.env.GOOGLE_REVIEWS_SYNC_ON_START !== 'false';
  const tz = process.env.GOOGLE_REVIEWS_SYNC_TZ || undefined;

  const run = async (trigger) => {
    try {
      console.log(`${new Date().toISOString()} [google-reviews] Run triggered (${trigger})`);
      const result = await syncGoogleBusinessProfileReviews();
      if (result.skipped) {
        console.log(`${new Date().toISOString()} [google-reviews] Sync skipped: ${result.reason}`);
        return;
      }
      console.log(`${new Date().toISOString()} [google-reviews] Scheduled sync finished`, {
        fetched: result.fetched,
        inserted: result.inserted,
        updated: result.updated,
        unchanged: result.unchanged,
      });
    } catch (err) {
      console.error(
        `${new Date().toISOString()} [google-reviews] Scheduled run failed (${trigger}):`,
        err.message || err
      );
    }
  };

  if (!enabled) {
    console.log(
      `${new Date().toISOString()} [google-reviews] Scheduler disabled (GOOGLE_REVIEWS_SYNC_ENABLED=false)`
    );
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(
      `${new Date().toISOString()} [google-reviews] Invalid GOOGLE_REVIEWS_SYNC_CRON: "${schedule}". Scheduler not started.`
    );
    return;
  }

  const options = tz ? { timezone: tz } : {};
  cron.schedule(
    schedule,
    () => {
      run('cron');
    },
    options
  );

  console.log(
    `${new Date().toISOString()} [google-reviews] Scheduler started: "${schedule}"` +
      (tz ? ` (${tz})` : '')
  );

  if (runOnStart) {
    setImmediate(() => run('startup'));
  }
};

module.exports = { startGoogleReviewsSyncScheduler };
