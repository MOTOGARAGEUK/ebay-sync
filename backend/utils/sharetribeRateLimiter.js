/**
 * ShareTribe Integration API Rate Limiter
 * 
 * Simple, consistent rate limiting:
 * - Steady pacing: ~1 request/second (safe under 100/min limit)
 * - Single sliding window per workspace/job
 * - Proper 429 handling with Retry-After header
 * - State machine: RUNNING, PAUSED, COMPLETED, FAILED
 */

class RateLimitError extends Error {
  constructor(retryAt, endpointType, message = 'Rate limit exceeded') {
    super(message);
    this.type = 'RATE_LIMIT';
    this.retryAt = retryAt; // Absolute timestamp (epoch ms) when retry is allowed
    this.endpointType = endpointType;
    this.retryAfterMs = Math.max(0, retryAt - Date.now());
  }
}

class ShareTribeRateLimiter {
  constructor(options = {}) {
    // Rate limits (requests per 60 seconds)
    this.maxRequestsPerMinute = options.maxRequestsPerMinute || 100;
    
    // Steady pacing: minimum interval between requests (1000ms = 1 req/sec = 60/min, safe under 100/min)
    this.minRequestInterval = options.minRequestInterval || 1000; // Start conservative: 1 req/sec
    
    // Minimum pause duration when 429 occurs without Retry-After (seconds)
    this.minPauseSeconds = options.minPauseSeconds || 15;
    
    // Safety buffer for retries (milliseconds)
    this.safetyBufferMs = options.safetyBufferMs || 1500;
    
    // Sliding window: track timestamps of ALL requests (single window per workspace)
    this.requestTimestamps = [];
    
    // Track last request time for pacing
    this.lastRequestTime = 0;
    
    // Track sync jobs to prevent concurrent syncs
    this.activeSyncJob = null;
    
    // Track rate limit events for progress updates
    this.rateLimitCallbacks = new Map(); // jobId -> callback function
    
    // Mutex/queue for atomic operations: serialize executeRequest() calls
    this.requestQueue = [];
    this.processingQueue = false;
    this.requestMutex = Promise.resolve(); // Start with resolved promise
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
   * Clean old timestamps from the sliding window (older than 60 seconds)
   */
  cleanOldTimestamps() {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      timestamp => now - timestamp < 60000
    );
  }
  
  /**
   * Check if we can make a request (pacing + sliding window)
   * Returns retryAt timestamp (epoch ms) if rate limited, or 0 if allowed
   */
  checkRateLimit() {
    const now = Date.now();
    
    // Clean old timestamps
    this.cleanOldTimestamps();
    
    // Check pacing: ensure minimum interval between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitMs = this.minRequestInterval - timeSinceLastRequest;
      const retryAt = now + waitMs;
      return retryAt; // Need to wait for pacing
    }
    
    // Check sliding window rate limit
    if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
      // Rate limit hit - calculate retryAt based on oldest request
      const oldestRequestTimestamp = this.requestTimestamps[0];
      const retryAt = oldestRequestTimestamp + 60000 + this.safetyBufferMs;
      return retryAt; // Need to wait for window to slide
    }
    
    return 0; // Allowed
  }
  
  /**
   * Record a request timestamp
   */
  recordRequest() {
    const now = Date.now();
    this.requestTimestamps.push(now);
    this.lastRequestTime = now;
  }
  
  /**
   * Parse Retry-After header: handles seconds (integer) OR HTTP-date format
   * Returns pause duration in seconds, or null if parse fails
   */
  parseRetryAfter(retryAfterHeader) {
    if (!retryAfterHeader) {
      return null;
    }
    
    // Try parsing as integer (seconds)
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds;
    }
    
    // Try parsing as HTTP-date (RFC 7231: "Retry-After: Fri, 31 Dec 1999 23:59:59 GMT")
    try {
      const date = new Date(retryAfterHeader);
      if (!isNaN(date.getTime())) {
        const now = Date.now();
        const pauseSeconds = Math.ceil((date.getTime() - now) / 1000);
        if (pauseSeconds > 0) {
          return pauseSeconds;
        }
      }
    } catch (e) {
      // Parse failed
    }
    
    // Parse failed - return null to use fallback
    return null;
  }
  
  /**
   * Execute a request with rate limiting and retry logic
   * ATOMIC: Uses mutex to serialize checkRateLimit + recordRequest operations
   */
  async executeRequest(requestFn, endpointType = 'create', requestId = null) {
    const id = requestId || `req_${Date.now()}_${Math.random()}`;
    
    // Serialize all requests through mutex to prevent race conditions
    return new Promise((resolve, reject) => {
      this.requestMutex = this.requestMutex.then(async () => {
        try {
          await this._executeRequestInternal(requestFn, endpointType, id, resolve, reject);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
  
  /**
   * Internal request execution (called serially via mutex)
   */
  async _executeRequestInternal(requestFn, endpointType, id, resolve, reject) {
    while (true) {
      try {
        // ATOMIC: Check rate limit (pacing + sliding window) - now serialized
        const retryAt = this.checkRateLimit();
        if (retryAt > Date.now()) {
          const waitMs = retryAt - Date.now();
          const waitSeconds = Math.ceil(waitMs / 1000);
          
          console.log(`⏰ [RateLimiter] Pacing wait for request ${id}: ${waitSeconds}s (proactive pacing - not a rate limit)`);
          
          // DO NOT notify callbacks about proactive pacing - this is normal operation
          // Only notify callbacks when there's an actual 429 response from ShareTribe
          
          await new Promise(resolve => setTimeout(resolve, waitMs));
          continue; // Retry after pacing wait
        }
        
        // ATOMIC: Record request before executing - now serialized
        this.recordRequest();
        
        // Execute the request (outside mutex - network I/O can be concurrent)
        const response = await requestFn();
        
        resolve(response);
        return;
      } catch (error) {
        // Check if it's a 429 from ShareTribe API
        if (error.response && error.response.status === 429) {
          const retryAfterHeader = error.response.headers['retry-after'] || 
                                   error.response.headers['Retry-After'];
          
          let retryAt;
          let pauseSeconds;
          
          // Parse Retry-After header (seconds OR HTTP-date format)
          const parsedSeconds = this.parseRetryAfter(retryAfterHeader);
          
          if (parsedSeconds !== null) {
            // Successfully parsed Retry-After header
            pauseSeconds = parsedSeconds;
            retryAt = Date.now() + (pauseSeconds * 1000) + this.safetyBufferMs;
            console.log(`⚠️ [RateLimiter] 429 received with Retry-After: ${pauseSeconds}s (parsed), retryAt: ${new Date(retryAt).toISOString()}`);
          } else {
            // Parse failed or no header - use minimum pause duration
            pauseSeconds = this.minPauseSeconds;
            retryAt = Date.now() + (pauseSeconds * 1000);
            console.log(`⚠️ [RateLimiter] 429 received without valid Retry-After (header: "${retryAfterHeader}"), using min pause: ${pauseSeconds}s, retryAt: ${new Date(retryAt).toISOString()}`);
          }
          
          // Extract endpoint info from error if available
          const endpoint = error.config?.url || error.config?.baseURL || 'unknown';
          
          // Notify all active callbacks with retryAt timestamp and retryAfterHeader
          this.rateLimitCallbacks.forEach((callback, jobId) => {
            console.log(`🚨 [RateLimiter] 429 OCCURRED - jobId: ${jobId}, endpoint: ${endpoint}, retryAt: ${new Date(retryAt).toISOString()}, retryAfterHeader: "${retryAfterHeader || 'none'}"`);
            callback(retryAt, 429, 'Rate limit exceeded', retryAfterHeader);
          });
          
          // Wait until retryAt
          const waitMs = Math.max(0, retryAt - Date.now());
          const waitSeconds = Math.ceil(waitMs / 1000);
          console.log(`⏸️ [RateLimiter] Waiting ${waitSeconds}s before retry (retryAt: ${new Date(retryAt).toISOString()})`);
          
          await new Promise(resolve => setTimeout(resolve, waitMs));
          continue; // Retry the request
        } else {
          // Not a rate limit error - throw it
          reject(error);
          return;
        }
      }
    }
  }
  
  /**
   * Register an active sync job
   */
  registerSyncJob(jobId) {
    if (this.activeSyncJob === jobId) {
      return;
    }
    if (this.activeSyncJob !== null) {
      throw new Error('A sync job is already in progress. Please wait for it to complete.');
    }
    this.activeSyncJob = jobId;
    console.log(`✅ [RateLimiter] Registered active sync job: ${jobId}`);
  }
  
  /**
   * Unregister active sync job
   */
  unregisterSyncJob(jobId) {
    if (this.activeSyncJob === jobId) {
      this.activeSyncJob = null;
      console.log(`🗑️ [RateLimiter] Unregistered active sync job: ${jobId}`);
    }
  }
  
  /**
   * Get active sync job ID
   */
  getActiveSyncJobId() {
    return this.activeSyncJob;
  }
  
  /**
   * Get current rate limiter stats for debugging
   */
  getStats() {
    const now = Date.now();
    this.cleanOldTimestamps();
    
    return {
      requestsInWindow: this.requestTimestamps.length,
      maxRequestsPerMinute: this.maxRequestsPerMinute,
      minRequestInterval: this.minRequestInterval,
      lastRequestTime: this.lastRequestTime ? new Date(this.lastRequestTime).toISOString() : null,
      activeSyncJob: this.activeSyncJob
    };
  }
}

// Export singleton instance
module.exports = new ShareTribeRateLimiter();
module.exports.RateLimitError = RateLimitError;
