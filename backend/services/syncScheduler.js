const cron = require('node-cron');
const syncService = require('./syncService');

let scheduledTask = null;

const start = () => {
  // Run every 6 hours: 0 */6 * * *
  scheduledTask = cron.schedule('0 */6 * * *', async () => {
    console.log('Starting scheduled sync...');
    try {
      // Sync for default tenant (tenant_id = 1)
      // In a multi-tenant setup, you might want to iterate through all tenants
      const result = await syncService.syncProducts(1);
      console.log(`Scheduled sync completed. Synced: ${result.synced}, Failed: ${result.failed}`);
      
      // Log sync result
      const db = require('../config/database');
      const dbInstance = db.getDb();
      dbInstance.run(
        `INSERT INTO sync_logs (tenant_id, sync_type, status, products_synced, products_failed)
         VALUES (?, ?, ?, ?, ?)`,
        [1, 'auto', result.failed === 0 ? 'success' : 'partial', result.synced, result.failed],
        (err) => {
          if (err) console.error('Error logging sync:', err);
        }
      );
    } catch (error) {
      console.error('Scheduled sync failed:', error);
      
      // Log error
      const db = require('../config/database');
      const dbInstance = db.getDb();
      dbInstance.run(
        `INSERT INTO sync_logs (tenant_id, sync_type, status, products_failed, error_message)
         VALUES (?, ?, ?, ?, ?)`,
        [1, 'auto', 'failed', 0, error.message],
        (err) => {
          if (err) console.error('Error logging sync error:', err);
        }
      );
    }
  }, {
    scheduled: true,
    timezone: 'UTC'
  });

  console.log('Sync scheduler started (runs every 6 hours)');
};

const stop = () => {
  if (scheduledTask) {
    scheduledTask.stop();
    console.log('Sync scheduler stopped');
  }
};

module.exports = {
  start,
  stop
};



