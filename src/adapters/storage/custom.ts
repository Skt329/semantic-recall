/**
 * semantic-recall — Custom Storage Adapter Validation
 *
 * Runtime validation for user-provided storage adapter objects.
 * Ensures all 24 required methods are present at construction time
 * rather than failing deep inside the memory pipeline.
 *
 * Developers are strongly encouraged to extend `BaseStorageAdapter`
 * instead of providing a raw object — it gives compile-time enforcement
 * and default implementations for analytics methods.
 */

import type { StorageAdapter } from '../../types.js';

/**
 * All 24 methods required by the StorageAdapter interface.
 * Listed in logical groups for readability.
 */
const REQUIRED_METHODS: (keyof StorageAdapter)[] = [
  // Lifecycle
  'init',
  'close',

  // Memory CRUD
  'insertMemory',
  'searchMemories',
  'deleteMemory',
  'deleteAllMemories',
  'listMemories',
  'pruneExpired',
  'getMemoryById',
  'updateMemory',
  'incrementRecallCount',
  'getAllMemories',
  'listNamespaces',
  'getStats',
  'bulkInsertMemories',

  // Queue
  'enqueue',
  'markProcessing',
  'markDone',
  'markFailed',
  'getRetryable',
  'getDeadJobs',
  'resetStaleProcessing',
  'cleanupDoneJobs',
  'retryDeadJob',
];

/**
 * Validate that a user-provided storage adapter implements the full
 * StorageAdapter interface (all 24 methods).
 *
 * @throws Error with a clear, actionable message listing missing methods
 *         and directing the developer to use BaseStorageAdapter.
 */
export function validateCustomAdapter(
  adapter: unknown,
): asserts adapter is StorageAdapter {
  const obj = adapter as Record<string, unknown>;
  const missing = REQUIRED_METHODS.filter(
    method => typeof obj[method] !== 'function',
  );

  if (missing.length > 0) {
    throw new Error(
      `[semantic-recall] Custom storage adapter is missing ${missing.length} required method(s):\n` +
      `  ${missing.join(', ')}\n\n` +
      `The StorageAdapter interface requires 24 methods. ` +
      `For the best developer experience, extend BaseStorageAdapter ` +
      `instead of providing a raw object:\n\n` +
      `  import { BaseStorageAdapter } from 'semantic-recall'\n\n` +
      `  class MyAdapter extends BaseStorageAdapter {\n` +
      `    // TypeScript will show you every abstract method\n` +
      `    // that needs to be implemented.\n` +
      `  }\n\n` +
      `BaseStorageAdapter provides default implementations for:\n` +
      `  - incrementRecallCount (no-op)\n` +
      `  - bulkInsertMemories (sequential fallback)\n` +
      `  - getStats (composed from other methods)\n\n` +
      `See: https://github.com/skt329/semantic-recall#custom-adapter-guide`
    );
  }
}
