import React, { useEffect, useState } from 'react';
import { X, CheckCircle, AlertCircle, Loader } from 'lucide-react';

// Format seconds as MM:SS
const formatTime = (seconds) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const SyncProgressModal = ({ jobId, onClose, onRetryFailed }) => {
  const [progress, setProgress] = useState(null);
  const [pollingInterval, setPollingInterval] = useState(null);
  const [countdown, setCountdown] = useState(null);

  console.log('📋 [Modal] SyncProgressModal rendered, jobId prop:', jobId, 'type:', typeof jobId);

  useEffect(() => {
    let interval = null;
    let isMounted = true;

    // Start polling for progress
    const pollProgress = async () => {
      if (!isMounted) return Promise.resolve();
      
      // If no jobId yet, show initializing state
      if (!jobId) {
        console.log('⚠️ [Modal] No jobId provided, showing initializing state');
        setProgress({
          total: 0,
          completed: 0,
          failed: 0,
          percent: 0,
          status: 'starting',
          currentStep: 'Initializing sync...',
          eta: null,
          errors: []
        });
        return;
      }
      
      console.log(`📋 [Modal] Polling progress for jobId: ${jobId}`);
      
      try {
        const url = `/api/sync/progress/${jobId}`;
        console.log(`📋 [Modal] Fetching progress from: ${url}`);
        const response = await fetch(url);
        console.log(`📋 [Modal] Response status: ${response.status}`);
        
        if (response.ok) {
          const data = await response.json();
          console.log('✅ [Modal] Progress update received:', {
            jobId: jobId,
            total: data.total,
            completed: data.completed,
            failed: data.failed,
            percent: data.percent,
            status: data.status,
            currentStep: data.currentStep,
            fullData: data
          });
          
          if (isMounted) {
            // Check if this is an "already running" error - if so, treat as in-progress
            const isAlreadyRunningError = (data.status === 'error' || data.state === 'failed') && 
              data.currentStep && 
              data.currentStep.includes('already in progress');
            
            // Use explicit state field if available, otherwise fall back to status
            const effectiveState = data.state || data.status;
            
            if (isAlreadyRunningError) {
              // Don't show error - treat as in-progress and keep polling
              // The real progress should be available from the active job
              console.log('📋 [Modal] Detected "already running" error - treating as in-progress');
              // Keep current progress or show initializing state
              if (!progress || progress.status === 'error') {
                setProgress({
                  ...data,
                  status: 'starting',
                  state: 'running',
                  currentStep: 'Attaching to existing sync job...'
                });
              }
              // Continue polling - don't stop
            } else {
              setProgress(data);
              
              // Stop polling only if sync is in terminal state (COMPLETED, FAILED, CANCELLED)
              const shouldStop = effectiveState === 'COMPLETED' || 
                                effectiveState === 'COMPLETED_SUCCESS' ||
                                effectiveState === 'CANCELLED' ||
                                (effectiveState === 'FAILED' && !isAlreadyRunningError);
              
              if (shouldStop) {
                console.log(`📋 [Modal] Stopping polling - state: ${effectiveState}`);
                if (interval) {
                  clearInterval(interval);
                  interval = null;
                  setPollingInterval(null);
                }
              } else {
                // Continue polling for: RUNNING, PAUSED_RATE_LIMIT states
                console.log(`📋 [Modal] Continuing polling - state: ${effectiveState}`);
              }
            }
          }
        } else if (response.status === 404) {
          // Job not found - might not be initialized yet or completed
          console.log('⚠️ [Modal] Sync job not found (404), jobId:', jobId);
          const errorData = await response.json().catch(() => ({}));
          console.log('⚠️ [Modal] 404 error data:', errorData);
          // Don't update progress to error immediately - might just not be initialized yet
          // Keep showing "waiting" state but log it
        } else {
          console.error('❌ [Modal] Failed to fetch progress:', response.status, response.statusText);
          const errorData = await response.json().catch(() => ({}));
          console.error('❌ [Modal] Error response:', errorData);
        }
      } catch (error) {
        console.error('❌ [Modal] Error polling progress:', error);
        console.error('❌ [Modal] Error details:', error.message, error.stack);
      }
    };

    // Poll immediately, then every 500ms (or 1s when resuming)
    pollProgress();
    
    // Determine poll interval: 1s if resuming (countdown <= 0), 500ms otherwise
    const determinePollInterval = () => {
      if (!progress) return 500;
      const backendRetryAt = progress.retryAt || progress.nextRetryAt;
      if (backendRetryAt && progress.state === 'PAUSED_RATE_LIMIT') {
        const retryAtMs = typeof backendRetryAt === 'number' ? backendRetryAt : new Date(backendRetryAt).getTime();
        const msRemaining = retryAtMs - Date.now();
        return msRemaining <= 0 ? 1000 : 500; // Poll every 1s if resuming
      }
      return 500;
    };
    
    const pollInterval = determinePollInterval();
    interval = setInterval(pollProgress, pollInterval);
    setPollingInterval(interval);

    return () => {
      isMounted = false;
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [jobId, progress?.state, progress?.retryAt]);

  // Destructure progress with defaults to avoid undefined errors (safe even if progress is null)
  const { 
    total = 0, 
    completed = 0, 
    failed = 0, 
    percent = 0, 
    status = 'starting',
    state = null, // Explicit state machine: RUNNING, PAUSED_RATE_LIMIT, COMPLETED, FAILED
    currentStep = '', 
    etaFormatted = null, 
    errors = [], 
    rateLimitRetryAfter = null, 
    rateLimited = false, 
    nextRetryAt = null,
    retryAt = null, // Backend-owned retry timestamp (epoch ms)
    retryInMs = null, // Milliseconds until retry
    retryInSeconds = null,
    updatedAt = null, // Backend timestamp
    lastUpdatedAt = null,
    lastAttemptAt = null,
    retryAttemptCount = 0,
    lastErrorCode = null,
    lastErrorMessage = null,
    processed: processedFromBackend = 0, // completed + failed (from backend)
    remaining: remainingFromBackend = 0, // total - processed (from backend)
    failedCount: failedCountFromBackend = 0 // Explicit failedCount (from backend)
  } = progress || {};
  
  // Use explicit state field (state machine) - MUST be declared first
  const effectiveState = state || status;
  
  // Calculate processed count (attempted items) - use backend value or calculate from completed + failed
  const processed = processedFromBackend || (completed + failed);
  
  // Calculate remaining items
  const remaining = remainingFromBackend !== undefined ? remainingFromBackend : Math.max(0, total - processed);
  
  // Calculate derived state variables BEFORE using them in calculations
  const isCompleted = effectiveState === 'COMPLETED' || effectiveState === 'COMPLETED_SUCCESS';
  const isCancelled = effectiveState === 'CANCELLED';
  const isAlreadyRunningError = (effectiveState === 'FAILED' || status === 'error') && currentStep && currentStep.includes('already in progress');
  const isError = (effectiveState === 'FAILED' || status === 'error') && !isAlreadyRunningError;
  const isPaused = effectiveState === 'PAUSED' || effectiveState === 'PAUSED_RATE_LIMIT' || status === 'retry_scheduled';
  const isRunning = effectiveState === 'RUNNING' || status === 'in_progress' || status === 'starting';
  const isInProgress = isRunning || isAlreadyRunningError;
  
  // Calculate percent from processed/total (not completed/total)
  // This ensures progress reflects processing, not success
  const calculatedPercent = total > 0 ? Math.round((processed / total) * 100) : 0;
  
  // Use calculated percent if available, otherwise use backend percent
  // When COMPLETED, ensure percent is 100
  const displayPercent = (isCompleted && processed === total) ? 100 : (calculatedPercent || percent);
  
  // Calculate resumeAt for countdown (always show countdown when PAUSED)
  const resumeAt = retryAt || nextRetryAt;
  const now = Date.now();
  const resumeAtMs = resumeAt ? (typeof resumeAt === 'number' ? resumeAt : new Date(resumeAt).getTime()) : null;

  // Countdown timer effect for rate limit - MUST be called before any conditional returns
  useEffect(() => {
    if (!progress) {
      setCountdown(null);
      return;
    }

    // Always show countdown when PAUSED and have resumeAt
    if (!isPaused || !resumeAtMs) {
      setCountdown(null);
      return;
    }

    // Use resumeAt to calculate countdown
    const updateCountdown = async () => {
      const now = Date.now();
      const msRemaining = resumeAtMs - now;
      const secondsRemaining = Math.ceil(msRemaining / 1000);
      
      if (secondsRemaining > 0) {
        setCountdown(secondsRemaining);
      } else {
        // Countdown reached 0 - refetch status
        try {
          const response = await fetch(`/api/sync/progress/${jobId}`);
          if (response.ok) {
            const data = await response.json();
            const newState = data.state || data.status;
            
            // If still PAUSED, backend will provide new resumeAt - continue countdown
            // If RUNNING, update progress and countdown will clear
            setProgress(data);
            
            // If still PAUSED but no resumeAt, set a short resumeAt (2s) to continue countdown
            if (newState === 'PAUSED' && !data.retryAt && !data.nextRetryAt) {
              const newResumeAt = Date.now() + 2000;
              setProgress({
                ...data,
                retryAt: newResumeAt,
                nextRetryAt: newResumeAt
              });
            }
          }
        } catch (error) {
          console.error('❌ [Modal] Error refetching status after countdown:', error);
          // On error, set a short resumeAt to retry
          const newResumeAt = Date.now() + 2000;
          setProgress(prev => ({
            ...prev,
            retryAt: newResumeAt,
            nextRetryAt: newResumeAt
          }));
        }
      }
    };

    // Update immediately
    updateCountdown();

    // Update every second
    const interval = setInterval(updateCountdown, 1000);

    return () => clearInterval(interval);
  }, [progress, isPaused, resumeAtMs, jobId]);

  // Don't render modal until we have a jobId
  if (!jobId) {
    return null;
  }

  // Show loading state until we have progress data
  if (!progress) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
          <div className="flex items-center justify-center">
            <Loader className="animate-spin h-8 w-8 text-blue-500" />
          </div>
          <p className="text-center mt-4 text-gray-600">Loading current sync status...</p>
        </div>
      </div>
    );
  }

  // Calculate circumference for circular progress bar (radius = 60, so circumference = 2 * π * 60)
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (displayPercent / 100) * circumference;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">
            {isCompleted ? 'Sync Completed' : isCancelled ? 'Sync Cancelled' : isError ? 'Sync Error' : isPaused ? 'Sync Paused' : 'Syncing Products'}
          </h2>
          {!isInProgress && (
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X size={24} />
            </button>
          )}
        </div>

        {/* Circular Progress Bar */}
        <div className="flex items-center justify-center my-6">
          <div className="relative">
            <svg className="transform -rotate-90" width="140" height="140">
              {/* Background circle */}
              <circle
                cx="70"
                cy="70"
                r={radius}
                stroke="#e5e7eb"
                strokeWidth="8"
                fill="none"
              />
              {/* Progress circle */}
              <circle
                cx="70"
                cy="70"
                r={radius}
                stroke={isError ? "#ef4444" : isCompleted ? "#10b981" : isCancelled ? "#6b7280" : isPaused ? "#f59e0b" : "#3b82f6"}
                strokeWidth="8"
                fill="none"
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                strokeLinecap="round"
                className="transition-all duration-300"
              />
            </svg>
            {/* Center content */}
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              {isPaused ? (
                <AlertCircle className="h-8 w-8 text-yellow-500 animate-pulse" />
              ) : isCompleted ? (
                <CheckCircle className="h-8 w-8 text-green-500" />
              ) : isCancelled ? (
                <AlertCircle className="h-8 w-8 text-gray-500" />
              ) : isError ? (
                <AlertCircle className="h-8 w-8 text-red-500" />
              ) : null}
              <span className="text-2xl font-bold text-gray-900 mt-2">{displayPercent}%</span>
            </div>
          </div>
        </div>

        {/* Progress Text */}
        <div className="text-center mb-4">
          {total > 0 ? (
            <p className="text-lg font-medium text-gray-900">
              {processed}/{total} — {displayPercent}%
            </p>
          ) : (
            <p className="text-lg font-medium text-gray-900">
              {status === 'starting' ? 'Initializing...' : `${processed}/${total} — ${displayPercent}%`}
            </p>
          )}
          {isPaused && countdown !== null && countdown > 0 ? (
            <p className="text-sm text-yellow-600 mt-1 font-medium">
              Next retry in: <span className="font-mono font-semibold">{formatTime(countdown)}</span>
            </p>
          ) : etaFormatted && isInProgress && total > 0 && !isPaused ? (
            <p className="text-sm text-gray-500 mt-1">
              Estimated time remaining: {etaFormatted}
            </p>
          ) : null}
        </div>

        {/* Current Step - Hide if paused (countdown box shows pause message) */}
        {currentStep && !isPaused && (
          <div className="bg-gray-50 rounded-lg p-3 mb-4">
            <p className="text-sm text-gray-700">{currentStep}</p>
          </div>
        )}

        {/* Status Messages */}
        {status === 'starting' && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
            <p className="text-sm text-blue-800">Initializing sync...</p>
          </div>
        )}

        {/* Paused Status - Always show countdown when PAUSED */}
        {isPaused && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
            <div className="flex items-center">
              <AlertCircle className="h-5 w-5 text-yellow-600 mr-2" />
              <div className="flex-1">
                {countdown !== null && countdown > 0 ? (
                  <p className="text-sm font-medium text-yellow-800">
                    Sharetribe rate limit reached — resuming in <span className="font-mono font-semibold">{formatTime(countdown)}</span>
                  </p>
                ) : (
                  <p className="text-sm font-medium text-yellow-800">
                    Checking status…
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
        

        {/* Errors / Rate Limited Products */}
        {errors && errors.length > 0 && (
          <div className={`${isPaused ? 'bg-yellow-50 border border-yellow-200' : 'bg-red-50 border border-red-200'} rounded-lg p-3 mb-4 max-h-40 overflow-y-auto`}>
            <p className={`text-sm font-medium mb-2 ${isPaused ? 'text-yellow-800' : 'text-red-800'}`}>
              {isPaused ? (
                <>
                  {failed} product(s) waiting to be synced:
                  <span className="block text-xs font-normal text-yellow-700 mt-1">
                    (Paused briefly due to API rate limiting)
                  </span>
                </>
              ) : (
                `${failed} product(s) failed:`
              )}
            </p>
            <ul className={`text-xs space-y-1 ${isPaused ? 'text-yellow-700' : 'text-red-700'}`}>
              {errors.slice(0, 5).map((error, idx) => {
                const isRateLimitError = error.error && (
                  error.error.includes('rate limit') || 
                  error.error.includes('429') || 
                  error.error.includes('Too Many Requests')
                );
                const displayError = isRateLimitError 
                  ? `Waiting to sync — paused due to ShareTribe API rate limit`
                  : error.error;
                return (
                  <li key={idx}>
                    • {error.title || error.itemId}: {displayError}
                  </li>
                );
              })}
              {errors.length > 5 && (
                <li className={isPaused ? 'text-yellow-600' : 'text-red-600'}>
                  ... and {errors.length - 5} more
                </li>
              )}
            </ul>
          </div>
        )}

        {/* Success Message - Only show for COMPLETED */}
        {isCompleted && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
            <p className="text-sm text-green-800">
              ✅ Successfully synced {completed} product(s)
              {failed > 0 && ` (${failed} failed)`}
            </p>
          </div>
        )}
        
        {/* Cancelled Message */}
        {isCancelled && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-4">
            <p className="text-sm text-gray-800">
              ⏸️ Sync cancelled: {processed}/{total} processed
            </p>
          </div>
        )}

        {/* Error Message */}
        {isError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
            <p className="text-sm text-red-800">
              ❌ Sync failed: {currentStep || 'Unknown error'}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 mt-6">
          {(isCompleted || isError || isCancelled) && (
            <button
              onClick={onClose}
              className="flex-1 bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg transition-colors"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default SyncProgressModal;

