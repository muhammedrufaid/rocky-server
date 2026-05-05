const cron = require('node-cron');
const { runMigrationFromFeed } = require('../services/salesforceMigrateService');

/**
 * Starts optional cron-based Salesforce → Mongo migration.
 *
 * Env:
 * - SALESFORCE_MIGRATE_ENABLED — default true; set to "false" to disable
 * - SALESFORCE_MIGRATE_CRON — cron expression, default "0 * * * *" (hourly at :00)
 * - SALESFORCE_MIGRATE_SKIP_IF_UNCHANGED — default true; set "false" to always bulkWrite
 * - SALESFORCE_MIGRATE_ON_START — default false; set "true" to run once after server boot
 * - SALESFORCE_MIGRATE_TZ — optional timezone for node-cron (e.g. Asia/Dubai)
 */
const startSalesforceMigrateScheduler = () => {
  const enabled = process.env.SALESFORCE_MIGRATE_ENABLED !== 'false';
  const schedule = process.env.SALESFORCE_MIGRATE_CRON || '0 * * * *';
  const skipIfUnchanged = process.env.SALESFORCE_MIGRATE_SKIP_IF_UNCHANGED !== 'false';
  const runOnStart = process.env.SALESFORCE_MIGRATE_ON_START === 'true';
  const tz = process.env.SALESFORCE_MIGRATE_TZ || undefined;

  const run = async (trigger) => {
    try {
      console.log(`${new Date().toISOString()} [salesforce-migrate] Run triggered (${trigger})`);
      await runMigrationFromFeed({ skipIfUnchanged });
    } catch (err) {
      const ts = new Date().toISOString();
      console.error(`${ts} [salesforce-migrate] Scheduled run failed (${trigger})`, err.message || err);
    }
  };

  if (!enabled) {
    console.log(`${new Date().toISOString()} [salesforce-migrate] Scheduler disabled (SALESFORCE_MIGRATE_ENABLED=false)`);
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(
      `${new Date().toISOString()} [salesforce-migrate] Invalid SALESFORCE_MIGRATE_CRON: "${schedule}". Scheduler not started.`
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
    `${new Date().toISOString()} [salesforce-migrate] Scheduler started: "${schedule}"` +
      (tz ? ` (${tz})` : '') +
      ` | skipIfUnchanged=${skipIfUnchanged}`
  );

  if (runOnStart) {
    setImmediate(() => run('startup'));
  }
};

module.exports = { startSalesforceMigrateScheduler };
