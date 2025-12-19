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
    
    const { synced, search } = req.query || {};
    
    let query = 'SELECT * FROM products WHERE tenant_id = ?';
    const params = [tenantId];
    
    if (synced !== undefined && synced !== null && synced !== '') {
      query += ' AND synced = ?';
      params.push(synced === 'true' ? 1 : 0);
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
    
    // Log sample product to verify all fields are present
    if (mergedProducts.length > 0) {
      const sample = mergedProducts[0];
      console.log('📦 Sample merged product (for mapping modal):', {
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
      const rows = [];
      let headersCaptured = false;
      const categoryColumns = new Set(); // Track potential category columns
      
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
          }
          
          preview.rowCount++;
          
          // Store sample rows (first 10 for display)
          if (rows.length < 10) {
            rows.push(data);
          }
          
          // Track unique values for all columns (to help identify category columns)
          preview.columns.forEach(col => {
            const value = data[col];
            if (value !== undefined && value !== null && value.toString().trim() !== '') {
              preview.uniqueCategories[col].add(value.toString().trim());
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
          
          // Don't delete file yet - we'll need it for import
          res.json(preview);
        })
        .on('error', (error) => {
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
    const { columnMappings, categoryMappings, categoryColumn, categoryFieldMappings, categoryListingTypeMappings, valueMappings, unmappedFieldValues } = req.body;
    
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
    
    console.log('Received column mappings:', JSON.stringify(mappings, null, 2));
    console.log('Received category mappings:', JSON.stringify(catMappings, null, 2));
    console.log('Received category column:', categoryColumn);
    console.log('Received category field mappings:', JSON.stringify(catFieldMappings, null, 2));
    console.log('Received category listing type mappings:', JSON.stringify(catListingTypeMappings, null, 2));
    console.log('Received value mappings:', JSON.stringify(valMappings, null, 2));
    console.log('Received unmapped field values:', JSON.stringify(unmappedValues, null, 2));
    
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

    const products = await csvService.parseCSVWithMappings(filePath, mappings, catMappings, categoryColumn, catFieldMappings, defaultCurrency, valMappings, catListingTypeMappings, unmappedValues);
    
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
          synced: false
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
      unmappedFieldValues = {}
    } = req.body;

    console.log('📝 Applying eBay product mappings:', {
      columnMappingsCount: Object.keys(columnMappings || {}).length,
      categoryMappingsCount: Object.keys(categoryMappings).length,
      categoryColumn,
      categoryFieldMappingsCount: Object.keys(categoryFieldMappings).length
    });

    const dbInstance = db.getDb();
    const csvService = require('../services/csvService');
    const syncService = require('../services/syncService');

    // Get all products from database (they have eBay field names)
    const products = await new Promise((resolve, reject) => {
      dbInstance.all(
        'SELECT * FROM products WHERE tenant_id = ?',
        [tenantId],
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
          unmappedFieldValues
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

        // Update product in database
        await syncService.upsertProduct(tenantId, {
          ...mappedProduct,
          synced: false // Mark as needing sync after mapping update
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
    
    if (item_ids && item_ids.length > 0) {
      const placeholders = item_ids.map(() => '?').join(',');
      productsToPreview = await new Promise((resolve, reject) => {
        dbInstance.all(
          `SELECT * FROM products WHERE tenant_id = ? AND ebay_item_id IN (${placeholders})`,
          [tenantId, ...item_ids],
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
          'SELECT * FROM products WHERE tenant_id = ?',
          [tenantId],
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
  try {
    const tenantId = getTenantId(req);
    const { item_ids, sharetribe_user_id } = req.body; // Optional array of item IDs to sync, optional sharetribe_user_id
    
    const dbInstance = db.getDb();
    const logId = await new Promise((resolve, reject) => {
      dbInstance.run(
        `INSERT INTO sync_logs (tenant_id, user_id, sync_type, status) VALUES (?, ?, ?, ?)`,
        [tenantId, sharetribe_user_id || null, 'manual', 'running'],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    const result = await syncService.syncProducts(tenantId, item_ids, sharetribe_user_id);
    
    // Update log
    dbInstance.run(
      `UPDATE sync_logs SET status = ?, products_synced = ?, products_failed = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [result.failed === 0 ? 'success' : 'partial', result.synced, result.failed, logId]
    );

    res.json({ success: true, ...result });
  } catch (error) {
    const tenantId = getTenantId(req);
    const dbInstance = db.getDb();
    
    // Log error
    dbInstance.run(
      `INSERT INTO sync_logs (tenant_id, sync_type, status, products_failed, error_message)
       VALUES (?, ?, ?, ?, ?)`,
      [tenantId, 'manual', 'failed', 0, error.message]
    );
    
    res.status(500).json({ error: error.message });
  }
});

// Remove products (delete from database)
router.post('/products/remove', (req, res) => {
  const tenantId = getTenantId(req);
  const dbInstance = db.getDb();
  const { item_ids } = req.body; // Optional array of item IDs to remove
  
  if (item_ids && Array.isArray(item_ids) && item_ids.length > 0) {
    // Remove selected products
    const placeholders = item_ids.map(() => '?').join(',');
    dbInstance.run(
      `DELETE FROM products WHERE tenant_id = ? AND ebay_item_id IN (${placeholders})`,
      [tenantId, ...item_ids],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({ 
          success: true, 
          message: `Removed ${this.changes} product(s)`,
          count: this.changes 
        });
      }
    );
  } else {
    // Remove all products
    dbInstance.run(
      `DELETE FROM products WHERE tenant_id = ?`,
      [tenantId],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({ 
          success: true, 
          message: `Removed ${this.changes} product(s)`,
          count: this.changes 
        });
      }
    );
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
router.get('/sharetribe-users/query', async (req, res) => {
  try {
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

// Debug endpoint to show ShareTribe configuration (without exposing secrets)
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

module.exports = router;
