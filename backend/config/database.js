const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/sync.db';
const DB_DIR = path.dirname(DB_PATH);

let db = null;

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const init = () => {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        reject(err);
        return;
      }
      console.log('Connected to SQLite database');
      createTables().then(resolve).catch(reject);
    });
  });
};

const createTables = () => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // ShareTribe Users table (simplified - stores only user IDs, API credentials come from main config)
      db.run(`
        CREATE TABLE IF NOT EXISTS sharetribe_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          sharetribe_user_id TEXT NOT NULL UNIQUE,
          location TEXT,
          pickup_enabled INTEGER DEFAULT 1,
          shipping_enabled INTEGER DEFAULT 1,
          shipping_measurement TEXT DEFAULT 'custom',
          parcel TEXT,
          transaction_process_alias TEXT DEFAULT 'default-purchase/release-1',
          unit_type TEXT DEFAULT 'item',
          default_image_id TEXT,
          default_image_path TEXT,
          ebay_user_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (ebay_user_id) REFERENCES ebay_users(ebay_user_id) ON DELETE SET NULL
        )
      `);

      // eBay Users table (stores per-user OAuth tokens)
      db.run(`
        CREATE TABLE IF NOT EXISTS ebay_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          ebay_user_id TEXT NOT NULL,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          token_expiry DATETIME NOT NULL,
          sandbox INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
          UNIQUE(tenant_id, ebay_user_id, sandbox)
        )
      `);

      // Tenants table (multi-tenant support - keeping for backward compatibility)
      db.run(`
        CREATE TABLE IF NOT EXISTS tenants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // API Configuration table
      db.run(`
        CREATE TABLE IF NOT EXISTS api_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          ebay_app_id TEXT,
          ebay_cert_id TEXT,
          ebay_dev_id TEXT,
          ebay_access_token TEXT,
          ebay_refresh_token TEXT,
          ebay_sandbox INTEGER DEFAULT 1,
          ebay_redirect_uri TEXT,
          ebay_privacy_policy_url TEXT,
          ebay_auth_accepted_url TEXT,
          ebay_auth_declined_url TEXT,
          sharetribe_api_key TEXT,
          sharetribe_api_secret TEXT,
          sharetribe_marketplace_api_client_id TEXT,
          sharetribe_marketplace_id TEXT,
          sharetribe_user_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
          UNIQUE(tenant_id)
        )
      `);

      // Field Mapping table
      db.run(`
        CREATE TABLE IF NOT EXISTS field_mappings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          ebay_field TEXT NOT NULL,
          sharetribe_field TEXT NOT NULL,
          transformation TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
          UNIQUE(tenant_id, ebay_field, sharetribe_field)
        )
      `);

      // Products table (eBay products cache)
      db.run(`
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          user_id INTEGER,
          ebay_item_id TEXT NOT NULL,
          title TEXT,
          description TEXT,
          price REAL,
          currency TEXT,
          quantity INTEGER,
          images TEXT,
          category TEXT,
          condition TEXT,
          brand TEXT,
          sku TEXT,
          synced BOOLEAN DEFAULT 0,
          sharetribe_listing_id TEXT,
          last_synced_at DATETIME,
          custom_fields TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(tenant_id, ebay_item_id)
        )
      `);
      
      // Add custom_fields column if it doesn't exist (migration)
      // SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we check first
      db.all(`PRAGMA table_info(products)`, (err, rows) => {
        if (!err && rows && Array.isArray(rows)) {
          const hasCustomFields = rows.some(row => row.name === 'custom_fields');
          if (!hasCustomFields) {
            db.run(`ALTER TABLE products ADD COLUMN custom_fields TEXT`, (alterErr) => {
              if (alterErr) {
                console.error('Error adding custom_fields column:', alterErr);
              } else {
                console.log('Successfully added custom_fields column to products table');
              }
            });
          }
        }
      });

      // Sync Logs table
      db.run(`
        CREATE TABLE IF NOT EXISTS sync_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          user_id INTEGER,
          sync_type TEXT NOT NULL,
          status TEXT NOT NULL,
          products_synced INTEGER DEFAULT 0,
          products_failed INTEGER DEFAULT 0,
          error_message TEXT,
          started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        )
      `);

      // Migrations for existing databases
      db.run(`ALTER TABLE api_config ADD COLUMN sharetribe_user_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      db.run(`ALTER TABLE products ADD COLUMN user_id INTEGER`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      db.run(`ALTER TABLE sync_logs ADD COLUMN user_id INTEGER`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      db.run(`ALTER TABLE api_config ADD COLUMN sharetribe_marketplace_api_client_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      // Add location column to sharetribe_users table
      db.run(`ALTER TABLE sharetribe_users ADD COLUMN location TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      // Add listing configuration columns to sharetribe_users table
      db.run(`ALTER TABLE sharetribe_users ADD COLUMN pickup_enabled INTEGER DEFAULT 1`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      db.run(`ALTER TABLE sharetribe_users ADD COLUMN shipping_enabled INTEGER DEFAULT 1`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      db.run(`ALTER TABLE sharetribe_users ADD COLUMN shipping_measurement TEXT DEFAULT 'custom'`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      // Add parcel column for shipping parcel data
      db.run(`ALTER TABLE sharetribe_users ADD COLUMN parcel TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      db.run(`ALTER TABLE sharetribe_users ADD COLUMN transaction_process_alias TEXT DEFAULT 'default-purchase/release-1'`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      db.run(`ALTER TABLE sharetribe_users ADD COLUMN unit_type TEXT DEFAULT 'item'`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      db.run(`ALTER TABLE sharetribe_users ADD COLUMN default_image_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      // Add default_image_path column for storing image file path
      db.run(`ALTER TABLE sharetribe_users ADD COLUMN default_image_path TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });

      // Add sandbox flag to api_config table
      db.run(`ALTER TABLE api_config ADD COLUMN ebay_sandbox INTEGER DEFAULT 1`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });

      // Add eBay redirect URI column for ngrok/local dev support
      db.run(`ALTER TABLE api_config ADD COLUMN ebay_redirect_uri TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      db.run(`ALTER TABLE api_config ADD COLUMN ebay_privacy_policy_url TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      db.run(`ALTER TABLE api_config ADD COLUMN ebay_auth_accepted_url TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });
      
      db.run(`ALTER TABLE api_config ADD COLUMN ebay_auth_declined_url TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });

      // Add ebay_user_id column to sharetribe_users table
      db.run(`ALTER TABLE sharetribe_users ADD COLUMN ebay_user_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column') && !err.message.includes('no such column')) {
          console.error('Migration error:', err);
        }
      });

      // Default tenant
      db.run(`INSERT OR IGNORE INTO tenants (id, name) VALUES (1, 'default')`, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });
};

const getDb = () => {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
};

const close = () => {
  if (db) {
    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err);
      } else {
        console.log('Database connection closed');
      }
    });
  }
};

module.exports = {
  init,
  getDb,
  close
};

