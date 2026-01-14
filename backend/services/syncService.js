const db = require('../config/database');
const eBayService = require('./ebayService');
const ShareTribeService = require('./sharetribeService');
const rateLimiter = require('../utils/sharetribeRateLimiter');

// Format seconds as MM:SS
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

class SyncService {
  constructor() {
    // Store progress for active sync jobs
    this.syncProgress = new Map();
    
    // Track rate limit status
    this.rateLimitStatus = new Map(); // jobId -> { retryAfter: seconds, paused: boolean }
    
    // Track resume timeouts for cleanup
    this.resumeTimeouts = new Map(); // jobId -> timeoutId
  }
  
  /**
   * Get progress for a sync job
   */
  getSyncProgress(jobId) {
    const progress = this.syncProgress.get(jobId) || null;
    if (progress) {
      console.log(`📋 [SyncService] Getting progress for job ${jobId}:`, {
        total: progress.total,
        completed: progress.completed,
        failed: progress.failed,
        percent: progress.percent,
        status: progress.status,
        currentStep: progress.currentStep
      });
    } else {
      console.log(`📋 [SyncService] No progress found for job ${jobId}`);
    }
    return progress;
  }
  
  /**
   * Update progress for a sync job
   * State machine: RUNNING, PAUSED_RATE_LIMIT, COMPLETED, FAILED
   * Ensures updatedAt is refreshed every few seconds while RUNNING
   */
  updateSyncProgress(jobId, progress) {
    const existingProgress = this.syncProgress.get(jobId) || {};
    const now = Date.now();
    
    // Determine state based on status (explicit state machine)
    // Terminal states: COMPLETED (only when processed === total), FAILED, CANCELLED
    // Non-terminal: RUNNING, PAUSED (jobs auto-continue until done)
    let state = 'RUNNING';
    if (progress.status === 'rate_limited' || progress.status === 'retry_scheduled' || 
        progress.state === 'PAUSED_RATE_LIMIT' || progress.state === 'PAUSED') {
      state = 'PAUSED';
    } else if (progress.state === 'COMPLETED' || progress.state === 'COMPLETED_SUCCESS' || 
               progress.state === 'CANCELLED' || progress.state === 'FAILED') {
      // Use explicit terminal state if provided
      state = progress.state;
    } else if (progress.status === 'completed') {
      // Only COMPLETED if processed === total (100%)
      const processed = (progress.completed || existingProgress.completed || 0) + (progress.failed || existingProgress.failed || 0);
      const total = progress.total || existingProgress.total || 0;
      
      if (processed === total) {
        state = 'COMPLETED';
      } else {
        // Not fully processed - keep as RUNNING or PAUSED (will auto-continue)
        // Check if there's a retryAt - if so, PAUSED, otherwise RUNNING
        state = (progress.retryAt || progress.nextRetryAt) ? 'PAUSED' : 'RUNNING';
      }
    } else if (progress.status === 'error' || progress.status === 'failed' || progress.state === 'FAILED') {
      state = 'FAILED';
    } else if (progress.status === 'in_progress' || progress.status === 'starting' || progress.status === 'running' || progress.state === 'RUNNING') {
      state = 'RUNNING';
    }
    
    // Calculate retryAt and retryInMs if nextRetryAt is provided
    let retryAt = null;
    let retryInMs = null;
    if (progress.nextRetryAt || progress.retryAt) {
      retryAt = progress.retryAt || (typeof progress.nextRetryAt === 'number' ? progress.nextRetryAt : new Date(progress.nextRetryAt).getTime());
      retryInMs = Math.max(0, retryAt - now);
    }
    
    // For RUNNING state, ensure updatedAt refreshes every few seconds
    // This helps frontend detect if sync is still active
    const finalState = progress.state || state;
    const shouldRefreshUpdatedAt = finalState === 'RUNNING' && 
                                   existingProgress.updatedAt && 
                                   (now - existingProgress.updatedAt) > 3000; // Refresh every 3s
    
    const progressData = {
      ...existingProgress,
      ...progress,
      state: finalState,
      lastUpdatedAt: now,
      updatedAt: shouldRefreshUpdatedAt ? now : (progress.updatedAt || existingProgress.updatedAt || now), // Refresh every 3s while RUNNING
      // Calculate processed and remaining
      processed: progress.processed !== undefined ? progress.processed : 
                 ((progress.completed !== undefined ? progress.completed : existingProgress.completed || 0) + 
                  (progress.failed !== undefined ? progress.failed : existingProgress.failed || 0)),
      // Lock total - never allow it to change after job starts
      total: existingProgress.total || progress.total || total, // Preserve locked total
      // Calculate remaining
      remaining: progress.remaining !== undefined ? progress.remaining : 
                 Math.max(0, (existingProgress.total || progress.total || total) - 
                 ((progress.completed !== undefined ? progress.completed : existingProgress.completed || 0) + 
                  (progress.failed !== undefined ? progress.failed : existingProgress.failed || 0))),
      // Preserve retry fields if not being updated
      lastAttemptAt: progress.lastAttemptAt || existingProgress.lastAttemptAt || null,
      nextRetryAt: progress.nextRetryAt !== undefined ? progress.nextRetryAt : existingProgress.nextRetryAt,
      retryAt: retryAt !== null ? retryAt : (progress.retryAt !== undefined ? progress.retryAt : existingProgress.retryAt), // Explicit retryAt timestamp
      retryInMs: retryInMs !== null ? retryInMs : (progress.retryInMs !== undefined ? progress.retryInMs : existingProgress.retryInMs), // Milliseconds until retry
      retryAttemptCount: progress.retryAttemptCount !== undefined ? progress.retryAttemptCount : (existingProgress.retryAttemptCount || 0),
      lastErrorCode: progress.lastErrorCode || existingProgress.lastErrorCode || null,
      lastErrorMessage: progress.lastErrorMessage || existingProgress.lastErrorMessage || null,
      lastUpdate: now // Keep for backward compatibility
    };
    
    this.syncProgress.set(jobId, progressData);
    console.log(`📋 [SyncService] Progress updated for job ${jobId}:`, {
      state: progressData.state,
      total: progressData.total,
      completed: progressData.completed,
      failed: progressData.failed,
      processed: progressData.processed,
      percent: progressData.percent,
      retryAt: progressData.retryAt ? new Date(progressData.retryAt).toISOString() : null,
      retryInMs: progressData.retryInMs,
      updatedAt: new Date(progressData.updatedAt).toISOString()
    });
  }
  
  /**
   * Clear progress for a completed/failed sync job
   */
  clearSyncProgress(jobId) {
    this.syncProgress.delete(jobId);
  }
  
  /**
   * Get active sync job ID (if any)
   */
  getActiveSyncJobId() {
    return rateLimiter.getActiveSyncJobId();
  }
  
  /**
   * Get active sync job progress (if any)
   */
  getActiveSyncJobProgress() {
    const activeJobId = rateLimiter.getActiveSyncJobId();
    if (!activeJobId) {
      return null;
    }
    
    const progress = this.getSyncProgress(activeJobId);
    if (!progress) {
      return null;
    }
    
    return {
      jobId: activeJobId,
      ...progress
    };
  }
  
  async syncProducts(tenantId = 1, itemIds = null, sharetribeUserId = null, jobId = null) {
    // Generate job ID if not provided
    const syncJobId = jobId || `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Note: We don't check for active jobs here anymore - the API route handles it
    // This allows the API route to return the existing jobId instead of throwing an error
    
    // Check if there's already an active job (safety check - API route should prevent this)
    const existingJobId = rateLimiter.getActiveSyncJobId();
    if (existingJobId && existingJobId !== syncJobId) {
      // This should never happen if API route is working correctly, but handle gracefully
      console.warn(`⚠️ [SyncService] Attempted to start sync ${syncJobId} but ${existingJobId} is already active`);
      // Return the existing job's progress instead of throwing
      const existingProgress = this.getSyncProgress(existingJobId);
      if (existingProgress) {
        return {
          success: true,
          synced: existingProgress.completed,
          failed: existingProgress.failed,
          errors: existingProgress.errors || [],
          jobId: existingJobId,
          alreadyRunning: true
        };
      }
      // If no progress found, throw (shouldn't happen)
      throw new Error(`A sync job (${existingJobId}) is already in progress. Please wait for it to complete.`);
    }
    
    // Register this sync job
    rateLimiter.registerSyncJob(syncJobId);
    
    // Register rate limit callback
    // Callback receives: (retryAt, errorCode, errorMessage)
    // retryAt is epoch milliseconds (timestamp) when retry should happen
    rateLimiter.registerRateLimitCallback(syncJobId, (retryAt, errorCode = 429, errorMessage = 'Rate limit exceeded') => {
      this.handleRateLimit(syncJobId, retryAt, errorCode, errorMessage);
    });
    
    try {
    const dbInstance = db.getDb();
    
    // Get API configuration (shared credentials)
    const config = await this.getApiConfig(tenantId);
    if (!config.sharetribe) {
      throw new Error('API configuration incomplete. Please configure ShareTribe credentials.');
    }

    // Get ShareTribe user ID and configuration if provided
    let sharetribeUserIdValue = null;
    let userLocation = null;
    let userConfig = null;
    if (sharetribeUserId) {
      const userRow = await new Promise((resolve, reject) => {
        dbInstance.get(
          `SELECT sharetribe_user_id, location, parcel,
                  pickup_enabled, shipping_enabled, shipping_measurement,
                  transaction_process_alias, unit_type, default_image_id, default_image_path
           FROM sharetribe_users WHERE id = ?`,
          [sharetribeUserId],
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
        throw new Error('ShareTribe user not found');
      }
      
      sharetribeUserIdValue = userRow.sharetribe_user_id;
      // Parse location JSON if it exists
      if (userRow.location) {
        try {
          userLocation = JSON.parse(userRow.location);
        } catch (e) {
          console.warn('Failed to parse user location JSON:', e.message);
        }
      }
      
      // Parse parcel JSON if it exists
      let userParcel = null;
      if (userRow.parcel) {
        try {
          userParcel = JSON.parse(userRow.parcel);
        } catch (e) {
          console.warn('Failed to parse user parcel JSON:', e.message);
        }
      }
      
      // Store user configuration for listing defaults
      userConfig = {
        pickupEnabled: userRow.pickup_enabled !== undefined ? Boolean(userRow.pickup_enabled) : true,
        shippingEnabled: userRow.shipping_enabled !== undefined ? Boolean(userRow.shipping_enabled) : true,
        shippingMeasurement: userRow.shipping_measurement || 'custom',
        parcel: userParcel,
        transactionProcessAlias: userRow.transaction_process_alias || 'default-purchase/release-1',
        unitType: userRow.unit_type || 'item',
        defaultImageId: userRow.default_image_id || null,
        defaultImagePath: userRow.default_image_path || null
      };
    } else if (config.sharetribe.userId) {
      // Fallback to config user ID for backward compatibility
      sharetribeUserIdValue = config.sharetribe.userId;
    }

    // Use shared API credentials with selected user ID
    const sharetribeConfig = {
      apiKey: config.sharetribe.apiKey,
      apiSecret: config.sharetribe.apiSecret,
      marketplaceId: config.sharetribe.marketplaceId,
      userId: sharetribeUserIdValue
    };

    // Get field mappings
    const fieldMappings = await this.getFieldMappings(tenantId);

    // Initialize ShareTribe service
    const sharetribeService = new ShareTribeService(sharetribeConfig);

    // Get products from database (not from eBay API)
    let productsToSync = [];
    
    // Helper function to merge custom_fields back into product object
    // This MUST match the logic in /sync/preview endpoint
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
      
      console.log(`Sync: Product ${completeProduct.ebay_item_id} from database (before custom_fields merge):`, {
        title: completeProduct.title,
        description: completeProduct.description,
        price: completeProduct.price,
        currency: completeProduct.currency,
        hasCustomFields: !!product.custom_fields,
        allKeys: Object.keys(completeProduct)
      });
      
      if (product.custom_fields) {
        try {
          const customFields = JSON.parse(product.custom_fields);
          console.log(`Sync: Custom fields for product ${completeProduct.ebay_item_id}:`, customFields);
          
          // Merge ALL custom fields into the product
          for (const key in customFields) {
            completeProduct[key] = customFields[key];
          }
          
          console.log(`Sync: After merging custom_fields, product ${completeProduct.ebay_item_id} has:`, {
            categoryLevel1: completeProduct.categoryLevel1,
            categoryLevel2: completeProduct.categoryLevel2,
            allKeys: Object.keys(completeProduct),
            allValues: Object.entries(completeProduct).filter(([k, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}: ${v}`).join(', ')
          });
        } catch (e) {
          console.error(`Error parsing custom_fields for product ${completeProduct.ebay_item_id}:`, e);
        }
      }
      
      // Remove custom_fields from the product object as it's now merged
      delete completeProduct.custom_fields;
      return completeProduct;
    };
    
    // CRITICAL: Filter products by user_id to prevent cross-user sync
    // Only sync products that belong to the specified ShareTribe user
    const userFilter = sharetribeUserId 
      ? ' AND user_id = ?'
      : ' AND user_id IS NULL';
    
    const userFilterParams = sharetribeUserId ? [sharetribeUserId] : [];
    
    if (itemIds && itemIds.length > 0) {
      // Sync specific items from database (scoped to user)
      const placeholders = itemIds.map(() => '?').join(',');
      productsToSync = await new Promise((resolve, reject) => {
        dbInstance.all(
          `SELECT * FROM products WHERE tenant_id = ?${userFilter} AND ebay_item_id IN (${placeholders})`,
          [tenantId, ...userFilterParams, ...itemIds],
          (err, rows) => {
            if (err) {
              reject(err);
            } else {
              // Merge custom_fields back into products
              const mergedRows = (rows || []).map(mergeCustomFields);
              // Log first product to debug
              if (mergedRows && mergedRows.length > 0) {
                console.log('Sample product from database:', {
                  ebay_item_id: mergedRows[0].ebay_item_id,
                  title: mergedRows[0].title,
                  price: mergedRows[0].price,
                  allFields: Object.keys(mergedRows[0]),
                  categoryLevel1: mergedRows[0].categoryLevel1,
                  categoryLevel2: mergedRows[0].categoryLevel2,
                  listingType: mergedRows[0].listingType
                });
              }
              resolve(mergedRows);
            }
          }
        );
      });
    } else {
      // Sync all products from database (scoped to user)
      productsToSync = await new Promise((resolve, reject) => {
        dbInstance.all(
          `SELECT * FROM products WHERE tenant_id = ?${userFilter}`,
          [tenantId, ...userFilterParams],
          (err, rows) => {
            if (err) {
              reject(err);
            } else {
              // Merge custom_fields back into products
              const mergedRows = (rows || []).map(mergeCustomFields);
              // Log first product to debug
              if (mergedRows && mergedRows.length > 0) {
                console.log('Sample product from database:', {
                  ebay_item_id: mergedRows[0].ebay_item_id,
                  title: mergedRows[0].title,
                  price: mergedRows[0].price,
                  allFields: Object.keys(mergedRows[0]),
                  categoryLevel1: mergedRows[0].categoryLevel1,
                  categoryLevel2: mergedRows[0].categoryLevel2,
                  listingType: mergedRows[0].listingType
                });
              }
              resolve(mergedRows);
            }
          }
        );
      });
    }

    // Initialize progress tracking
    const totalProducts = productsToSync.length;
    console.log(`📋 [SyncService] Products fetched for job ${syncJobId}: ${totalProducts} products`);
    console.log(`📋 [SyncService] productsToSync array length:`, productsToSync.length);
    console.log(`📋 [SyncService] productsToSync sample:`, productsToSync.slice(0, 2));
    
    if (totalProducts === 0) {
      // No products to sync - mark as COMPLETED_SUCCESS (nothing to do = success)
      console.log(`⚠️ [SyncService] No products to sync for job ${syncJobId}`);
      this.updateSyncProgress(syncJobId, {
        jobId: syncJobId,
        total: 0,
        completed: 0,
        failed: 0,
        processed: 0,
        remaining: 0,
        percent: 100,
        status: 'completed',
        state: 'COMPLETED_SUCCESS',
        currentStep: 'No products to sync',
        eta: 0,
        errors: []
      });
      rateLimiter.unregisterSyncJob(syncJobId);
      rateLimiter.unregisterRateLimitCallback(syncJobId);
      return {
        success: true,
        synced: 0,
        failed: 0,
        errors: [],
        jobId: syncJobId
      };
    }
    
    let syncedCount = 0;
    let failedCount = 0;
    const errors = [];
    const startTime = Date.now();
    const completedTimes = []; // Track completion times for ETA calculation
    
    // Update progress with actual product count (progress was initialized in API route)
    // Store sharetribeUserId in progress for resume continuation
    console.log(`📋 [SyncService] Updating progress for job ${syncJobId} with ${totalProducts} products`);
    this.updateSyncProgress(syncJobId, {
      jobId: syncJobId,
      total: totalProducts,
      completed: 0,
      failed: 0,
      percent: 0,
      status: 'in_progress',
      state: 'RUNNING',
      sharetribeUserId: sharetribeUserId, // Store for resume continuation
      currentStep: `Starting sync of ${totalProducts} product(s)...`,
      eta: null,
      errors: []
    });
    
    console.log(`🚀 Starting sync job ${syncJobId}: ${totalProducts} products to sync`);
    console.log(`📋 [SyncService] Progress updated - total: ${totalProducts}`);

    for (let i = 0; i < productsToSync.length; i++) {
      const ebayProduct = productsToSync[i];
      const productIndex = i + 1;
      
      // Check if we're paused due to rate limit - wait until retryAt arrives
      const rateLimitInfo = this.rateLimitStatus.get(syncJobId);
      if (rateLimitInfo && rateLimitInfo.paused) {
        const now = Date.now();
        const retryAt = rateLimitInfo.retryAt || rateLimitInfo.nextRetryAt;
        
        if (retryAt && now < retryAt) {
          // Still waiting - update progress periodically
          const retryInMs = Math.max(0, retryAt - now);
          const retryInSeconds = Math.ceil(retryInMs / 1000);
          
          // Update progress with current wait status (PAUSED_RATE_LIMIT state)
          this.updateSyncProgress(syncJobId, {
            jobId: syncJobId,
            total: totalProducts,
            completed: syncedCount,
            failed: failedCount,
            percent: Math.round(((syncedCount + failedCount) / totalProducts) * 100),
            status: 'retry_scheduled',
            state: 'PAUSED_RATE_LIMIT',
            rateLimited: true,
            nextRetryAt: retryAt,
            retryAt: retryAt,
            retryInMs: retryInMs,
            retryInSeconds: retryInSeconds,
            lastAttemptAt: rateLimitInfo.pausedAt,
            currentStep: `Sharetribe rate limit reached — resuming in ${formatTime(retryInSeconds)}`,
            eta: null,
            rateLimitRetryAfter: retryInSeconds,
            errors: errors.slice(-10)
          });
          
          // Wait until retry time (scheduleResume will fire and set state to RUNNING)
          await new Promise(resolve => setTimeout(resolve, retryInMs));
          
          // After wait, check if still paused (scheduleResume should have cleared paused flag)
          const stillPaused = this.rateLimitStatus.get(syncJobId)?.paused;
          if (stillPaused) {
            console.log(`⚠️ [SyncService] Still paused after wait, clearing manually for job ${syncJobId}`);
            this.clearRateLimitStatus(syncJobId);
          }
          
          console.log(`🔄 [SyncService] Resuming product ${i + 1}/${totalProducts} after rate limit wait`);
        } else {
          // Retry time has passed, clear status
          this.clearRateLimitStatus(syncJobId);
        }
      }
      
      // Update progress: starting this product
      this.updateSyncProgress(syncJobId, {
        jobId: syncJobId,
        total: totalProducts,
        completed: syncedCount,
        failed: failedCount,
        percent: Math.round(((syncedCount + failedCount) / totalProducts) * 100),
        status: 'in_progress',
        currentStep: `Syncing product ${productIndex}/${totalProducts}: ${ebayProduct.title || ebayProduct.ebay_item_id}`,
        eta: this.calculateETA(syncedCount + failedCount, totalProducts, completedTimes, startTime),
        errors: errors.slice(-10) // Keep last 10 errors
      });
      try {
        // Log product data from database before transformation
        console.log(`=== SYNC: Product ${ebayProduct.ebay_item_id} from database (AFTER mergeCustomFields) ===`);
        console.log('Title:', ebayProduct.title);
        console.log('Description:', ebayProduct.description);
        console.log('Price:', ebayProduct.price);
        console.log('Currency:', ebayProduct.currency);
        console.log('Category:', ebayProduct.category);
        console.log('CategoryLevel1:', ebayProduct.categoryLevel1);
        console.log('CategoryLevel2:', ebayProduct.categoryLevel2);
        console.log('All fields:', Object.keys(ebayProduct));
        console.log('All values:', JSON.stringify(ebayProduct, null, 2));
        
        // Apply field mappings
        // CRITICAL: Pass the EXACT product object to buildSharetribePayload
        // If applyFieldMappings returns empty, use ebayProduct directly as fallback
        let transformedProduct = this.applyFieldMappings(ebayProduct, fieldMappings);
        
        // SAFETY CHECK: If transformedProduct is empty or missing critical fields, use original product
        if (!transformedProduct || Object.keys(transformedProduct).length === 0) {
          console.error(`❌ FATAL: applyFieldMappings returned empty object for ${ebayProduct.ebay_item_id}. Using original product.`);
          transformedProduct = { ...ebayProduct };
          // Remove metadata but keep all data fields
          const metadataColumns = ['id', 'tenant_id', 'synced', 'sharetribe_listing_id', 'last_synced_at', 'created_at', 'updated_at', 'user_id'];
          metadataColumns.forEach(col => delete transformedProduct[col]);
        }
        
        // Ensure critical fields are present
        if (!transformedProduct.title && ebayProduct.title) transformedProduct.title = ebayProduct.title;
        if (!transformedProduct.description && ebayProduct.description) transformedProduct.description = ebayProduct.description;
        if (transformedProduct.price === undefined && ebayProduct.price !== undefined) transformedProduct.price = ebayProduct.price;
        if (!transformedProduct.currency && ebayProduct.currency) transformedProduct.currency = ebayProduct.currency;
        if (!transformedProduct.ebay_item_id && ebayProduct.ebay_item_id) transformedProduct.ebay_item_id = ebayProduct.ebay_item_id;
        
        // Ensure custom fields are copied
        Object.keys(ebayProduct).forEach(key => {
          if (!['id', 'tenant_id', 'synced', 'sharetribe_listing_id', 'last_synced_at', 'created_at', 'updated_at', 'user_id'].includes(key)) {
            if (transformedProduct[key] === undefined && ebayProduct[key] !== undefined) {
              transformedProduct[key] = ebayProduct[key];
            }
          }
        });
        
        console.log(`=== SYNC: Product ${ebayProduct.ebay_item_id} after applyFieldMappings ===`);
        console.log('Title:', transformedProduct.title);
        console.log('Description:', transformedProduct.description);
        console.log('Price:', transformedProduct.price);
        console.log('Currency:', transformedProduct.currency);
        console.log('All fields:', Object.keys(transformedProduct));
        console.log('All values:', JSON.stringify(transformedProduct, null, 2));
        
        // Log product data after transformation
        console.log(`Product ${ebayProduct.ebay_item_id} after transformation:`, {
          title: transformedProduct.title,
          price: transformedProduct.price,
          description: transformedProduct.description,
          allFields: Object.keys(transformedProduct),
          allValues: Object.entries(transformedProduct).map(([k, v]) => `${k}: ${v}`).join(', ')
        });
        
        // Validate required fields before syncing
        // Check both transformedProduct and ebayProduct as fallback
        const titleToUse = transformedProduct.title || ebayProduct.title;
        
        if (!titleToUse || (typeof titleToUse === 'string' && titleToUse.trim() === '')) {
          const availableFields = Object.keys(transformedProduct).filter(k => transformedProduct[k] !== null && transformedProduct[k] !== undefined).join(', ');
          const nullFields = Object.keys(transformedProduct).filter(k => transformedProduct[k] === null).map(k => `${k}(NULL)`).join(', ');
          const dbFields = Object.keys(ebayProduct).filter(k => ebayProduct[k] !== null && ebayProduct[k] !== undefined).join(', ');
          const dbNullFields = Object.keys(ebayProduct).filter(k => ebayProduct[k] === null && ['title', 'description', 'price', 'currency', 'quantity'].includes(k)).map(k => `${k}(NULL)`).join(', ');
          
          let errorMsg = `Product ${ebayProduct.ebay_item_id} is missing required field: title. `;
          errorMsg += `Transformed keys: ${Object.keys(transformedProduct).join(', ')}. `;
          errorMsg += `DB keys: ${Object.keys(ebayProduct).join(', ')}. `;
          if (availableFields) {
            errorMsg += `Available fields with values: ${availableFields}. `;
          }
          if (nullFields) {
            errorMsg += `Fields with NULL values: ${nullFields}. `;
          }
          if (dbNullFields) {
            errorMsg += `Database has NULL for: ${dbNullFields}. `;
          }
          errorMsg += `This suggests the CSV import did not map columns correctly. Please check your CSV column mappings and ensure "Title" is mapped correctly.`;
          
          throw new Error(errorMsg);
        }
        
        // Ensure title is set in transformedProduct (use fallback if needed)
        if (!transformedProduct.title && titleToUse) {
          transformedProduct.title = titleToUse;
        }
        
        console.log(`Syncing product ${ebayProduct.ebay_item_id}:`, {
          title: transformedProduct.title,
          price: transformedProduct.price,
          hasDescription: !!transformedProduct.description,
          allFields: Object.keys(transformedProduct)
        });
        
        // Add user location and configuration to product data if available
        if (userLocation) {
          transformedProduct.location = userLocation;
        }
        
        // Add user parcel configuration to product data if available
        if (userConfig && userConfig.parcel) {
          transformedProduct.parcel = userConfig.parcel;
        }
        
        // Add user configuration defaults to product data
        if (userConfig) {
          console.log(`🔍 [${ebayProduct.ebay_item_id}] Applying userConfig for user ${sharetribeUserId}:`, {
            hasDefaultImageId: !!userConfig.defaultImageId,
            defaultImageId: userConfig.defaultImageId,
            pickupEnabled: userConfig.pickupEnabled,
            shippingEnabled: userConfig.shippingEnabled
          });
          
          transformedProduct.pickupEnabled = userConfig.pickupEnabled;
          transformedProduct.shippingEnabled = userConfig.shippingEnabled;
          transformedProduct.shippingMeasurement = userConfig.shippingMeasurement;
          transformedProduct.transactionProcessAlias = userConfig.transactionProcessAlias;
          transformedProduct.unitType = userConfig.unitType;
          // Store default image path for later upload (we'll upload it fresh for each listing)
          if (userConfig.defaultImagePath) {
            transformedProduct.defaultImagePath = userConfig.defaultImagePath;
            console.log(`✅ Added default image path ${userConfig.defaultImagePath} to product ${ebayProduct.ebay_item_id}`);
          } else if (userConfig.defaultImageId) {
            // Fallback: if path not available but ID is, log warning
            transformedProduct.defaultImageId = userConfig.defaultImageId;
            console.log(`⚠️ Default image ID available but no file path - image may not work for multiple listings`);
          } else {
            console.log(`⚠️ No default image configured for user ${sharetribeUserId}`);
          }
        } else {
          console.warn(`⚠️ [${ebayProduct.ebay_item_id}] userConfig is null/undefined - no user configuration will be applied`);
          console.warn(`   sharetribeUserId: ${sharetribeUserId}`);
        }
        
        // Sync to ShareTribe (use existing sharetribe_listing_id if product was already synced)
        const syncStartTime = Date.now();
        const result = await sharetribeService.createOrUpdateListing(
          transformedProduct,
          ebayProduct.sharetribe_listing_id || null
        );
        const syncEndTime = Date.now();
        completedTimes.push(syncEndTime - syncStartTime);
        
        // Success! Clear retryAt now that we've successfully processed a request
        const rateLimitInfo = this.rateLimitStatus.get(syncJobId);
        if (rateLimitInfo && rateLimitInfo.retryAt && !rateLimitInfo.paused) {
          // We successfully processed a request after resume - clear retryAt
          rateLimitInfo.retryAt = null;
          rateLimitInfo.nextRetryAt = null;
          console.log(`✅ [SyncService] Successfully processed product after resume, cleared retryAt for job ${syncJobId}`);
        }
        
        // Keep only last 10 completion times for rolling average
        if (completedTimes.length > 10) {
          completedTimes.shift();
        }

        // Update or insert product in database
        await this.upsertProduct(tenantId, {
          ...ebayProduct,
          sharetribe_listing_id: result.listingId,
          synced: true,
          last_synced_at: new Date().toISOString(),
          user_id: sharetribeUserId || null
        });

        syncedCount++;
        
        // Update progress: product synced successfully
        this.updateSyncProgress(syncJobId, {
          jobId: syncJobId,
          total: totalProducts,
          completed: syncedCount,
          failed: failedCount,
          percent: Math.round(((syncedCount + failedCount) / totalProducts) * 100),
          status: 'in_progress',
          currentStep: `Synced ${syncedCount}/${totalProducts} products`,
          eta: this.calculateETA(syncedCount + failedCount, totalProducts, completedTimes, startTime),
          errors: errors.slice(-10)
        });
      } catch (error) {
        const now = Date.now();
        
        // Check if this is a rate limit error
        const isRateLimitError = error.message && (
          error.message.includes('rate limit') || 
          error.message.includes('429') || 
          error.message.includes('Too Many Requests') ||
          error.status === 429 ||
          (error.response && error.response.status === 429)
        );
        
        const errorCode = (error.response && error.response.status) || error.status || null;
        const errorMessage = error.message || (error.response && error.response.statusText) || 'Unknown error';
        
        if (isRateLimitError) {
          // Rate limit error - immediately compute new retryAt and transition to PAUSED_RATE_LIMIT
          // The rate limiter callback should have already been called with retryAt timestamp
          // But if not, we need to compute it here
          const retryAfterHeader = error.response?.headers?.['retry-after'] || 
                                   error.response?.headers?.['Retry-After'] || 
                                   60; // Default 60 seconds
          
          // Get retryAt from rate limiter callback (if available) or compute it
          const rateLimitInfo = this.rateLimitStatus.get(syncJobId);
          let retryAt;
          
          if (rateLimitInfo && rateLimitInfo.retryAt) {
            // Use retryAt from rate limiter (sliding window calculation)
            retryAt = rateLimitInfo.retryAt;
          } else {
            // Fallback: compute retryAt from retry-after header
            const retryAfterMs = parseInt(retryAfterHeader) * 1000;
            retryAt = now + retryAfterMs + 1500; // Add safety buffer
          }
          
          const retryAfterMs = Math.max(0, retryAt - now);
          const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
          
          // Set paused state immediately
          this.rateLimitStatus.set(syncJobId, {
            retryAfter: retryAfterSeconds,
            retryAfterMs: retryAfterMs,
            paused: true,
            pausedAt: now,
            nextRetryAt: retryAt,
            retryAt: retryAt,
            retryAttemptCount: (rateLimitInfo?.retryAttemptCount || 0) + 1,
            scheduledResume: false // Will schedule new resume
          });
          
          // Schedule new resume at retryAt
          this.scheduleResume(syncJobId, retryAt);
          
          // Update progress to PAUSED_RATE_LIMIT state immediately
          this.updateSyncProgress(syncJobId, {
            jobId: syncJobId,
            total: totalProducts,
            completed: syncedCount,
            failed: failedCount, // Don't increment yet - will retry
            percent: Math.round(((syncedCount + failedCount) / totalProducts) * 100),
            status: 'retry_scheduled',
            state: 'PAUSED_RATE_LIMIT', // Explicit state
            rateLimited: true,
            nextRetryAt: retryAt,
            retryAt: retryAt,
            retryInMs: retryAfterMs,
            retryInSeconds: retryAfterSeconds,
            lastAttemptAt: now,
            lastErrorCode: errorCode,
            lastErrorMessage: errorMessage,
            currentStep: `Sharetribe rate limit reached — resuming in ${formatTime(retryAfterSeconds)}`,
            eta: null,
            errors: errors.slice(-10)
          });
          
          console.warn(`⏸️ [SyncService] Rate limit error for product ${ebayProduct.ebay_item_id}, transitioned to PAUSED_RATE_LIMIT, retryAt: ${new Date(retryAt).toISOString()}`);
          
          // Break out of loop - will resume at retryAt
          break;
        } else {
          // Non-rate-limit error - mark as failed
          failedCount++;
          
          const errorInfo = {
            itemId: ebayProduct.ebay_item_id,
            title: ebayProduct.title || 'Unknown',
            error: errorMessage
          };
          errors.push(errorInfo);
          
          // Update progress: product failed
          this.updateSyncProgress(syncJobId, {
            jobId: syncJobId,
            total: totalProducts,
            completed: syncedCount,
            failed: failedCount,
            percent: Math.round(((syncedCount + failedCount) / totalProducts) * 100),
            status: 'in_progress',
            state: 'running',
            currentStep: `Failed: ${ebayProduct.title || ebayProduct.ebay_item_id}`,
            eta: this.calculateETA(syncedCount + failedCount, totalProducts, completedTimes, startTime),
            lastAttemptAt: now,
            lastErrorCode: errorCode,
            lastErrorMessage: errorMessage,
            errors: errors.slice(-10)
          });
          
          console.error(`❌ Error syncing product ${ebayProduct.ebay_item_id}:`, error);
        }
      }
    }

    // Final progress update
    // Only mark COMPLETED if processed === total (100%)
    // Otherwise, keep RUNNING or PAUSED so job can auto-continue
    const finalProcessed = syncedCount + failedCount; // All items have been attempted
    const finalPercent = totalProducts > 0 ? Math.round((finalProcessed / totalProducts) * 100) : 100;
    const remaining = totalProducts - finalProcessed;
    
    // Sanity check: Only COMPLETED if processed === total (100%)
    // If processed < total, keep job active (RUNNING or PAUSED) so it can auto-continue
    if (finalProcessed === totalProducts) {
      // All items processed - mark as COMPLETED
      this.updateSyncProgress(syncJobId, {
        jobId: syncJobId,
        total: totalProducts, // Locked total (set at job start)
        completed: syncedCount,
        failed: failedCount,
        processed: finalProcessed,
        remaining: 0,
        percent: 100,
        status: 'completed',
        state: 'COMPLETED',
        currentStep: 'Sync completed',
        eta: 0,
        errors: errors
      });
    } else {
      // Not fully processed - keep job active (will auto-continue)
      // Set to PAUSED with resumeAt so UI shows countdown
      const resumeAt = Date.now() + 5000; // Resume in 5s
      this.updateSyncProgress(syncJobId, {
        jobId: syncJobId,
        total: totalProducts,
        completed: syncedCount,
        failed: failedCount,
        processed: finalProcessed,
        remaining: remaining,
        percent: finalPercent,
        status: 'retry_scheduled',
        state: 'PAUSED', // Keep PAUSED so job can auto-continue
        nextRetryAt: resumeAt,
        retryAt: resumeAt,
        currentStep: 'Sync will continue automatically',
        eta: null,
        errors: errors
      });
      
      // Schedule auto-resume
      this.scheduleResume(syncJobId, resumeAt);
      console.log(`⏸️ [SyncService] Job ${syncJobId} not fully processed (${finalProcessed}/${totalProducts}), keeping active and scheduling auto-resume`);
      return; // Don't unregister job - it will continue
    }
    
    // Unregister sync job and rate limit callback
    rateLimiter.unregisterSyncJob(syncJobId);
    rateLimiter.unregisterRateLimitCallback(syncJobId);
    this.clearRateLimitStatus(syncJobId);
    
    // Clear progress after 5 minutes (keep it for a bit in case UI needs to refresh)
    setTimeout(() => {
      this.clearSyncProgress(syncJobId);
    }, 5 * 60 * 1000);

    return {
      success: true,
      synced: syncedCount,
      failed: failedCount,
      errors: errors,
      jobId: syncJobId
    };
    } catch (error) {
      console.error('❌ Error syncing products:', error);
      console.error('Error stack:', error.stack);
      
      // Update progress: sync failed
      const currentProgress = this.getSyncProgress(syncJobId);
      const totalProducts = currentProgress?.total || 0;
      this.updateSyncProgress(syncJobId, {
        jobId: syncJobId,
        total: totalProducts,
        completed: currentProgress?.completed || 0,
        failed: currentProgress?.failed || 0,
        percent: currentProgress?.percent || 0,
        status: 'error',
        currentStep: `Error: ${error.message}`,
        eta: null,
        errors: currentProgress?.errors || [{ itemId: 'SYNC_ERROR', error: error.message }]
      });
      
      // Unregister sync job and rate limit callback
      rateLimiter.unregisterSyncJob(syncJobId);
      rateLimiter.unregisterRateLimitCallback(syncJobId);
      this.clearRateLimitStatus(syncJobId);
      
      throw error;
    }
  }
  
  /**
   * Handle rate limit event
   * retryAfter can be retryAt timestamp (epoch ms) or milliseconds/seconds
   * Uses sliding window calculation: retryAt = oldestRequestTimestamp + 60000 + 1500ms
   */
  handleRateLimit(jobId, retryAfter, errorCode = 429, errorMessage = 'Rate limit exceeded') {
    const progress = this.getSyncProgress(jobId);
    if (progress) {
      const now = Date.now();
      
      // If retryAfter is a large number (> 1000000), treat it as retryAt timestamp (epoch ms)
      // Otherwise, treat as wait time in ms or seconds
      let retryAt;
      let retryAfterMs;
      
      if (retryAfter > 1000000) {
        // This is a retryAt timestamp (epoch ms)
        retryAt = retryAfter;
        retryAfterMs = Math.max(0, retryAt - now);
      } else {
        // This is wait time (ms or seconds)
        retryAfterMs = retryAfter > 1000 ? retryAfter : retryAfter * 1000;
        retryAt = now + retryAfterMs;
      }
      
      const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
      const retryAttemptCount = (progress.retryAttemptCount || 0) + 1;
      
      this.rateLimitStatus.set(jobId, {
        retryAfter: retryAfterSeconds,
        retryAfterMs: retryAfterMs,
        paused: true,
        pausedAt: now,
        nextRetryAt: retryAt,
        retryAt: retryAt, // Explicit retryAt timestamp (from sliding window)
        retryAttemptCount: retryAttemptCount,
        scheduledResume: false
      });
      
      // Update progress to PAUSED_RATE_LIMIT state
      this.updateSyncProgress(jobId, {
        ...progress,
        status: 'retry_scheduled',
        state: 'PAUSED_RATE_LIMIT',
        rateLimited: true,
        nextRetryAt: retryAt,
        retryAt: retryAt,
        retryInMs: retryAfterMs,
        retryInSeconds: retryAfterSeconds,
        retryAttemptCount: retryAttemptCount,
        lastAttemptAt: now,
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage,
        currentStep: `Sharetribe rate limit reached — resuming in ${formatTime(retryAfterSeconds)}`,
        rateLimitRetryAfter: retryAfterSeconds
      });
      
      // Schedule backend resume at retryAt (backend-owned)
      this.scheduleResume(jobId, retryAt);
      
      console.log(`⏸️ [SyncService] Rate limit hit for job ${jobId}, scheduled retry at ${new Date(retryAt).toISOString()} (in ${retryAfterSeconds}s / ${retryAfterMs}ms)`);
    }
  }
  
  /**
   * Schedule backend resume at retryAt timestamp (backend-owned)
   * When resume fires, sets state to RUNNING and clears pause flag
   * If job is not fully processed, it will continue automatically
   */
  scheduleResume(jobId, retryAt) {
    const rateLimitInfo = this.rateLimitStatus.get(jobId);
    if (!rateLimitInfo) {
      // Create rate limit info if it doesn't exist (for incomplete jobs)
      this.rateLimitStatus.set(jobId, {
        paused: true,
        pausedAt: Date.now(),
        retryAt: retryAt,
        nextRetryAt: retryAt,
        scheduledResume: false
      });
    }
    
    const currentRateLimitInfo = this.rateLimitStatus.get(jobId);
    if (currentRateLimitInfo.scheduledResume) {
      return; // Already scheduled
    }
    
    const now = Date.now();
    const waitMs = Math.max(0, retryAt - now);
    
    console.log(`⏰ [SyncService] Scheduling resume for job ${jobId} in ${Math.ceil(waitMs / 1000)}s (at ${new Date(retryAt).toISOString()})`);
    
    // Mark as scheduled
    currentRateLimitInfo.scheduledResume = true;
    
    // Store timeout ID for cleanup
    if (!this.resumeTimeouts) {
      this.resumeTimeouts = new Map();
    }
    
    // Clear any existing timeout for this job
    if (this.resumeTimeouts.has(jobId)) {
      clearTimeout(this.resumeTimeouts.get(jobId));
    }
    
    // Schedule resume using setTimeout
    const timeoutId = setTimeout(() => {
      console.log(`🔄 [SyncService] Resume fired for job ${jobId} at ${new Date().toISOString()}`);
      
      const currentProgress = this.getSyncProgress(jobId);
      const currentRateLimitInfo = this.rateLimitStatus.get(jobId);
      
      if (currentProgress) {
        // Check if job is fully processed
        const processed = (currentProgress.completed || 0) + (currentProgress.failed || 0);
        const total = currentProgress.total || 0;
        
        if (processed < total) {
          // Not fully processed - continue sync
          // Update state to RUNNING
          this.updateSyncProgress(jobId, {
            ...currentProgress,
            status: 'in_progress',
            state: 'RUNNING',
            rateLimited: false,
            nextRetryAt: null,
            retryAt: null,
            retryInMs: null,
            currentStep: 'Resuming sync...'
          });
          
          // Clear paused flag
          if (currentRateLimitInfo) {
            currentRateLimitInfo.paused = false;
            currentRateLimitInfo.resumedAt = Date.now();
          }
          
          console.log(`✅ [SyncService] Job ${jobId} resumed, state set to RUNNING (${processed}/${total} processed)`);
          
          // Continue sync by calling syncProducts again with remaining items
          // Get remaining product IDs from database
          const dbInstance = db.getDb();
          dbInstance.all(
            `SELECT ebay_item_id FROM products WHERE tenant_id = ? AND user_id = ? AND (synced = 0 OR sharetribe_listing_id IS NULL)`,
            [1, currentProgress.sharetribeUserId || null],
            async (err, rows) => {
              if (err) {
                console.error(`❌ [SyncService] Error fetching remaining products for job ${jobId}:`, err);
                return;
              }
              
              if (rows && rows.length > 0) {
                const remainingItemIds = rows.map(r => r.ebay_item_id);
                console.log(`🔄 [SyncService] Continuing sync for job ${jobId} with ${remainingItemIds.length} remaining products`);
                
                // Continue sync with remaining items
                try {
                  await this.syncProducts(1, remainingItemIds, currentProgress.sharetribeUserId, jobId);
                } catch (error) {
                  console.error(`❌ [SyncService] Error continuing sync for job ${jobId}:`, error);
                }
              } else {
                // All products processed - mark as COMPLETED
                this.updateSyncProgress(jobId, {
                  ...currentProgress,
                  status: 'completed',
                  state: 'COMPLETED',
                  currentStep: 'Sync completed',
                  percent: 100
                });
                
                // Unregister job
                rateLimiter.unregisterSyncJob(jobId);
                rateLimiter.unregisterRateLimitCallback(jobId);
                this.clearRateLimitStatus(jobId);
              }
            }
          );
        } else {
          // Fully processed - mark as COMPLETED
          this.updateSyncProgress(jobId, {
            ...currentProgress,
            status: 'completed',
            state: 'COMPLETED',
            currentStep: 'Sync completed',
            percent: 100
          });
          
          // Unregister job
          rateLimiter.unregisterSyncJob(jobId);
          rateLimiter.unregisterRateLimitCallback(jobId);
          this.clearRateLimitStatus(jobId);
        }
      } else {
        console.log(`⚠️ [SyncService] Job ${jobId} not found or already completed`);
      }
      
      // Clean up timeout
      this.resumeTimeouts.delete(jobId);
    }, waitMs);
    
    this.resumeTimeouts.set(jobId, timeoutId);
  }
  
  /**
   * Clear rate limit status and resume sync
   */
  clearRateLimitStatus(jobId) {
    const rateLimitInfo = this.rateLimitStatus.get(jobId);
    this.rateLimitStatus.delete(jobId);
    
    const progress = this.getSyncProgress(jobId);
    if (progress && (progress.status === 'rate_limited' || progress.status === 'retry_scheduled' || progress.state === 'retry_scheduled')) {
      const now = Date.now();
      this.updateSyncProgress(jobId, {
        ...progress,
        status: 'in_progress',
        state: 'running',
        rateLimited: false,
        nextRetryAt: null,
        retryInSeconds: null,
        lastAttemptAt: now,
        currentStep: 'Resuming sync...',
        rateLimitRetryAfter: null // Keep for backward compatibility
      });
      
      console.log(`▶️ [SyncService] Rate limit cleared for job ${jobId}, resuming sync`);
    }
  }
  
  /**
   * Check if it's time to retry based on nextRetryAt
   */
  shouldRetryNow(jobId) {
    const rateLimitInfo = this.rateLimitStatus.get(jobId);
    if (!rateLimitInfo || !rateLimitInfo.paused) {
      return false;
    }
    
    const now = Date.now();
    return now >= rateLimitInfo.nextRetryAt;
  }
  
  /**
   * Calculate ETA based on rolling average of completion times
   */
  calculateETA(completed, total, completedTimes, startTime) {
    if (completed === 0 || completedTimes.length === 0) {
      return null; // Not enough data yet
    }
    
    // Calculate average time per product from recent completions
    const avgTimePerProduct = completedTimes.reduce((sum, time) => sum + time, 0) / completedTimes.length;
    
    // Calculate effective rate (products per second)
    const effectiveRatePerSecond = 1000 / avgTimePerProduct; // Convert ms to seconds
    
    // Remaining products
    const remaining = total - completed;
    
    // ETA in seconds
    const etaSeconds = remaining / effectiveRatePerSecond;
    
    return Math.max(0, Math.round(etaSeconds));
  }

  async applyFieldMappings(product, mappings) {
    // Products from CSV already have ShareTribe field names (from CSV column mapping)
    // Products from eBay have eBay field names (need mapping via field_mappings table)
    
    // Debug logging
    console.log('applyFieldMappings input:', {
      ebay_item_id: product.ebay_item_id,
      hasTitle: 'title' in product,
      titleValue: product.title,
      titleType: typeof product.title,
      allKeys: Object.keys(product),
      productKeys: Object.getOwnPropertyNames(product)
    });
    
    // Check if product has ShareTribe field names (columns exist in database)
    // Even if values are NULL, if the columns exist, it's a CSV product
    const hasShareTribeColumns = 'title' in product || 
                                 'description' in product || 
                                 'price' in product ||
                                 product.title !== undefined ||
                                 product.description !== undefined ||
                                 product.price !== undefined;
    
    console.log('hasShareTribeColumns:', hasShareTribeColumns, 'mappings.length:', mappings.length);
    
    // If product has ShareTribe columns, it's from CSV - use as-is
    // Simply copy all fields except database metadata
    if (hasShareTribeColumns || mappings.length === 0) {
      const metadataColumns = ['id', 'tenant_id', 'synced', 'sharetribe_listing_id', 'last_synced_at', 'created_at', 'updated_at', 'user_id'];
      
      // Build cleaned product by explicitly copying each field
      // This is more reliable than spread operator with SQLite row objects
      const cleanedProduct = {};
      
      // Get ALL keys from the product object (including non-enumerable if needed)
      const allKeys = Object.keys(product).concat(Object.getOwnPropertyNames(product));
      const uniqueKeys = [...new Set(allKeys)];
      
      // Copy all fields except metadata
      uniqueKeys.forEach(key => {
        if (!metadataColumns.includes(key)) {
          // Explicitly copy the value
          cleanedProduct[key] = product[key];
        }
      });
      
      // CRITICAL: Explicitly ensure all important fields are set
      // This handles cases where properties might not be enumerable or spread didn't work
      if (product.title !== undefined) cleanedProduct.title = product.title;
      if (product.description !== undefined) cleanedProduct.description = product.description;
      if (product.price !== undefined) cleanedProduct.price = product.price;
      if (product.currency !== undefined) cleanedProduct.currency = product.currency;
      if (product.quantity !== undefined) cleanedProduct.quantity = product.quantity;
      if (product.images !== undefined) cleanedProduct.images = product.images;
      if (product.category !== undefined) cleanedProduct.category = product.category;
      if (product.condition !== undefined) cleanedProduct.condition = product.condition;
      if (product.brand !== undefined) cleanedProduct.brand = product.brand;
      if (product.sku !== undefined) cleanedProduct.sku = product.sku;
      if (product.ebay_item_id !== undefined) cleanedProduct.ebay_item_id = product.ebay_item_id;
      
      // Copy ALL custom fields (categoryLevel1, categoryLevel2, gearbrand, helmetsize, newused, etc.)
      uniqueKeys.forEach(key => {
        if (!metadataColumns.includes(key) && cleanedProduct[key] === undefined && product[key] !== undefined) {
          cleanedProduct[key] = product[key];
        }
      });
      
      console.log('applyFieldMappings output:', {
        ebay_item_id: cleanedProduct.ebay_item_id,
        hasTitle: 'title' in cleanedProduct,
        titleValue: cleanedProduct.title,
        hasDescription: 'description' in cleanedProduct,
        descriptionValue: cleanedProduct.description,
        hasPrice: 'price' in cleanedProduct,
        priceValue: cleanedProduct.price,
        allKeys: Object.keys(cleanedProduct),
        keyCount: Object.keys(cleanedProduct).length,
        allValues: JSON.stringify(cleanedProduct, null, 2)
      });
      
      // SAFETY CHECK: If cleanedProduct is empty, something went wrong
      if (Object.keys(cleanedProduct).length === 0) {
        console.error(`❌ FATAL: applyFieldMappings produced empty object for ${product.ebay_item_id}`);
        console.error('Input product keys:', Object.keys(product));
        console.error('Input product:', JSON.stringify(product, null, 2));
        // Return a minimal product with at least the title
        return {
          ebay_item_id: product.ebay_item_id,
          title: product.title || 'Unknown',
          description: product.description,
          price: product.price,
          currency: product.currency
        };
      }
      
      return cleanedProduct;
    }
    
    // Product has eBay field names, apply mappings
    const mappedProduct = {};
    
    for (const mapping of mappings) {
      const sourceValue = product[mapping.ebay_field];
      if (sourceValue !== undefined && sourceValue !== null && sourceValue !== '') {
        mappedProduct[mapping.sharetribe_field] = sourceValue;
      }
    }
    
    // Copy over other fields that aren't mapped (like ebay_item_id, id, etc.)
    for (const key in product) {
      if (product.hasOwnProperty(key) && !mappedProduct.hasOwnProperty(key)) {
        // Keep non-mapped fields that aren't eBay-specific
        if (!key.startsWith('ebay_') || key === 'ebay_item_id') {
          mappedProduct[key] = product[key];
        }
      }
    }

    return mappedProduct;
  }

  async getApiConfig(tenantId = 1) {
    return new Promise((resolve, reject) => {
      const dbInstance = db.getDb();
      dbInstance.get(
        'SELECT * FROM api_config WHERE tenant_id = ?',
        [tenantId],
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }

          if (!row) {
            resolve({ ebay: null, sharetribe: null });
            return;
          }

          resolve({
            ebay: {
              appId: row.ebay_app_id,
              certId: row.ebay_cert_id,
              devId: row.ebay_dev_id,
              accessToken: row.ebay_access_token,
              refreshToken: row.ebay_refresh_token,
              sandbox: row.ebay_sandbox !== undefined ? row.ebay_sandbox === 1 : true, // Default to sandbox if not set
              redirectUri: row.ebay_redirect_uri || null
            },
            sharetribe: {
              apiKey: row.sharetribe_api_key,
              apiSecret: row.sharetribe_api_secret,
              marketplaceApiClientId: row.sharetribe_marketplace_api_client_id,
              marketplaceId: row.sharetribe_marketplace_id,
              userId: row.sharetribe_user_id
            }
          });
        }
      );
    });
  }

  async getFieldMappings(tenantId = 1) {
    return new Promise((resolve, reject) => {
      const dbInstance = db.getDb();
      dbInstance.all(
        'SELECT * FROM field_mappings WHERE tenant_id = ?',
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
  }

  async getProductByEbayId(tenantId, ebayItemId) {
    return new Promise((resolve, reject) => {
      const dbInstance = db.getDb();
      dbInstance.get(
        'SELECT * FROM products WHERE tenant_id = ? AND ebay_item_id = ?',
        [tenantId, ebayItemId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row || null);
          }
        }
      );
    });
  }

  async upsertProduct(tenantId, productData) {
    return new Promise((resolve, reject) => {
      const dbInstance = db.getDb();
      
      // Define standard columns that are stored directly
      const standardColumns = [
        'id', 'tenant_id', 'user_id', 'ebay_item_id', 'title', 'description', 
        'price', 'currency', 'quantity', 'images', 'category', 'condition', 
        'brand', 'sku', 'synced', 'sharetribe_listing_id', 'last_synced_at',
        'created_at', 'updated_at', 'custom_fields',
        // Price fields (store in custom_fields but ensure they're accessible)
        'start_price', 'start_price_currency', 'buy_now_price', 'buy_now_price_currency',
        'current_price', 'current_price_currency'
      ];
      
      // Extract custom fields (everything not in standard columns)
      const customFields = {};
      for (const key in productData) {
        if (!standardColumns.includes(key) && productData[key] !== undefined && productData[key] !== null) {
          customFields[key] = productData[key];
        }
      }
      
      // Log categoryLevel fields being saved
      if (productData.categoryLevel1 || productData.categoryLevel2 || productData.categoryLevel3) {
        console.log(`Saving categoryLevel fields for product ${productData.ebay_item_id}:`, {
          categoryLevel1: productData.categoryLevel1,
          categoryLevel2: productData.categoryLevel2,
          categoryLevel3: productData.categoryLevel3,
          inCustomFields: {
            categoryLevel1: customFields.categoryLevel1,
            categoryLevel2: customFields.categoryLevel2,
            categoryLevel3: customFields.categoryLevel3
          }
        });
      }
      
      const customFieldsJson = Object.keys(customFields).length > 0 ? JSON.stringify(customFields) : null;
      
      // CRITICAL: Use composite key (user_id + ebay_item_id) to prevent cross-user collisions
      // Products are scoped per user - same ebay_item_id can exist for different users
      const userId = productData.user_id || null;
      
      // First check if product exists for THIS user
      const lookupQuery = userId !== null
        ? 'SELECT id FROM products WHERE tenant_id = ? AND user_id = ? AND ebay_item_id = ?'
        : 'SELECT id FROM products WHERE tenant_id = ? AND user_id IS NULL AND ebay_item_id = ?';
      
      const lookupParams = userId !== null
        ? [tenantId, userId, productData.ebay_item_id]
        : [tenantId, productData.ebay_item_id];
      
      dbInstance.get(lookupQuery, lookupParams, (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        if (row) {
          // Update existing product (only if it belongs to the same user)
          console.log(`Updating product ${productData.ebay_item_id} for user ${userId}:`, {
            title: productData.title,
            titleType: typeof productData.title,
            description: productData.description,
            price: productData.price,
            allFields: Object.keys(productData),
            customFields: customFields,
            allValues: Object.entries(productData).map(([k, v]) => `${k}: ${v !== null && v !== undefined ? v : 'NULL/UNDEFINED'}`).join(', ')
          });
          
          // CRITICAL: Update must filter by user_id to prevent cross-user updates
          const updateQuery = userId !== null
            ? `UPDATE products SET
                title = ?, description = ?, price = ?, currency = ?, quantity = ?,
                images = ?, category = ?, condition = ?, brand = ?, sku = ?,
                synced = ?, sharetribe_listing_id = ?, last_synced_at = ?,
                user_id = ?, custom_fields = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND user_id = ?`
            : `UPDATE products SET
                title = ?, description = ?, price = ?, currency = ?, quantity = ?,
                images = ?, category = ?, condition = ?, brand = ?, sku = ?,
                synced = ?, sharetribe_listing_id = ?, last_synced_at = ?,
                user_id = ?, custom_fields = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND user_id IS NULL`;
          
          const updateParams = userId !== null
            ? [
                productData.title || null,
                productData.description || null,
                productData.price || 0,
                productData.currency || 'USD',
                productData.quantity || 0,
                productData.images || null,
                productData.category || null,
                productData.condition || null,
                productData.brand || null,
                productData.sku || null,
                productData.synced ? 1 : 0,
                productData.sharetribe_listing_id || null,
                productData.last_synced_at || null,
                userId,
                customFieldsJson,
                row.id,
                userId // Additional filter to ensure we only update this user's product
              ]
            : [
                productData.title || null,
                productData.description || null,
                productData.price || 0,
                productData.currency || 'USD',
                productData.quantity || 0,
                productData.images || null,
                productData.category || null,
                productData.condition || null,
                productData.brand || null,
                productData.sku || null,
                productData.synced ? 1 : 0,
                productData.sharetribe_listing_id || null,
                productData.last_synced_at || null,
                null,
                customFieldsJson,
                row.id
              ];
          
          dbInstance.run(updateQuery, updateParams, function(updateErr) {
            if (updateErr) {
              reject(updateErr);
            } else {
              if (this.changes === 0) {
                console.warn(`⚠️ Update affected 0 rows for product ${productData.ebay_item_id} - product may belong to different user`);
              }
              resolve({ id: row.id });
            }
          });
        } else {
            // Insert new product
            dbInstance.run(
              `INSERT INTO products (
                tenant_id, user_id, ebay_item_id, title, description, price, currency, quantity,
                images, category, condition, brand, sku, synced, sharetribe_listing_id, last_synced_at, custom_fields
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                tenantId,
                productData.user_id || null,
                productData.ebay_item_id,
                productData.title,
                productData.description,
                productData.price,
                productData.currency,
                productData.quantity,
                productData.images,
                productData.category,
                productData.condition,
                productData.brand,
                productData.sku,
                productData.synced ? 1 : 0,
                productData.sharetribe_listing_id,
                productData.last_synced_at,
                customFieldsJson
              ],
              function(insertErr) {
                if (insertErr) {
                  reject(insertErr);
                } else {
                  resolve({ id: this.lastID });
                }
              }
            );
          }
        }
      );
    });
  }

  async refreshProductsFromEbay(tenantId = 1, sharetribeUserId = null, debug = false) {
    const config = await this.getApiConfig(tenantId);
    if (!config.ebay) {
      throw new Error('eBay API configuration missing');
    }

    const dbInstance = db.getDb();
    let ebayUserId = null;
    let useSandbox = true;

    // If ShareTribe user ID is provided, get eBay account associated with that user
    // sharetribeUserId can be either the database ID (integer) or sharetribe_user_id (UUID)
    if (sharetribeUserId) {
      // Try to find by database ID first (most common case)
      let sharetribeUser = await new Promise((resolve, reject) => {
        dbInstance.get(
          `SELECT id, sharetribe_user_id, ebay_user_id FROM sharetribe_users WHERE id = ?`,
          [sharetribeUserId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      // If not found by ID, try by sharetribe_user_id (UUID)
      if (!sharetribeUser) {
        sharetribeUser = await new Promise((resolve, reject) => {
          dbInstance.get(
            `SELECT id, sharetribe_user_id, ebay_user_id FROM sharetribe_users WHERE sharetribe_user_id = ?`,
            [sharetribeUserId],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });
      }

      if (!sharetribeUser) {
        throw new Error(`ShareTribe user ${sharetribeUserId} not found. Please check the user ID.`);
      }

      console.log(`🔍 Found ShareTribe user:`, {
        id: sharetribeUser.id,
        sharetribe_user_id: sharetribeUser.sharetribe_user_id,
        ebay_user_id: sharetribeUser.ebay_user_id
      });

      if (sharetribeUser.ebay_user_id) {
        ebayUserId = sharetribeUser.ebay_user_id;
        console.log(`✅ Using eBay account ${ebayUserId} associated with ShareTribe user (ID: ${sharetribeUser.id}, UUID: ${sharetribeUser.sharetribe_user_id})`);
        
        // Get sandbox flag from eBay user
        const ebayUser = await new Promise((resolve, reject) => {
          dbInstance.get(
            `SELECT sandbox FROM ebay_users WHERE tenant_id = ? AND ebay_user_id = ?`,
            [tenantId, ebayUserId],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });
        
        if (ebayUser) {
          useSandbox = ebayUser.sandbox === 1;
        } else {
          throw new Error(`eBay user ${ebayUserId} not found in database. The association may be invalid.`);
        }
      } else {
        throw new Error(`No eBay account connected for ShareTribe user (ID: ${sharetribeUser.id}, UUID: ${sharetribeUser.sharetribe_user_id}). Please connect an eBay account for this user in API Configuration.`);
      }
    } else {
      // Fallback: Get any connected eBay user
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

      if (!ebayUsers || ebayUsers.length === 0) {
        throw new Error('No eBay accounts connected. Please connect an eBay account first in API Configuration.');
      }

      // Use the first connected eBay user (most recent)
      const ebayUser = ebayUsers[0];
      ebayUserId = ebayUser.ebay_user_id;
      useSandbox = ebayUser.sandbox === 1;
    }

    // Create eBay service with user ID so it can load tokens from database
    const ebayConfig = {
      ...config.ebay,
      sandbox: useSandbox
    };
    const ebayService = new eBayService(ebayConfig, ebayUserId, tenantId);
    
    // Load tokens from database
    await ebayService.loadTokensFromDatabase();
    
    const result = await ebayService.getActiveListings({ debug });

    // Handle debug mode response
    if (result.debug) {
      return result; // Return debug response as-is
    }

    const products = result.items || result;

    if (!products || products.length === 0) {
      console.log('⚠️ No listings found from eBay');
      return { items: [], count: 0 };
    }

    console.log(`✅ Fetched ${products.length} listings from eBay`);

    // Get the ShareTribe user database ID if provided
    let sharetribeUserDbId = null;
    if (sharetribeUserId) {
      // sharetribeUserId might be the database ID or UUID, we need the database ID
      const sharetribeUser = await new Promise((resolve, reject) => {
        dbInstance.get(
          `SELECT id FROM sharetribe_users WHERE id = ? OR sharetribe_user_id = ?`,
          [sharetribeUserId, sharetribeUserId],
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

    for (const product of products) {
      await this.upsertProduct(tenantId, {
        ...product,
        synced: false, // Mark as needing sync
        user_id: sharetribeUserDbId || null // Associate with ShareTribe user
      });
    }

    return { items: products, count: products.length };
  }
}

module.exports = new SyncService();

