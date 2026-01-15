const db = require('../config/database');
const eBayService = require('./ebayService');
const ShareTribeService = require('./sharetribeService');
const rateLimiter = require('../utils/sharetribeRateLimiter');
const syncEventLogger = require('./syncEventLogger');

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
    this.rateLimitStatus = new Map(); // jobId -> { retryAfter: seconds, paused: boolean, retryAt: timestamp, rateLimitCount: number }
    
    // Track resume timeouts for cleanup
    this.resumeTimeouts = new Map(); // jobId -> timeoutId
    
    // Track retry attempts per product (for exponential backoff)
    this.productRetryAttempts = new Map(); // jobId -> Map(productId -> retryCount)
    
    // Max retry attempts before marking as failed
    this.MAX_RETRY_ATTEMPTS = 10;
  }
  
  /**
   * Get progress for a sync job
   */
  getSyncProgress(jobId) {
    const progress = this.syncProgress.get(jobId) || null;
    if (progress) {
      console.log(`📋 [SyncService] Getting progress for job ${jobId}:`, {
        total: progress.total || 0,
        completed: progress.completed || 0,
        failed: progress.failed || 0,
        percent: progress.percent || 0,
        status: progress.status || 'unknown',
        currentStep: progress.currentStep || 'N/A'
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
    
    // Ensure existingProgress has all required properties with defaults
    const safeExistingProgress = {
      completed: existingProgress.completed || 0,
      failed: existingProgress.failed || 0,
      total: existingProgress.total || 0,
      processed: existingProgress.processed || 0,
      percent: existingProgress.percent || 0,
      status: existingProgress.status || 'in_progress',
      state: existingProgress.state || 'RUNNING',
      updatedAt: existingProgress.updatedAt || now,
      lastUpdatedAt: existingProgress.lastUpdatedAt || now,
      ...existingProgress // Spread to preserve any other properties
    };
    
    // State machine: RUNNING, PAUSED_RATE_LIMIT (only for actual 429), COMPLETED, FAILED
    let state = progress.state || 'RUNNING';
    
    // Normalize state names
    if (state === 'PAUSED_RATE_LIMIT') {
      // Keep PAUSED_RATE_LIMIT - only for actual 429/Retry-After
      state = 'PAUSED_RATE_LIMIT';
    } else if (progress.status === 'retry_scheduled' || progress.status === 'rate_limited') {
      // Legacy rate limit status - check if it's a real rate limit
      if (progress.lastErrorCode === 429 || progress.lastErrorMessage?.includes('Rate limit exceeded')) {
        state = 'PAUSED_RATE_LIMIT';
      } else {
        // Not a real rate limit - keep as RUNNING (proactive pacing)
        state = 'RUNNING';
      }
    } else if (state === 'COMPLETED_SUCCESS') {
      state = 'COMPLETED';
    } else if (progress.status === 'completed') {
      // Only COMPLETED if processed === total (100%)
      const processed = (progress.completed !== undefined ? progress.completed : safeExistingProgress.completed) + 
                        (progress.failed !== undefined ? progress.failed : safeExistingProgress.failed);
      const total = progress.total !== undefined ? progress.total : safeExistingProgress.total;
      state = (processed === total) ? 'COMPLETED' : 'RUNNING'; // Keep RUNNING if not complete (don't set PAUSED)
    } else if (progress.status === 'error' || progress.status === 'failed' || state === 'FAILED') {
      // CRITICAL: Never set FAILED if this is a 429 rate limit error
      // Check if error is a rate limit (429) - if so, set to PAUSED_RATE_LIMIT instead
      const isRateLimitError = progress.lastErrorCode === 429 || 
                               progress.lastErrorMessage?.includes('rate limit') ||
                               progress.lastErrorMessage?.includes('429') ||
                               progress.lastErrorMessage?.includes('Too Many Requests');
      
      if (isRateLimitError) {
        // 429 error - set to PAUSED_RATE_LIMIT, not FAILED
        state = 'PAUSED_RATE_LIMIT';
        // Ensure retryAt is set if not already
        if (!progress.retryAt && !progress.nextRetryAt) {
          const now = Date.now();
          progress.retryAt = now + (this.minPauseSeconds || 15) * 1000;
          progress.nextRetryAt = progress.retryAt;
        }
      } else {
        // Non-rate-limit error - set to FAILED
        state = 'FAILED';
      }
    } else if (progress.retryAt || progress.nextRetryAt) {
      // Only set PAUSED_RATE_LIMIT if we have retryAt AND it's from a real 429
      // Otherwise, keep RUNNING (proactive pacing)
      if (progress.lastErrorCode === 429 || progress.lastErrorMessage?.includes('Rate limit exceeded')) {
        state = 'PAUSED_RATE_LIMIT';
      } else {
        // Proactive pacing - keep RUNNING
        state = 'RUNNING';
      }
    } else if (progress.status === 'in_progress' || progress.status === 'starting' || progress.status === 'running' || state === 'RUNNING') {
      state = 'RUNNING';
    }
    
    // Calculate retryAt and retryInMs if nextRetryAt is provided
    let retryAt = null;
    let retryInMs = null;
    if (progress.nextRetryAt) {
      retryAt = typeof progress.nextRetryAt === 'number' ? progress.nextRetryAt : parseInt(progress.nextRetryAt);
      retryInMs = Math.max(0, retryAt - now);
    } else if (progress.retryAt) {
      retryAt = typeof progress.retryAt === 'number' ? progress.retryAt : parseInt(progress.retryAt);
      retryInMs = Math.max(0, retryAt - now);
    }
    
    // For RUNNING state, ensure updatedAt refreshes every few seconds
    // This helps frontend detect if sync is still active
    const finalState = progress.state || state;
    const shouldRefreshUpdatedAt = finalState === 'RUNNING' && 
                                   safeExistingProgress.updatedAt && 
                                   (now - safeExistingProgress.updatedAt) > 3000; // Refresh every 3s
    
    const progressData = {
      ...safeExistingProgress,
      ...progress,
      state: finalState,
      lastUpdatedAt: now,
      updatedAt: shouldRefreshUpdatedAt ? now : (progress.updatedAt !== undefined ? progress.updatedAt : safeExistingProgress.updatedAt), // Refresh every 3s while RUNNING
      // Calculate processed and remaining
      processed: progress.processed !== undefined ? progress.processed : 
                 ((progress.completed !== undefined ? progress.completed : safeExistingProgress.completed) + 
                  (progress.failed !== undefined ? progress.failed : safeExistingProgress.failed)),
      // Lock total - never allow it to change after job starts
      total: safeExistingProgress.total || progress.total || 0, // Preserve locked total
      // Calculate remaining
      remaining: progress.remaining !== undefined ? progress.remaining : 
                 Math.max(0, (safeExistingProgress.total || progress.total || 0) - 
                 ((progress.completed !== undefined ? progress.completed : safeExistingProgress.completed) + 
                  (progress.failed !== undefined ? progress.failed : safeExistingProgress.failed))),
      // Preserve retry fields if not being updated
      lastAttemptAt: progress.lastAttemptAt !== undefined ? progress.lastAttemptAt : safeExistingProgress.lastAttemptAt,
      nextRetryAt: progress.nextRetryAt !== undefined ? progress.nextRetryAt : safeExistingProgress.nextRetryAt,
      retryAt: retryAt !== null ? retryAt : (progress.retryAt !== undefined ? progress.retryAt : safeExistingProgress.retryAt), // Explicit retryAt timestamp
      retryInMs: retryInMs !== null ? retryInMs : (progress.retryInMs !== undefined ? progress.retryInMs : safeExistingProgress.retryInMs), // Milliseconds until retry
      retryAttemptCount: progress.retryAttemptCount !== undefined ? progress.retryAttemptCount : (safeExistingProgress.retryAttemptCount || 0),
      lastErrorCode: progress.lastErrorCode !== undefined ? progress.lastErrorCode : safeExistingProgress.lastErrorCode,
      lastErrorMessage: progress.lastErrorMessage !== undefined ? progress.lastErrorMessage : safeExistingProgress.lastErrorMessage,
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
          synced: existingProgress.completed || 0,
          failed: existingProgress.failed || 0,
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
    // Callback receives: (retryAt, errorCode, errorMessage, retryAfterHeader)
    // retryAt is epoch milliseconds (timestamp) when retry should happen
    rateLimiter.registerRateLimitCallback(syncJobId, async (retryAt, errorCode = 429, errorMessage = 'Rate limit exceeded', retryAfterHeader = null) => {
      await this.handleRateLimit(syncJobId, retryAt, errorCode, errorMessage, retryAfterHeader);
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
      
      // Set sync context for event logging
      sharetribeService.setSyncContext(syncJobId, tenantId, sharetribeUserId, null);

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
      
      // Persist job record with totalProducts set
      await syncEventLogger.updateJobProgress(syncJobId, {
        state: 'RUNNING',
        processed: 0,
        total: totalProducts, // Set totalProducts now
        completed: 0,
        failed: 0,
        currentProductId: null,
        currentStep: `Starting sync of ${totalProducts} product(s)...`,
        retryAt: null,
        throttleSettings: {
          minDelayMs: rateLimiter.minRequestInterval || 1000,
          concurrency: rateLimiter.maxRequestsPerMinute || 100
        },
        workspaceId: tenantId,
        userId: sharetribeUserId || null
      });
      
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
        errors: [],
        workspaceId: tenantId,
        userId: sharetribeUserId || null
      });
      
      console.log(`🚀 Starting sync job ${syncJobId}: ${totalProducts} products to sync`);
      console.log(`📋 [SyncService] Progress updated - total: ${totalProducts}`);

      for (let i = 0; i < productsToSync.length; i++) {
        const ebayProduct = productsToSync[i];
        const productIndex = i + 1;
        
        // Check if we're paused due to rate limit - check both in-memory and DB
        let rateLimitInfo = this.rateLimitStatus.get(syncJobId);
        let retryAt = null;
        
        // First check in-memory state
        if (rateLimitInfo && rateLimitInfo.paused && rateLimitInfo.retryAt) {
          retryAt = rateLimitInfo.retryAt;
        } else {
          // Check DB for paused state (in case process restarted)
          const dbProgress = await syncEventLogger.getJobSnapshotFromDB(syncJobId);
          if (dbProgress && dbProgress.state === 'PAUSED_RATE_LIMIT' && dbProgress.retry_at) {
            retryAt = typeof dbProgress.retry_at === 'number' ? dbProgress.retry_at : new Date(dbProgress.retry_at).getTime();
            // Restore in-memory state
            if (!rateLimitInfo) {
              rateLimitInfo = {};
              this.rateLimitStatus.set(syncJobId, rateLimitInfo);
            }
            rateLimitInfo.paused = true;
            rateLimitInfo.retryAt = retryAt;
            console.log(`🔄 [SyncService] Restored paused state from DB for job ${syncJobId}, retryAt: ${new Date(retryAt).toISOString()}`);
          }
        }
        
        if (retryAt) {
          const now = Date.now();
          
          if (now < retryAt) {
            // Still waiting - update progress with heartbeat and wait
            const retryInMs = Math.max(0, retryAt - now);
            const retryInSeconds = Math.ceil(retryInMs / 1000);
            
            // Log pause start
            console.log(`⏸️ [SyncService] PAUSED start - jobId: ${syncJobId}, retryInSeconds: ${retryInSeconds}, current index i: ${i}, product: ${i + 1}/${totalProducts}`);
            
            // Update progress with heartbeat (persist to DB)
            this.updateSyncProgress(syncJobId, {
              jobId: syncJobId,
              total: totalProducts,
              completed: syncedCount,
              failed: failedCount,
              processed: syncedCount + failedCount,
              percent: Math.round(((syncedCount + failedCount) / totalProducts) * 100),
              state: 'PAUSED_RATE_LIMIT', // Use specific state for rate limits
              status: 'paused',
              nextRetryAt: retryAt,
              retryAt: retryAt,
              retryInMs: retryInMs,
              retryInSeconds: retryInSeconds,
              rateLimited: true,
              rateLimitCount: rateLimitInfo?.rateLimitCount || 0,
              currentStep: `Sharetribe API limit reached (100 requests/min). Sync will resume in ${formatTime(retryInSeconds)}.`,
              eta: null,
              errors: errors.slice(-10),
              updatedAt: now // Heartbeat update
            });
            
            // Persist to DB with heartbeat
            await syncEventLogger.updateJobProgress(syncJobId, {
              state: 'PAUSED_RATE_LIMIT',
              retryAt: retryAt,
              updatedAt: now,
              currentStep: `Sharetribe API limit reached (100 requests/min). Sync will resume in ${formatTime(retryInSeconds)}.`
            }).catch(err => {
              console.error(`[SyncService] Error persisting pause state:`, err);
            });
            
            // Wait until retry time (with periodic heartbeat updates)
            const waitStartTime = now;
            const heartbeatInterval = 3000; // Update every 3 seconds
            
            while (Date.now() < retryAt) {
              const remainingMs = Math.max(0, retryAt - Date.now());
              const waitMs = Math.min(remainingMs, heartbeatInterval);
              
              await new Promise(resolve => setTimeout(resolve, waitMs));
              
              // Heartbeat update while waiting
              const currentNow = Date.now();
              if (currentNow < retryAt) {
                const currentRetryInSeconds = Math.ceil((retryAt - currentNow) / 1000);
                await syncEventLogger.updateJobProgress(syncJobId, {
                  state: 'PAUSED_RATE_LIMIT',
                  retryAt: retryAt,
                  updatedAt: currentNow,
                  currentStep: `Sharetribe API limit reached (100 requests/min). Sync will resume in ${formatTime(currentRetryInSeconds)}.`
                }).catch(() => {}); // Ignore errors in heartbeat
              }
            }
          }
          
          // After wait, clear pause flag and update state to RUNNING
          const resumeNow = Date.now();
          const resumeRetryInSeconds = Math.ceil((retryAt - resumeNow) / 1000);
          
          // Log resume
          console.log(`▶️ [SyncService] RESUMED at ${new Date(resumeNow).toISOString()} - jobId: ${syncJobId}, now>=retryAt: ${resumeNow >= retryAt}, continuing i=${i}, product: ${i + 1}/${totalProducts}, retryInSeconds was: ${resumeRetryInSeconds}`);
          
          if (rateLimitInfo) {
            rateLimitInfo.paused = false;
          }
          
          // Update state to RUNNING and persist to DB
          await syncEventLogger.updateJobProgress(syncJobId, {
            state: 'RUNNING',
            updatedAt: resumeNow,
            currentStep: `Resuming sync after rate limit pause...`
          }).catch(() => {});
          
          this.updateSyncProgress(syncJobId, {
            jobId: syncJobId,
            state: 'RUNNING',
            status: 'in_progress',
            retryAt: null,
            nextRetryAt: null,
            updatedAt: resumeNow
          });
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
          
          // Success! Clear retryAt now that we've successfully processed a request after pause
          const rateLimitInfo = this.rateLimitStatus.get(syncJobId);
          if (rateLimitInfo && rateLimitInfo.retryAt) {
            // We successfully processed a request after resume - clear retryAt and set to RUNNING
            rateLimitInfo.retryAt = null;
            rateLimitInfo.nextRetryAt = null;
            console.log(`✅ Successfully processed product ${ebayProduct.ebay_item_id} after resume, cleared retryAt and setting to RUNNING`);
            
            // Now set state to RUNNING since we've successfully processed at least one request
            this.updateSyncProgress(syncJobId, {
              jobId: syncJobId,
              state: 'RUNNING',
              status: 'in_progress',
              rateLimited: false,
              currentStep: `Syncing product ${productIndex}/${totalProducts}: ${ebayProduct.title || ebayProduct.ebay_item_id}`,
              nextRetryAt: null,
              retryAt: null,
              retryInMs: null
            });
            
            // Clear rate limit status (but keep job registered)
            this.rateLimitStatus.delete(syncJobId);
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
          const processed = syncedCount + failedCount;
          
          // Update event logger snapshot
          await syncEventLogger.updateJobProgress(syncJobId, {
            state: 'RUNNING',
            processed: processed,
            total: totalProducts,
            completed: syncedCount,
            failed: failedCount,
            currentProductId: ebayProduct.ebay_item_id,
            currentStep: `Synced ${syncedCount}/${totalProducts} products`,
            retryAt: null,
            throttleSettings: {
              minDelayMs: rateLimiter.minRequestInterval || 1000,
              concurrency: rateLimiter.maxRequestsPerMinute || 100
            },
            workspaceId: tenantId,
            userId: sharetribeUserId || null
          });
          
          // Update progress: product synced successfully
          this.updateSyncProgress(syncJobId, {
            jobId: syncJobId,
            total: totalProducts,
            completed: syncedCount,
            failed: failedCount,
            percent: Math.round((processed / totalProducts) * 100),
            status: 'in_progress',
            currentStep: `Synced ${syncedCount}/${totalProducts} products`,
            eta: this.calculateETA(processed, totalProducts, completedTimes, startTime),
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
            // Rate limit error (429) - treat as retryable, do NOT mark as failed
            console.warn(`⏸️ [SyncService] Rate limit error (429) for product ${ebayProduct.ebay_item_id}`);
            
            // Get retry count for this product
            let productRetries = this.productRetryAttempts.get(syncJobId);
            if (!productRetries) {
              productRetries = new Map();
              this.productRetryAttempts.set(syncJobId, productRetries);
            }
            const productRetryCount = productRetries.get(ebayProduct.ebay_item_id) || 0;
            
            // Check if max retries exceeded
            if (productRetryCount >= this.MAX_RETRY_ATTEMPTS) {
              console.error(`❌ [SyncService] Max retry attempts (${this.MAX_RETRY_ATTEMPTS}) exceeded for product ${ebayProduct.ebay_item_id}, marking as failed`);
              failedCount++;
              const errorInfo = {
                itemId: ebayProduct.ebay_item_id,
                title: ebayProduct.title || 'Unknown',
                error: `Rate limit retry failed after ${this.MAX_RETRY_ATTEMPTS} attempts`
              };
              errors.push(errorInfo);
              
              // Update progress: product failed after max retries
              this.updateSyncProgress(syncJobId, {
                jobId: syncJobId,
                total: totalProducts,
                completed: syncedCount,
                failed: failedCount,
                percent: Math.round(((syncedCount + failedCount) / totalProducts) * 100),
                status: 'in_progress',
                state: 'RUNNING',
                currentStep: `Max retries exceeded for ${ebayProduct.title || ebayProduct.ebay_item_id}`,
                eta: this.calculateETA(syncedCount + failedCount, totalProducts, completedTimes, startTime),
                errors: errors.slice(-10)
              });
              
              // Continue to next product
              continue;
            }
            
            // Increment retry count for this product
            productRetries.set(ebayProduct.ebay_item_id, productRetryCount + 1);
            
            // Calculate retryAt
            const retryAfterHeader = error.response?.headers?.['retry-after'] || 
                                     error.response?.headers?.['Retry-After'];
            
            // Extract endpoint info from error
            const endpoint = error.config?.url || error.response?.config?.url || 'unknown';
            
            let retryAt;
            if (retryAfterHeader) {
              // Use Retry-After header with safety buffer
              const retryAfterSeconds = parseInt(retryAfterHeader);
              retryAt = now + (retryAfterSeconds * 1000) + 1500; // Add 1500ms buffer
              console.log(`⏸️ [SyncService] Using Retry-After header: ${retryAfterSeconds}s + 1500ms buffer`);
            } else {
              // Fallback to exponential backoff
              const backoffMs = this.calculateExponentialBackoff(productRetryCount);
              retryAt = now + backoffMs;
              console.log(`⏸️ [SyncService] No Retry-After header, using exponential backoff: ${Math.ceil(backoffMs / 1000)}s (attempt ${productRetryCount + 1})`);
            }
            
            // Log 429 occurrence with all details
            console.log(`🚨 [SyncService] 429 OCCURRED - jobId: ${syncJobId}, endpoint: ${endpoint}, retryAt: ${new Date(retryAt).toISOString()}, retryAfterHeader: "${retryAfterHeader || 'none'}", current index i: ${i}, product: ${i + 1}/${totalProducts}`);
            
            // Call handleRateLimit to set PAUSED_RATE_LIMIT state (await to ensure DB persistence)
            await this.handleRateLimit(syncJobId, retryAt, errorCode, errorMessage, retryAfterHeader);
            
            // Decrement i to retry the same product after pause
            i--; // Will be incremented by for loop, so this retries the same product
            console.log(`🔄 [SyncService] Will retry product ${ebayProduct.ebay_item_id} after pause (attempt ${productRetryCount + 1}/${this.MAX_RETRY_ATTEMPTS})`);
            
            // Continue to restart loop - will hit pause check at top, wait until retryAt, then retry same product
            continue;
          } else {
            // Check if error is retryable (400/401/403/404 are NOT retryable)
            const isRetryableError = errorCode !== 400 && errorCode !== 401 && errorCode !== 403 && errorCode !== 404;
            
            if (!isRetryableError) {
              // Non-retryable error (validation/auth) - mark as failed immediately
              console.error(`❌ [SyncService] Non-retryable error (${errorCode}) for product ${ebayProduct.ebay_item_id}: ${errorMessage}`);
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
        await syncEventLogger.updateJobProgress(syncJobId, {
          state: 'COMPLETED',
          processed: finalProcessed,
          total: totalProducts,
          completed: syncedCount,
          failed: failedCount,
          currentProductId: null,
          currentStep: 'Sync completed',
          retryAt: null,
          throttleSettings: {
            minDelayMs: rateLimiter.minRequestInterval || 1000,
            concurrency: rateLimiter.maxRequestsPerMinute || 100
          },
          workspaceId: tenantId,
          userId: sharetribeUserId || null
        });
        
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
        // Not fully processed - this should never happen if loop logic is correct
        // If we reach here, it means the loop exited early (shouldn't happen)
        console.error(`❌ [SyncService] Job ${syncJobId} reached end of syncProducts but not fully processed (${finalProcessed}/${totalProducts}). This indicates a bug in the loop logic.`);
        
        // Mark as FAILED since we can't auto-continue without a resume mechanism
        await syncEventLogger.updateJobProgress(syncJobId, {
          state: 'FAILED',
          processed: finalProcessed,
          total: totalProducts,
          completed: syncedCount,
          failed: failedCount,
          currentProductId: null,
          currentStep: `Sync stopped unexpectedly (${finalProcessed}/${totalProducts} processed)`,
          retryAt: null
        });
        
        this.updateSyncProgress(syncJobId, {
          jobId: syncJobId,
          total: totalProducts,
          completed: syncedCount,
          failed: failedCount,
          processed: finalProcessed,
          remaining: remaining,
          percent: finalPercent,
          status: 'error',
          state: 'FAILED',
          currentStep: `Sync stopped unexpectedly (${finalProcessed}/${totalProducts} processed)`,
          eta: null,
          errors: errors
        });
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
      
      // Get current progress safely
      const currentProgress = this.getSyncProgress(syncJobId) || {};
      const totalProducts = currentProgress.total || 0;
      const currentCompleted = currentProgress.completed || 0;
      const currentFailed = currentProgress.failed || 0;
      const currentPercent = currentProgress.percent || 0;
      const currentErrors = currentProgress.errors || [];
      
      // Check if this is a rate limit error (429) - should pause, not fail
      const isRateLimitError = error.response?.status === 429 || 
                               error.status === 429 ||
                               error.message?.includes('rate limit') ||
                               error.message?.includes('429') ||
                               error.message?.includes('Too Many Requests');
      
      if (isRateLimitError) {
        // 429 error - pause and resume, don't fail
        console.warn(`⏸️ [SyncService] Rate limit error (429) caught in outer catch - pausing sync job ${syncJobId}`);
        
        // Calculate retryAt
        const now = Date.now();
        const retryAfterHeader = error.response?.headers?.['retry-after'] || 
                                 error.response?.headers?.['Retry-After'];
        
        let retryAt;
        if (retryAfterHeader) {
          const retryAfterSeconds = parseInt(retryAfterHeader);
          retryAt = now + (retryAfterSeconds * 1000) + 1500; // Add 1500ms buffer
        } else {
          // Default backoff: 15 seconds
          retryAt = now + 15000;
        }
        
        // Set to PAUSED_RATE_LIMIT state - sync will resume automatically (await to ensure DB persistence)
        await this.handleRateLimit(syncJobId, retryAt, 429, error.message || 'Rate limit exceeded', retryAfterHeader);
        
        // Update progress to show paused state
        this.updateSyncProgress(syncJobId, {
          jobId: syncJobId,
          total: totalProducts,
          completed: currentCompleted,
          failed: currentFailed,
          percent: currentPercent,
          status: 'paused',
          state: 'PAUSED_RATE_LIMIT',
          currentStep: `Rate limit reached. Sync will resume automatically in ${Math.ceil((retryAt - now) / 1000)}s`,
          eta: null,
          errors: currentErrors,
          nextRetryAt: retryAt,
          retryAt: retryAt,
          retryInMs: retryAt - now
        });
        
        // Don't unregister job - it will resume automatically
        // Don't throw error - let the job stay active so it can resume
        return {
          success: false,
          synced: currentCompleted,
          failed: currentFailed,
          errors: currentErrors,
          jobId: syncJobId,
          paused: true,
          retryAt: retryAt
        };
      } else {
        // Non-rate-limit error - mark as FAILED
        const finalState = 'FAILED';
        
        this.updateSyncProgress(syncJobId, {
          jobId: syncJobId,
          total: totalProducts,
          completed: currentCompleted,
          failed: currentFailed,
          percent: currentPercent,
          status: 'error',
          state: finalState,
          currentStep: `Error: ${error.message}`,
          eta: null,
          errors: [...currentErrors, { itemId: 'SYNC_ERROR', error: error.message }]
        });
        
        // Unregister sync job and rate limit callback
        rateLimiter.unregisterSyncJob(syncJobId);
        rateLimiter.unregisterRateLimitCallback(syncJobId);
        this.clearRateLimitStatus(syncJobId);
        
        throw error;
      }
    }
  }
  
  
  /**
   * Handle rate limit event
   * retryAt is epoch milliseconds (timestamp) when retry should happen
   */
  async handleRateLimit(jobId, retryAt, errorCode = 429, errorMessage = 'Rate limit exceeded', retryAfterHeader = null) {
    // Only handle actual rate limits (429), not proactive pacing
    if (errorCode !== 429) {
      console.log(`ℹ️ [SyncService] Ignoring non-429 rate limit callback (errorCode: ${errorCode}) - this is proactive pacing, not a real rate limit`);
      return;
    }
    
    const progress = this.getSyncProgress(jobId);
    if (!progress) {
      console.warn(`⚠️ [SyncService] handleRateLimit called but no progress found for jobId: ${jobId}`);
      return;
    }
    
    const now = Date.now();
    const retryAfterMs = Math.max(0, retryAt - now);
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
    
    // Log 429 handling (this is called from rate limiter callback)
    console.log(`🚨 [SyncService] handleRateLimit called - jobId: ${jobId}, retryAt: ${new Date(retryAt).toISOString()}, retryAfterHeader: "${retryAfterHeader || 'none'}", retryInSeconds: ${retryAfterSeconds}`);
    
    // Get existing rate limit info or create new
    const existingRateLimitInfo = this.rateLimitStatus.get(jobId) || {};
    const rateLimitCount = (existingRateLimitInfo.rateLimitCount || 0) + 1;
    
    // Store rate limit info with counter
    this.rateLimitStatus.set(jobId, {
      paused: true,
      pausedAt: now,
      retryAt: retryAt,
      retryAttemptCount: (existingRateLimitInfo.retryAttemptCount || 0) + 1,
      rateLimitCount: rateLimitCount,
      isRealRateLimit: true, // Flag to distinguish from proactive pacing
      retryAfterHeader: retryAfterHeader
    });
    
    // Update progress to PAUSED_RATE_LIMIT state (only for actual 429)
    this.updateSyncProgress(jobId, {
      ...progress,
      state: 'PAUSED_RATE_LIMIT', // Use specific state for actual rate limits
      status: 'paused',
      nextRetryAt: retryAt,
      retryAt: retryAt,
      retryInMs: retryAfterMs,
      retryInSeconds: retryAfterSeconds,
      retryAttemptCount: existingRateLimitInfo.retryAttemptCount || 0,
      rateLimitCount: rateLimitCount,
      rateLimited: true,
      lastAttemptAt: now,
      lastErrorCode: errorCode,
      lastErrorMessage: errorMessage,
      currentStep: `Sharetribe API limit reached (100 requests/min). Sync will resume in ${formatTime(retryAfterSeconds)}.`,
      updatedAt: now // Heartbeat
    });
    
    // Persist to database IMMEDIATELY (critical for persistence across restarts) IMMEDIATELY (critical for persistence across restarts)
    await syncEventLogger.updateJobProgress(jobId, {
      state: 'PAUSED_RATE_LIMIT',
      retryAt: retryAt, // Absolute epoch ms timestamp
      updatedAt: now, // Heartbeat
      rateLimited: true,
      rateLimitCount: rateLimitCount,
      currentStep: `Sharetribe API limit reached (100 requests/min). Sync will resume in ${formatTime(retryAfterSeconds)}.`
    }).catch(err => {
      console.error(`[SyncService] Error updating job progress for rate limit:`, err);
      // Don't throw - progress endpoint should never fail
    });
    
    console.log(`⏸️ [SyncService] Real rate limit hit (429) for job ${jobId}, paused until ${new Date(retryAt).toISOString()} (in ${retryAfterSeconds}s), rateLimitCount: ${rateLimitCount}`);
  }
  
  /**
   * Calculate exponential backoff retry time
   * Starts at 10s, doubles up to 60s max
   */
  calculateExponentialBackoff(retryCount) {
    const baseDelay = 10; // 10 seconds
    const maxDelay = 60; // 60 seconds max
    const delay = Math.min(maxDelay, baseDelay * Math.pow(2, retryCount));
    return delay * 1000; // Convert to milliseconds
  }
  
  /**
   * REMOVED: scheduleResume is no longer needed
   * Pauses are now handled directly in the sync loop
   */
  _scheduleResume_removed(jobId, retryAt) {
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
          // Keep state as PAUSED until first successful API request
          // Don't clear resumeAt yet - will be cleared after first success
          this.updateSyncProgress(jobId, {
            ...currentProgress,
            status: 'retry_scheduled',
            state: 'PAUSED', // Keep PAUSED until first successful request
            rateLimited: true,
            // Keep retryAt/resumeAt until first successful request
            nextRetryAt: retryAt,
            retryAt: retryAt,
            retryInMs: 0, // Countdown should be 0 (ready to retry)
            currentStep: `Sync paused — resuming in 00:00`
          });
          
          // Clear paused flag to allow processing, but keep retryAt
          if (currentRateLimitInfo) {
            currentRateLimitInfo.paused = false;
            currentRateLimitInfo.resumedAt = Date.now();
            // Keep retryAt until first successful request
          }
          
          console.log(`✅ [SyncService] Job ${jobId} ready to resume, keeping PAUSED until first success (${processed}/${total} processed)`);
          
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
    
    // Don't update state here - let the sync loop handle state transitions
    // Only clear the rate limit status map entry
    console.log(`▶️ [SyncService] Rate limit cleared for job ${jobId}`);
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

