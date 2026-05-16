/**
 * semantic-recall — Abstract Base Storage Adapter
 *
 * Extend this class to create custom storage adapters with compile-time
 * enforcement of all required methods. Provides default implementations
 * for analytics-only methods that can be overridden for optimization.
 *
 * @example
 * ```typescript
 * import { BaseStorageAdapter } from 'semantic-recall'
 *
 * class MyRedisAdapter extends BaseStorageAdapter {
 *   // TypeScript will error on any missing abstract method
 *   async init() { ... }
 *   async insertMemory(params) { ... }
 *   // ... all other abstract methods
 * }
 * ```
 */

import type {
  StorageAdapter,
  InsertMemoryParams,
  SearchParams,
  RawMemoryRow,
  NewJob,
  MemoryJob,
  AdapterStats,
  UpdateMemoryParams,
} from '../../types.js';

export abstract class BaseStorageAdapter implements StorageAdapter {
  // ── Abstract — must be implemented by subclass ──────────────────────────

  abstract init(): Promise<void>;
  abstract insertMemory(params: InsertMemoryParams): Promise<number>;
  abstract searchMemories(params: SearchParams): Promise<RawMemoryRow[]>;
  abstract deleteMemory(id: number): Promise<void>;
  abstract deleteAllMemories(userId: string, namespace: string): Promise<void>;
  abstract listMemories(userId: string, namespace: string, limit: number): Promise<RawMemoryRow[]>;
  abstract pruneExpired(userId: string): Promise<void>;
  abstract enqueue(job: NewJob): Promise<number>;
  abstract markProcessing(jobId: number): Promise<void>;
  abstract markDone(jobId: number): Promise<void>;
  abstract markFailed(jobId: number, error: string): Promise<void>;
  abstract getRetryable(): Promise<MemoryJob[]>;
  abstract getDeadJobs(userId: string): Promise<MemoryJob[]>;
  abstract resetStaleProcessing(): Promise<void>;
  abstract cleanupDoneJobs(olderThanMs: number): Promise<number>;
  abstract retryDeadJob(jobId: number): Promise<void>;
  abstract close(): void;
  abstract getMemoryById(id: number): Promise<RawMemoryRow | null>;
  abstract updateMemory(id: number, params: UpdateMemoryParams): Promise<void>;
  abstract getAllMemories(userId: string): Promise<RawMemoryRow[]>;
  abstract listNamespaces(userId: string): Promise<string[]>;

  // ── Default implementations — override to optimize ─────────────────────

  /**
   * No-op default. Override for recall count tracking.
   * This is fire-and-forget on the hot path, so a no-op
   * is acceptable for adapters that don't need analytics.
   */
  async incrementRecallCount(_ids: number[]): Promise<void> {
    // No-op default
  }

  /**
   * Sequential fallback. Override with transaction-wrapped batch insert
   * for significantly better performance on your storage backend.
   */
  async bulkInsertMemories(memories: InsertMemoryParams[]): Promise<number[]> {
    const ids: number[] = [];
    for (const mem of memories) {
      ids.push(await this.insertMemory(mem));
    }
    return ids;
  }

  /**
   * Composed default — uses listNamespaces + listMemories + getDeadJobs.
   * Override with optimized SQL (e.g., COUNT + PRAGMA page_count) for
   * better performance on large datasets.
   *
   * Note: This implementation uses an N+1 query pattern per namespace.
   * Acceptable for the default, but override for production workloads.
   */
  async getStats(userId: string): Promise<AdapterStats> {
    const namespaces = await this.listNamespaces(userId);
    const namespaceCounts: Record<string, number> = {};
    let allMemories: RawMemoryRow[] = [];
    const now = new Date().toISOString();

    for (const ns of namespaces) {
      const rows = await this.listMemories(userId, ns, 100_000);
      const live = rows.filter(r => !r.expires_at || r.expires_at > now);
      namespaceCounts[ns] = live.length;
      allMemories = allMemories.concat(live);
    }

    const deadJobs = await this.getDeadJobs(userId);

    const sorted = [...allMemories].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    const mostRecalled = allMemories.reduce<{ content: string; recallCount: number } | null>(
      (best, row) => {
        const rc = row.recall_count ?? 0;
        return rc > (best?.recallCount ?? 0) ? { content: row.content, recallCount: rc } : best;
      },
      null,
    );

    return {
      totalMemories: allMemories.length,
      oldestDate: sorted[0]?.created_at ?? null,
      newestDate: sorted.at(-1)?.created_at ?? null,
      mostRecalled: mostRecalled?.recallCount ? mostRecalled : null,
      deadJobCount: deadJobs.length,
      namespaceCounts,
      storageSizeKB: null,
    };
  }
}
