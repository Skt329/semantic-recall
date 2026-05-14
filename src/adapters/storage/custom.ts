/**
 * semantic-memory — Custom Storage Adapter Validator
 *
 * Wraps a developer-supplied storage adapter with runtime validation
 * to catch missing or incorrectly typed methods early.
 */

import type { StorageAdapter } from '../../types.js';

/** Required methods on a StorageAdapter. */
const REQUIRED_METHODS: (keyof StorageAdapter)[] = [
  'init',
  'insertMemory',
  'searchMemories',
  'deleteMemory',
  'deleteAllMemories',
  'listMemories',
  'pruneExpired',
  'enqueue',
  'markProcessing',
  'markDone',
  'markFailed',
  'getRetryable',
  'getDeadJobs',
  'resetStaleProcessing',
  'cleanupDoneJobs',
  'retryDeadJob',
  'close',
];

/**
 * Validate that a custom storage adapter implements all required methods.
 *
 * @param adapter - Developer-supplied storage adapter.
 * @returns The same adapter, validated.
 * @throws {Error} If any required method is missing.
 */
export function validateCustomAdapter(adapter: StorageAdapter): StorageAdapter {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error(
      '[semantic-memory] Custom storage adapter must be an object implementing the StorageAdapter interface.'
    );
  }

  const missing: string[] = [];

  for (const method of REQUIRED_METHODS) {
    if (typeof (adapter as unknown as Record<string, unknown>)[method] !== 'function') {
      missing.push(method);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `[semantic-memory] Custom storage adapter is missing required methods: ${missing.join(', ')}. ` +
      'See the StorageAdapter interface in the documentation.'
    );
  }

  return adapter;
}
