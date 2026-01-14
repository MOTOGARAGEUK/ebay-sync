/**
 * ShareTribe Integration API Rate Limiter
 * 
 * Implements token bucket algorithm with concurrency control to respect API limits:
 * - /listings/create: 100 requests/min average
 * - POST endpoints: 30/min average (dev/test)
 * - GET endpoints: 60/min average (dev/test)
 * - Concurrency: max 10 concurrent requests per client IP (we use max 5 for safety)
 */

class ShareTribeRateLimiter {
  constructor(options = {}) {
    // Rate limits (requests per minute)
    this.createListingRate = options.createListingRate || 90; // Headroom under 100/min
    this.postRate = options.postRate || 25; // Headroom under 30/min
    this.getRate = options.getRate || 55; // Headroom under 60/min
    
    // Concurrency limits
    this.maxConcurrency = options.maxConcurrency || 5; // Safety margin under 10
    
    // Token buckets: start with full capacity
    this.createListingTokens = this.createListingRate;
    this.postTokens = this.postRate;
    this.getTokens = this.getRate;
    
    // Track last refill time for each bucket
    this.lastRefillTime = {
      create: Date.now(),
      post: Date.now(),
      get: Date.now()
    };
    
    // Track in-flight requests
    this.inFlightRequests = 0;
    this.requestQueue = [];
    
    // Track retry attempts for exponential backoff
    this.retryAttempts = new Map();
    
    // Track sync jobs to prevent concurrent syncs
    this.activeSyncJob = null;
    
    // Track rate limit events for progress updates
    this.rateLimitCallbacks = new Map(); // jobId -> callback function
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
   * Refill tokens based on elapsed time (continuous refill)
   */
  refillTokens(endpointType) {
    const now = Date.now();
    const lastRefill = this.lastRefillTime[endpointType];
    const elapsedSeconds = (now - lastRefill) / 1000;
    
    let tokensToAdd = 0;
    let maxTokens = 0;
    
    switch (endpointType) {
      case 'create':
        // 90 tokens per 60 seconds = 1.5 tokens per second
        tokensToAdd = (this.createListingRate / 60) * elapsedSeconds;
        maxTokens = this.createListingRate;
        this.createListingTokens = Math.min(maxTokens, this.createListingTokens + tokensToAdd);
        break;
      case 'post':
        // 25 tokens per 60 seconds = ~0.417 tokens per second
        tokensToAdd = (this.postRate / 60) * elapsedSeconds;
        maxTokens = this.postRate;
        this.postTokens = Math.min(maxTokens, this.postTokens + tokensToAdd);
        break;
      case 'get':
        // 55 tokens per 60 seconds = ~0.917 tokens per second
        tokensToAdd = (this.getRate / 60) * elapsedSeconds;
        maxTokens = this.getRate;
        this.getTokens = Math.min(maxTokens, this.getTokens + tokensToAdd);
        break;
    }
    
    this.lastRefillTime[endpointType] = now;
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
    return new Promise((resolve) => {
      const checkAvailability = () => {
        // Refill tokens based on elapsed time (continuous refill)
        this.refillTokens(endpointType);
        
        // Check concurrency first
        if (this.inFlightRequests >= this.maxConcurrency) {
          // Queue the request
          this.requestQueue.push({ endpointType, resolve, checkAvailability });
          return;
        }
        
        // Check token availability
        let hasToken = false;
        switch (endpointType) {
          case 'create':
            if (this.createListingTokens >= 1) {
              this.createListingTokens -= 1;
              hasToken = true;
            }
            break;
          case 'post':
            if (this.postTokens >= 1) {
              this.postTokens -= 1;
              hasToken = true;
            }
            break;
          case 'get':
            if (this.getTokens >= 1) {
              this.getTokens -= 1;
              hasToken = true;
            }
            break;
        }
        
        if (hasToken) {
          this.inFlightRequests++;
          resolve();
        } else {
          // Not enough tokens, calculate wait time based on refill rate
          let waitTime = 100; // Default 100ms
          switch (endpointType) {
            case 'create':
              // 1.5 tokens per second = 667ms per token
              waitTime = Math.ceil(1000 / (this.createListingRate / 60));
              break;
            case 'post':
              // ~0.417 tokens per second = ~2400ms per token
              waitTime = Math.ceil(1000 / (this.postRate / 60));
              break;
            case 'get':
              // ~0.917 tokens per second = ~1091ms per token
              waitTime = Math.ceil(1000 / (this.getRate / 60));
              break;
          }
          setTimeout(checkAvailability, waitTime);
        }
      };
      
      checkAvailability();
    });
  }
  
  /**
   * Release a request slot (called after request completes)
   */
  releaseSlot() {
    this.inFlightRequests--;
    
    // Process queued requests
    if (this.requestQueue.length > 0 && this.inFlightRequests < this.maxConcurrency) {
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
        // Acquire token and concurrency slot
        await this.acquireToken(endpointType);
        
        // Execute the request
        const response = await requestFn();
        
        // Success - release slot and reset retry attempts
        this.releaseSlot();
        this.retryAttempts.delete(id);
        
        return response;
      } catch (error) {
        this.releaseSlot();
        
        // Check if it's a 429 rate limit error
        if (error.response && error.response.status === 429) {
          attemptNumber++;
          this.retryAttempts.set(id, attemptNumber);
          
          // Get Retry-After header if present
          const retryAfter = error.response.headers['retry-after'] || 
                           error.response.headers['Retry-After'];
          
          const backoffDelay = this.calculateBackoff(attemptNumber, retryAfter);
          
          console.warn(`⚠️ Rate limit hit (429) for request ${id}, attempt ${attemptNumber}. Backing off for ${backoffDelay}ms`);
          console.warn(`   Endpoint type: ${endpointType}, InFlight: ${this.inFlightRequests}, Queued: ${this.requestQueue.length}`);
          console.warn(`   Available tokens - Create: ${this.createListingTokens}, POST: ${this.postTokens}, GET: ${this.getTokens}`);
          
          // Notify about rate limit (find jobId from requestId if possible)
          // Try to extract jobId from requestId (format: "create_<ebay_item_id>" or "update_<listing_id>")
          // For now, notify all active callbacks (we'll improve this later)
          const retryAfterSeconds = retryAfter ? parseInt(retryAfter) : Math.ceil(backoffDelay / 1000);
          this.rateLimitCallbacks.forEach((callback, jobId) => {
            callback(retryAfterSeconds);
          });
          
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          
          // Continue loop to retry
          continue;
        } else {
          // Not a rate limit error, throw it
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
    return {
      inFlightRequests: this.inFlightRequests,
      queuedRequests: this.requestQueue.length,
      availableTokens: {
        create: this.createListingTokens,
        post: this.postTokens,
        get: this.getTokens
      },
      activeSyncJob: this.activeSyncJob
    };
  }
}

// Export singleton instance
module.exports = new ShareTribeRateLimiter();

