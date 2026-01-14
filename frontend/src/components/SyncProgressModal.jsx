import React, { useEffect, useState } from 'react';
import { X, CheckCircle, AlertCircle, Loader } from 'lucide-react';

const SyncProgressModal = ({ jobId, onClose, onRetryFailed }) => {
  const [progress, setProgress] = useState(null);
  const [pollingInterval, setPollingInterval] = useState(null);

  console.log('📋 [Modal] SyncProgressModal rendered, jobId prop:', jobId, 'type:', typeof jobId);

  useEffect(() => {
    let interval = null;
    let isMounted = true;

    // Start polling for progress
    const pollProgress = async () => {
      if (!isMounted) return;
      
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
            const isAlreadyRunningError = data.status === 'error' && 
              data.currentStep && 
              data.currentStep.includes('already in progress');
            
            if (isAlreadyRunningError) {
              // Don't show error - treat as in-progress and keep polling
              // The real progress should be available from the active job
              console.log('📋 [Modal] Detected "already running" error - treating as in-progress');
              // Keep current progress or show initializing state
              if (!progress || progress.status === 'error') {
                setProgress({
                  ...data,
                  status: 'starting',
                  currentStep: 'Attaching to existing sync job...'
                });
              }
              // Continue polling - don't stop
            } else {
              setProgress(data);
              
              // Stop polling if sync is completed or errored (but not "already running" errors)
              if (data.status === 'completed' || (data.status === 'error' && !isAlreadyRunningError)) {
                if (interval) {
                  clearInterval(interval);
                  interval = null;
                  setPollingInterval(null);
                }
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

    // Poll immediately, then every 500ms
    pollProgress();
    interval = setInterval(pollProgress, 500);
    setPollingInterval(interval);

    return () => {
      isMounted = false;
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [jobId]);

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

  const { total, completed, failed, percent, status, currentStep, etaFormatted, errors, rateLimitRetryAfter } = progress;
  const isCompleted = status === 'completed';
  // Don't treat "already running" errors as real errors - they're just status messages
  const isAlreadyRunningError = status === 'error' && currentStep && currentStep.includes('already in progress');
  const isError = status === 'error' && !isAlreadyRunningError;
  const isRateLimited = status === 'rate_limited';
  const isInProgress = status === 'in_progress' || status === 'starting' || isAlreadyRunningError;

  // Calculate circumference for circular progress bar (radius = 60, so circumference = 2 * π * 60)
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">
            {isCompleted ? 'Sync Completed' : isError ? 'Sync Error' : 'Syncing Products'}
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
                stroke={isError ? "#ef4444" : isCompleted ? "#10b981" : "#3b82f6"}
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
              {isRateLimited ? (
                <AlertCircle className="h-8 w-8 text-yellow-500 animate-pulse" />
              ) : isCompleted ? (
                <CheckCircle className="h-8 w-8 text-green-500" />
              ) : isError ? (
                <AlertCircle className="h-8 w-8 text-red-500" />
              ) : null}
              <span className="text-2xl font-bold text-gray-900 mt-2">{percent}%</span>
            </div>
          </div>
        </div>

        {/* Progress Text */}
        <div className="text-center mb-4">
          {total > 0 ? (
            <p className="text-lg font-medium text-gray-900">
              {completed}/{total} — {percent}%
            </p>
          ) : (
            <p className="text-lg font-medium text-gray-900">
              {status === 'starting' ? 'Initializing...' : `${completed}/${total} — ${percent}%`}
            </p>
          )}
          {isRateLimited && rateLimitRetryAfter ? (
            <p className="text-sm text-yellow-600 mt-1 font-medium">
              Waiting for API limit refresh: {rateLimitRetryAfter}s remaining
            </p>
          ) : etaFormatted && isInProgress && total > 0 ? (
            <p className="text-sm text-gray-500 mt-1">
              Estimated time remaining: {etaFormatted}
            </p>
          ) : null}
        </div>

        {/* Current Step */}
        {currentStep && (
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

        {/* Rate Limit Status */}
        {isRateLimited && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
            <div className="flex items-center">
              <AlertCircle className="h-5 w-5 text-yellow-600 mr-2" />
              <div>
                <p className="text-sm font-medium text-yellow-800">Rate Limit Hit</p>
                <p className="text-xs text-yellow-700 mt-1">
                  Waiting for API limit refresh... {rateLimitRetryAfter ? `${rateLimitRetryAfter}s remaining` : 'Please wait'}
                </p>
                <p className="text-xs text-yellow-600 mt-1">
                  Sync will automatically resume once the rate limit resets.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Errors */}
        {errors && errors.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 max-h-40 overflow-y-auto">
            <p className="text-sm font-medium text-red-800 mb-2">
              {failed} product(s) failed:
            </p>
            <ul className="text-xs text-red-700 space-y-1">
              {errors.slice(0, 5).map((error, idx) => (
                <li key={idx}>
                  • {error.title || error.itemId}: {error.error}
                </li>
              ))}
              {errors.length > 5 && (
                <li className="text-red-600">... and {errors.length - 5} more</li>
              )}
            </ul>
          </div>
        )}

        {/* Success Message */}
        {isCompleted && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
            <p className="text-sm text-green-800">
              ✅ Successfully synced {completed} product(s)
              {failed > 0 && ` (${failed} failed)`}
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
          {isCompleted && failed > 0 && onRetryFailed && (
            <button
              onClick={() => {
                onRetryFailed(errors.map(e => e.itemId));
                onClose();
              }}
              className="flex-1 bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded-lg transition-colors"
            >
              Retry Failed Items
            </button>
          )}
          {isCompleted || isError ? (
            <button
              onClick={onClose}
              className="flex-1 bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg transition-colors"
            >
              Done
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default SyncProgressModal;

