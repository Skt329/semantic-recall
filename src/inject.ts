/**
 * semantic-recall — Injection Pipeline
 *
 * Orchestrates the full background memory injection flow:
 *   mark processing → embed → dimension check → dedup → TTL → prune → insert → mark done
 *
 * On failure: increment attempts, compute backoff, emit retry/dead events.
 * This pipeline is designed to never throw — all errors are handled internally
 * and communicated via events on the Memory EventEmitter.
 */

import { EventEmitter } from 'node:events';
import type {
  InjectParams,
  MemorySavedEvent,
  MemoryRetryEvent,
  MemoryDeadEvent,
} from './types.js';
import { checkAndDedup } from './dedup.js';
import { generateExpiresAt, nowISO } from './utils.js';

/**
 * Execute the full injection pipeline for a single memory.
 *
 * This function is called:
 * - When `memory.remember()` enqueues a new job
 * - When the retry scheduler picks up a failed job
 * - On startup when replaying pending jobs from a crashed session
 *
 * It NEVER throws. All errors are caught and handled via the
 * storage adapter's markFailed() and event emission.
 *
 * @param params - Full pipeline parameters including embedder, storage, and job metadata.
 * @param emitter - EventEmitter instance for emitting memory events.
 */
export async function injectBackground(
  params: InjectParams,
  emitter: EventEmitter,
): Promise<{ saved: boolean; duplicate: boolean }> {
  const {
    jobId,
    userId,
    namespace,
    content,
    ttl,
    dedupThreshold,
    embedder,
    storage,
    replayed = false,
    retried = false,
  } = params;

  try {
    // Step 1: Mark job as processing
    await storage.markProcessing(jobId);

    // Step 2: Embed the text
    const vector = await embedder(content);

    // Step 3+4: Single-pass dimension check + deduplication
    const duplicate = await checkAndDedup({
      vector,
      userId,
      namespace,
      threshold: dedupThreshold,
      storage,
    });

    if (duplicate) {
      // Memory is a duplicate — skip insert, mark job done
      await storage.markDone(jobId);
      return { saved: false, duplicate: true };
    }

    // Step 5: Compute TTL / expiry
    const expiresAt = generateExpiresAt(ttl);

    // Step 6: Prune expired memories for this user
    await storage.pruneExpired(userId);

    // Step 7: Insert into memories table
    await storage.insertMemory({
      userId,
      namespace,
      content,
      embedding: vector,
      createdAt: nowISO(),
      expiresAt,
      tags: params.tags,
    });

    // Step 8: Mark job done
    await storage.markDone(jobId);

    // Step 9: Emit success event
    const savedEvent: MemorySavedEvent = {
      jobId,
      content,
      replayed: replayed || undefined,
      retried: retried || undefined,
    };
    emitter.emit('memory:saved', savedEvent);

    return { saved: true, duplicate: false };
  } catch (err) {
    // ─── Failure Handling ──────────────────────────────────────────────

    const errorMessage = err instanceof Error ? err.message : String(err);

    try {
      // Mark failed in storage (increments attempts, computes backoff)
      await storage.markFailed(jobId, errorMessage);

      // Re-read the job to get updated attempt count
      const retryable = await storage.getRetryable();
      const deadJobs = await storage.getDeadJobs(userId);

      // Check if this job is now dead
      const isDead = deadJobs.some(j => j.id === jobId);
      const failedJob = retryable.find(j => j.id === jobId);

      if (isDead) {
        // All retries exhausted — emit dead event
        const deadJob = deadJobs.find(j => j.id === jobId);
        const deadEvent: MemoryDeadEvent = {
          jobId,
          content,
          error: errorMessage,
          attempts: deadJob?.attempts ?? failedJob?.attempts ?? 1,
        };
        emitter.emit('memory:dead', deadEvent);
      } else {
        // Will be retried — emit retry event
        const retryEvent: MemoryRetryEvent = {
          jobId,
          content,
          error: errorMessage,
          attempts: failedJob?.attempts ?? 1,
        };
        emitter.emit('memory:retry', retryEvent);
      }
    } catch {
      // If even the failure handling fails, swallow silently.
      // The developer can discover this via getDeadJobs() later.
    }

    return { saved: false, duplicate: false };
  }
}
