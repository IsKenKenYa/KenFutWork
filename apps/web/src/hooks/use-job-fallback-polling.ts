"use client";

import type { StreamEvent } from "@loomic/shared";
import { useCallback, useEffect, useRef } from "react";

import { fetchJob } from "../lib/server-api";

// --- Constants ---

/** Interval between polling attempts (ms) */
const POLL_INTERVAL_MS = 5_000;
/** Maximum total polling duration before giving up (ms) */
const MAX_POLL_DURATION_MS = 10 * 60 * 1_000; // 10 minutes
/** Terminal job statuses that should stop polling */
const TERMINAL_FAILURE_STATUSES = new Set([
  "failed",
  "dead_letter",
  "canceled",
]);

// --- Types ---

type UseJobFallbackPollingOptions = {
  /** Called when a timed-out job succeeds — trigger canvas re-fetch */
  onJobSucceeded: (jobId: string, jobType: string) => void;
  /** Ref to the current access token — avoids stale closure issues */
  accessTokenRef: React.RefObject<string | undefined>;
};

type ActivePoll = {
  intervalId: ReturnType<typeof setInterval>;
  startedAt: number;
  jobType: string;
};

// --- Hook ---

/**
 * Fallback polling for timed-out generation jobs.
 *
 * When the agent's generate_image/generate_video tool times out on the server
 * (poll timeout), the worker may still succeed later. This hook detects the
 * timeout from the `tool.completed` stream event and starts polling the job
 * API until the worker finishes, then notifies the caller to re-fetch the canvas.
 *
 * This prevents users from losing both their result and credits when the
 * backend times out but the worker eventually succeeds.
 *
 * Since the backend now inserts elements into the canvas directly, this hook
 * simply notifies the caller so it can trigger a canvas re-fetch (canvas.sync).
 */
export function useJobFallbackPolling({
  onJobSucceeded,
  accessTokenRef,
}: UseJobFallbackPollingOptions) {
  // Track active polls by jobId to avoid duplicates
  const activePollsRef = useRef<Map<string, ActivePoll>>(new Map());

  // Keep callback ref current to avoid stale closures in intervals
  const onJobSucceededRef = useRef(onJobSucceeded);
  onJobSucceededRef.current = onJobSucceeded;

  // Cleanup: stop all active polls on unmount
  useEffect(() => {
    return () => {
      for (const [jobId, poll] of activePollsRef.current.entries()) {
        clearInterval(poll.intervalId);
        console.log(`[job-fallback] Cleanup: stopped polling for job ${jobId}`);
      }
      activePollsRef.current.clear();
    };
  }, []);

  /**
   * Stop polling for a specific job and remove from active polls map.
   */
  const stopPolling = useCallback((jobId: string) => {
    const poll = activePollsRef.current.get(jobId);
    if (poll) {
      clearInterval(poll.intervalId);
      activePollsRef.current.delete(jobId);
    }
  }, []);

  /**
   * Start polling a specific job until it reaches a terminal state.
   */
  const startPolling = useCallback(
    (jobId: string, jobType: string) => {
      // Guard against duplicate polling for the same job
      if (activePollsRef.current.has(jobId)) {
        console.log(
          `[job-fallback] Already polling job ${jobId}, skipping duplicate`,
        );
        return;
      }

      const startedAt = Date.now();
      console.log(
        `[job-fallback] Starting fallback polling for ${jobType} job ${jobId}`,
      );

      const intervalId = setInterval(async () => {
        // Safety: check max duration
        const elapsed = Date.now() - startedAt;
        if (elapsed > MAX_POLL_DURATION_MS) {
          console.warn(
            `[job-fallback] Giving up on job ${jobId} after ${Math.round(elapsed / 1000)}s`,
          );
          stopPolling(jobId);
          return;
        }

        const token = accessTokenRef.current;
        if (!token) {
          // Token not available (e.g. user logged out) — stop polling
          console.warn(
            `[job-fallback] No access token available, stopping poll for job ${jobId}`,
          );
          stopPolling(jobId);
          return;
        }

        try {
          const { job } = await fetchJob(token, jobId);

          if (job.status === "succeeded" && job.result) {
            console.log(
              `[job-fallback] Job ${jobId} succeeded after fallback polling (${Math.round(elapsed / 1000)}s)`,
            );
            stopPolling(jobId);
            // Backend has already inserted the element into the canvas.
            // Notify caller to trigger a canvas re-fetch.
            onJobSucceededRef.current(jobId, job.job_type ?? "unknown");
            return;
          }

          if (TERMINAL_FAILURE_STATUSES.has(job.status)) {
            console.warn(
              `[job-fallback] Job ${jobId} reached terminal status: ${job.status}`,
            );
            stopPolling(jobId);
            return;
          }

          // Still running — continue polling
        } catch (err) {
          // Network error or API error — log but continue polling
          // (transient errors should not stop the recovery mechanism)
          console.warn(`[job-fallback] Poll error for job ${jobId}:`, err);
        }
      }, POLL_INTERVAL_MS);

      activePollsRef.current.set(jobId, {
        intervalId,
        startedAt,
        jobType,
      });
    },
    [accessTokenRef, stopPolling],
  );

  /**
   * Check a stream event for timed-out generation jobs.
   * Call this for every stream event received from the WebSocket.
   */
  const checkForTimedOutJobs = useCallback(
    (event: StreamEvent) => {
      if (event.type !== "tool.completed") return;

      const output = event.output;
      if (!output) return;

      const error = output.error;
      const jobId = output.jobId;
      const jobType = output.jobType;

      // Only trigger fallback for timeout errors with a valid jobId
      if (
        typeof error !== "string" ||
        !error.toLowerCase().includes("timed out") ||
        typeof jobId !== "string" ||
        !jobId
      ) {
        return;
      }

      const resolvedJobType = typeof jobType === "string" ? jobType : "unknown";
      startPolling(jobId, resolvedJobType);
    },
    [startPolling],
  );

  return { checkForTimedOutJobs };
}
