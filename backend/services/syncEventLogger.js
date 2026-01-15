/**
 * Sync Event Logger
 * 
 * Logs all ShareTribe API requests/responses during sync jobs for debugging.
 * Persists events to database and maintains lightweight job snapshots.
 */

const db = require('../config/database');

class SyncEventLogger {
  constructor() {
    // In-memory cache for ultra-fast status reads (<150ms)
    // jobId -> snapshot
    this.jobSnapshots = new Map();
    
    // Last event timestamp per job for stall detection
    this.lastEventTimestamps = new Map();
    
    // Stall detection interval (30 seconds)
    this.stallDetectionInterval = 30000;
    
    // Start stall detection timer
    this.startStallDetection();
  }
  
  /**
   * Start stall detection timer
   */
  startStallDetection() {
    setInterval(() => {
      this.checkForStalls();
    }, this.stallDetectionInterval);
  }
  
  /**
   * Check for stalled jobs
   */
  async checkForStalls() {
    try {
      // Check if database is initialized
      const dbInstance = db.getDb();
      if (!dbInstance) {
        return; // Database not ready yet, skip check
      }
      
      const now = Date.now();
      
      for (const [jobId, lastEventAt] of this.lastEventTimestamps.entries()) {
        const snapshot = this.jobSnapshots.get(jobId);
        if (!snapshot || snapshot.state !== 'RUNNING') continue;
        
        const timeSinceLastEvent = now - lastEventAt;
        if (timeSinceLastEvent > this.stallDetectionInterval) {
          // Job is stalled - log it
          console.warn(`⚠️ [SyncEventLogger] STALL_DETECTED for job ${jobId}: No events for ${Math.round(timeSinceLastEvent / 1000)}s`);
          console.warn(`   Current product: ${snapshot.current_product_id || 'unknown'}`);
          console.warn(`   Current step: ${snapshot.current_step || 'unknown'}`);
          
          // Update snapshot
          snapshot.stall_detected = 1;
          snapshot.updated_at = now;
          
          // Persist to DB
          await this.updateJobSnapshot(jobId, snapshot);
        }
      }
    } catch (error) {
      // Database not initialized yet, skip check
      if (error.message && error.message.includes('not initialized')) {
        return;
      }
      console.error('[SyncEventLogger] Error checking for stalls:', error);
    }
  }
  
  /**
   * Log a ShareTribe API event and persist to database
   */
  async logEvent(jobId, event) {
    if (!jobId) {
      console.warn('⚠️ [SyncEventLogger] No jobId provided for event');
      return;
    }
    
    const now = Date.now();
    const timestamp = new Date().toISOString();
    
    const eventRecord = {
      timestamp: timestamp,
      timestampMs: now,
      jobId: jobId,
      workspaceId: event.workspaceId || 1,
      userId: event.userId || null,
      productId: event.productId || null,
      listingId: event.listingId || null,
      operation: event.operation || 'unknown',
      httpMethod: event.httpMethod || 'GET',
      endpointPath: event.endpointPath || '',
      statusCode: event.statusCode || null,
      durationMs: event.durationMs || 0,
      requestId: event.requestId || null,
      retryAfterSeconds: event.retryAfterSeconds || null,
      rateLimitHeaders: event.rateLimitHeaders ? JSON.stringify(event.rateLimitHeaders) : null,
      errorCode: event.errorCode || null,
      errorMessage: event.errorMessage ? event.errorMessage.substring(0, 500) : null,
      payloadSummary: event.payloadSummary ? event.payloadSummary.substring(0, 200) : null,
      responseSnippet: event.responseSnippet ? event.responseSnippet.substring(0, 1000) : null
    };
    
    // Persist event to database (async, don't wait)
    this.persistEvent(jobId, eventRecord).catch(err => {
      console.error(`[SyncEventLogger] Error persisting event:`, err);
    });
    
    // Update job snapshot incrementally (fast)
    await this.updateJobSnapshotFromEvent(jobId, eventRecord, event);
    
    // Update last event timestamp
    this.lastEventTimestamps.set(jobId, now);
    
    // Log to console for debugging
    const statusEmoji = eventRecord.statusCode === 429 ? '⛔' : 
                       eventRecord.statusCode >= 400 ? '❌' : 
                       eventRecord.statusCode >= 200 && eventRecord.statusCode < 300 ? '✅' : '⚠️';
    console.log(`${statusEmoji} [SyncEventLogger] ${eventRecord.httpMethod} ${eventRecord.endpointPath} → ${eventRecord.statusCode || 'ERROR'} (${eventRecord.durationMs}ms) [Job: ${jobId}]`);
  }
  
  /**
   * Persist event to database
   */
  async persistEvent(jobId, eventRecord) {
    return new Promise((resolve, reject) => {
      let dbInstance;
      try {
        dbInstance = db.getDb();
      } catch (err) {
        if (err.message && err.message.includes('not initialized')) {
          // Database not ready yet, skip persistence
          resolve();
          return;
        }
        reject(err);
        return;
      }
      dbInstance.run(`
        INSERT INTO sync_events (
          job_id, timestamp_ms, timestamp, workspace_id, user_id, product_id, listing_id,
          operation, http_method, endpoint_path, status_code, duration_ms, request_id,
          retry_after_seconds, rate_limit_headers, error_code, error_message,
          payload_summary, response_snippet
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        jobId,
        eventRecord.timestampMs,
        eventRecord.timestamp,
        eventRecord.workspaceId,
        eventRecord.userId,
        eventRecord.productId,
        eventRecord.listingId,
        eventRecord.operation,
        eventRecord.httpMethod,
        eventRecord.endpointPath,
        eventRecord.statusCode,
        eventRecord.durationMs,
        eventRecord.requestId,
        eventRecord.retryAfterSeconds,
        eventRecord.rateLimitHeaders,
        eventRecord.errorCode,
        eventRecord.errorMessage,
        eventRecord.payloadSummary,
        eventRecord.responseSnippet
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
  
  /**
   * Update job snapshot incrementally from event
   */
  async updateJobSnapshotFromEvent(jobId, eventRecord, event) {
    let snapshot = this.jobSnapshots.get(jobId);
    const now = Date.now();
    
    if (!snapshot) {
      // Initialize snapshot from DB or create new
      snapshot = await this.getJobSnapshotFromDB(jobId);
      if (!snapshot) {
        snapshot = {
          job_id: jobId,
          tenant_id: event.workspaceId || 1,
          user_id: event.userId || null,
          state: 'RUNNING',
          processed: 0,
          total: 0,
          completed: 0,
          failed: 0,
          current_product_id: event.productId || null,
          current_step: null,
          retry_at: null,
          last_event_at: now,
          updated_at: now,
          total_requests: 0,
          requests_last60s: 0,
          error429_count: 0,
          avg_latency_ms: 0,
          throttle_min_delay_ms: 1000,
          throttle_concurrency: 100,
          last_retry_after: null,
          stall_detected: 0,
          created_at: now
        };
      }
    }
    
    // Incremental updates (fast)
    snapshot.total_requests = (snapshot.total_requests || 0) + 1;
    snapshot.last_event_at = now;
    snapshot.updated_at = now;
    
    // Update product/step if provided
    if (event.productId) {
      snapshot.current_product_id = event.productId;
    }
    
    // Update 429 count and retry info
    if (eventRecord.statusCode === 429) {
      snapshot.error429_count++;
      if (eventRecord.retryAfterSeconds) {
        snapshot.last_retry_after = eventRecord.retryAfterSeconds;
        snapshot.retry_at = now + (eventRecord.retryAfterSeconds * 1000);
      }
    }
    
    // Update rolling 60s count (approximate - we'll recalculate periodically)
    const sixtySecondsAgo = now - 60000;
    if (eventRecord.timestampMs >= sixtySecondsAgo) {
      snapshot.requests_last60s++;
    }
    
    // Update average latency
    if (eventRecord.durationMs > 0) {
      const totalLatency = snapshot.avg_latency_ms * (snapshot.total_requests - 1) + eventRecord.durationMs;
      snapshot.avg_latency_ms = Math.round(totalLatency / snapshot.total_requests);
    }
    
    // Cache snapshot
    this.jobSnapshots.set(jobId, snapshot);
    
    // Persist to DB (async, don't wait)
    this.updateJobSnapshot(jobId, snapshot).catch(err => {
      console.error(`[SyncEventLogger] Error updating job snapshot:`, err);
    });
  }
  
  /**
   * Update job snapshot with progress info
   */
  async updateJobSnapshot(jobId, snapshot) {
    return new Promise((resolve, reject) => {
      let dbInstance;
      try {
        dbInstance = db.getDb();
      } catch (err) {
        if (err.message && err.message.includes('not initialized')) {
          // Database not ready yet, skip persistence
          resolve();
          return;
        }
        reject(err);
        return;
      }
      dbInstance.run(`
        INSERT INTO sync_jobs (
          job_id, tenant_id, user_id, state, processed, total, completed, failed,
          current_product_id, current_step, retry_at, last_event_at, updated_at,
          total_requests, requests_last60s, error429_count, avg_latency_ms,
          throttle_min_delay_ms, throttle_concurrency, last_retry_after, stall_detected, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          state = excluded.state,
          processed = excluded.processed,
          total = excluded.total,
          completed = excluded.completed,
          failed = excluded.failed,
          current_product_id = excluded.current_product_id,
          current_step = excluded.current_step,
          retry_at = excluded.retry_at,
          last_event_at = excluded.last_event_at,
          updated_at = excluded.updated_at,
          total_requests = excluded.total_requests,
          requests_last60s = excluded.requests_last60s,
          error429_count = excluded.error429_count,
          avg_latency_ms = excluded.avg_latency_ms,
          throttle_min_delay_ms = excluded.throttle_min_delay_ms,
          throttle_concurrency = excluded.throttle_concurrency,
          last_retry_after = excluded.last_retry_after,
          stall_detected = excluded.stall_detected
      `, [
        snapshot.job_id,
        snapshot.tenant_id,
        snapshot.user_id,
        snapshot.state,
        snapshot.processed,
        snapshot.total,
        snapshot.completed,
        snapshot.failed,
        snapshot.current_product_id,
        snapshot.current_step,
        snapshot.retry_at,
        snapshot.last_event_at,
        snapshot.updated_at,
        snapshot.total_requests,
        snapshot.requests_last60s,
        snapshot.error429_count,
        snapshot.avg_latency_ms,
        snapshot.throttle_min_delay_ms,
        snapshot.throttle_concurrency,
        snapshot.last_retry_after,
        snapshot.stall_detected,
        snapshot.created_at || snapshot.updated_at
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
  
  /**
   * Get job snapshot from database
   */
  async getJobSnapshotFromDB(jobId) {
    return new Promise((resolve, reject) => {
      let dbInstance;
      try {
        dbInstance = db.getDb();
      } catch (err) {
        if (err.message && err.message.includes('not initialized')) {
          // Database not ready yet, return null
          resolve(null);
          return;
        }
        reject(err);
        return;
      }
      dbInstance.get(`
        SELECT * FROM sync_jobs WHERE job_id = ?
      `, [jobId], (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  }
  
  /**
   * Get lightweight job snapshot (ultra-fast, <150ms)
   */
  getJobSnapshot(jobId) {
    return this.jobSnapshots.get(jobId) || null;
  }
  
  /**
   * Update job progress (called from syncService)
   */
  async updateJobProgress(jobId, progress) {
    let snapshot = this.jobSnapshots.get(jobId);
    const now = Date.now();
    
    if (!snapshot) {
      snapshot = await this.getJobSnapshotFromDB(jobId);
      if (!snapshot) {
        snapshot = {
          job_id: jobId,
          tenant_id: progress.workspaceId || 1,
          user_id: progress.userId || null,
          state: progress.state || 'RUNNING',
          processed: progress.processed || 0,
          total: progress.total || 0,
          completed: progress.completed || 0,
          failed: progress.failed || 0,
          current_product_id: progress.currentProductId || null,
          current_step: progress.currentStep || null,
          retry_at: progress.retryAt || null,
          last_event_at: now,
          updated_at: now,
          total_requests: 0,
          requests_last60s: 0,
          error429_count: 0,
          avg_latency_ms: 0,
          throttle_min_delay_ms: progress.throttleSettings?.minDelayMs || 1000,
          throttle_concurrency: progress.throttleSettings?.concurrency || 100,
          last_retry_after: null,
          stall_detected: 0,
          created_at: now
        };
      }
    }
    
    // Update from progress
    snapshot.state = progress.state || snapshot.state;
    snapshot.processed = progress.processed !== undefined ? progress.processed : snapshot.processed;
    snapshot.total = progress.total !== undefined ? progress.total : snapshot.total;
    snapshot.completed = progress.completed !== undefined ? progress.completed : snapshot.completed;
    snapshot.failed = progress.failed !== undefined ? progress.failed : snapshot.failed;
    snapshot.current_product_id = progress.currentProductId || snapshot.current_product_id;
    snapshot.current_step = progress.currentStep || snapshot.current_step;
    // CRITICAL: Ensure retryAt is stored as epoch ms (not Date object or string)
    if (progress.retryAt !== undefined) {
      if (progress.retryAt instanceof Date) {
        snapshot.retry_at = progress.retryAt.getTime();
      } else if (typeof progress.retryAt === 'string') {
        snapshot.retry_at = new Date(progress.retryAt).getTime();
      } else if (typeof progress.retryAt === 'number') {
        snapshot.retry_at = progress.retryAt; // Already epoch ms
      } else {
        snapshot.retry_at = progress.retryAt;
      }
    } else {
      snapshot.retry_at = snapshot.retry_at || null;
    }
    snapshot.updated_at = progress.updatedAt !== undefined ? progress.updatedAt : now;
    
    if (progress.throttleSettings) {
      snapshot.throttle_min_delay_ms = progress.throttleSettings.minDelayMs || snapshot.throttle_min_delay_ms;
      snapshot.throttle_concurrency = progress.throttleSettings.concurrency || snapshot.throttle_concurrency;
    }
    
    // Cache snapshot
    this.jobSnapshots.set(jobId, snapshot);
    
    // Persist to DB (async)
    this.updateJobSnapshot(jobId, snapshot).catch(err => {
      console.error(`[SyncEventLogger] Error updating job progress:`, err);
    });
  }
  
  /**
   * Recalculate requests_last60s from events (periodic cleanup)
   */
  async recalculateLast60s(jobId) {
    const now = Date.now();
    const sixtySecondsAgo = now - 60000;
    
    return new Promise((resolve, reject) => {
      let dbInstance;
      try {
        dbInstance = db.getDb();
      } catch (err) {
        if (err.message && err.message.includes('not initialized')) {
          resolve(0);
          return;
        }
        reject(err);
        return;
      }
      dbInstance.get(`
        SELECT COUNT(*) as count FROM sync_events
        WHERE job_id = ? AND timestamp_ms >= ?
      `, [jobId, sixtySecondsAgo], (err, row) => {
        if (err) {
          reject(err);
        } else {
          const snapshot = this.jobSnapshots.get(jobId);
          if (snapshot) {
            snapshot.requests_last60s = row.count || 0;
            this.updateJobSnapshot(jobId, snapshot).catch(() => {});
          }
          resolve(row.count || 0);
        }
      });
    });
  }
  
  /**
   * Get events for a job (paginated, from database)
   */
  async getEvents(jobId, limit = 200, cursor = null) {
    return new Promise((resolve, reject) => {
      let dbInstance;
      try {
        dbInstance = db.getDb();
      } catch (err) {
        if (err.message && err.message.includes('not initialized')) {
          resolve({ events: [], nextCursor: null, total: 0, hasMore: false });
          return;
        }
        reject(err);
        return;
      }
      
      let query = `SELECT * FROM sync_events WHERE job_id = ?`;
      const params = [jobId];
      
      if (cursor) {
        query += ` AND timestamp_ms < ?`;
        params.push(cursor);
      }
      
      query += ` ORDER BY timestamp_ms DESC LIMIT ?`;
      params.push(limit + 1); // Fetch one extra to check if there are more
      
      dbInstance.all(query, params, (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        
        const hasMore = rows.length > limit;
        const events = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor = hasMore ? events[events.length - 1].timestamp_ms : null;
        
        // Convert DB rows to event objects
        const eventObjects = events.map(row => ({
          timestamp: row.timestamp,
          timestampMs: row.timestamp_ms,
          jobId: row.job_id,
          workspaceId: row.workspace_id,
          userId: row.user_id,
          productId: row.product_id,
          listingId: row.listing_id,
          operation: row.operation,
          httpMethod: row.http_method,
          endpointPath: row.endpoint_path,
          statusCode: row.status_code,
          durationMs: row.duration_ms,
          requestId: row.request_id,
          retryAfterSeconds: row.retry_after_seconds,
          rateLimitHeaders: row.rate_limit_headers ? JSON.parse(row.rate_limit_headers) : null,
          errorCode: row.error_code,
          errorMessage: row.error_message,
          payloadSummary: row.payload_summary,
          responseSnippet: row.response_snippet
        }));
        
        resolve({
          events: eventObjects,
          nextCursor: nextCursor,
          total: events.length,
          hasMore: hasMore
        });
      });
    });
  }
  
  /**
   * Get all active job IDs
   */
  async getActiveJobIds() {
    return new Promise((resolve, reject) => {
      let dbInstance;
      try {
        dbInstance = db.getDb();
      } catch (err) {
        if (err.message && err.message.includes('not initialized')) {
          resolve([]);
          return;
        }
        reject(err);
        return;
      }
      const now = Date.now();
      const fiveMinutesAgo = now - (5 * 60 * 1000);
      
      dbInstance.all(`
        SELECT job_id FROM sync_jobs
        WHERE updated_at > ? AND state IN ('RUNNING', 'PAUSED_RATE_LIMIT', 'PAUSED')
        ORDER BY updated_at DESC
      `, [fiveMinutesAgo], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows.map(r => r.job_id));
        }
      });
    });
  }
  
  /**
   * Clear job (when completed)
   */
  clearJob(jobId) {
    this.jobSnapshots.delete(jobId);
    this.lastEventTimestamps.delete(jobId);
  }
}

// Export singleton instance
module.exports = new SyncEventLogger();
