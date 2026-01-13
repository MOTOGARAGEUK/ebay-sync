/**
 * Database Migration Script
 * 
 * This script can be used to initialize or migrate the database schema.
 * Run with: node scripts/migrate.js
 */

require('dotenv').config();
const db = require('../config/database');

async function migrate() {
  try {
    console.log('Starting database migration...');
    await db.init();
    console.log('Database migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();



