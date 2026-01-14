/**
 * ShareTribe Integration API Rate Limiter
 * 
 * Implements token bucket algorithm for smooth throttling:
 * - /listings/create: 100 requests per 60 seconds (capacity=100, refill=100/60 per sec)
 * - POST endpoints: 30/min (capacity=30, refill=30/60 per sec)
 * - GET endpoints: 60/min (capacity=60, refill=60/60 per sec)
 * - Concurrency: max 10 concurrent requests per client IP (we use max 5 for safety)
 * 
 * Features:
 * - Smooth throttling (no burst pauses)
 * - Safety buffer on retries (+1500ms)
 * - Gradual concurrency ramp-up after rate limit
 */

class RateLimitError extends Error {
  constructor(waitMs, endpointType, retryAt = null) {
    super(`Rate limit exceeded. Retry after ${Math.ceil(waitMs / 1000)}s`);
    this.type = 'RATE_LIMIT';
    this.retryAfterMs = waitMs;
    this.endpointType = endpointType;
    this.retryAt = retryAt; // Absolute timestamp (epoch ms) when retry should happen
  }
}

class ShareTribeRateLimiter {
  constructor(options = {}) {
    // Rate limits (requests per 60 seconds)
    this.createListingRate = options.createListingRate || 100; // Capacity
    this.postRate = options.postRate || 30;
    this.getRate = options.getRate || 60;
    
    // Fixed pacing: minimum time between requests (750ms = ~80 requests/min, safe under 100/min)
    this.minRequestInterval = options.minRequestInterval || 750; // milliseconds
    
    // Track request timestamps for sliding window (one array per endpoint type)
    this.requestTimestamps = {
      create: [],
      post: [],
      get: []
    };
    
    // Track last request time for pacing
    this.lastRequestTime = {
      create: 0,
      post: 0,
      get: 0
    };
    
    // Concurrency limits (start low, ramp up)
    this.maxConcurrency = options.maxConcurrency || 2; // Start with 2 for safety
    this.currentMaxConcurrency = 1; // Start with 1, ramp up after resume
    
    // Track when we last hit rate limit (for gradual ramp-up)
    this.lastRateLimitHit = null;
    this.rampUpStartTime = null;
    
    // Track in-flight requests
    this.inFlightRequests = 0;
    this.requestQueue = [];
    
    // Track retry attempts for exponential backoff
    this.retryAttempts = new Map();
    
    // Track sync jobs to prevent concurrent syncs
    this.activeSyncJob = null;
    
    // Track rate limit events for progress updates
    this.rateLimitCallbacks = new Map(); // jobId -> callback function
    
    // Safety buffer for retries (milliseconds)
    this.safetyBufferMs = options.safetyBufferMs || 1500;
    
    // Window size in milliseconds (60 seconds)
    this.windowMs = 60000;
  }
  
  /**
   * Register a callback for rate limit events
   */
  registerRateLimitCallback(jobId, callback) {
    this.rateLimitCallbacks.set(jobId, callback);
  }
  
  /**
   * Unregister rate limit callback
   */
  unregisterRateLimitCallback(jobId) {
    this.rateLimitCallbacks.delete(jobId);
  }
  
  /**
   * Notify about rate limit event
   */
  notifyRateLimit(jobId, retryAfter) {
    const callback = this.rateLimitCallbacks.get(jobId);
    if (callback) {
      callback(retryAfter);
    }
  }
  
  /**
   * Clean old timestamps outside the sliding window
   */
  cleanOldTimestamps(endpointType) {
    const now = Date.now();
    const timestamps = this.requestTimestamps[endpointType];
    
    // Remove timestamps older than 60 seconds
    while (timestamps.length > 0 && now - timestamps[0] > this.windowMs) {
      timestamps.shift();
    }
  }
  
  /**
   * Check rate limit using sliding window + fixed pacing
   * Returns wait time in milliseconds if rate limited, or 0 if allowed
   * Also returns oldestTimestamp for retryAt calculation
   */
  checkRateLimit(endpointType) {
    const now = Date.now();
    const timestamps = this.requestTimestamps[endpointType];
    
    // Clean old timestamps
    this.cleanOldTimestamps(endpointType);
    
    // Get rate limit for this endpoint type
    let rateLimit;
    switch (endpointType) {
      case 'create':
        rateLimit = this.createListingRate;
        break;
      case 'post':
        rateLimit = this.postRate;
        break;
      case 'get':
        rateLimit = this.getRate;
        break;
      default:
        rateLimit = 100;
    }
    
    // Check sliding window limit
    if (timestamps.length >= rateLimit) {
      // Calculate retryAt using sliding window: oldestTimestamp + 60000 + buffer
      const oldestTimestamp = timestamps[0];
      const retryAt = oldestTimestamp + this.windowMs + this.safetyBufferMs;
      const waitMs = Math.max(0, retryAt - now);
      
      return { waitMs, oldestTimestamp, retryAt };
    }
    
    // Check fixed pacing (minimum time between requests)
    const lastRequestTime = this.lastRequestTime[endpointType];
    const timeSinceLastRequest = now - lastRequestTime;
    
    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitMs = this.minRequestInterval - timeSinceLastRequest;
      return { waitMs, oldestTimestamp: null, retryAt: null };
    }
    
    // We can proceed
    return { waitMs: 0, oldestTimestamp: null, retryAt: null };
  }
  
  /**
   * Record a request timestamp
   */
  recordRequest(endpointType) {
    const now = Date.now();
    this.requestTimestamps[endpointType].push(now);
    this.lastRequestTime[endpointType] = now;
    
    // Clean old timestamps (keep array size manageable)
    this.cleanOldTimestamps(endpointType);
  }
  
  /**
   * Update concurrency limit based on ramp-up schedule
   * On resume after rate limit, start with 1 request, then ramp up gradually
   */
  updateConcurrencyLimit() {
    const now = Date.now();
    
    // If we haven't hit rate limit recently (10s), use full concurrency
    if (!this.lastRateLimitHit || (now - this.lastRateLimitHit) > 10000) {
      this.currentMaxConcurrency = this.maxConcurrency;
      this.rampUpStartTime = null;
      return;
    }
    
    // If we just hit rate limit, start ramp-up with 1 request
    if (!this.rampUpStartTime) {
      this.rampUpStartTime = now;
      this.currentMaxConcurrency = 1; // Start with 1 request
      console.log(`📊 [RateLimiter] Starting ramp-up: concurrency = 1`);
      return;
    }
    
    // Gradual ramp-up schedule after rate limit:
    // 0-5s: concurrency = 1 (single request)
    // 5-10s: concurrency = 2
    // 10s+: concurrency = normal (2)
    const elapsedSinceRampUp = now - this.rampUpStartTime;
    
    if (elapsedSinceRampUp < 5000) {
      this.currentMaxConcurrency = 1;
    } else if (elapsedSinceRampUp < 10000) {
      this.currentMaxConcurrency = 2;
    } else {
      this.currentMaxConcurrency = this.maxConcurrency; // Normal (2)
    }
  }
  
  /**
   * Determine endpoint type from URL
   */
  getEndpointType(url) {
    if (url.includes('/listings/create') || url.includes('/listings/') && url.includes('create')) {
      return 'create';
    }
    if (url.includes('POST') || url.includes('post')) {
      return 'post';
    }
    return 'get';
  }
  
  /**
   * Calculate exponential backoff delay with jitter
   */
  calculateBackoff(attemptNumber, retryAfter = null) {
    if (retryAfter) {
      // Respect Retry-After header if present
      return parseInt(retryAfter) * 1000; // Convert to milliseconds
    }
    
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const baseDelay = Math.min(1000 * Math.pow(2, attemptNumber - 1), 30000);
    // Add jitter: random 0-20% of base delay
    const jitter = Math.random() * 0.2 * baseDelay;
    return baseDelay + jitter;
  }
  
  /**
   * Wait for available token and concurrency slot
   */
  async acquireToken(endpointType) {
    return new Promise((resolve, reject) => {
      const checkAvailability = async () => {
        // Update concurrency limit based on ramp-up schedule
        this.updateConcurrencyLimit();
        
        // Check rate limit (sliding window + pacing)
        const rateLimitCheck = this.checkRateLimit(endpointType);
        
        if (rateLimitCheck.waitMs > 0) {
          // Rate limited - use retryAt from sliding window if available
          let waitMs = rateLimitCheck.waitMs;
          let retryAt = rateLimitCheck.retryAt;
          
          // If we have oldestTimestamp, calculate proper retryAt
          if (rateLimitCheck.oldestTimestamp) {
            retryAt = rateLimitCheck.oldestTimestamp + this.windowMs + this.safetyBufferMs;
            waitMs = Math.max(0, retryAt - Date.now());
          }
          
          // Record rate limit hit for ramp-up
          this.lastRateLimitHit = Date.now();
          
          reject(new RateLimitError(waitMs, endpointType, retryAt));
          return;
        }
        
        // Check fixed pacing (minimum time between requests)
        const lastRequestTime = this.lastRequestTime[endpointType];
        const now = Date.now();
        const timeSinceLastRequest = now - lastRequestTime;
        
        if (timeSinceLastRequest < this.minRequestInterval) {
          // Need to wait for pacing
          const waitMs = this.minRequestInterval - timeSinceLastRequest;
          setTimeout(checkAvailability, waitMs);
          return;
        }
        
        // Check concurrency limit (using current max, which may be reduced)
        if (this.inFlightRequests >= this.currentMaxConcurrency) {
          // Queue the request (concurrency limit)
          this.requestQueue.push({ endpointType, resolve, checkAvailability });
          return;
        }
        
        // Record the request timestamp
        this.recordRequest(endpointType);
        
        // Increment in-flight counter
        this.inFlightRequests++;
        resolve();
      };
      
      checkAvailability();
    });
  }
  
  /**
   * Release a request slot (called after request completes)
   */
  releaseSlot() {
    this.inFlightRequests--;
    
    // Update concurrency limit (may have changed due to ramp-up)
    this.updateConcurrencyLimit();
    
    // Process queued requests (respecting current max concurrency)
    if (this.requestQueue.length > 0 && this.inFlightRequests < this.currentMaxConcurrency) {
      const next = this.requestQueue.shift();
      next.checkAvailability();
    }
  }
  
  /**
   * Execute a request with rate limiting and retry logic
   */
  async executeRequest(requestFn, endpointType, requestId = null) {
    const id = requestId || `req_${Date.now()}_${Math.random()}`;
    let attemptNumber = this.retryAttempts.get(id) || 0;
    
    while (true) {
      try {
        // Acquire token and concurrency slot (may throw RateLimitError)
        await this.acquireToken(endpointType);
        
        // Execute the request
        const response = await requestFn();
        
        // Success - release slot and reset retry attempts
        this.releaseSlot();
        this.retryAttempts.delete(id);
        
        return response;
      } catch (error) {
        // Check if it's our RateLimitError (from sliding window + pacing check)
        if (error instanceof RateLimitError) {
          const waitMs = error.retryAfterMs;
          const retryAt = error.retryAt || (Date.now() + waitMs);
          const waitSeconds = Math.ceil(waitMs / 1000);
          
          // Record that we hit rate limit (for gradual ramp-up)
          this.lastRateLimitHit = Date.now();
          
          // Clean timestamps to get accurate count
          this.cleanOldTimestamps(endpointType);
          
          console.warn(`⚠️ Rate limit hit (sliding window + pacing) for request ${id}, endpoint: ${endpointType}`);
          console.warn(`   Wait time: ${waitSeconds}s (${waitMs}ms)`);
          console.warn(`   RetryAt: ${new Date(retryAt).toISOString()}`);
          console.warn(`   Requests in window: ${this.requestTimestamps[endpointType].length}`);
          console.warn(`   InFlight: ${this.inFlightRequests}, Queued: ${this.requestQueue.length}, MaxConcurrency: ${this.currentMaxConcurrency}`);
          
          // Notify all active callbacks with retryAt timestamp (for accurate countdown)
          this.rateLimitCallbacks.forEach((callback, jobId) => {
            if (callback.length === 1) {
              // Old signature - convert to seconds
              callback(waitSeconds);
            } else {
              // New signature - pass retryAt timestamp (epoch ms) for accuracy
              callback(retryAt, 429, 'Rate limit exceeded');
            }
          });
          
          // Wait for the exact time
          await new Promise(resolve => setTimeout(resolve, waitMs));
          
          // Continue loop to retry (don't increment attempt number for our own rate limiting)
          continue;
        }
        
        // Check if it's a 429 from ShareTribe API
        if (error.response && error.response.status === 429) {
          attemptNumber++;
          this.retryAttempts.set(id, attemptNumber);
          
          // Get Retry-After header if present
          const retryAfter = error.response.headers['retry-after'] || 
                           error.response.headers['Retry-After'];
          
          // Use Retry-After if provided, otherwise calculate from our token bucket
          let waitMs;
          if (retryAfter) {
            waitMs = parseInt(retryAfter) * 1000;
          } else {
            // Fall back to our token bucket calculation
            waitMs = this.checkRateLimit(endpointType);
            if (waitMs === 0) {
              // If we're not rate limited, use exponential backoff
              waitMs = this.calculateBackoff(attemptNumber);
            }
          }
          
          // Add safety buffer
          waitMs += this.safetyBufferMs;
          
          // Record that we hit rate limit (for gradual ramp-up)
          this.lastRateLimitHit = Date.now();
          
          const waitSeconds = Math.ceil(waitMs / 1000);
          
          console.warn(`⚠️ Rate limit hit (429 from API) for request ${id}, attempt ${attemptNumber}. Waiting ${waitSeconds}s`);
          console.warn(`   Endpoint type: ${endpointType}, InFlight: ${this.inFlightRequests}, Queued: ${this.requestQueue.length}`);
          
          // Notify callbacks
          const errorCode = 429;
          const errorMessage = error.response?.statusText || 'Rate limit exceeded';
          
          this.rateLimitCallbacks.forEach((callback, jobId) => {
            if (callback.length === 1) {
              callback(waitSeconds);
            } else {
              callback(waitSeconds, errorCode, errorMessage);
            }
          });
          
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, waitMs));
          
          // Continue loop to retry
          continue;
        } else {
          // Not a rate limit error, throw it
          this.releaseSlot();
          this.retryAttempts.delete(id);
          throw error;
        }
      }
    }
  }
  
  /**
   * Check if a sync job is already running
   */
  hasActiveSyncJob() {
    return this.activeSyncJob !== null;
  }
  
  /**
   * Get active sync job ID
   */
  getActiveSyncJobId() {
    return this.activeSyncJob;
  }
  
  /**
   * Register a sync job
   */
  registerSyncJob(jobId) {
    // Allow re-registering the same job (idempotent)
    if (this.activeSyncJob === jobId) {
      return; // Already registered, no-op
    }
    // Only throw if a different job is active
    if (this.activeSyncJob !== null) {
      throw new Error('A sync job is already in progress. Please wait for it to complete.');
    }
    this.activeSyncJob = jobId;
  }
  
  /**
   * Unregister a sync job
   */
  unregisterSyncJob(jobId) {
    if (this.activeSyncJob === jobId) {
      this.activeSyncJob = null;
    }
  }
  
  /**
   * Get current rate limiter stats (for monitoring/debugging)
   */
  getStats() {
    // Clean timestamps to get accurate counts
    this.cleanOldTimestamps('create');
    this.cleanOldTimestamps('post');
    this.cleanOldTimestamps('get');
    
    return {
      inFlightRequests: this.inFlightRequests,
      queuedRequests: this.requestQueue.length,
      requestsInWindow: {
        create: this.requestTimestamps.create.length,
        post: this.requestTimestamps.post.length,
        get: this.requestTimestamps.get.length
      },
      rateLimits: {
        create: this.createListingRate,
        post: this.postRate,
        get: this.getRate
      },
      concurrency: {
        current: this.currentMaxConcurrency,
        max: this.maxConcurrency
      },
      pacing: {
        minInterval: this.minRequestInterval,
        lastRequestTime: this.lastRequestTime
      },
      activeSyncJob: this.activeSyncJob
    };
  }
}

// Export singleton instance
module.exports = new ShareTribeRateLimiter();
module.exports.RateLimitError = RateLimitError;

