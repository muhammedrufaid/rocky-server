const cron = require('node-cron');
const { syncJobsToDb } = require('../services/teamtailorService');

/**
 * Starts optional cron-based TeamTailor → Mongo sync.
 *
 * Env:
 * - TEAMTAILOR_SYNC_ENABLED — default true; set to "false" to disable
 * - TEAMTAILOR_SYNC_CRON — cron expression, default every 5 minutes
 * - TEAMTAILOR_SYNC_ON_START — default true; set "false" to skip startup sync
 * - TEAMTAILOR_SYNC_TZ — optional timezone for node-cron (e.g. Asia/Dubai)
 */
const startTeamTailorSyncScheduler = () => {
  const enabled = process.env.TEAMTAILOR_SYNC_ENABLED !== 'false';
  const schedule = process.env.TEAMTAILOR_SYNC_CRON || '*/5 * * * *';
  const runOnStart = process.env.TEAMTAILOR_SYNC_ON_START !== 'false';
  const tz = process.env.TEAMTAILOR_SYNC_TZ || undefined;

  const run = async (trigger) => {
    try {
      console.log(`${new Date().toISOString()} [teamtailor-sync] Run triggered (${trigger})`);
      const result = await syncJobsToDb();
      console.log(`${new Date().toISOString()} [teamtailor-sync] Sync finished`, {
        count: result.count,
        upserted: result.upserted,
        modified: result.modified,
        deleted: result.deleted,
      });
    } catch (err) {
      const ts = new Date().toISOString();
      console.error(`${ts} [teamtailor-sync] Scheduled run failed (${trigger})`, err.message || err);
    }
  };

  if (!enabled) {
    console.log(`${new Date().toISOString()} [teamtailor-sync] Scheduler disabled (TEAMTAILOR_SYNC_ENABLED=false)`);
    return;
  }

  if (!process.env.TEAMTAILOR_API_TOKEN) {
    console.log(
      `${new Date().toISOString()} [teamtailor-sync] Scheduler skipped (TEAMTAILOR_API_TOKEN not set)`
    );
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(
      `${new Date().toISOString()} [teamtailor-sync] Invalid TEAMTAILOR_SYNC_CRON: "${schedule}". Scheduler not started.`
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
    `${new Date().toISOString()} [teamtailor-sync] Scheduler started: "${schedule}"` +
      (tz ? ` (${tz})` : '')
  );

  if (runOnStart) {
    setImmediate(() => run('startup'));
  }
};

module.exports = { startTeamTailorSyncScheduler };
