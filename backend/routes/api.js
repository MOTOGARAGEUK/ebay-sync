const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../config/database');
const syncService = require('../services/syncService');
const eBayService = require('../services/ebayService');
const eBayOAuthService = require('../services/ebayOAuthService');
const ShareTribeService = require('../services/sharetribeService');
const csvService = require('../services/csvService');
const syncEventLogger = require('../services/syncEventLogger');
const rateLimiter = require('../utils/sharetribeRateLimiter');

// ========== Request Storm Protection ==========

// In-flight request tracking for debouncing
const inFlightStatusRequests = new Map(); // jobId -> Promise

// Status cache (500-1000ms TTL)
const statusCache = new Map(); // jobId -> { data, expiresAt }

// Simple rate limiter for admin endpoints (per IP)
// RELAXED: High limits for dev/debugging, SSE exempted
const adminRateLimitMap = new Map(); // ip -> { count, resetAt }
const ADMIN_RATE_LIMIT_WINDOW = 1000; // 1 second
const ADMIN_RATE_LIMIT_MAX = 10; // Increased to 10 req/sec for debugging (was 1)

function getClientIP(req) {
  return req.ip || 
         req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
         req.headers['x-real-ip'] || 
         req.connection?.remoteAddress || 
         'unknown';
}

function checkAdminRateLimit(req, res, next) {
  // EXEMPT SSE streams from rate limiting entirely
  if (req.path.includes('/events/stream')) {
    return next(); // No rate limit for SSE
  }
  
  const ip = getClientIP(req);
  const now = Date.now();
  
  let limit = adminRateLimitMap.get(ip);
  
  if (!limit || now > limit.resetAt) {
    // Reset window
    limit = { count: 1, resetAt: now + ADMIN_RATE_LIMIT_WINDOW };
    adminRateLimitMap.set(ip, limit);
    return next();
  }
  
  if (limit.count >= ADMIN_RATE_LIMIT_MAX) {
    // Rate limited (but limit is now much higher: 10/sec)
    return res.status(429).json({ 
      error: 'Rate limit exceeded', 
      message: `Maximum ${ADMIN_RATE_LIMIT_MAX} requests per second for admin endpoints` 
    });
  }
  
  limit.count++;
  adminRateLimitMap.set(ip, limit);
  next();
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, limit] of adminRateLimitMap.entries()) {
    if (now > limit.resetAt + 60000) { // Keep for 1 minute after expiry
      adminRateLimitMap.delete(ip);
    }
  }
}, 60000); // Clean every minute

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadsDir = './uploads';
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'csv-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel' || 
        path.extname(file.originalname).toLowerCase() === '.csv') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Configure multer for image uploads
const imageStorage = multer.memoryStorage();
const imageUpload = multer({
  storage: imageStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Helper to get tenant ID (defaults to 1 for now, can be extended for multi-tenant auth)
const getTenantId = (req) => {
  return req.headers['x-tenant-id'] ? parseInt(req.headers['x-tenant-id']) : 1;
};

// ========== API Configuration Routes ==========

// Get API configuration
router.get('/config', (req, res) => {
  const tenantId = getTenantId(req);
  const dbInstance = db.getDb();
  
  dbInstance.get(
    'SELECT * FROM api_config WHERE tenant_id = ?',
    [tenantId],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(row || {});
    }
  );
});

// Save API configuration
router.post('/config', (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const dbInstance = db.getDb();
    const {
      ebay_app_id,
      ebay_cert_id,
      ebay_dev_id,
      ebay_access_token,
      ebay_refresh_token,
      ebay_sandbox,
      ebay_redirect_uri,
      ebay_privacy_policy_url,
      ebay_auth_accepted_url,
      ebay_auth_declined_url,
      sharetribe_api_key,
      sharetribe_api_secret,
      sharetribe_marketplace_id,
      sharetribe_user_id
    } = req.body;

    console.log('Saving API configuration for tenant:', tenantId);
    console.log('ShareTribe config:', {
      api_key: sharetribe_api_key ? `${sharetribe_api_key.substring(0, 10)}...` : 'empty',
      api_secret: sharetribe_api_secret ? 'provided' : 'empty',
      marketplace_id: sharetribe_marketplace_id || 'empty'
    });

    // Check if config exists
    dbInstance.get(
      'SELECT id FROM api_config WHERE tenant_id = ?',
      [tenantId],
      (checkErr, existing) => {
        if (checkErr) {
          console.error('Error checking existing config:', checkErr);
          return res.status(500).json({ error: checkErr.message });
        }

        if (existing) {
          // Update existing config
          const sharetribe_marketplace_api_client_id = req.body.sharetribe_marketplace_api_client_id || '';
          dbInstance.run(
            `UPDATE api_config SET
              ebay_app_id = ?, ebay_cert_id = ?, ebay_dev_id = ?,
              ebay_access_token = ?, ebay_refresh_token = ?,
              ebay_sandbox = ?, ebay_redirect_uri = ?,
              ebay_privacy_policy_url = ?, ebay_auth_accepted_url = ?, ebay_auth_declined_url = ?,
              sharetribe_api_key = ?, sharetribe_api_secret = ?,
              sharetribe_marketplace_api_client_id = ?,
              sharetribe_marketplace_id = ?, sharetribe_user_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = ?`,
            [
              ebay_app_id, ebay_cert_id, ebay_dev_id,
              ebay_access_token, ebay_refresh_token,
              ebay_sandbox !== undefined ? (ebay_sandbox ? 1 : 0) : 1, // Default to sandbox
              ebay_redirect_uri || null,
              ebay_privacy_policy_url || null,
              ebay_auth_accepted_url || null,
              ebay_auth_declined_url || null,
              sharetribe_api_key, sharetribe_api_secret,
              sharetribe_marketplace_api_client_id,
              sharetribe_marketplace_id, sharetribe_user_id, tenantId
            ],
            function(updateErr) {
              if (updateErr) {
                console.error('Error updating config:', updateErr);
                return res.status(500).json({ error: updateErr.message });
              }
              console.log('Config updated successfully');
              res.json({ success: true, id: existing.id });
            }
          );
        } else {
          // Insert new config
          const sharetribe_marketplace_api_client_id = req.body.sharetribe_marketplace_api_client_id || '';
          dbInstance.run(
            `INSERT INTO api_config (
              tenant_id, ebay_app_id, ebay_cert_id, ebay_dev_id, ebay_access_token, ebay_refresh_token,
              ebay_sandbox, ebay_redirect_uri,
              ebay_privacy_policy_url, ebay_auth_accepted_url, ebay_auth_declined_url,
              sharetribe_api_key, sharetribe_api_secret, sharetribe_marketplace_api_client_id,
              sharetribe_marketplace_id, sharetribe_user_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
              tenantId,
              ebay_app_id,
              ebay_cert_id,
              ebay_dev_id,
              ebay_access_token,
              ebay_refresh_token,
              ebay_sandbox !== undefined ? (ebay_sandbox ? 1 : 0) : 1, // Default to sandbox
              ebay_redirect_uri || null,
              ebay_privacy_policy_url || null,
              ebay_auth_accepted_url || null,
              ebay_auth_declined_url || null,
              sharetribe_api_key,
              sharetribe_api_secret,
              sharetribe_marketplace_api_client_id,
              sharetribe_marketplace_id,
              sharetribe_user_id
            ],
            function(insertErr) {
              if (insertErr) {
                console.error('Error inserting config:', insertErr);
                return res.status(500).json({ error: insertErr.message });
              }
              console.log('Config inserted successfully, ID:', this.lastID);
              res.json({ success: true, id: this.lastID });
            }
          );
        }
      }
    );
  } catch (error) {
    console.error('Unexpected error in /config endpoint:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Test API connections
router.post('/config/test', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const config = await syncService.getApiConfig(tenantId);
    
    const results = {};
    const axios = require('axios');
    
    // Test eBay API - Check for inventory items
    if (config.ebay) {
      try {
        // Try to get connected eBay users
        const dbInstance = db.getDb();
        const ebayUsers = await new Promise((resolve, reject) => {
          dbInstance.all(
            `SELECT ebay_user_id, sandbox FROM ebay_users WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`,
            [tenantId],
            (err, rows) => {
              if (err) reject(err);
              else resolve(rows);
            }
          );
        });

        if (ebayUsers && ebayUsers.length > 0) {
          // Use the most recent eBay user's credentials
          const ebayUser = ebayUsers[0];
          const ebayConfig = {
            ...config.ebay,
            sandbox: ebayUser.sandbox === 1
          };
          const ebayService = new eBayService(ebayConfig, ebayUser.ebay_user_id, tenantId);
          
          // Load tokens from database
          await ebayService.loadTokensFromDatabase();
          
          // Get inventory items count
          const inventoryItems = await ebayService.getActiveListings();
          const itemCount = inventoryItems ? inventoryItems.length : 0;
          
          results.ebay = {
            success: true,
            message: `Connection successful. Found ${itemCount} inventory item(s) available to sync.`,
            itemCount: itemCount,
            authenticated: true
          };
        } else {
          // No authenticated eBay user, test basic connection
          const ebayService = new eBayService(config.ebay);
          const basicTest = await ebayService.testConnection();
          results.ebay = {
            ...basicTest,
            message: basicTest.message + ' (No authenticated seller account connected. Connect an eBay account to see available products.)',
            authenticated: false
          };
        }
      } catch (error) {
        console.error('Error testing eBay connection:', error);
        results.ebay = {
          success: false,
          message: `eBay API test failed: ${error.message}`,
          authenticated: false
        };
      }
    } else {
      results.ebay = { success: false, message: 'eBay configuration missing' };
    }
    
    // Test ShareTribe APIs separately
    results.sharetribe = {};
    
    // Test Marketplace API (Asset Delivery API)
    if (config.sharetribe && config.sharetribe.marketplaceApiClientId) {
      try {
        console.log('Testing Marketplace API (Asset Delivery API)...');
        const marketplaceClientId = config.sharetribe.marketplaceApiClientId;
        
        // Test listing-types endpoint - try multiple URL variations
        const testUrls = [
          `https://cdn.st-api.com/v1/assets/pub/${marketplaceClientId}/listings/listing-types.json`,
          `https://cdn.st-api.com/v1/assets/pub/${marketplaceClientId}/latest/listings/listing-types.json`,
          `https://cdn.st-api.com/v1/assets/pub/${marketplaceClientId}/${config.sharetribe.marketplaceId}/listings/listing-types.json`
        ];
        
        let response = null;
        let workingUrl = null;
        
        for (const testUrl of testUrls) {
          console.log(`Testing Asset Delivery API: ${testUrl}`);
          try {
            const testResponse = await axios.get(testUrl, {
              headers: {
                'Accept': 'application/json'
              },
              validateStatus: function (status) {
                return status < 500;
              }
            });
            
            if (testResponse.status >= 200 && testResponse.status < 300) {
              response = testResponse;
              workingUrl = testUrl;
              console.log(`Success! Working URL: ${testUrl}`);
              break;
            } else {
              console.log(`URL ${testUrl} returned status ${testResponse.status}`);
            }
          } catch (err) {
            console.log(`URL ${testUrl} failed: ${err.message}`);
            continue;
          }
        }
        
        if (response && response.status >= 200 && response.status < 300) {
          const data = response.data;
          let listingTypes = [];
          if (Array.isArray(data)) {
            listingTypes = data;
          } else if (data && data.data && Array.isArray(data.data)) {
            listingTypes = data.data;
          } else if (data && data.listingTypes) {
            listingTypes = Array.isArray(data.listingTypes) ? data.listingTypes : [data.listingTypes];
          }
          
          results.sharetribe.marketplace = {
            success: true,
            message: `Marketplace API connection successful. Found ${listingTypes.length} listing types via Asset Delivery API. (URL: ${workingUrl})`
          };
        } else {
          results.sharetribe.marketplace = {
            success: false,
            message: `Marketplace API returned 404 for all URL variations. Asset Delivery API requires assets to be published/deployed. In test environments, you may need to deploy your marketplace first (ShareTribe Console → Deploy). Alternatively, listing types, categories, and fields can be inferred from existing listings.`
          };
        }
      } catch (error) {
        console.error('Error testing Marketplace API:', error.message);
        results.sharetribe.marketplace = {
          success: false,
          message: `Marketplace API test failed: ${error.response?.status === 404 ? 'Assets not found (404). Verify Marketplace API Client ID is correct.' : error.message}`
        };
      }
    } else {
      results.sharetribe.marketplace = {
        success: false,
        message: 'Marketplace API Client ID not configured'
      };
    }
    
    // Test Integration API
    if (config.sharetribe && config.sharetribe.apiKey && config.sharetribe.apiSecret && config.sharetribe.marketplaceId) {
      try {
        const sharetribeService = new ShareTribeService(config.sharetribe);
        results.sharetribe.integration = await sharetribeService.testConnection();
      } catch (error) {
        console.error('Error testing Integration API:', error.message);
        results.sharetribe.integration = {
          success: false,
          message: `Integration API test failed: ${error.message}`
        };
      }
    } else {
      results.sharetribe.integration = {
        success: false,
        message: 'Integration API credentials not configured (Client ID, Client Secret, and Marketplace ID required)'
      };
    }
    
    res.json(results);
  } catch (error) {
    console.error('Error testing API connections:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== Field Mapping Routes ==========

// Get ShareTribe metadata (listing types, categories, fields)
router.get('/sharetribe/metadata', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const config = await syncService.getApiConfig(tenantId);
    
    if (!config.sharetribe || !config.sharetribe.marketplaceId) {
      return res.status(400).json({ error: 'ShareTribe Marketplace ID not configured' });
    }
    
    if (!config.sharetribe.marketplaceApiClientId) {
      return res.status(400).json({ error: 'Marketplace API Client ID is required for Asset Delivery API. Please configure it in API Configuration.' });
    }
    
    console.log('Fetching ShareTribe metadata for marketplace:', config.sharetribe.marketplaceId);
    const sharetribeService = new ShareTribeService(config.sharetribe);
    const metadata = await sharetribeService.getMetadata();
    
    console.log('Metadata fetched:', {
      listingTypes: metadata.listingTypes?.length || 0,
      categories: metadata.categories?.length || 0,
      defaultFields: metadata.defaultFields?.length || 0,
      listingFields: metadata.listingFields?.length || 0
    });
    
    res.json(metadata);
  } catch (error) {
    console.error('Error fetching ShareTribe metadata:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.response?.data || null
    });
  }
});

// Get field mappings
router.get('/field-mappings', (req, res) => {
  const tenantId = getTenantId(req);
  const dbInstance = db.getDb();
  
  dbInstance.all(
    'SELECT * FROM field_mappings WHERE tenant_id = ? ORDER BY id',
    [tenantId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// Save field mappings (replace all)
router.post('/field-mappings', (req, res) => {
  const tenantId = getTenantId(req);
  const dbInstance = db.getDb();
  const mappings = req.body; // Array of { ebay_field, sharetribe_field, transformation }

  dbInstance.serialize(() => {
    dbInstance.run('BEGIN TRANSACTION');
    
    // Delete existing mappings
    dbInstance.run('DELETE FROM field_mappings WHERE tenant_id = ?', [tenantId], (err) => {
      if (err) {
        dbInstance.run('ROLLBACK');
        return res.status(500).json({ error: err.message });
      }

      // Insert new mappings
      const stmt = dbInstance.prepare(
        'INSERT INTO field_mappings (tenant_id, ebay_field, sharetribe_field, transformation) VALUES (?, ?, ?, ?)'
      );

      let completed = 0;
      if (mappings.length === 0) {
        dbInstance.run('COMMIT');
        return res.json({ success: true, count: 0 });
      }

      mappings.forEach(mapping => {
        stmt.run([tenantId, mapping.ebay_field, mapping.sharetribe_field, mapping.transformation || null], (err) => {
          if (err) {
            dbInstance.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          completed++;
          if (completed === mappings.length) {
            stmt.finalize();
            dbInstance.run('COMMIT');
            res.json({ success: true, count: mappings.length });
          }
        });
      });
    });
  });
});

// ========== Products Routes ==========

// Get all products
router.get('/products', (req, res) => {
  // Wrap in try-catch to prevent any unhandled errors
  try {
    const tenantId = getTenantId(req);
    
    // Safely get database instance
    let dbInstance;
    try {
      dbInstance = db.getDb();
    } catch (dbError) {
      console.error('Error getting database instance:', dbError);
      return res.status(500).json({ error: 'Database connection failed: ' + dbError.message });
    }
    
    if (!dbInstance) {
      console.error('Database instance is null');
      return res.status(500).json({ error: 'Database connection failed' });
    }
    
    const { synced, search, sharetribe_user_id } = req.query || {};
    
    console.log(`📋 GET /products - Query params:`, { synced, search, sharetribe_user_id });
    
    let query = 'SELECT * FROM products WHERE tenant_id = ?';
    const params = [tenantId];
    
    if (synced !== undefined && synced !== null && synced !== '') {
      query += ' AND synced = ?';
      params.push(synced === 'true' ? 1 : 0);
    }
    
    // CRITICAL: Always require user_id filter for user scoping
    // Products must be scoped to a specific user - no cross-user visibility
    if (sharetribe_user_id === undefined || sharetribe_user_id === null || sharetribe_user_id === '') {
      // No user provided - return empty result
      console.log('⚠️ No sharetribe_user_id provided - returning empty result (user selection required)');
      query += ' AND 1 = 0'; // Always false condition
    } else {
      const userId = parseInt(sharetribe_user_id);
      if (!isNaN(userId) && userId > 0) {
        query += ' AND user_id = ?';
        params.push(userId);
        console.log(`✅ Filtering products by user_id: ${userId} (strict user scoping)`);
      } else {
        console.warn(`⚠️ Invalid sharetribe_user_id provided: ${sharetribe_user_id}, showing no products`);
        // Return empty result for invalid user ID
        query += ' AND 1 = 0'; // Always false condition
      }
    }
    
    if (search && typeof search === 'string' && search.trim()) {
      query += ' AND (title LIKE ? OR description LIKE ?)';
      const searchParam = `%${search.trim()}%`;
      params.push(searchParam, searchParam);
    }
    
    query += ' ORDER BY created_at DESC';
    
    // Execute query with error handling
    try {
      dbInstance.all(query, params, (err, rows) => {
        if (err) {
          console.error('Database error fetching products:', err);
          console.error('Query:', query);
          console.error('Params:', params);
          return res.status(500).json({ error: 'Database error: ' + err.message });
        }
        
        // Ensure we return an array
        const result = Array.isArray(rows) ? rows : [];
        res.json(result);
      });
    } catch (queryError) {
      console.error('Error executing query:', queryError);
      return res.status(500).json({ error: 'Query execution failed: ' + queryError.message });
    }
  } catch (error) {
    console.error('Unexpected error in /products endpoint:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Refresh products from eBay
router.post('/products/refresh', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { sharetribe_user_id } = req.body; // Optional: use eBay account associated with ShareTribe user
    const debug = req.query.debug === 'true' || req.body.debug === true; // Support debug mode
    
    // Fetch products from eBay (this stores them in DB and returns the raw products with all price fields)
    const result = await syncService.refreshProductsFromEbay(tenantId, sharetribe_user_id, debug);
    
    // Handle debug mode response
    if (result.debug) {
      return res.json({
        success: result.success !== false,
        count: result.count || 0,
        products: result.items || [],
        debug: result.debug
      });
    }
    
    // Extract products array from result (could be {items: [...]} or just [...])
    const productsFromEbay = result.items || result;
    
    // Ensure it's an array
    if (!Array.isArray(productsFromEbay)) {
      console.error('❌ productsFromEbay is not an array:', typeof productsFromEbay, productsFromEbay);
      return res.status(500).json({ 
        error: 'Invalid response from eBay service',
        details: 'Expected array but got ' + typeof productsFromEbay
      });
    }
    
    // CRITICAL: Merge eBay API products (has price fields) with database products (has Item Specifics)
    // Use eBay API products as base (they have price fields), then merge Item Specifics from DB
    const dbInstance = db.getDb();
    const productsFromDb = await new Promise((resolve, reject) => {
      dbInstance.all(
        'SELECT * FROM products WHERE tenant_id = ? AND synced = 0',
        [tenantId],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
    
    // Create a map of products by ebay_item_id for quick lookup
    const dbProductsMap = new Map();
    productsFromDb.forEach(row => {
      const product = { ...row };
      if (row.custom_fields) {
        try {
          const customFields = JSON.parse(row.custom_fields);
          Object.assign(product, customFields);
        } catch (e) {
          console.warn(`Failed to parse custom_fields for product ${row.ebay_item_id}:`, e.message);
        }
      }
      delete product.custom_fields;
      dbProductsMap.set(row.ebay_item_id, product);
    });
    
    // Merge: Start with eBay API products (has price fields), then add Item Specifics from DB
    const mergedProducts = productsFromEbay.map(ebayProduct => {
      const dbProduct = dbProductsMap.get(ebayProduct.ebay_item_id);
      if (dbProduct) {
        // Merge: eBay API has price fields, DB has Item Specifics
        return {
          ...ebayProduct, // Start with eBay API product (has price fields: start_price, buy_now_price, etc.)
          ...dbProduct // Add Item Specifics from DB (brand, size, etc.)
        };
      }
      return ebayProduct; // If not in DB yet, use eBay API product as-is
    });
    
    // Log sample product to verify all fields are present (including Item Specifics)
    if (mergedProducts.length > 0) {
      const sample = mergedProducts[0];
      const itemSpecificsKeys = Object.keys(sample).filter(k => 
        !['id', 'tenant_id', 'user_id', 'ebay_item_id', 'title', 'description', 'price', 'currency', 
          'quantity', 'images', 'category', 'condition', 'brand', 'sku', 'synced', 'sharetribe_listing_id', 
          'last_synced_at', 'created_at', 'updated_at', 'categoryLevel1', 'categoryLevel2', 'categoryLevel3',
          'start_price', 'start_price_currency', 'buy_now_price', 'buy_now_price_currency',
          'current_price', 'current_price_currency', 'listing_type', 'price_source'].includes(k)
      );
      console.log('📦 Sample merged product (for mapping modal):', {
        itemSpecificsFound: itemSpecificsKeys.length > 0,
        itemSpecificsKeys: itemSpecificsKeys,
        ebay_item_id: sample.ebay_item_id,
        title: sample.title,
        price: sample.price,
        start_price: sample.start_price,
        buy_now_price: sample.buy_now_price,
        current_price: sample.current_price,
        brand: sample.brand,
        size: sample.size,
        allFields: Object.keys(sample),
        priceFields: {
          price: sample.price,
          start_price: sample.start_price,
          buy_now_price: sample.buy_now_price,
          current_price: sample.current_price
        },
        allFieldValues: Object.entries(sample)
          .filter(([k, v]) => v !== null && v !== undefined && v !== '')
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ')
      });
    }
    
    // Use merged products (eBay API price fields + DB Item Specifics)
    res.json({ 
      success: true, 
      count: mergedProducts.length, 
      products: mergedProducts 
    });
  } catch (error) {
    console.error('Error refreshing products from eBay:', error);
    res.status(500).json({ error: error.message });
  }
});

// Preview CSV file (get column headers for mapping)
router.post('/products/preview-csv', upload.single('csvFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file uploaded' });
  }

  try {
    const filePath = req.file.path;
    const csv = require('csv-parser');
    
    const preview = {
      fileId: req.file.filename,
      columns: [],
      sampleRows: [],
      rowCount: 0,
      uniqueCategories: {} // Map of column name -> Set of unique values
    };
    
    return new Promise((resolve, reject) => {
      const rows = []; // First 1000 rows for preview table
      let headersCaptured = false;
      const categoryColumns = new Set(); // Track potential category columns
      
      // Track category samples across ALL rows (not just first 1000)
      // Structure: categorySamples[categoryColumn][categoryValue] = [title1, title2]
      const categorySamples = {};
      let titleColumn = null; // Will be detected from common column names
      
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (data) => {
          // Capture headers from first row
          if (!headersCaptured) {
            preview.columns = Object.keys(data);
            headersCaptured = true;
            
            // Initialize unique categories tracking for all columns
            preview.columns.forEach(col => {
              preview.uniqueCategories[col] = new Set();
            });
            
            // Detect title column (common names) - be more aggressive in detection
            const commonTitleNames = ['title', 'Title', 'TITLE', 'product_title', 'Product Title', 
                                     'name', 'Name', 'product_name', 'Product Name', 'item_title', 'Item Title',
                                     'product name', 'Product Name', 'item name', 'Item Name'];
            
            // Try multiple strategies to find title column
            titleColumn = preview.columns.find(col => commonTitleNames.includes(col)) || 
                         preview.columns.find(col => col.toLowerCase() === 'title') ||
                         preview.columns.find(col => col.toLowerCase() === 'name') ||
                         preview.columns.find(col => col.toLowerCase().includes('title')) ||
                         preview.columns.find(col => col.toLowerCase().includes('name')) ||
                         preview.columns.find(col => col.toLowerCase().includes('product')) ||
                         null; // Allow null if not found
            
            console.log(`CSV Preview: Title column detection - Found: ${titleColumn || 'NONE'}`, {
              availableColumns: preview.columns,
              matchedColumn: titleColumn
            });
            
            // Initialize categorySamples structure for all columns (in case any becomes a category column)
            preview.columns.forEach(col => {
              categorySamples[col] = {};
            });
          }
          
          preview.rowCount++;
          
          // Log progress every 100 rows to verify we're scanning all rows
          if (preview.rowCount % 100 === 0) {
            console.log(`CSV Preview: Processing row ${preview.rowCount}...`);
          }
          
          // Store sample rows (first 1000 for preview table)
          if (rows.length < 1000) {
            rows.push(data);
          }
          
          // Track unique values for all columns (to help identify category columns)
          preview.columns.forEach(col => {
            const value = data[col];
            if (value !== undefined && value !== null && value.toString().trim() !== '') {
              preview.uniqueCategories[col].add(value.toString().trim());
              
              // For each column, track up to 2 sample titles per unique value
              // This helps find samples for categories that appear later in the file
              const normalizedValue = value.toString().trim();
              const isNewCategory = !categorySamples[col][normalizedValue];
              
              if (isNewCategory) {
                categorySamples[col][normalizedValue] = [];
                // Log when we find a new category (for first 20 categories per column to avoid spam)
                const existingCategories = Object.keys(categorySamples[col]).length;
                if (existingCategories <= 20) {
                  console.log(`CSV Preview: Row ${preview.rowCount} - Found new category in column "${col}": "${normalizedValue}"`);
                }
              }
              
              // Add title sample if we have a title column and haven't reached 2 samples yet
              if (titleColumn && categorySamples[col][normalizedValue].length < 2) {
                const title = data[titleColumn];
                if (title && String(title).trim()) {
                  const titleStr = String(title).trim();
                  // Avoid duplicates
                  if (!categorySamples[col][normalizedValue].includes(titleStr)) {
                    categorySamples[col][normalizedValue].push(titleStr);
                    // Log when we add a sample (for first 10 per column)
                    if (categorySamples[col][normalizedValue].length <= 2 && Object.keys(categorySamples[col]).length <= 10) {
                      console.log(`CSV Preview: Row ${preview.rowCount} - Added sample "${titleStr.substring(0, 50)}..." for "${col}"="${normalizedValue}"`);
                    }
                  }
                }
              } else if (!titleColumn && preview.rowCount <= 5) {
                // Log warning if title column not found in first few rows
                console.warn(`CSV Preview: Title column not detected! Row ${preview.rowCount}, available columns: ${preview.columns.join(', ')}`);
              }
            }
          });
        })
        .on('end', () => {
          preview.sampleRows = rows;
          
          // Convert Sets to Arrays for JSON serialization
          const uniqueCategoriesArray = {};
          Object.keys(preview.uniqueCategories).forEach(col => {
            uniqueCategoriesArray[col] = Array.from(preview.uniqueCategories[col]).sort();
          });
          preview.uniqueCategories = uniqueCategoriesArray;
          
          // Add categorySamples to preview (scanned from ALL rows)
          preview.categorySamples = categorySamples;
          preview.titleColumn = titleColumn;
          
          // Log how many rows we scanned and samples found
          console.log(`CSV Preview: Scanned ${preview.rowCount} total rows`);
          console.log(`CSV Preview: Sending ${rows.length} sample rows for preview table`);
          console.log(`CSV Preview: Title column detected: ${titleColumn || 'none'}`);
          
          // Log category samples summary with detailed info
          console.log(`CSV Preview: Summary of categorySamples for all columns:`);
          Object.keys(categorySamples).forEach(col => {
            const samples = categorySamples[col];
            const categoryCount = Object.keys(samples).length;
            if (categoryCount > 0) {
              const totalSamples = Object.values(samples).reduce((sum, titles) => sum + titles.length, 0);
              const categoriesWithSamples = Object.entries(samples).filter(([_, titles]) => titles.length > 0).length;
              console.log(`CSV Preview: Column "${col}": ${categoryCount} unique values, ${categoriesWithSamples} categories with samples, ${totalSamples} total sample titles`);
              
              // Log ALL categories (not just first 10) to verify all are included
              const allCategories = Object.entries(samples);
              console.log(`CSV Preview: Column "${col}" - All ${allCategories.length} categories:`, 
                allCategories.map(([catValue, titles]) => `"${catValue}": ${titles.length} sample(s)`)
              );
              
              // Log first 10 categories with their actual sample titles for debugging
              const firstFewCategories = Object.entries(samples).slice(0, 10);
              firstFewCategories.forEach(([catValue, titles]) => {
                if (titles.length > 0) {
                  console.log(`  - "${catValue}": ${titles.length} sample(s) - ${titles.join(', ')}`);
                } else {
                  console.log(`  - "${catValue}": 0 samples (title column may not be detected)`);
                }
              });
            } else {
              console.log(`CSV Preview: Column "${col}": 0 unique values (no data found)`);
            }
          });
          
          // Verify categorySamples structure
          console.log(`CSV Preview: categorySamples structure has ${Object.keys(categorySamples).length} columns`);
          const sampleColumns = Object.keys(categorySamples);
          console.log(`CSV Preview: categorySamples columns: ${sampleColumns.join(', ')}`);
          
          // Log a sample of categorySamples to verify structure
          if (sampleColumns.length > 0) {
            const firstCol = sampleColumns[0];
            const firstColSamples = categorySamples[firstCol];
            const firstColKeys = Object.keys(firstColSamples);
            console.log(`CSV Preview: Sample column "${firstCol}" has ${firstColKeys.length} unique values`);
            if (firstColKeys.length > 0) {
              console.log(`CSV Preview: Sample values for "${firstCol}": ${firstColKeys.slice(0, 5).join(', ')}${firstColKeys.length > 5 ? '...' : ''}`);
              const firstValue = firstColKeys[0];
              console.log(`CSV Preview: Sample for "${firstCol}"="${firstValue}": ${JSON.stringify(firstColSamples[firstValue])}`);
            }
          }
          
          // Verify preview object structure before sending
          const previewKeys = Object.keys(preview);
          console.log(`CSV Preview: Preview object keys: ${previewKeys.join(', ')}`);
          console.log(`CSV Preview: Has categorySamples: ${!!preview.categorySamples}`);
          console.log(`CSV Preview: categorySamples type: ${typeof preview.categorySamples}`);
          
          // Don't delete file yet - we'll need it for import
          res.json(preview);
        })
        .on('error', (error) => {
          console.error('CSV Preview: Error reading CSV file:', error);
          console.error('CSV Preview: Error details:', {
            message: error.message,
            stack: error.stack,
            rowsProcessed: preview.rowCount
          });
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          reject(error);
        });
    });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: error.message });
  }
});

// Upload and parse CSV file with column mappings
router.post('/products/upload-csv', upload.single('csvFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file uploaded' });
  }

  try {
    const tenantId = getTenantId(req);
    const filePath = req.file.path;
    const { columnMappings, categoryMappings, categoryColumn, categoryFieldMappings, categoryListingTypeMappings, valueMappings, unmappedFieldValues, productFieldMappings, productUnmappedFieldValues, sharetribe_user_id } = req.body;
    
    // Get ShareTribe user database ID if provided
    let sharetribeUserDbId = null;
    if (sharetribe_user_id) {
      const dbInstance = db.getDb();
      const sharetribeUser = await new Promise((resolve, reject) => {
        dbInstance.get(
          `SELECT id FROM sharetribe_users WHERE id = ? OR sharetribe_user_id = ?`,
          [sharetribe_user_id, sharetribe_user_id],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });
      if (sharetribeUser) {
        sharetribeUserDbId = sharetribeUser.id;
        console.log(`📌 CSV import will associate products with ShareTribe user ID: ${sharetribeUserDbId}`);
      } else {
        console.warn(`⚠️ ShareTribe user ${sharetribe_user_id} not found, products will not be associated with a user`);
      }
    }
    
    // Parse column mappings from JSON string if needed
    let mappings = columnMappings;
    if (typeof columnMappings === 'string') {
      try {
        mappings = JSON.parse(columnMappings);
      } catch (e) {
        fs.unlinkSync(filePath);
        return res.status(400).json({ error: 'Invalid column mappings format' });
      }
    }
    
    // Parse category mappings
    let catMappings = categoryMappings || {};
    if (typeof categoryMappings === 'string') {
      try {
        catMappings = JSON.parse(categoryMappings);
      } catch (e) {
        catMappings = {};
      }
    }
    
    // Parse category field mappings
    let catFieldMappings = categoryFieldMappings || {};
    if (typeof categoryFieldMappings === 'string') {
      try {
        catFieldMappings = JSON.parse(categoryFieldMappings);
      } catch (e) {
        catFieldMappings = {};
      }
    }
    
    // Parse category listing type mappings
    let catListingTypeMappings = categoryListingTypeMappings || {};
    if (typeof categoryListingTypeMappings === 'string') {
      try {
        catListingTypeMappings = JSON.parse(categoryListingTypeMappings);
      } catch (e) {
        catListingTypeMappings = {};
      }
    }
    
    if (!mappings || Object.keys(mappings).length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Column mappings are required' });
    }
    
    // Parse value mappings (for mapping invalid enum values to valid ones)
    let valMappings = valueMappings || {};
    if (typeof valueMappings === 'string') {
      try {
        valMappings = JSON.parse(valueMappings);
      } catch (e) {
        valMappings = {};
      }
    }
    
    // Parse unmapped field values (default values for unmapped ShareTribe fields)
    let unmappedValues = unmappedFieldValues || {};
    if (typeof unmappedFieldValues === 'string') {
      try {
        unmappedValues = JSON.parse(unmappedFieldValues);
      } catch (e) {
        unmappedValues = {};
      }
    }
    
    // Parse product-level mappings
    let productFieldMaps = productFieldMappings || {};
    if (typeof productFieldMappings === 'string') {
      try {
        productFieldMaps = JSON.parse(productFieldMappings);
      } catch (e) {
        productFieldMaps = {};
      }
    }
    
    let productUnmappedVals = productUnmappedFieldValues || {};
    if (typeof productUnmappedFieldValues === 'string') {
      try {
        productUnmappedVals = JSON.parse(productUnmappedFieldValues);
      } catch (e) {
        productUnmappedVals = {};
      }
    }
    
    console.log('Received column mappings:', JSON.stringify(mappings, null, 2));
    console.log('Received category mappings:', JSON.stringify(catMappings, null, 2));
    console.log('Received category column:', categoryColumn);
    console.log('Received category field mappings:', JSON.stringify(catFieldMappings, null, 2));
    console.log('Received category listing type mappings:', JSON.stringify(catListingTypeMappings, null, 2));
    console.log('Received value mappings:', JSON.stringify(valMappings, null, 2));
    console.log('Received unmapped field values:', JSON.stringify(unmappedValues, null, 2));
    console.log('Received product field mappings:', JSON.stringify(productFieldMaps, null, 2));
    console.log('Received product unmapped field values:', JSON.stringify(productUnmappedVals, null, 2));
    
    // Parse CSV file with custom column mappings and per-category mappings
    // Get default currency from ShareTribe marketplace config
    let defaultCurrency = null;
    try {
      const config = await syncService.getApiConfig(tenantId);
      if (config.sharetribe && config.sharetribe.marketplaceId && config.sharetribe.marketplaceApiClientId) {
        const ShareTribeService = require('../services/sharetribeService');
        const sharetribeService = new ShareTribeService(config.sharetribe);
        const marketplaceConfig = await sharetribeService.getMarketplaceConfig();
        defaultCurrency = marketplaceConfig?.currency || null;
        console.log(`Using marketplace default currency: ${defaultCurrency || 'not found'}`);
      }
    } catch (error) {
      console.warn('Could not fetch marketplace default currency:', error.message);
    }

    const products = await csvService.parseCSVWithMappings(filePath, mappings, catMappings, categoryColumn, catFieldMappings, defaultCurrency, valMappings, catListingTypeMappings, unmappedValues, productFieldMaps, productUnmappedVals);
    
    // Store products in database (mark as not synced yet)
    const dbInstance = db.getDb();
    let importedCount = 0;
    let errorCount = 0;
    const importDetails = [];
    
    if (products.length === 0) {
      // Clean up uploaded file
      fs.unlinkSync(filePath);
      return res.status(400).json({ 
        error: 'No valid products found in CSV. Please check your column mappings.',
        total: 0,
        imported: 0,
        errors: 0,
        debug: {
          csvColumns: Object.keys(mappings),
          mappings: mappings
        }
      });
    }
    
    for (const product of products) {
      // Skip null or invalid products
      if (!product || !product.ebay_item_id) {
        errorCount++;
        importDetails.push({
          itemId: product?.ebay_item_id || 'unknown',
          status: 'skipped',
          reason: 'Missing ebay_item_id',
          product: product
        });
        continue;
      }
      
      try {
        const productData = {
          title: product.title,
          price: product.price,
          description: product.description,
          allFields: Object.keys(product),
          fieldValues: Object.entries(product).map(([k, v]) => `${k}:${v !== null && v !== undefined ? v : 'NULL'}`).join(', ')
        };
        
        console.log(`Importing product ${product.ebay_item_id}:`, productData);
        
        await syncService.upsertProduct(tenantId, {
          ...product,
          synced: false,
          user_id: sharetribeUserDbId || null // Associate with ShareTribe user if provided
        });
        
        importedCount++;
        importDetails.push({
          itemId: product.ebay_item_id,
          status: 'imported',
          data: productData
        });
      } catch (error) {
        console.error(`Error importing product ${product.ebay_item_id}:`, error);
        errorCount++;
        importDetails.push({
          itemId: product.ebay_item_id,
          status: 'error',
          error: error.message,
          product: product
        });
      }
    }
    
    // Clean up uploaded file
    fs.unlinkSync(filePath);
    
    // Log summary
    console.log(`CSV Import Summary: ${importedCount} imported, ${errorCount} errors out of ${products.length} total`);
    if (importedCount > 0) {
      console.log(`Sample imported product:`, importDetails.find(d => d.status === 'imported')?.data);
    }
    if (errorCount > 0) {
      console.log(`Sample error:`, importDetails.find(d => d.status === 'error'));
    }
    
    res.json({
      success: true,
      imported: importedCount,
      errors: errorCount,
      total: products.length,
      message: `Imported ${importedCount} products from CSV`,
      debug: {
        sampleProduct: products[0] || null,
        importDetails: importDetails.slice(0, 5) // First 5 for debugging
      }
    });
  } catch (error) {
    // Clean up file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error processing CSV:', error);
    res.status(500).json({ error: error.message });
  }
});

// Apply mappings to eBay products (update existing products in database)
router.post('/products/apply-ebay-mappings', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const {
      columnMappings,
      categoryMappings = {},
      categoryColumn = null,
      categoryFieldMappings = {},
      categoryListingTypeMappings = {},
      valueMappings = {},
      unmappedFieldValues = {},
      sharetribe_user_id
    } = req.body;

    console.log('📝 Applying eBay product mappings:', {
      columnMappingsCount: Object.keys(columnMappings || {}).length,
      categoryMappingsCount: Object.keys(categoryMappings).length,
      categoryColumn,
      categoryFieldMappingsCount: Object.keys(categoryFieldMappings).length,
      sharetribe_user_id
    });

    const dbInstance = db.getDb();
    const csvService = require('../services/csvService');
    const syncService = require('../services/syncService');

    // CRITICAL: Filter products by user_id to prevent cross-user updates
    // Get ShareTribe user database ID if provided
    let sharetribeUserDbId = null;
    if (sharetribe_user_id) {
      const sharetribeUser = await new Promise((resolve, reject) => {
        dbInstance.get(
          `SELECT id FROM sharetribe_users WHERE id = ? OR sharetribe_user_id = ?`,
          [sharetribe_user_id, sharetribe_user_id],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });
      if (sharetribeUser) {
        sharetribeUserDbId = sharetribeUser.id;
        console.log(`📌 Applying mappings to products for ShareTribe user ID: ${sharetribeUserDbId}`);
      } else {
        return res.status(400).json({ error: `ShareTribe user ${sharetribe_user_id} not found` });
      }
    } else {
      return res.status(400).json({ error: 'ShareTribe user ID is required to apply mappings' });
    }

    // Get products from database filtered by user_id (they have eBay field names)
    const userFilter = sharetribeUserDbId !== null ? ' AND user_id = ?' : ' AND user_id IS NULL';
    const userFilterParams = sharetribeUserDbId !== null ? [sharetribeUserDbId] : [];
    
    const products = await new Promise((resolve, reject) => {
      dbInstance.all(
        `SELECT * FROM products WHERE tenant_id = ?${userFilter}`,
        [tenantId, ...userFilterParams],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    if (products.length === 0) {
      return res.json({ success: true, count: 0, message: 'No products found to update' });
    }

    console.log(`📦 Found ${products.length} products to update`);

    // Get marketplace currency for price mapping
    const config = await syncService.getApiConfig(tenantId);
    const defaultCurrency = config.sharetribe?.marketplaceId ? 'GBP' : null; // Default to GBP for UK marketplace

    let updatedCount = 0;
    let errorCount = 0;
    const errors = [];

    // Process each product
    for (const product of products) {
      try {
        // Merge custom_fields back into product
        let completeProduct = { ...product };
        if (product.custom_fields) {
          try {
            const customFields = JSON.parse(product.custom_fields);
            completeProduct = { ...completeProduct, ...customFields };
          } catch (e) {
            console.warn(`Failed to parse custom_fields for product ${product.ebay_item_id}:`, e.message);
          }
        }

        // Convert product to "row" format (like CSV row) for mapping
        // The product already has eBay field names, so we can use it directly as a "row"
        const productRow = completeProduct;

        // CRITICAL: Preserve price from eBay product if not mapped
        // eBay products already have price field, ensure it's preserved
        const originalPrice = completeProduct.price;
        const originalCurrency = completeProduct.currency;
        
        // Apply mappings using CSV service (it handles the mapping logic)
        const mappedProduct = csvService.mapCSVRowWithMappings(
          productRow,
          columnMappings,
          categoryMappings,
          categoryColumn,
          categoryFieldMappings,
          'ebay_item_id', // itemIdColumn - use ebay_item_id field
          defaultCurrency,
          valueMappings,
          categoryListingTypeMappings,
          unmappedFieldValues,
          productFieldMappings,
          productUnmappedFieldValues
        );

        if (!mappedProduct || !mappedProduct.ebay_item_id) {
          console.warn(`⚠️ Skipping product ${product.ebay_item_id}: mapping returned invalid product`);
          errorCount++;
          errors.push({ itemId: product.ebay_item_id, error: 'Mapping returned invalid product' });
          continue;
        }
        
        // CRITICAL: Preserve price if it wasn't mapped (eBay products already have price)
        // If price is missing or 0 after mapping, restore from original
        if ((!mappedProduct.price || mappedProduct.price === 0) && originalPrice && originalPrice > 0) {
          console.log(`💰 Preserving price from eBay product ${product.ebay_item_id}: ${originalPrice} ${originalCurrency || 'GBP'}`);
          mappedProduct.price = originalPrice;
          if (originalCurrency) {
            mappedProduct.currency = originalCurrency;
          }
        }
        
        // Also preserve other important fields that might not be mapped
        // Preserve images if they exist
        if (completeProduct.images && (!mappedProduct.images || mappedProduct.images === '')) {
          mappedProduct.images = completeProduct.images;
        }
        
        // Preserve title, description if they exist and weren't mapped
        if (completeProduct.title && (!mappedProduct.title || mappedProduct.title === '')) {
          mappedProduct.title = completeProduct.title;
        }
        if (completeProduct.description && (!mappedProduct.description || mappedProduct.description === '')) {
          mappedProduct.description = completeProduct.description;
        }

        // Update product in database (with user_id to maintain ownership)
        await syncService.upsertProduct(tenantId, {
          ...mappedProduct,
          synced: false, // Mark as needing sync after mapping update
          user_id: sharetribeUserDbId // Maintain user ownership
        });

        updatedCount++;
      } catch (error) {
        console.error(`❌ Error updating product ${product.ebay_item_id}:`, error);
        errorCount++;
        errors.push({ itemId: product.ebay_item_id, error: error.message });
      }
    }

    console.log(`✅ eBay product mappings applied: ${updatedCount} updated, ${errorCount} errors`);

    res.json({
      success: true,
      count: updatedCount,
      errors: errorCount,
      errorDetails: errors
    });
  } catch (error) {
    console.error('❌ Error applying eBay product mappings:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== Sync Routes ==========

// Manual sync
// Preview ShareTribe payload for products (without syncing)
router.post('/sync/preview', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { item_ids, sharetribe_user_id } = req.body; // Optional array of item IDs to preview
    
    const dbInstance = db.getDb();
    
    // Get API configuration
    const config = await syncService.getApiConfig(tenantId);
    if (!config.sharetribe) {
      return res.status(400).json({ error: 'API configuration incomplete. Please configure ShareTribe credentials.' });
    }

    // Get ShareTribe user ID and location if provided
    let sharetribeUserIdValue = null;
    let userLocation = null;
    let userConfig = null;
    if (sharetribe_user_id) {
      const userRow = await new Promise((resolve, reject) => {
        dbInstance.get(
          'SELECT sharetribe_user_id, location, parcel, pickup_enabled, shipping_enabled, shipping_measurement, transaction_process_alias, unit_type, default_image_id FROM sharetribe_users WHERE id = ?',
          [sharetribe_user_id],
          (err, row) => {
            if (err) {
              reject(err);
            } else {
              resolve(row);
            }
          }
        );
      });
      
      if (!userRow) {
        return res.status(400).json({ error: 'ShareTribe user not found' });
      }
      
      sharetribeUserIdValue = userRow.sharetribe_user_id;
      // Parse location JSON if it exists
      if (userRow.location) {
        try {
          userLocation = JSON.parse(userRow.location);
        } catch (e) {
          console.warn('Failed to parse user location JSON in preview:', e.message);
        }
      }
      
      // Parse parcel JSON if it exists
      let userParcel = null;
      if (userRow.parcel) {
        try {
          userParcel = JSON.parse(userRow.parcel);
        } catch (e) {
          console.warn('Failed to parse user parcel JSON in preview:', e.message);
        }
      }
      
      // Build userConfig object from userRow
      userConfig = {
        pickupEnabled: userRow.pickup_enabled !== undefined ? Boolean(userRow.pickup_enabled) : true,
        shippingEnabled: userRow.shipping_enabled !== undefined ? Boolean(userRow.shipping_enabled) : true,
        shippingMeasurement: userRow.shipping_measurement || 'custom',
        parcel: userParcel,
        transactionProcessAlias: userRow.transaction_process_alias || 'default-purchase/release-1',
        unitType: userRow.unit_type || 'item',
        defaultImageId: userRow.default_image_id || null
      };
    } else if (config.sharetribe.userId) {
      sharetribeUserIdValue = config.sharetribe.userId;
    }

    if (!sharetribeUserIdValue) {
      return res.status(400).json({ error: 'ShareTribe user ID is required. Please select a ShareTribe user.' });
    }

    // Use shared API credentials with selected user ID
    const sharetribeConfig = {
      apiKey: config.sharetribe.apiKey,
      apiSecret: config.sharetribe.apiSecret,
      marketplaceId: config.sharetribe.marketplaceId,
      userId: sharetribeUserIdValue
    };

    // Get field mappings
    const fieldMappings = await syncService.getFieldMappings(tenantId);

    // Initialize ShareTribe service
    const sharetribeService = new ShareTribeService(sharetribeConfig);

    // Get products from database
    let productsToPreview = [];
    
    // Helper function to merge custom_fields back into product object
    const mergeCustomFields = (product) => {
      // Start with the original product object (spread to ensure all properties are enumerable)
      const completeProduct = { ...product };
      
      // Ensure all standard fields are explicitly set (even if null/undefined)
      completeProduct.title = product.title || null;
      completeProduct.description = product.description || null;
      completeProduct.price = product.price !== undefined && product.price !== null ? product.price : null;
      completeProduct.currency = product.currency || null;
      completeProduct.quantity = product.quantity !== undefined && product.quantity !== null ? product.quantity : null;
      completeProduct.images = product.images || null;
      completeProduct.category = product.category || null;
      completeProduct.condition = product.condition || null;
      completeProduct.brand = product.brand || null;
      completeProduct.sku = product.sku || null;
      
      console.log(`Preview: Product ${completeProduct.ebay_item_id} from database (before custom_fields merge):`, {
        title: completeProduct.title,
        description: completeProduct.description,
        price: completeProduct.price,
        currency: completeProduct.currency,
        hasCustomFields: !!product.custom_fields,
        allKeys: Object.keys(completeProduct),
        fullProduct: JSON.stringify(completeProduct, null, 2)
      });
      
      if (product.custom_fields) {
        try {
          const customFields = JSON.parse(product.custom_fields);
          console.log(`Preview: Custom fields for product ${completeProduct.ebay_item_id}:`, customFields);
          
          // Merge ALL custom fields into the product
          for (const key in customFields) {
            completeProduct[key] = customFields[key];
          }
          
          console.log(`Preview: After merging custom_fields, product ${completeProduct.ebay_item_id}:`, {
            title: completeProduct.title,
            description: completeProduct.description,
            price: completeProduct.price,
            categoryLevel1: completeProduct.categoryLevel1,
            categoryLevel2: completeProduct.categoryLevel2,
            listingType: completeProduct.listingType,
            gearbrand: completeProduct.gearbrand,
            helmetsize: completeProduct.helmetsize,
            newused: completeProduct.newused,
            allKeys: Object.keys(completeProduct),
            fullProduct: JSON.stringify(completeProduct, null, 2)
          });
        } catch (e) {
          console.error(`Error parsing custom_fields for product ${completeProduct.ebay_item_id}:`, e);
        }
      }
      
      // Remove custom_fields from the final object
      delete completeProduct.custom_fields;
      
      return completeProduct;
    };
    
    // CRITICAL: Filter products by user_id to prevent cross-user preview
    // Get ShareTribe user database ID if provided
    let sharetribeUserDbId = null;
    if (sharetribe_user_id) {
      const sharetribeUser = await new Promise((resolve, reject) => {
        dbInstance.get(
          `SELECT id FROM sharetribe_users WHERE id = ? OR sharetribe_user_id = ?`,
          [sharetribe_user_id, sharetribe_user_id],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });
      if (sharetribeUser) {
        sharetribeUserDbId = sharetribeUser.id;
      }
    }
    
    const userFilter = sharetribeUserDbId !== null ? ' AND user_id = ?' : ' AND user_id IS NULL';
    const userFilterParams = sharetribeUserDbId !== null ? [sharetribeUserDbId] : [];
    
    if (item_ids && item_ids.length > 0) {
      const placeholders = item_ids.map(() => '?').join(',');
      productsToPreview = await new Promise((resolve, reject) => {
        dbInstance.all(
          `SELECT * FROM products WHERE tenant_id = ?${userFilter} AND ebay_item_id IN (${placeholders})`,
          [tenantId, ...userFilterParams, ...item_ids],
          (err, rows) => {
            if (err) {
              reject(err);
            } else {
              console.log(`Preview: Retrieved ${rows.length} products from database`);
              rows.forEach((row, idx) => {
                console.log(`Preview: Raw database row ${idx + 1} (${row.ebay_item_id}):`, {
                  title: row.title,
                  description: row.description,
                  price: row.price,
                  currency: row.currency,
                  custom_fields: row.custom_fields,
                  allColumns: Object.keys(row),
                  rowData: JSON.stringify(row, null, 2)
                });
              });
              resolve((rows || []).map(mergeCustomFields));
            }
          }
        );
      });
    } else {
      productsToPreview = await new Promise((resolve, reject) => {
        dbInstance.all(
          `SELECT * FROM products WHERE tenant_id = ?${userFilter}`,
          [tenantId, ...userFilterParams],
          (err, rows) => {
            if (err) {
              reject(err);
            } else {
              console.log(`Preview: Retrieved ${rows.length} products from database`);
              rows.forEach((row, idx) => {
                console.log(`Preview: Raw database row ${idx + 1} (${row.ebay_item_id}):`, {
                  title: row.title,
                  description: row.description,
                  price: row.price,
                  currency: row.currency,
                  custom_fields: row.custom_fields,
                  allColumns: Object.keys(row),
                  rowData: JSON.stringify(row, null, 2)
                });
              });
              resolve((rows || []).map(mergeCustomFields));
            }
          }
        );
      });
    }

    // Transform each product and generate payload preview
    const previews = [];
    for (const product of productsToPreview) {
      try {
        // The product from mergeCustomFields should already have all fields
        // But let's ensure it's a proper object
        console.log(`Preview: Processing product ${product.ebay_item_id}:`, {
          title: product.title,
          description: product.description,
          price: product.price,
          currency: product.currency,
          ebay_item_id: product.ebay_item_id,
          allKeys: Object.keys(product),
          hasTitle: 'title' in product,
          titleValue: product.title,
          titleType: typeof product.title,
          fullProduct: JSON.stringify(product, null, 2)
        });
        
        // Apply field mappings - this should preserve CSV products as-is
        const transformedProduct = await syncService.applyFieldMappings(product, fieldMappings);
        
        // Add user location and configuration to product data if available (same as sync endpoint)
        if (userLocation) {
          transformedProduct.location = userLocation;
          console.log(`Preview: Added location to product ${product.ebay_item_id}`);
        }
        
        // Add user parcel configuration to product data if available
        if (userConfig && userConfig.parcel) {
          transformedProduct.parcel = userConfig.parcel;
          console.log(`Preview: Added parcel to product ${product.ebay_item_id}`);
        }
        
        // Add user configuration defaults to product data
        if (userConfig) {
          transformedProduct.pickupEnabled = userConfig.pickupEnabled;
          transformedProduct.shippingEnabled = userConfig.shippingEnabled;
          transformedProduct.shippingMeasurement = userConfig.shippingMeasurement;
          transformedProduct.transactionProcessAlias = userConfig.transactionProcessAlias;
          transformedProduct.unitType = userConfig.unitType;
          if (userConfig.defaultImageId) {
            transformedProduct.defaultImageId = userConfig.defaultImageId;
          }
          console.log(`Preview: Added user config to product ${product.ebay_item_id}:`, userConfig);
        }
        
        console.log(`Preview: After applyFieldMappings for product ${product.ebay_item_id}:`, {
          title: transformedProduct.title,
          description: transformedProduct.description,
          price: transformedProduct.price,
          hasLocation: !!transformedProduct.location,
          allKeys: Object.keys(transformedProduct),
          fullTransformedProduct: JSON.stringify(transformedProduct, null, 2)
        });
        
        // Build ShareTribe payload using the SINGLE SOURCE OF TRUTH function
        // This is the EXACT same function used for actual API calls
        const payload = await sharetribeService.buildSharetribePayload(transformedProduct);
        
        console.log(`Preview: Final payload for product ${product.ebay_item_id}:`, {
          title: payload.title,
          description: payload.description,
          publicDataKeys: Object.keys(payload.publicData || {}),
          fullPayload: JSON.stringify(payload, null, 2)
        });
        
        previews.push({
          ebay_item_id: product.ebay_item_id,
          title: product.title || productWithAllFields.title || 'Unknown',
          payload: payload,
          productData: transformedProduct
        });
      } catch (error) {
        console.error(`Preview: Error processing product ${product.ebay_item_id}:`, error);
        previews.push({
          ebay_item_id: product.ebay_item_id,
          title: product.title || 'Unknown',
          error: error.message,
          stack: error.stack
        });
      }
    }

    res.json({
      success: true,
      count: previews.length,
      previews: previews
    });
  } catch (error) {
    console.error('Error previewing payload:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/sync', async (req, res) => {
  let jobId = null;
  try {
    console.log(`📋 [API] /sync endpoint called - START`);
    const tenantId = getTenantId(req);
    const { item_ids, sharetribe_user_id } = req.body; // Optional array of item IDs to sync, optional sharetribe_user_id
    
    console.log(`📋 [API] Request body:`, { item_ids, sharetribe_user_id });
    
    // Check if a sync job is already running
    const activeJobId = syncService.getActiveSyncJobId();
    if (activeJobId) {
      console.log(`📋 [API] Sync job already in progress: ${activeJobId}`);
      const activeProgress = syncService.getSyncProgress(activeJobId);
      
      // Return the existing job ID (not an error)
      const responseData = {
        success: true,
        jobId: activeJobId,
        alreadyRunning: true,
        message: 'A sync job is already in progress. Attaching to existing job.',
        progress: activeProgress ? {
          total: activeProgress.total || 0,
          completed: activeProgress.completed || 0,
          failed: activeProgress.failed || 0,
          percent: activeProgress.percent || 0,
          status: activeProgress.status || 'in_progress',
          currentStep: activeProgress.currentStep || 'Starting sync...'
        } : null
      };
      console.log(`📋 [API] Returning existing job: ${activeJobId}`);
      return res.json(responseData);
    }
    
    // Generate job ID for progress tracking
    jobId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    console.log(`📋 [API] Created sync job: ${jobId}`);
    
    // Initialize progress IMMEDIATELY so the frontend can start polling
    // Note: total will be updated when sync actually starts, but we create the job record now
    try {
      const now = Date.now();
      // Create job record in event logger immediately
      await syncEventLogger.updateJobProgress(jobId, {
        state: 'RUNNING',
        processed: 0,
        total: 0, // Will be updated when sync starts
        completed: 0,
        failed: 0,
        currentProductId: null,
        currentStep: 'Initializing sync...',
        retryAt: null,
        throttleSettings: {
          minDelayMs: 1000,
          concurrency: 100
        },
        workspaceId: tenantId,
        userId: sharetribe_user_id || null
      });
      
      syncService.updateSyncProgress(jobId, {
        jobId: jobId,
        total: 0, // Will be updated when sync starts
        completed: 0,
        failed: 0,
        percent: 0,
        status: 'starting',
        state: 'RUNNING',
        currentStep: 'Initializing sync...',
        eta: null,
        errors: [],
        workspaceId: tenantId,
        userId: sharetribe_user_id || null
      });
      console.log(`📋 [API] Progress initialized for job ${jobId}`);
    } catch (progressError) {
      console.error(`❌ [API] Error initializing progress:`, progressError);
      // Continue anyway - we'll still send the response
    }
    
    // Return immediately with job ID for progress tracking
    // Don't wait for database operations - send response first
    const responseData = { 
      success: true, 
      jobId: jobId,
      message: 'Sync started. Use /api/sync/progress/:jobId to track progress.'
    };
    console.log(`📋 [API] Sending response for job ${jobId}:`, responseData);
    res.json(responseData);
    console.log(`✅ [API] Response sent for job ${jobId}`);
    
    // Now do database operations and start sync asynchronously (after response is sent)
    try {
      const dbInstance = db.getDb();
      const logId = await new Promise((resolve, reject) => {
        dbInstance.run(
          `INSERT INTO sync_logs (tenant_id, user_id, sync_type, status) VALUES (?, ?, ?, ?)`,
          [tenantId, sharetribe_user_id || null, 'manual', 'running'],
          function(err) {
            if (err) {
              console.error(`❌ [API] Error inserting sync log for job ${jobId}:`, err);
              reject(err);
            } else {
              console.log(`📋 [API] Sync log created with ID ${this.lastID} for job ${jobId}`);
              resolve(this.lastID);
            }
          }
        );
      });

      // Start sync asynchronously (don't wait for completion)
      syncService.syncProducts(tenantId, item_ids, sharetribe_user_id, jobId)
        .then(result => {
          console.log(`✅ [API] Sync result for job ${jobId}:`, result);
          // Handle paused state (429) - don't log as completed yet
          if (result && result.paused) {
            console.log(`⏸️ [API] Sync paused (rate limit) for job ${jobId} - not logging as completed`);
            return; // Don't update log - sync will resume automatically
          }
          // Update log on completion
          const synced = result?.synced || 0;
          const failed = result?.failed || 0;
          dbInstance.run(
            `UPDATE sync_logs SET status = ?, products_synced = ?, products_failed = ?, completed_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [failed === 0 ? 'success' : 'partial', synced, failed, logId]
          );
        })
        .catch(error => {
          console.error(`❌ [API] Sync error for job ${jobId}:`, error);
          
          // Check if this is an "already running" error - if so, don't update progress as error
          const isAlreadyRunningError = error.message && error.message.includes('already in progress');
          if (isAlreadyRunningError) {
            console.log(`📋 [API] Ignoring "already running" error for job ${jobId} - this should not happen`);
            // Don't update progress - the existing job's progress should be used instead
            return;
          }
          
          // Check if this is a rate limit error (429) - should pause, not fail
          const isRateLimitError = error.response?.status === 429 || 
                                   error.status === 429 ||
                                   error.message?.includes('rate limit') ||
                                   error.message?.includes('429') ||
                                   error.message?.includes('Too Many Requests');
          
          if (isRateLimitError) {
            console.log(`⏸️ [API] Rate limit error (429) caught in API route - sync will pause and resume automatically`);
            // Don't update progress to error - the sync service should have already set it to PAUSED_RATE_LIMIT
            // Don't log as failed - it's just paused
            return;
          }
          
          // Get current progress safely
          const currentProgress = syncService.getSyncProgress(jobId) || {};
          
          // Update progress with error (only for real errors, not 429s)
          syncService.updateSyncProgress(jobId, {
            jobId: jobId,
            total: currentProgress.total || 0,
            completed: currentProgress.completed || 0,
            failed: currentProgress.failed || 0,
            percent: currentProgress.percent || 0,
            status: 'error',
            state: 'FAILED',
            currentStep: `Error: ${error.message}`,
            eta: null,
            errors: currentProgress.errors || [{ itemId: 'SYNC_ERROR', error: error.message }]
          });
          // Log error
          dbInstance.run(
            `UPDATE sync_logs SET status = ?, products_failed = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            ['failed', currentProgress.failed || 0, error.message, logId]
          );
        });
    } catch (dbError) {
      console.error(`❌ [API] Error setting up sync log for job ${jobId}:`, dbError);
      // Don't fail the request - sync can still proceed without the log entry
    }
  } catch (error) {
    console.error(`❌ [API] Error in /sync endpoint:`, error);
    console.error(`❌ [API] Error stack:`, error.stack);
    
    // Try to send error response, but don't fail if response already sent
    if (!res.headersSent) {
      // If we have a jobId, return it anyway so frontend can track progress
      if (jobId) {
        console.log(`📋 [API] Sending error response with jobId ${jobId}`);
        res.status(500).json({ 
          success: false,
          error: error.message,
          jobId: jobId,
          message: 'Sync started but encountered an error. Use /api/sync/progress/:jobId to track progress.'
        });
      } else {
        console.log(`📋 [API] Sending error response without jobId`);
        res.status(500).json({ error: error.message });
      }
    } else {
      console.log(`⚠️ [API] Response already sent, cannot send error response`);
    }
    
    // Try to log error to database (don't block)
    try {
      const tenantId = getTenantId(req);
      const dbInstance = db.getDb();
      dbInstance.run(
        `INSERT INTO sync_logs (tenant_id, sync_type, status, products_failed, error_message)
         VALUES (?, ?, ?, ?, ?)`,
        [tenantId, 'manual', 'failed', 0, error.message]
      );
    } catch (dbError) {
      console.error(`❌ [API] Error logging to database:`, dbError);
    }
  }
});

// Get active sync job (if any)
router.get('/sync/active', (req, res) => {
  try {
    const { sharetribe_user_id } = req.query;
    console.log(`📋 [API] Checking for active sync job, user: ${sharetribe_user_id}`);
    
    const activeProgress = syncService.getActiveSyncJobProgress();
    
    if (!activeProgress) {
      console.log(`📋 [API] No active sync job found`);
      return res.json({ active: false, jobId: null });
    }
    
    // If user_id is specified, verify the job belongs to that user
    // Note: We can't easily verify this without storing user_id with the job
    // For now, return the active job if it exists
    console.log(`📋 [API] Active sync job found: ${activeProgress.jobId}`);
    res.json({
      active: true,
      jobId: activeProgress.jobId || null,
      status: activeProgress.status || 'in_progress',
      total: activeProgress.total || 0,
      completed: activeProgress.completed || 0,
      failed: activeProgress.failed || 0,
      percent: activeProgress.percent || 0,
      currentStep: activeProgress.currentStep || 'Starting sync...',
      startedAt: activeProgress.lastUpdate || Date.now()
    });
  } catch (error) {
    console.error(`❌ [API] Error checking active sync job:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Get sync progress
router.get('/sync/progress/:jobId', (req, res) => {
  try {
    const { jobId } = req.params;
    console.log(`📋 [API] Progress request for job: ${jobId}`);
    const progress = syncService.getSyncProgress(jobId);
    
    if (!progress) {
      console.log(`📋 [API] Progress not found for job: ${jobId}`);
      return res.status(404).json({ error: 'Sync job not found or completed' });
    }
    
    console.log(`📋 [API] Progress found for job ${jobId}:`, {
      total: progress.total,
      completed: progress.completed,
      failed: progress.failed || 0,
      percent: progress.percent,
      status: progress.status,
      currentStep: progress.currentStep
    });
    
    // Format ETA as MM:SS
    let etaFormatted = null;
    if (progress.eta !== null && progress.eta > 0) {
      const minutes = Math.floor(progress.eta / 60);
      const seconds = progress.eta % 60;
      etaFormatted = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    
    // Build response with explicit retry state fields
    const now = Date.now();
    const lastUpdate = progress.updatedAt || progress.lastUpdatedAt || progress.lastUpdate || now;
    const secondsSinceUpdate = Math.floor((now - lastUpdate) / 1000);
    
    // Check if progress is stale (no update for >10s) - treat as PAUSED with auto-resume
    const isStale = secondsSinceUpdate > 10 && 
                    progress.state !== 'COMPLETED' && 
                    progress.state !== 'COMPLETED_SUCCESS' &&
                    progress.state !== 'FAILED';
    
    // Calculate backoff: exponential backoff based on stale duration
    const backoffSeconds = Math.min(30, Math.max(2, Math.floor(secondsSinceUpdate / 5))); // 2-30s backoff
    const staleResumeAt = isStale ? now + (backoffSeconds * 1000) : null;
    
    // Determine resumeAt: use retryAt if available, otherwise use staleResumeAt
    let resumeAt = progress.retryAt || progress.nextRetryAt || staleResumeAt;
    
    // Determine state: if stale and not terminal, set to PAUSED
    let responseState = progress.state || progress.status || 'RUNNING';
    if (isStale && !resumeAt) {
      responseState = 'PAUSED';
      resumeAt = staleResumeAt;
    }
    
    const response = {
      ...progress,
      etaFormatted: etaFormatted,
      // Explicit state machine fields - use PAUSED for all pause scenarios
      state: responseState,
      // Timestamps
      lastUpdatedAt: lastUpdate,
      updatedAt: lastUpdate,
      lastAttemptAt: progress.lastAttemptAt || null,
      // Resume fields (always populated when PAUSED)
      // CRITICAL: Always compute retryInSeconds from retryAt - now for dynamic countdown
      nextRetryAt: resumeAt,
      retryAt: resumeAt, // Explicit resumeAt timestamp (absolute epoch ms)
      retryInMs: resumeAt ? Math.max(0, resumeAt - now) : null,
      retryInSeconds: resumeAt ? Math.ceil(Math.max(0, resumeAt - now) / 1000) : null, // Always compute dynamically
      retryAttemptCount: progress.retryAttemptCount || 0,
      // Error fields
      lastErrorCode: progress.lastErrorCode || null,
      lastErrorMessage: progress.lastErrorMessage || null,
      // Progress tracking
      processed: progress.processed !== undefined 
        ? progress.processed 
        : ((progress.completed || 0) + (progress.failed || 0)),
      remaining: progress.remaining !== undefined
        ? progress.remaining
        : Math.max(0, (progress.total || 0) - ((progress.completed || 0) + (progress.failed || 0))),
      failedCount: progress.failed || 0, // Explicit failedCount for UI
      // Backward compatibility fields
      rateLimited: progress.rateLimited || false,
      retryInSeconds: resumeAt ? Math.ceil(Math.max(0, resumeAt - now) / 1000) : null,
      rateLimitRetryAfter: resumeAt ? Math.ceil(Math.max(0, resumeAt - now) / 1000) : null
    };
    
    // Update rate limit info from rateLimitStatus map if present
    const rateLimitInfo = syncService.rateLimitStatus?.get(jobId);
    if (rateLimitInfo && rateLimitInfo.paused) {
      const retryAt = rateLimitInfo.retryAt || rateLimitInfo.nextRetryAt || (rateLimitInfo.pausedAt + (rateLimitInfo.retryAfterMs || rateLimitInfo.retryAfter * 1000));
      const retryInMs = Math.max(0, retryAt - now);
      const retryInSeconds = Math.ceil(retryInMs / 1000);
      
      response.state = 'PAUSED';
      response.status = 'retry_scheduled';
      response.rateLimited = true;
      response.nextRetryAt = retryAt;
      response.retryAt = retryAt; // Explicit resumeAt timestamp
      response.retryInMs = retryInMs;
      response.retryInSeconds = retryInSeconds;
      response.rateLimitRetryAfter = retryInSeconds;
      // Include retry attempt info from rateLimitInfo if not already in progress
      if (rateLimitInfo.retryAttemptCount !== undefined) {
        response.retryAttemptCount = rateLimitInfo.retryAttemptCount;
      }
      if (rateLimitInfo.pausedAt) {
        response.lastAttemptAt = rateLimitInfo.pausedAt;
      }
    } else if (isStale && resumeAt) {
      // Stale update - ensure PAUSED state with resumeAt
      response.state = 'PAUSED';
      response.status = 'retry_scheduled';
      response.nextRetryAt = resumeAt;
      response.retryAt = resumeAt;
      response.retryInMs = Math.max(0, resumeAt - now);
      response.retryInSeconds = Math.ceil(response.retryInMs / 1000);
    }
    
    res.json(response);
  } catch (error) {
    // Ensure progress endpoint never throws and never changes job state to FAILED
    console.error(`📋 [API] Error getting progress:`, error);
    // Return a safe response - don't expose internal errors or change job state
    res.status(500).json({ 
      error: 'Failed to retrieve sync progress',
      state: 'UNKNOWN', // Don't set FAILED
      message: 'An error occurred while retrieving progress. The sync job may still be running.'
    });
  }
});

// Remove products (delete from database)
router.post('/products/remove', async (req, res) => {
  const tenantId = getTenantId(req);
  const dbInstance = db.getDb();
  const { item_ids, sharetribe_user_id } = req.body; // Optional array of item IDs to remove, and user ID for scoping
  
  let sharetribeUserDbId = null;
  
  // If user_id is provided, look it up; otherwise allow removing NULL user_id products (legacy)
  if (sharetribe_user_id) {
    const sharetribeUser = await new Promise((resolve, reject) => {
      dbInstance.get(
        `SELECT id FROM sharetribe_users WHERE id = ? OR sharetribe_user_id = ?`,
        [sharetribe_user_id, sharetribe_user_id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    
    if (!sharetribeUser) {
      return res.status(400).json({ error: `ShareTribe user ${sharetribe_user_id} not found` });
    }
    
    sharetribeUserDbId = sharetribeUser.id;
  }
  
  if (item_ids && Array.isArray(item_ids) && item_ids.length > 0) {
    // Remove selected products (scoped to user if provided, otherwise NULL user_id)
    const placeholders = item_ids.map(() => '?').join(',');
    let query, params;
    
    if (sharetribeUserDbId) {
      query = `DELETE FROM products WHERE tenant_id = ? AND user_id = ? AND ebay_item_id IN (${placeholders})`;
      params = [tenantId, sharetribeUserDbId, ...item_ids];
    } else {
      // Allow removing products with NULL user_id (legacy products)
      query = `DELETE FROM products WHERE tenant_id = ? AND user_id IS NULL AND ebay_item_id IN (${placeholders})`;
      params = [tenantId, ...item_ids];
    }
    
    dbInstance.run(query, params, function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ 
        success: true, 
        message: `Removed ${this.changes} product(s)`,
        count: this.changes 
      });
    });
  } else {
    // Remove all products for this user (or NULL user_id if no user provided)
    let query, params;
    
    if (sharetribeUserDbId) {
      query = `DELETE FROM products WHERE tenant_id = ? AND user_id = ?`;
      params = [tenantId, sharetribeUserDbId];
    } else {
      // Allow removing all products with NULL user_id (legacy products)
      query = `DELETE FROM products WHERE tenant_id = ? AND user_id IS NULL`;
      params = [tenantId];
    }
    
    dbInstance.run(query, params, function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ 
        success: true, 
        message: `Removed ${this.changes} product(s)`,
        count: this.changes 
      });
    });
  }
});

// ========== Sync Logs Routes ==========

// Get sync logs
router.get('/sync-logs', (req, res) => {
  const tenantId = getTenantId(req);
  const dbInstance = db.getDb();
  const { limit = 50 } = req.query;
  
  dbInstance.all(
    'SELECT * FROM sync_logs WHERE tenant_id = ? ORDER BY started_at DESC LIMIT ?',
    [tenantId, parseInt(limit)],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// ========== ShareTribe Users Routes ==========

// Get all ShareTribe users
router.get('/sharetribe-users', (req, res) => {
  try {
    const dbInstance = db.getDb();
    dbInstance.all(
      `SELECT id, name, sharetribe_user_id, location, 
              pickup_enabled, shipping_enabled, shipping_measurement, parcel,
              transaction_process_alias, unit_type, default_image_id, ebay_user_id,
              created_at, updated_at 
       FROM sharetribe_users ORDER BY name`,
      [],
      (err, rows) => {
        if (err) {
          console.error('Error fetching ShareTribe users:', err);
          return res.status(500).json({ error: err.message });
        }
        // Parse location JSON and convert boolean integers to booleans for each user
        const users = (rows || []).map(user => {
          let parsedLocation = null;
          let parsedParcel = null;
          try {
            parsedLocation = user.location ? JSON.parse(user.location) : null;
          } catch (e) {
            console.warn('Failed to parse location JSON for user:', user.id);
          }
          try {
            parsedParcel = user.parcel ? JSON.parse(user.parcel) : null;
          } catch (e) {
            console.warn('Failed to parse parcel JSON for user:', user.id);
          }
          return {
            ...user,
            location: parsedLocation,
            parcel: parsedParcel,
            pickup_enabled: user.pickup_enabled !== undefined ? Boolean(user.pickup_enabled) : true,
            shipping_enabled: user.shipping_enabled !== undefined ? Boolean(user.shipping_enabled) : true,
            shipping_measurement: user.shipping_measurement || 'custom',
            transaction_process_alias: user.transaction_process_alias || 'default-purchase/release-1',
            unit_type: user.unit_type || 'item',
            ebay_user_id: user.ebay_user_id || null
          };
        });
        res.json(users);
      }
    );
  } catch (error) {
    console.error('Error in /sharetribe-users endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create ShareTribe user
router.post('/sharetribe-users', (req, res) => {
  try {
    const dbInstance = db.getDb();
    const { 
      name, 
      sharetribe_user_id, 
      location,
      pickup_enabled,
      shipping_enabled,
      shipping_measurement,
      parcel,
      transaction_process_alias,
      unit_type,
      default_image_id,
      default_image_path
    } = req.body;
    
    console.log('📝 Creating ShareTribe user with data:', {
      name,
      sharetribe_user_id,
      hasLocation: !!location,
      hasParcel: !!parcel,
      pickup_enabled,
      shipping_enabled,
      shipping_measurement,
      default_image_id,
      default_image_path
    });
  
  // Validate location JSON if provided
  let locationJson = null;
  if (location) {
    try {
      // If it's a string, parse it; if it's already an object, stringify then parse to validate
      const locationObj = typeof location === 'string' ? JSON.parse(location) : location;
      locationJson = JSON.stringify(locationObj);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid location JSON: ' + e.message });
    }
  }
  
  // Validate parcel JSON if provided
  let parcelJson = null;
  if (parcel) {
    try {
      // If it's a string, parse it; if it's already an object, stringify then parse to validate
      const parcelObj = typeof parcel === 'string' ? JSON.parse(parcel) : parcel;
      parcelJson = JSON.stringify(parcelObj);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid parcel JSON: ' + e.message });
    }
  }
  
  // Convert boolean values to integers for SQLite
  const pickupEnabledInt = pickup_enabled === false || pickup_enabled === 'false' ? 0 : 1;
  const shippingEnabledInt = shipping_enabled === false || shipping_enabled === 'false' ? 0 : 1;
  
  dbInstance.run(
    `INSERT INTO sharetribe_users (
      name, sharetribe_user_id, location, 
      pickup_enabled, shipping_enabled, shipping_measurement, parcel,
      transaction_process_alias, unit_type, default_image_id, default_image_path, updated_at
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      name || null, 
      sharetribe_user_id || null, 
      locationJson,
      pickupEnabledInt,
      shippingEnabledInt,
      shipping_measurement || 'custom',
      parcelJson,
      transaction_process_alias || 'default-purchase/release-1',
      unit_type || 'item',
      default_image_id || null,
      default_image_path || null
    ],
    function(err) {
      if (err) {
        console.error('❌ Database error creating ShareTribe user:', err);
        console.error('❌ SQL Error details:', {
          message: err.message,
          code: err.code,
          errno: err.errno
        });
        return res.status(500).json({ error: err.message });
      }
      console.log('✅ ShareTribe user created successfully with ID:', this.lastID);
      res.json({ success: true, id: this.lastID });
    }
  );
  } catch (error) {
    console.error('❌ Unexpected error in POST /sharetribe-users:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Update ShareTribe user
router.put('/sharetribe-users/:id', (req, res) => {
  const dbInstance = db.getDb();
  const { 
    name, 
    sharetribe_user_id, 
    location,
    pickup_enabled,
    shipping_enabled,
    shipping_measurement,
    parcel,
    transaction_process_alias,
    unit_type,
    default_image_id,
    default_image_path
  } = req.body;
  const userId = parseInt(req.params.id);
  
  // Validate location JSON if provided
  let locationJson = null;
  if (location !== undefined && location !== null) {
    if (location === '') {
      locationJson = null; // Allow clearing location
    } else {
      try {
        // If it's a string, parse it; if it's already an object, stringify then parse to validate
        const locationObj = typeof location === 'string' ? JSON.parse(location) : location;
        locationJson = JSON.stringify(locationObj);
      } catch (e) {
        return res.status(400).json({ error: 'Invalid location JSON: ' + e.message });
      }
    }
  }
  
  // Validate parcel JSON if provided
  let parcelJson = null;
  if (parcel !== undefined && parcel !== null) {
    if (parcel === '') {
      parcelJson = null; // Allow clearing parcel
    } else {
      try {
        // If it's a string, parse it; if it's already an object, stringify then parse to validate
        const parcelObj = typeof parcel === 'string' ? JSON.parse(parcel) : parcel;
        parcelJson = JSON.stringify(parcelObj);
      } catch (e) {
        return res.status(400).json({ error: 'Invalid parcel JSON: ' + e.message });
      }
    }
  }
  
  // Convert boolean values to integers for SQLite
  const pickupEnabledInt = pickup_enabled !== undefined 
    ? (pickup_enabled === false || pickup_enabled === 'false' ? 0 : 1)
    : undefined;
  const shippingEnabledInt = shipping_enabled !== undefined
    ? (shipping_enabled === false || shipping_enabled === 'false' ? 0 : 1)
    : undefined;
  
  dbInstance.run(
    `UPDATE sharetribe_users SET
      name = ?, 
      sharetribe_user_id = ?, 
      location = COALESCE(?, location),
      pickup_enabled = COALESCE(?, pickup_enabled),
      shipping_enabled = COALESCE(?, shipping_enabled),
      shipping_measurement = COALESCE(?, shipping_measurement),
      parcel = COALESCE(?, parcel),
      transaction_process_alias = COALESCE(?, transaction_process_alias),
      unit_type = COALESCE(?, unit_type),
      default_image_id = COALESCE(?, default_image_id),
      default_image_path = COALESCE(?, default_image_path),
      updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      name, 
      sharetribe_user_id, 
      locationJson,
      pickupEnabledInt,
      shippingEnabledInt,
      shipping_measurement,
      parcelJson,
      transaction_process_alias,
      unit_type,
      default_image_id,
      default_image_path,
      userId
    ],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, changes: this.changes });
    }
  );
});

// Upload default image for ShareTribe user
router.post('/sharetribe-users/:id/upload-image', imageUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const userId = parseInt(req.params.id);
    const dbInstance = db.getDb();
    
    // Get user to fetch API config
    const userRow = await new Promise((resolve, reject) => {
      dbInstance.get(
        'SELECT sharetribe_user_id FROM sharetribe_users WHERE id = ?',
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!userRow) {
      return res.status(404).json({ error: 'ShareTribe user not found' });
    }

    // Get API configuration
    const tenantId = getTenantId(req);
    const config = await syncService.getApiConfig(tenantId);

    if (!config.sharetribe || !config.sharetribe.apiKey || !config.sharetribe.apiSecret) {
      return res.status(400).json({ error: 'ShareTribe API credentials not configured' });
    }

    // Initialize ShareTribe service
    const sharetribeConfig = {
      apiKey: config.sharetribe.apiKey,
      apiSecret: config.sharetribe.apiSecret,
      marketplaceId: config.sharetribe.marketplaceId,
      userId: userRow.sharetribe_user_id
    };

    const sharetribeService = new ShareTribeService(sharetribeConfig);

    // Upload image to ShareTribe (this UUID is just for reference, we'll upload again for each listing)
    const imageId = await sharetribeService.uploadImage(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );

    // Save image file to disk for reuse
    const imagesDir = './uploads/images';
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }
    
    const imageFileName = `default-image-${userId}-${Date.now()}${path.extname(req.file.originalname)}`;
    const imagePath = path.join(imagesDir, imageFileName);
    
    // Write file to disk
    fs.writeFileSync(imagePath, req.file.buffer);
    console.log(`✅ Saved default image file to: ${imagePath}`);

    // Delete old image file if it exists
    const oldUserRow = await new Promise((resolve, reject) => {
      dbInstance.get(
        'SELECT default_image_path FROM sharetribe_users WHERE id = ?',
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    
    if (oldUserRow && oldUserRow.default_image_path && fs.existsSync(oldUserRow.default_image_path)) {
      try {
        fs.unlinkSync(oldUserRow.default_image_path);
        console.log(`🗑️ Deleted old default image file: ${oldUserRow.default_image_path}`);
      } catch (unlinkErr) {
        console.warn(`⚠️ Could not delete old image file: ${unlinkErr.message}`);
      }
    }

    // Save image ID and file path to database
    dbInstance.run(
      'UPDATE sharetribe_users SET default_image_id = ?, default_image_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [imageId, imagePath, userId],
      function(err) {
        if (err) {
          // Clean up file if database update fails
          try {
            fs.unlinkSync(imagePath);
          } catch (unlinkErr) {
            console.warn(`⚠️ Could not clean up image file: ${unlinkErr.message}`);
          }
          return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, imageId: imageId });
      }
    );
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all users from ShareTribe (for user selection)
// Note: Requires Integration API credentials (Client ID + Client Secret)
// Marketplace API does not support querying users
router.get('/sharetribe-users/query', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const config = await syncService.getApiConfig(tenantId);

    if (!config.sharetribe || !config.sharetribe.apiKey) {
      return res.status(400).json({ error: 'ShareTribe API credentials not configured' });
    }

    if (!config.sharetribe.apiSecret) {
      return res.status(400).json({ 
        error: 'ShareTribe Integration API credentials required. User query requires both Client ID and Client Secret. Marketplace API does not support querying users.' 
      });
    }

    // Initialize ShareTribe service with Integration API credentials
    const sharetribeConfig = {
      apiKey: config.sharetribe.apiKey,
      apiSecret: config.sharetribe.apiSecret, // Required for Integration API
      marketplaceId: config.sharetribe.marketplaceId,
      marketplaceApiClientId: config.sharetribe.marketplaceApiClientId || '', // Optional
      userId: '' // Not needed for querying users
    };

    const sharetribeService = new ShareTribeService(sharetribeConfig);
    const users = await sharetribeService.getAllUsers();

    res.json({ success: true, users: users });
  } catch (error) {
    console.error('Error querying ShareTribe users:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete ShareTribe user
router.delete('/sharetribe-users/:id', (req, res) => {
  const dbInstance = db.getDb();
  const userId = parseInt(req.params.id);
  
  dbInstance.run(
    'DELETE FROM sharetribe_users WHERE id = ?',
    [userId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, changes: this.changes });
    }
  );
});

// Debug endpoint to check product data
router.get('/debug/products/:itemId', (req, res) => {
  const tenantId = getTenantId(req);
  const dbInstance = db.getDb();
  const { itemId } = req.params;
  
  dbInstance.get(
    'SELECT * FROM products WHERE tenant_id = ? AND ebay_item_id = ?',
    [tenantId, itemId],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (!row) {
        return res.status(404).json({ error: 'Product not found' });
      }
      res.json({
        product: row,
        fields: Object.keys(row),
        nonNullFields: Object.keys(row).filter(k => row[k] !== null && row[k] !== undefined),
        nullFields: Object.keys(row).filter(k => row[k] === null).map(k => ({ field: k, value: row[k] }))
      });
    }
  );
});

// Debug endpoint to list all products
router.get('/debug/products', (req, res) => {
  const tenantId = getTenantId(req);
  const dbInstance = db.getDb();
  
  dbInstance.all(
    'SELECT ebay_item_id, title, price, description, synced FROM products WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20',
    [tenantId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({
        count: rows.length,
        products: rows.map(row => ({
          ebay_item_id: row.ebay_item_id,
          title: row.title || '(NULL)',
          price: row.price || '(NULL)',
          description: row.description ? row.description.substring(0, 50) + '...' : '(NULL)',
          synced: row.synced
        }))
      });
    }
  );
});

// Debug endpoint to test field mapping transformation
router.get('/debug/test-transform/:itemId', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { itemId } = req.params;
    const dbInstance = db.getDb();
    
    // Get product from database
    const product = await new Promise((resolve, reject) => {
      dbInstance.get(
        'SELECT * FROM products WHERE tenant_id = ? AND ebay_item_id = ?',
        [tenantId, itemId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    // Get field mappings
    const fieldMappings = await syncService.getFieldMappings(tenantId);
    
    // Test transformation
    const transformed = await syncService.applyFieldMappings(product, fieldMappings);
    
    res.json({
      original: {
        keys: Object.keys(product),
        title: product.title,
        titleType: typeof product.title,
        hasTitle: 'title' in product,
        allFields: product
      },
      transformed: {
        keys: Object.keys(transformed),
        title: transformed.title,
        titleType: typeof transformed.title,
        hasTitle: 'title' in transformed,
        allFields: transformed
      },
      fieldMappings: fieldMappings
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to test ShareTribe API call (dry run - doesn't actually create listing)
router.post('/debug/test-sharetribe', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { itemId } = req.params;
    const { productData } = req.body;
    
    if (!productData) {
      return res.status(400).json({ error: 'productData is required' });
    }
    
    // Get API config
    const config = await syncService.getApiConfig(tenantId);
    if (!config.sharetribe) {
      return res.status(400).json({ error: 'ShareTribe API not configured' });
    }
    
    const ShareTribeService = require('../services/sharetribeService');
    const sharetribeService = new ShareTribeService(config.sharetribe);
    
    // Transform product data
    const listingData = await sharetribeService.transformProductToShareTribe(productData);
    
    res.json({
      success: true,
      listingData: listingData,
      message: 'This is a dry run - no listing was created. Check listingData to see what would be sent to ShareTribe.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Debug endpoint: Get Asset Delivery API responses
router.get('/admin/asset-delivery-api', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const config = await syncService.getApiConfig(tenantId);
    
    if (!config.sharetribe || !config.sharetribe.marketplaceApiClientId) {
      return res.status(400).json({ 
        error: 'ShareTribe Marketplace API Client ID not configured',
        endpoint: null,
        response: null
      });
    }
    
    const marketplaceApiClientId = config.sharetribe.marketplaceApiClientId;
    const assetDeliveryEndpoint = `https://cdn.st-api.com/v1/assets/pub/${marketplaceApiClientId}/a/latest/listings/listing-types.json`;
    
    const axios = require('axios');
    let responseData = null;
    let responseStatus = null;
    let error = null;
    
    try {
      const response = await axios.get(assetDeliveryEndpoint, {
        headers: {
          'Accept': 'application/json'
        },
        validateStatus: function (status) {
          return status < 500; // Don't throw on 4xx errors
        }
      });
      
      responseStatus = response.status;
      responseData = response.data;
    } catch (err) {
      error = {
        message: err.message,
        code: err.code,
        response: err.response ? {
          status: err.response.status,
          statusText: err.response.statusText,
          data: err.response.data
        } : null
      };
    }
    
    res.json({
      endpoint: assetDeliveryEndpoint,
      status: responseStatus,
      response: responseData,
      error: error,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching Asset Delivery API response:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/debug/sharetribe-config', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const config = await syncService.getApiConfig(tenantId);
    
    if (!config.sharetribe) {
      return res.json({ error: 'ShareTribe API not configured' });
    }
    
    res.json({
      configured: true,
      marketplaceId: config.sharetribe.marketplaceId,
      apiKey: config.sharetribe.apiKey ? `${config.sharetribe.apiKey.substring(0, 10)}...` : 'missing',
      apiSecret: config.sharetribe.apiSecret ? `${config.sharetribe.apiSecret.substring(0, 10)}...` : 'missing',
      userId: config.sharetribe.userId,
      apiUrl: `https://api.sharetribe.com/v1/marketplaces/${config.sharetribe.marketplaceId}/own_listings.json`,
      note: 'Check that Marketplace ID matches your ShareTribe Console URL (the part after /m/)'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to test ShareTribe API call directly
router.get('/debug/test-sharetribe-api', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const config = await syncService.getApiConfig(tenantId);
    
    if (!config.sharetribe) {
      return res.status(400).json({ error: 'ShareTribe API not configured' });
    }
    
    const axios = require('axios');
    const apiUrl = `https://api.sharetribe.com/v1/marketplaces/${config.sharetribe.marketplaceId}/own_listings.json`;
    
    console.log('Testing ShareTribe API with GET request...');
    console.log('URL:', apiUrl);
    console.log('Client ID:', config.sharetribe.apiKey ? `${config.sharetribe.apiKey.substring(0, 15)}...` : 'MISSING');
    console.log('Marketplace ID:', config.sharetribe.marketplaceId);
    
    try {
      const response = await axios.get(apiUrl, {
        auth: {
          username: config.sharetribe.apiKey,
          password: config.sharetribe.apiSecret
        },
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        params: {
          per_page: 1
        },
        validateStatus: function (status) {
          return status < 500; // Don't throw on 4xx errors
        }
      });
      
      const contentType = response.headers['content-type'] || '';
      const isHtml = contentType.includes('text/html') || 
                     (typeof response.data === 'string' && (response.data.trim().startsWith('<!DOCTYPE') || response.data.trim().startsWith('<html')));
      
      res.json({
        success: !isHtml && response.status >= 200 && response.status < 300,
        status: response.status,
        statusText: response.statusText,
        contentType: contentType,
        isHtml: isHtml,
        responseType: typeof response.data,
        responsePreview: typeof response.data === 'string' 
          ? response.data.substring(0, 500) 
          : JSON.stringify(response.data).substring(0, 500),
        headers: response.headers,
        apiUrl: apiUrl,
        marketplaceId: config.sharetribe.marketplaceId
      });
    } catch (error) {
      res.json({
        success: false,
        error: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        contentType: error.response?.headers?.['content-type'],
        responsePreview: typeof error.response?.data === 'string' 
          ? error.response.data.substring(0, 500)
          : JSON.stringify(error.response?.data).substring(0, 500),
        apiUrl: apiUrl,
        marketplaceId: config.sharetribe.marketplaceId
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== eBay OAuth Routes ==========

// Start eBay OAuth flow
router.get('/auth/ebay', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { sandbox = 'true', sharetribe_user_id } = req.query; // Default to sandbox, optional ShareTribe user ID
    
    // Get API config for tenant
    const config = await syncService.getApiConfig(tenantId);
    if (!config.ebay || !config.ebay.appId || !config.ebay.certId) {
      return res.status(400).json({ 
        error: 'eBay API credentials not configured. Please configure App ID and Cert ID first.' 
      });
    }

    // Use sandbox from query param or config
    // Query param can be 'true', 'false', or undefined
    // Config.ebay.sandbox is a boolean (true for sandbox, false for production)
    let useSandbox = true; // Default to sandbox for safety
    if (sandbox !== undefined) {
      // Query param takes precedence
      useSandbox = sandbox === 'true' || sandbox === true;
    } else if (config.ebay.sandbox !== undefined && config.ebay.sandbox !== null) {
      // Use config value
      useSandbox = config.ebay.sandbox === true || config.ebay.sandbox === 1;
    }
    
    console.log('🔍 Sandbox determination:', {
      queryParam: sandbox,
      configValue: config.ebay.sandbox,
      useSandbox: useSandbox,
      environment: useSandbox ? 'SANDBOX' : 'PRODUCTION'
    });

    // Get redirect URI (RuName or full URL)
    // For eBay OAuth, redirect_uri should be:
    // - RuName (recommended for sandbox): e.g., "Tyler_Maddren-TylerMad-ShareT-jwplfdid"
    // - Full HTTPS URL (for production/ngrok): e.g., "https://abc123.ngrok.io/api/ebay/callback"
    // Note: The Auth Accepted URL in eBay Developer Portal should point to: https://your-ngrok.io/api/ebay/callback
    let redirectUri = config.ebay.redirectUri;
    if (!redirectUri) {
      return res.status(400).json({ 
        error: 'eBay redirect URI not configured. Please configure it in API Settings.' 
      });
    }
    
    console.log('🚀 Initiating eBay OAuth');
    console.log('🔗 Redirect URI:', redirectUri.startsWith('http') ? redirectUri : 'RuName: ' + redirectUri);

    // Initialize OAuth service
    const oauthService = new eBayOAuthService({
      appId: config.ebay.appId,
      certId: config.ebay.certId,
      devId: config.ebay.devId,
      sandbox: useSandbox,
      redirectUri: redirectUri
    });

    // Generate state token for CSRF protection
    const stateToken = oauthService.generateStateToken();
    
    // Encode sharetribe_user_id in state if provided
    const stateData = {
      token: stateToken,
      sharetribe_user_id: sharetribe_user_id || null
    };
    const encodedState = Buffer.from(JSON.stringify(stateData)).toString('base64');
    
    // Store state in session or return it to client to verify on callback
    // For now, we'll include it in the redirect URL as a query param
    const authUrl = oauthService.getAuthorizationUrl(encodedState);

    res.json({
      authUrl,
      state: encodedState,
      sandbox: sandbox === 'true'
    });
  } catch (error) {
    console.error('Error initiating eBay OAuth:', error);
    res.status(500).json({ error: error.message });
  }
});

// eBay OAuth callback handler - processes the authorization code
async function handleEbayOAuthCallback(req, res) {
  try {
    const tenantId = getTenantId(req);
    const { code, state } = req.query;

    console.log('🔔 eBay OAuth Callback received at /auth/accepted');
    console.log('📥 Full query params:', JSON.stringify(req.query, null, 2));
    console.log('📥 Code:', code ? code.substring(0, 50) + '...' : 'missing');
    console.log('📥 State:', state ? state.substring(0, 50) + '...' : 'missing');
    
    // Check for error in query params (eBay may redirect with error instead of code)
    if (req.query.error) {
      console.error('❌ eBay OAuth Error:', req.query.error);
      console.error('❌ Error Description:', req.query.error_description || 'No description provided');
      return res.status(400).send(`
        <html>
          <body>
            <h1>eBay Authorization Failed</h1>
            <p><strong>Error:</strong> ${req.query.error}</p>
            <p><strong>Description:</strong> ${req.query.error_description || 'No description provided'}</p>
            <p>Common causes:</p>
            <ul>
              <li>Invalid or disabled OAuth scope - check eBay Developer Portal → Application Keys → OAuth Scopes</li>
              <li>Redirect URI mismatch - ensure redirect URI matches exactly in eBay Developer Portal</li>
              <li>App not properly configured in eBay Developer Portal</li>
            </ul>
            <p><a href="/">Return to Dashboard</a></p>
          </body>
        </html>
      `);
    }

    if (!code) {
      console.error('❌ Authorization code not provided in query params');
      return res.status(400).send(`
        <html>
          <body>
            <h1>Authorization Failed</h1>
            <p>Authorization code not provided. Please try connecting again.</p>
            <p><a href="/">Return to Dashboard</a></p>
          </body>
        </html>
      `);
    }

    // Parse and validate state BEFORE token exchange
    let sharetribeUserId = null;
    let stateToken = null;
    if (state) {
      try {
        const decodedState = Buffer.from(state, 'base64').toString();
        console.log('🔍 Decoded state:', decodedState);
        const stateData = JSON.parse(decodedState);
        sharetribeUserId = stateData.sharetribe_user_id || null;
        stateToken = stateData.token || null;
        console.log('✅ State parsed successfully');
        console.log('📋 ShareTribe User ID from state:', sharetribeUserId);
        console.log('📋 State token:', stateToken ? stateToken.substring(0, 20) + '...' : 'none');
      } catch (e) {
        console.warn('⚠️ Failed to parse state token:', e.message);
        console.warn('⚠️ State value:', state.substring(0, 50));
      }
    } else {
      console.warn('⚠️ No state token provided in callback');
    }

    // Get API config for tenant
    const config = await syncService.getApiConfig(tenantId);
    if (!config.ebay || !config.ebay.appId || !config.ebay.certId) {
      return res.status(400).json({ 
        error: 'eBay API credentials not configured' 
      });
    }

    // Determine sandbox/production from config
    const useSandbox = config.ebay.sandbox !== false; // Default to sandbox

    // Get redirect URI (RuName or full URL)
    // IMPORTANT: For token exchange, we MUST use the RuName if a RuName was used in the authorization request
    // eBay requires the redirect_uri in token exchange to match exactly what was sent in authorization
    let redirectUri = config.ebay.redirectUri;
    if (!redirectUri) {
      console.error('❌ No eBay redirect URI configured');
      return res.status(400).send(`
        <html>
          <body>
            <h1>Configuration Error</h1>
            <p>eBay redirect URI not configured. Please configure it in API Settings.</p>
            <p><a href="/">Return to Dashboard</a></p>
          </body>
        </html>
      `);
    }

    // Determine if redirectUri is RuName or full URL
    const isRuName = !redirectUri.startsWith('http://') && !redirectUri.startsWith('https://');
    console.log('🔗 Redirect URI type:', isRuName ? 'RuName' : 'Full URL');
    console.log('🔗 Redirect URI value:', redirectUri);

    // IMPORTANT: For token exchange, eBay requires the redirect_uri to be the RuName
    // If redirectUri is a full URL, we need to extract the RuName
    // The RuName should be stored in config, but for now we'll use redirectUri as-is
    // If it's a RuName (doesn't start with http), use it directly
    // If it's a URL, we need the RuName - check if we can extract it or use the URL
    let redirectUriForTokenExchange = redirectUri;
    
    // IMPORTANT: For token exchange, eBay requires redirect_uri to be the RuName
    // If redirectUri is a RuName, use it directly for token exchange
    // If redirectUri is a full URL, we still need the RuName - it should be the same value
    // that was used in the authorization request
    console.log('🔗 Token exchange will use:', isRuName ? 'RuName: ' + redirectUri : 'Full URL: ' + redirectUri);
    if (!isRuName) {
      console.warn('⚠️ Redirect URI is a full URL. Token exchange may require RuName.');
      console.warn('⚠️ Ensure the redirect_uri matches what was sent in authorization request.');
    }

    // Initialize OAuth service
    // Pass ruName separately if redirectUri is a URL but we need RuName for token exchange
    const oauthService = new eBayOAuthService({
      appId: config.ebay.appId,
      certId: config.ebay.certId,
      devId: config.ebay.devId,
      sandbox: useSandbox,
      redirectUri: redirectUri, // Original redirect URI
      ruName: isRuName ? redirectUri : null // If redirectUri is RuName, use it for token exchange
    });

    // Exchange code for tokens
    console.log('🔄 Starting token exchange...');
    let tokenResponse;
    try {
      tokenResponse = await oauthService.exchangeCodeForToken(code);
      console.log('✅ Token exchange successful');
    } catch (error) {
      console.error('❌ Token exchange failed:', error.message);
      console.error('❌ Full error:', error);
      
      // Mask token request details for display
      const maskToken = (token) => {
        if (!token || token.length < 8) return '***';
        return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
      };
      
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Token Exchange Failed</title>
            <style>
              body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
              .error { background: #fee; border: 1px solid #fcc; padding: 15px; border-radius: 5px; margin: 20px 0; }
              .code { background: #f5f5f5; padding: 10px; border-radius: 3px; font-family: monospace; margin: 10px 0; }
              .label { font-weight: bold; color: #666; margin-top: 15px; }
            </style>
          </head>
          <body>
            <h1>❌ Token Exchange Failed</h1>
            <div class="error">
              <p><strong>Error:</strong> ${error.message}</p>
              <p>Check backend logs for details.</p>
            </div>
            <p><a href="/">Return to Dashboard</a></p>
          </body>
        </html>
      `);
    }
    
    // Get eBay user info using the access token
    // According to eBay docs, the access token identifies the seller account
    // If we can't get the username, we'll generate a unique ID from the token
    console.log('🔄 Fetching eBay user info...');
    let userInfo;
    let ebayUserId = null;
    
    try {
      userInfo = await oauthService.getUserInfo(tokenResponse.access_token);
      ebayUserId = userInfo.ebay_user_id;
      console.log('✅ eBay user info retrieved:', {
        ebay_user_id: ebayUserId,
        email: userInfo.email || 'not provided',
        account_type: userInfo.account_type || 'not provided'
      });
    } catch (error) {
      console.warn('⚠️ Failed to get eBay user info from API:', error.message);
      console.warn('⚠️ Error details:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });
      
      // According to eBay docs: "the access token identifies the seller account"
      // If we can't get username, generate a unique ID from the access token
      // This is a hash of the first part of the token to create a stable identifier
      const crypto = require('crypto');
      const tokenHash = crypto.createHash('sha256').update(tokenResponse.access_token.substring(0, 50)).digest('hex').substring(0, 16);
      ebayUserId = `ebay_${tokenHash}`;
      
      console.log('✅ Generated eBay user ID from access token:', ebayUserId);
      console.log('ℹ️ Note: This is a token-based identifier. To get the actual eBay username, ensure sell.account.readonly scope is enabled.');
      
      userInfo = {
        ebay_user_id: ebayUserId,
        email: null,
        account_type: null
      };
    }
    
    // Ensure we have a user ID (either from API or generated)
    if (!ebayUserId) {
      console.error('❌ Failed to get or generate eBay user ID');
      return res.status(500).send(`
        <html>
          <body>
            <h1>Failed to Identify eBay Account</h1>
            <p>Unable to identify the eBay account. Please try reconnecting.</p>
            <p><a href="/">Return to Dashboard</a></p>
          </body>
        </html>
      `);
    }

    // Calculate token expiry
    const tokenExpiry = new Date();
    tokenExpiry.setSeconds(tokenExpiry.getSeconds() + tokenResponse.expires_in);

    // Store tokens in database against eBay user ID
    console.log('💾 Storing tokens in database...');
    const dbInstance = db.getDb();
    await new Promise((resolve, reject) => {
      dbInstance.run(
        `INSERT OR REPLACE INTO ebay_users 
         (tenant_id, ebay_user_id, access_token, refresh_token, token_expiry, sandbox, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          tenantId,
          ebayUserId, // Use the validated/generated user ID
          tokenResponse.access_token,
          tokenResponse.refresh_token,
          tokenExpiry.toISOString(),
          useSandbox ? 1 : 0
        ],
        function(err) {
          if (err) {
            console.error('❌ Error storing tokens:', err);
            reject(err);
          } else {
            console.log('✅ Tokens stored successfully for eBay user:', ebayUserId);
            resolve(ebayUserId);
          }
        }
      );
    });

    // If sharetribe_user_id was provided, associate eBay user with ShareTribe user
    if (sharetribeUserId) {
      console.log(`🔗 Associating eBay user ${ebayUserId} with ShareTribe user ${sharetribeUserId}`);
      
      // First, check if user exists and get their current state
      const checkUser = await new Promise((resolve, reject) => {
        dbInstance.get(
          `SELECT id, sharetribe_user_id, name, ebay_user_id FROM sharetribe_users WHERE sharetribe_user_id = ?`,
          [sharetribeUserId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });
      
      if (!checkUser) {
        console.error(`❌ User with sharetribe_user_id ${sharetribeUserId} does not exist in database`);
        // List all users to help debug
        const allUsers = await new Promise((resolve, reject) => {
          dbInstance.all(
            `SELECT id, sharetribe_user_id, name FROM sharetribe_users`,
            [],
            (err, rows) => {
              if (err) reject(err);
              else resolve(rows);
            }
          );
        });
        console.log(`📋 All ShareTribe users in database:`, allUsers);
      } else {
        console.log(`✅ Found ShareTribe user before update:`, checkUser);
        
        const updateResult = await new Promise((resolve, reject) => {
          dbInstance.run(
            `UPDATE sharetribe_users 
             SET ebay_user_id = ?, updated_at = CURRENT_TIMESTAMP
             WHERE sharetribe_user_id = ?`,
            [ebayUserId, sharetribeUserId],
            function(err) {
              if (err) reject(err);
              else resolve({ changes: this.changes, lastID: this.lastID });
            }
          );
        });
        
        console.log(`✅ Update result:`, updateResult);
        
        if (updateResult.changes === 0) {
          console.error(`❌ UPDATE failed - no rows affected. This should not happen if user exists.`);
        } else {
          console.log(`✅ Successfully associated eBay user ${ebayUserId} with ShareTribe user ${sharetribeUserId}`);
          // Verify the association was saved
          const verifyUser = await new Promise((resolve, reject) => {
            dbInstance.get(
              `SELECT id, sharetribe_user_id, ebay_user_id FROM sharetribe_users WHERE sharetribe_user_id = ?`,
              [sharetribeUserId],
              (err, row) => {
                if (err) reject(err);
                else resolve(row);
              }
            );
          });
          console.log(`🔍 Verification - User after update:`, verifyUser);
        }
      }
    } else {
      console.log('ℹ️ No sharetribe_user_id provided, skipping association');
    }

    // Redirect to frontend success page
    // Note: eBay redirects to the Auth Accepted URL (this callback route) with code and state in query params
    // After processing, we redirect to the frontend
    
    // Determine frontend URL dynamically:
    // 1. Try to detect from request headers (if coming from ngrok) - most reliable
    // 2. Use the Auth Accepted URL from config (which should be the ngrok URL if configured)
    // 3. Fall back to FRONTEND_URL env var or localhost
    let frontendUrl = process.env.FRONTEND_URL || `http://localhost:3000`;
    
    // First, try to detect from request headers (if coming from ngrok)
    // Check multiple header sources for ngrok detection
    const host = req.get('host') || req.get('x-forwarded-host') || req.headers.host;
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
    const forwardedHost = req.get('x-forwarded-host');
    
    // Log all relevant headers for debugging
    console.log('🔍 Request headers for URL detection:', {
      host: req.get('host'),
      'x-forwarded-host': req.get('x-forwarded-host'),
      'x-forwarded-proto': req.get('x-forwarded-proto'),
      protocol: req.protocol,
      headers: Object.keys(req.headers).filter(k => k.toLowerCase().includes('host') || k.toLowerCase().includes('forwarded'))
    });
    
    // Use forwarded host if available (ngrok sets this)
    const detectedHost = forwardedHost || host;
    
    // If host contains ngrok domain, use it (most reliable method)
    if (detectedHost && (detectedHost.includes('ngrok') || detectedHost.includes('ngrok-free.dev') || detectedHost.includes('ngrok.io') || detectedHost.includes('ngrok.app'))) {
      // Ensure HTTPS for ngrok
      const detectedProtocol = protocol === 'https' || protocol === 'http' && detectedHost.includes('ngrok') ? 'https' : protocol;
      frontendUrl = `${detectedProtocol}://${detectedHost}`;
      console.log('🔗 Detected ngrok URL from request headers:', frontendUrl);
    } else {
      // Try to get Auth Accepted URL from config
      // The config structure from getApiConfig may have ebay_auth_accepted_url at the root level
      const authAcceptedUrl = config.ebay_auth_accepted_url || (config.ebay && config.ebay.authAcceptedUrl);
      
      if (authAcceptedUrl && authAcceptedUrl.startsWith('https://')) {
        try {
          const url = new URL(authAcceptedUrl);
          frontendUrl = `${url.protocol}//${url.host}`;
          console.log('🔗 Using frontend URL from Auth Accepted URL config:', frontendUrl);
        } catch (e) {
          console.warn('⚠️ Failed to parse Auth Accepted URL, using fallback');
          console.log('🔗 Using configured frontend URL:', frontendUrl);
        }
      } else {
        console.log('🔗 Using configured frontend URL:', frontendUrl);
      }
    }
    
    // Helper function to mask tokens for display
    const maskToken = (token) => {
      if (!token || token.length < 8) return '***';
      return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
    };
    
    // Build success page with token details
    const environment = useSandbox ? 'SANDBOX' : 'PRODUCTION';
    const tokenRequestUrl = useSandbox 
      ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
      : 'https://api.ebay.com/identity/v1/oauth2/token';
    
    const successPage = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>eBay Account Connected</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 900px; margin: 50px auto; padding: 20px; background: #f5f5f5; }
            .container { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            h1 { color: #28a745; margin-bottom: 10px; }
            .env-badge { display: inline-block; padding: 5px 12px; border-radius: 4px; font-weight: bold; font-size: 12px; margin-left: 10px; }
            .env-production { background: #28a745; color: white; }
            .env-sandbox { background: #ffc107; color: #000; }
            .section { margin: 25px 0; padding: 20px; background: #f9f9f9; border-radius: 5px; border-left: 4px solid #007bff; }
            .section h2 { margin-top: 0; color: #333; font-size: 18px; }
            .code-block { background: #2d2d2d; color: #f8f8f2; padding: 15px; border-radius: 5px; overflow-x: auto; font-family: 'Courier New', monospace; font-size: 13px; margin: 10px 0; }
            .token { color: #a6e22e; }
            .label { font-weight: bold; color: #666; margin-top: 15px; display: block; }
            .value { color: #333; margin-left: 10px; }
            .success { color: #28a745; font-weight: bold; }
            .info { color: #17a2b8; }
            .btn { display: inline-block; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px; }
            .btn:hover { background: #0056b3; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ eBay Account Connected Successfully 
              <span class="env-badge ${useSandbox ? 'env-sandbox' : 'env-production'}">${environment}</span>
            </h1>
            <p class="success">Your eBay account has been successfully connected and authenticated.</p>
            
            <div class="section">
              <h2>📤 Token Request (${environment})</h2>
              <div class="code-block">
                <div><span style="color: #f92672;">POST</span> <span style="color: #66d9ef;">${tokenRequestUrl}</span></div>
                <div style="margin-top: 10px;">
                  <div><span style="color: #a6e22e;">grant_type</span>=<span style="color: #e6db74;">authorization_code</span></div>
                  <div><span style="color: #a6e22e;">code</span>=<span style="color: #e6db74;">${maskToken(code)}</span></div>
                  <div><span style="color: #a6e22e;">redirect_uri</span>=<span style="color: #e6db74;">${maskToken(redirectUri)}</span></div>
                </div>
              </div>
            </div>
            
            <div class="section">
              <h2>📥 Token Response (Masked)</h2>
              <div class="code-block">
                <div>{</div>
                <div>  <span style="color: #a6e22e;">"access_token"</span>: <span class="token">"${maskToken(tokenResponse.access_token)}"</span>,</div>
                <div>  <span style="color: #a6e22e;">"expires_in"</span>: <span style="color: #ae81ff;">${tokenResponse.expires_in}</span>,</div>
                <div>  <span style="color: #a6e22e;">"token_type"</span>: <span style="color: #e6db74;">"${tokenResponse.token_type || 'User Access Token'}"</span>,</div>
                <div>  <span style="color: #a6e22e;">"refresh_token"</span>: <span class="token">"${maskToken(tokenResponse.refresh_token)}"</span>,</div>
                <div>  <span style="color: #a6e22e;">"refresh_token_expires_in"</span>: <span style="color: #ae81ff;">${tokenResponse.refresh_token_expires_in || 'N/A'}</span></div>
                <div>}</div>
              </div>
            </div>
            
            <div class="section">
              <h2>👤 Account Information</h2>
              <div>
                <span class="label">eBay User ID:</span>
                <span class="value">${ebayUserId}</span>
              </div>
              ${userInfo?.email ? `<div><span class="label">Email:</span><span class="value">${userInfo.email}</span></div>` : ''}
              ${sharetribeUserId ? `<div><span class="label">ShareTribe User:</span><span class="value">${sharetribeUserId}</span></div>` : ''}
            </div>
            
            <p class="info">⚠️ <strong>Security Note:</strong> Tokens are masked for security. Full tokens are stored securely in the database.</p>
            
            <a href="${frontendUrl}/?ebay_connected=true&user_id=${ebayUserId}${sharetribeUserId ? `&sharetribe_user_id=${sharetribeUserId}` : ''}" class="btn">Continue to Dashboard</a>
          </div>
        </body>
      </html>
    `;
    
    // Return success page instead of redirecting immediately
    // The page will have a "Continue" button that redirects to frontend
    console.log('✅ OAuth flow completed successfully');
    console.log(`✅ Showing success page for ${environment} environment`);
    return res.send(successPage);
  } catch (error) {
    console.error('Error in eBay OAuth callback:', error);
    res.status(500).send(`
      <html>
        <body>
          <h1>eBay Connection Failed</h1>
          <p>${error.message}</p>
          <p><a href="/">Return to Dashboard</a></p>
        </body>
      </html>
    `);
  }
}

// Manually associate eBay user with ShareTribe user (for fixing associations)
// Disassociate eBay user from ShareTribe user (remove association)
router.delete('/sharetribe-users/:id/ebay-association', async (req, res) => {
  try {
    const sharetribeUserId = parseInt(req.params.id); // Database ID
    
    const dbInstance = db.getDb();
    
    // Update ShareTribe user to remove eBay association
    const result = await new Promise((resolve, reject) => {
      dbInstance.run(
        `UPDATE sharetribe_users 
         SET ebay_user_id = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [sharetribeUserId],
        function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes });
        }
      );
    });
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'ShareTribe user not found or no association to remove' });
    }
    
    console.log(`✅ Removed eBay association from ShareTribe user ${sharetribeUserId}`);
    res.json({ success: true, message: 'eBay association removed successfully' });
  } catch (error) {
    console.error('Error removing eBay association:', error);
    res.status(500).json({ error: error.message });
  }
});

// Associate eBay user with ShareTribe user
router.post('/sharetribe-users/:id/associate-ebay', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const sharetribeUserId = parseInt(req.params.id); // Database ID
    const { ebay_user_id } = req.body;
    
    if (!ebay_user_id) {
      return res.status(400).json({ error: 'ebay_user_id is required' });
    }
    
    const dbInstance = db.getDb();
    
    // First get the user's sharetribe_user_id (UUID)
    const user = await new Promise((resolve, reject) => {
      dbInstance.get(
        `SELECT id, sharetribe_user_id FROM sharetribe_users WHERE id = ?`,
        [sharetribeUserId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    
    if (!user) {
      return res.status(404).json({ error: 'ShareTribe user not found' });
    }
    
    // Update using the UUID
    const updateResult = await new Promise((resolve, reject) => {
      dbInstance.run(
        `UPDATE sharetribe_users 
         SET ebay_user_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE sharetribe_user_id = ?`,
        [ebay_user_id, user.sharetribe_user_id],
        function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes });
        }
      );
    });
    
    if (updateResult.changes === 0) {
      return res.status(404).json({ error: 'Failed to update user' });
    }
    
    res.json({ success: true, message: `Associated eBay user ${ebay_user_id} with ShareTribe user ${user.sharetribe_user_id}` });
  } catch (error) {
    console.error('Error associating eBay user:', error);
    res.status(500).json({ error: error.message });
  }
});

// eBay OAuth callback routes
// eBay redirects to the Auth Accepted URL with code and state in query params
router.get('/ebay/callback', handleEbayOAuthCallback);
router.get('/auth/accepted', handleEbayOAuthCallback); // Also handle /auth/accepted route (Auth Accepted URL)

// Get all connected eBay users
router.get('/ebay-users', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const dbInstance = db.getDb();

    const users = await new Promise((resolve, reject) => {
      dbInstance.all(
        `SELECT id, ebay_user_id, token_expiry, sandbox, created_at, updated_at
         FROM ebay_users 
         WHERE tenant_id = ?
         ORDER BY created_at DESC`,
        [tenantId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    res.json(users.map(user => ({
      id: user.id,
      ebay_user_id: user.ebay_user_id,
      token_expiry: user.token_expiry,
      sandbox: user.sandbox === 1,
      created_at: user.created_at,
      updated_at: user.updated_at,
      token_expired: new Date(user.token_expiry) < new Date()
    })));
  } catch (error) {
    console.error('Error fetching eBay users:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete/disconnect eBay user
router.delete('/ebay-users/:id', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;
    const dbInstance = db.getDb();

    await new Promise((resolve, reject) => {
      dbInstance.run(
        `DELETE FROM ebay_users WHERE id = ? AND tenant_id = ?`,
        [id, tenantId],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });

    res.json({ success: true, message: 'eBay user disconnected' });
  } catch (error) {
    console.error('Error disconnecting eBay user:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== Live Sync Admin Endpoints ==========

// Get current job status (ultra-lightweight, <150ms) - reads from persisted job record
// WITH DEBOUNCING AND CACHING to prevent request storms
router.get('/admin/sync/jobs/:jobId/status', checkAdminRateLimit, async (req, res) => {
  const startTime = Date.now();
  try {
    const { jobId } = req.params;
    
    // Check cache first (500-1000ms TTL)
    const cached = statusCache.get(jobId);
    if (cached && Date.now() < cached.expiresAt) {
      const duration = Date.now() - startTime;
      if (duration > 50) {
        console.warn(`⚠️ [Status Endpoint] Cache hit but slow: ${duration}ms for job ${jobId}`);
      }
      return res.json(cached.data);
    }
    
    // Check if request is already in-flight (debouncing)
    const inFlight = inFlightStatusRequests.get(jobId);
    if (inFlight) {
      // Wait for existing request and return its result
      try {
        const data = await inFlight;
        return res.json(data);
      } catch (err) {
        // If existing request failed, continue to new request
        inFlightStatusRequests.delete(jobId);
      }
    }
    
    // Create new request promise
    const statusPromise = (async () => {
      try {
        // Always read from database first (single source of truth)
        let snapshot = await syncEventLogger.getJobSnapshotFromDB(jobId);
        
        // If not in DB, try cache (for very recent jobs)
        if (!snapshot) {
          snapshot = syncEventLogger.getJobSnapshot(jobId);
        }
        
        // If still not found, try syncService progress (backward compatibility)
        if (!snapshot) {
          const progress = syncService.getSyncProgress(jobId);
          if (progress) {
            // Convert progress to snapshot format
            snapshot = {
              job_id: jobId,
              state: progress.state || 'UNKNOWN',
              processed: progress.processed || 0,
              total: progress.total || 0,
              completed: progress.completed || 0,
              failed: progress.failed || 0,
              current_product_id: progress.currentProductId || null,
              current_step: progress.currentStep || null,
              retry_at: progress.retryAt || null,
              last_event_at: progress.lastUpdatedAt || progress.updatedAt || null,
              updated_at: progress.updatedAt || progress.lastUpdatedAt || Date.now(),
              total_requests: 0,
              requests_last60s: 0,
              error429_count: 0,
              avg_latency_ms: 0,
              throttle_min_delay_ms: 1000,
              throttle_concurrency: 100,
              last_retry_after: null,
              stall_detected: 0
            };
          }
        }
        
        if (!snapshot) {
          throw new Error('Sync job not found');
        }
        
        // Update cache for next time
        syncEventLogger.jobSnapshots.set(jobId, snapshot);
        
        // Return lightweight snapshot (always from persisted record)
        const processed = snapshot.processed !== null && snapshot.processed !== undefined ? snapshot.processed : ((snapshot.completed || 0) + (snapshot.failed || 0));
        const total = snapshot.total || 0;
        
        // Compute retryInSeconds dynamically from retryAt - now
        const now = Date.now();
        const retryAtMs = snapshot.retry_at ? (typeof snapshot.retry_at === 'number' ? snapshot.retry_at : new Date(snapshot.retry_at).getTime()) : null;
        const retryInSeconds = retryAtMs && retryAtMs > now ? Math.ceil((retryAtMs - now) / 1000) : null;
        
        const response = {
          jobId: snapshot.job_id,
          state: snapshot.state || 'UNKNOWN',
          processed: processed,
          total: total,
          completed: snapshot.completed || 0,
          failed: snapshot.failed || 0,
          remaining: Math.max(0, total - processed),
          percent: total > 0 ? Math.round((processed / total) * 100) : 0,
          currentProduct: snapshot.current_product_id || null,
          currentStep: snapshot.current_step || null,
          retryAt: retryAtMs, // Absolute epoch ms timestamp
          retryInSeconds: retryInSeconds, // Computed dynamically
          lastEventAt: snapshot.last_event_at || null,
          updatedAt: snapshot.updated_at || null,
          throttleSettings: {
            minDelayMs: snapshot.throttle_min_delay_ms || 1000,
            concurrency: snapshot.throttle_concurrency || 100
          },
          requestCounters: {
            last60s: snapshot.requests_last60s || 0,
            total: snapshot.total_requests || 0,
            error429Count: snapshot.error429_count || 0,
            avgLatencyMs: snapshot.avg_latency_ms || 0,
            lastRetryAfter: snapshot.last_retry_after || null
          },
          stallDetected: snapshot.stall_detected === 1
        };
        
        // Cache response (750ms TTL - between 500-1000ms)
        statusCache.set(jobId, {
          data: response,
          expiresAt: Date.now() + 750
        });
        
        // Clean up old cache entries periodically
        if (statusCache.size > 100) {
          const now = Date.now();
          for (const [jid, cached] of statusCache.entries()) {
            if (now > cached.expiresAt) {
              statusCache.delete(jid);
            }
          }
        }
        
        return response;
      } finally {
        // Remove from in-flight map
        inFlightStatusRequests.delete(jobId);
      }
    })();
    
    // Store promise for debouncing
    inFlightStatusRequests.set(jobId, statusPromise);
    
    // Wait for result
    const response = await statusPromise;
    
    const duration = Date.now() - startTime;
    if (duration > 150) {
      console.warn(`⚠️ [Status Endpoint] Slow response: ${duration}ms for job ${jobId}`);
    }
    
    res.json(response);
  } catch (error) {
    // Remove from in-flight map on error
    inFlightStatusRequests.delete(req.params.jobId);
    console.error('Error getting sync job status:', error);
    res.status(error.message === 'Sync job not found' ? 404 : 500).json({ error: error.message });
  }
});

// Get recent log events (paginated, from database)
router.get('/admin/sync/jobs/:jobId/events', checkAdminRateLimit, async (req, res) => {
  try {
    const { jobId } = req.params;
    // Reduced default limit to avoid heavy queries (was 200, now 100, max 200)
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const cursor = req.query.cursor || null;
    
    const result = await syncEventLogger.getEvents(jobId, limit, cursor);
    res.json(result);
  } catch (error) {
    console.error('Error getting sync events:', error);
    res.status(500).json({ error: error.message });
  }
});

// Live streaming events (SSE) - Real SSE endpoint
// NO rate limiting - SSE streams must stay open (exempted in checkAdminRateLimit, but removed here for clarity)
// INCLUDES STATUS IN PAYLOAD to avoid separate /status fetches
router.get('/admin/sync/jobs/:jobId/events/stream', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    // Set proper SSE headers (no compression, no buffering)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Disable compression for this response
    res.removeHeader('Content-Encoding');
    
    // Flush headers immediately
    res.flushHeaders();
    
    // Helper to get status snapshot (lightweight)
    const getStatusSnapshot = async () => {
      try {
        let snapshot = await syncEventLogger.getJobSnapshotFromDB(jobId);
        if (!snapshot) {
          snapshot = syncEventLogger.getJobSnapshot(jobId);
        }
        if (!snapshot) {
          const progress = syncService.getSyncProgress(jobId);
          if (progress) {
            snapshot = {
              job_id: jobId,
              state: progress.state || 'UNKNOWN',
              processed: progress.processed || 0,
              total: progress.total || 0,
              completed: progress.completed || 0,
              failed: progress.failed || 0,
              current_product_id: progress.currentProductId || null,
              current_step: progress.currentStep || null,
              retry_at: progress.retryAt || null,
              last_event_at: progress.lastUpdatedAt || progress.updatedAt || null,
              updated_at: progress.updatedAt || progress.lastUpdatedAt || Date.now(),
              total_requests: 0,
              requests_last60s: 0,
              error429_count: 0,
              avg_latency_ms: 0,
              throttle_min_delay_ms: 1000,
              throttle_concurrency: 100,
              last_retry_after: null,
              stall_detected: 0
            };
          }
        }
        if (!snapshot) return null;
        
        const processed = snapshot.processed !== null && snapshot.processed !== undefined ? snapshot.processed : ((snapshot.completed || 0) + (snapshot.failed || 0));
        const total = snapshot.total || 0;
        
        return {
          jobId: snapshot.job_id,
          state: snapshot.state || 'UNKNOWN',
          processed: processed,
          total: total,
          completed: snapshot.completed || 0,
          failed: snapshot.failed || 0,
          remaining: Math.max(0, total - processed),
          percent: total > 0 ? Math.round((processed / total) * 100) : 0,
          currentProduct: snapshot.current_product_id || null,
          currentStep: snapshot.current_step || null,
          retryAt: snapshot.retry_at || null,
          lastEventAt: snapshot.last_event_at || null,
          updatedAt: snapshot.updated_at || null,
          throttleSettings: {
            minDelayMs: snapshot.throttle_min_delay_ms || 1000,
            concurrency: snapshot.throttle_concurrency || 100
          },
          requestCounters: {
            last60s: snapshot.requests_last60s || 0,
            total: snapshot.total_requests || 0,
            error429Count: snapshot.error429_count || 0,
            avgLatencyMs: snapshot.avg_latency_ms || 0,
            lastRetryAfter: snapshot.last_retry_after || null
          },
          stallDetected: snapshot.stall_detected === 1
        };
      } catch (err) {
        console.error('Error getting status snapshot in SSE:', err);
        return null;
      }
    };
    
    // Send initial connection message with status
    const initialStatus = await getStatusSnapshot();
    res.write(`data: ${JSON.stringify({ type: 'connected', jobId: jobId, status: initialStatus })}\n\n`);
    if (res.flush) res.flush();
    
    // Track last event timestamp to only send new events
    let lastEventTimestampMs = null;
    let lastHeartbeat = Date.now();
    let lastStatusUpdate = Date.now();
    
    // Function to send event
    const sendEvent = (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (res.flush) res.flush();
      } catch (err) {
        console.error('Error writing SSE event:', err);
      }
    };
    
    // Poll for new events from database
    const pollInterval = setInterval(async () => {
      try {
        // Check if client disconnected
        if (req.aborted || res.destroyed) {
          clearInterval(pollInterval);
          return;
        }
        
        // Get new events from database
        const eventsResult = await syncEventLogger.getEvents(jobId, 50, lastEventTimestampMs);
        const newEvents = eventsResult.events || [];
        
        if (newEvents.length > 0) {
          // Update last timestamp
          lastEventTimestampMs = Math.max(...newEvents.map(e => e.timestampMs));
          
          // Send each new event WITH STATUS (every 3-5 seconds)
          const now = Date.now();
          const includeStatus = (now - lastStatusUpdate) >= 3000; // Include status every 3 seconds
          
          if (includeStatus) {
            const status = await getStatusSnapshot();
            newEvents.forEach(event => {
              sendEvent({ type: 'event', event: event, status: status });
            });
            lastStatusUpdate = now;
          } else {
            newEvents.forEach(event => {
              sendEvent({ type: 'event', event: event });
            });
          }
        }
        
        // Send heartbeat with status every 15 seconds
        const now = Date.now();
        if (now - lastHeartbeat >= 15000) {
          const status = await getStatusSnapshot();
          sendEvent({ type: 'ping', timestamp: new Date().toISOString(), status: status });
          lastHeartbeat = now;
          lastStatusUpdate = now;
        }
      } catch (error) {
        console.error('Error in SSE stream:', error);
        sendEvent({ type: 'error', error: error.message });
      }
    }, 500); // Poll every 500ms
    
    // Clean up on client disconnect
    req.on('close', () => {
      clearInterval(pollInterval);
      if (!res.destroyed) {
        res.end();
      }
    });
    
    req.on('aborted', () => {
      clearInterval(pollInterval);
      if (!res.destroyed) {
        res.end();
      }
    });
  } catch (error) {
    console.error('Error setting up SSE stream:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get all active job IDs
router.get('/admin/sync/jobs', checkAdminRateLimit, async (req, res) => {
  try {
    const activeJobIds = await syncEventLogger.getActiveJobIds();
    const jobs = await Promise.all(activeJobIds.map(async (jobId) => {
      const snapshot = syncEventLogger.getJobSnapshot(jobId) || await syncEventLogger.getJobSnapshotFromDB(jobId);
      return {
        jobId: jobId,
        state: snapshot?.state || 'UNKNOWN',
        processed: snapshot?.processed || 0,
        total: snapshot?.total || 0,
        lastEventTimestamp: snapshot?.last_event_at || null
      };
    }));
    
    res.json({ jobs: jobs });
  } catch (error) {
    console.error('Error getting active jobs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint: last 20 events + key counters
router.get('/admin/sync/jobs/:jobId/debug', checkAdminRateLimit, async (req, res) => {
  try {
    const { jobId } = req.params;
    
    // Get snapshot
    let snapshot = syncEventLogger.getJobSnapshot(jobId);
    if (!snapshot) {
      snapshot = await syncEventLogger.getJobSnapshotFromDB(jobId);
    }
    
    if (!snapshot) {
      return res.status(404).json({ error: 'Sync job not found' });
    }
    
    // Get last 20 events
    const eventsResult = await syncEventLogger.getEvents(jobId, 20);
    
    res.json({
      snapshot: {
        jobId: snapshot.job_id,
        state: snapshot.state,
        processed: snapshot.processed,
        total: snapshot.total,
        currentProduct: snapshot.current_product_id,
        currentStep: snapshot.current_step,
        retryAt: snapshot.retry_at,
        lastEventAt: snapshot.last_event_at,
        updatedAt: snapshot.updated_at,
        stallDetected: snapshot.stall_detected === 1
      },
      counters: {
        totalRequests: snapshot.total_requests || 0,
        requestsLast60s: snapshot.requests_last60s || 0,
        error429Count: snapshot.error429_count || 0,
        avgLatencyMs: snapshot.avg_latency_ms || 0,
        lastRetryAfter: snapshot.last_retry_after || null
      },
      throttleSettings: {
        minDelayMs: snapshot.throttle_min_delay_ms || 1000,
        concurrency: snapshot.throttle_concurrency || 100
      },
      recentEvents: eventsResult.events || []
    });
  } catch (error) {
    console.error('Error getting debug info:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
