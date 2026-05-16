/**
 * semantic-recall — Turso Storage Adapter
 *
 * Drop-in replacement for the SQLite adapter on serverless platforms
 * (Vercel, Cloudflare Workers, etc.) where there's no persistent filesystem.
 *
 * Turso is a hosted SQLite-compatible database with an HTTP API.
 * Same schema as the SQLite adapter, same JS-side cosine computation.
 *
 * @example
 * ```typescript
 * import { Memory } from 'semantic-recall'
 * import { createTursoAdapter } from 'semantic-recall/adapters/storage/turso'
 *
 * const memory = new Memory({
 *   userId: 'user_123',
 *   storage: createTursoAdapter({
 *     url: 'libsql://your-db.turso.io',
 *     authToken: 'your-token',
 *   }),
 * })
 * ```
 */

import type {
  StorageAdapter,
  InsertMemoryParams,
  SearchParams,
  RawMemoryRow,
  NewJob,
  MemoryJob,
  JobStatus,
  AdapterStats,
  UpdateMemoryParams,
} from '../../types.js';
import { computeBackoffMs, nowISO } from '../../utils.js';

export interface TursoAdapterOptions {
  url: string;
  authToken: string;
}

interface TursoClient {
  execute(args: { sql: string; args?: unknown[] }): Promise<{ rows: unknown[]; lastInsertRowid?: bigint | number }>;
  batch(stmts: Array<{ sql: string; args?: unknown[] }>): Promise<unknown>;
}

/**
 * Create a Turso storage adapter.
 *
 * @param options - Turso connection options.
 * @returns A StorageAdapter instance.
 */
export function createTursoAdapter(options: TursoAdapterOptions): StorageAdapter {
  let client: TursoClient | null = null;

  async function getClient(): Promise<TursoClient> {
    if (client) return client;

    try {
      const { createClient } = await import('@libsql/client');
      client = createClient({
        url: options.url,
        authToken: options.authToken,
      }) as unknown as TursoClient;
      return client;
    } catch {
      throw new Error(
        '[semantic-recall] The "@libsql/client" package is required for the Turso adapter. ' +
        'Install it with: npm install @libsql/client'
      );
    }
  }

  function mapJobRow(row: Record<string, unknown>): MemoryJob {
    return {
      id: Number(row['id']),
      userId: row['user_id'] as string,
      namespace: row['namespace'] as string,
      content: row['content'] as string,
      status: row['status'] as JobStatus,
      attempts: Number(row['attempts']),
      maxAttempts: Number(row['max_attempts']),
      lastError: (row['last_error'] as string) ?? null,
      createdAt: row['created_at'] as string,
      nextRetryAt: (row['next_retry_at'] as string) ?? null,
      ttl: (row['ttl'] as string) ?? null,
      tags: (row['tags'] as string) ?? null,
    };
  }

  const ALLOWED_TABLES = new Set(['memories', 'pending_memories']);

  /** Safe column addition — no-op if column already exists. */
  async function migrateAddColumn(table: string, column: string, alterSql: string): Promise<void> {
    if (!ALLOWED_TABLES.has(table)) {
      throw new Error(`[semantic-recall] Unexpected table name: ${table}`);
    }
    const db = await getClient();
    const result = await db.execute({ sql: `PRAGMA table_info(${table})`, args: [] });
    const columns = result.rows as unknown as Array<{ name: string }>;
    const exists = columns.some(c => c.name === column);
    if (!exists) {
      await db.execute({ sql: alterSql, args: [] });
    }
  }

  const adapter: StorageAdapter = {
    async init(): Promise<void> {
      const db = await getClient();
      await db.batch([
        {
          sql: `CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            namespace TEXT NOT NULL DEFAULT 'default',
            content TEXT NOT NULL,
            embedding TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT
          )`,
          args: [],
        },
        {
          sql: `CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, namespace)`,
          args: [],
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS pending_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            namespace TEXT NOT NULL DEFAULT 'default',
            content TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 3,
            last_error TEXT,
            created_at TEXT NOT NULL,
            next_retry_at TEXT
          )`,
          args: [],
        },
        {
          sql: `CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_memories(status, next_retry_at)`,
          args: [],
        },
      ]);

      // Guarded migrations
      await migrateAddColumn('memories', 'tags', "ALTER TABLE memories ADD COLUMN tags TEXT DEFAULT '[]'");
      await migrateAddColumn('memories', 'recall_count', 'ALTER TABLE memories ADD COLUMN recall_count INTEGER DEFAULT 0');
      await migrateAddColumn('pending_memories', 'ttl', 'ALTER TABLE pending_memories ADD COLUMN ttl TEXT');
      await migrateAddColumn('pending_memories', 'tags', "ALTER TABLE pending_memories ADD COLUMN tags TEXT DEFAULT '[]'");

      // Partial index for faster TTL pruning
      await db.execute({
        sql: `CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL`,
        args: [],
      });
    },

    async insertMemory(params: InsertMemoryParams): Promise<number> {
      const db = await getClient();
      const result = await db.execute({
        sql: `INSERT INTO memories (user_id, namespace, content, embedding, created_at, expires_at, tags)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          params.userId,
          params.namespace,
          params.content,
          JSON.stringify(params.embedding),
          params.createdAt,
          params.expiresAt,
          JSON.stringify(params.tags ?? []),
        ],
      });
      return Number(result.lastInsertRowid);
    },

    async searchMemories(params: SearchParams): Promise<RawMemoryRow[]> {
      const db = await getClient();
      const now = nowISO();
      let sql = `SELECT id, user_id, namespace, content, embedding, created_at, expires_at, tags, recall_count
              FROM memories
              WHERE user_id = ? AND namespace = ?
                AND (expires_at IS NULL OR expires_at > ?)`;
      const args: unknown[] = [params.userId, params.namespace, now];

      if (params.after) {
        sql += ` AND created_at >= ?`;
        args.push(params.after);
      }
      if (params.before) {
        sql += ` AND created_at <= ?`;
        args.push(params.before);
      }

      if (params.limit) {
        sql += ` ORDER BY created_at DESC LIMIT ?`;
        args.push(params.limit);
      }

      const result = await db.execute({ sql, args });
      return result.rows as unknown as RawMemoryRow[];
    },

    async deleteMemory(id: number): Promise<void> {
      const db = await getClient();
      await db.execute({ sql: 'DELETE FROM memories WHERE id = ?', args: [id] });
    },

    async deleteAllMemories(userId: string, namespace: string): Promise<void> {
      const db = await getClient();
      await db.execute({
        sql: 'DELETE FROM memories WHERE user_id = ? AND namespace = ?',
        args: [userId, namespace],
      });
    },

    async listMemories(userId: string, namespace: string, limit: number): Promise<RawMemoryRow[]> {
      const db = await getClient();
      const result = await db.execute({
        sql: `SELECT id, user_id, namespace, content, embedding, created_at, expires_at, tags, recall_count
              FROM memories
              WHERE user_id = ? AND namespace = ?
                AND (expires_at IS NULL OR expires_at > ?)
              ORDER BY created_at DESC LIMIT ?`,
        args: [userId, namespace, nowISO(), limit],
      });
      return result.rows as unknown as RawMemoryRow[];
    },

    async pruneExpired(userId: string): Promise<void> {
      const db = await getClient();
      await db.execute({
        sql: 'DELETE FROM memories WHERE user_id = ? AND expires_at IS NOT NULL AND expires_at <= ?',
        args: [userId, nowISO()],
      });
    },

    // ─── New Methods (v1.1.0) ─────────────────────────────────────────

    async getMemoryById(id: number): Promise<RawMemoryRow | null> {
      const db = await getClient();
      const result = await db.execute({
        sql: `SELECT id, user_id, namespace, content, embedding, created_at, expires_at, tags, recall_count
              FROM memories WHERE id = ?`,
        args: [id],
      });
      return (result.rows[0] as unknown as RawMemoryRow) ?? null;
    },

    async updateMemory(id: number, params: UpdateMemoryParams): Promise<void> {
      const db = await getClient();
      await db.execute({
        sql: `UPDATE memories SET content = ?, embedding = ?, tags = ? WHERE id = ?`,
        args: [
          params.content,
          JSON.stringify(params.embedding),
          JSON.stringify(params.tags ?? []),
          id,
        ],
      });
    },

    async incrementRecallCount(ids: number[]): Promise<void> {
      if (ids.length === 0) return;
      const db = await getClient();
      const placeholders = ids.map(() => '?').join(',');
      await db.execute({
        sql: `UPDATE memories SET recall_count = COALESCE(recall_count, 0) + 1 WHERE id IN (${placeholders})`,
        args: ids,
      });
    },

    async getAllMemories(userId: string): Promise<RawMemoryRow[]> {
      const db = await getClient();
      const result = await db.execute({
        sql: `SELECT id, user_id, namespace, content, embedding, created_at, expires_at, tags, recall_count
              FROM memories
              WHERE user_id = ?
                AND (expires_at IS NULL OR expires_at > ?)
              ORDER BY created_at DESC`,
        args: [userId, nowISO()],
      });
      return result.rows as unknown as RawMemoryRow[];
    },

    async listNamespaces(userId: string): Promise<string[]> {
      const db = await getClient();
      const result = await db.execute({
        sql: 'SELECT DISTINCT namespace FROM memories WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)',
        args: [userId, nowISO()],
      });
      return (result.rows as unknown as Array<{ namespace: string }>).map(r => r.namespace);
    },

    async getStats(userId: string): Promise<AdapterStats> {
      const db = await getClient();
      const now = nowISO();

      const countResult = await db.execute({
        sql: `SELECT COUNT(*) as cnt FROM memories
              WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
        args: [userId, now],
      });
      const totalMemories = (countResult.rows[0] as unknown as { cnt: number })?.cnt ?? 0;

      const dateResult = await db.execute({
        sql: `SELECT MIN(created_at) as oldest, MAX(created_at) as newest
              FROM memories
              WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
        args: [userId, now],
      });
      const dateRow = dateResult.rows[0] as unknown as { oldest: string | null; newest: string | null } | undefined;

      const recallResult = await db.execute({
        sql: `SELECT content, COALESCE(recall_count, 0) as rc
              FROM memories
              WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)
              ORDER BY rc DESC LIMIT 1`,
        args: [userId, now],
      });
      const recalledRow = recallResult.rows[0] as unknown as { content: string; rc: number } | undefined;

      const deadResult = await db.execute({
        sql: `SELECT COUNT(*) as cnt FROM pending_memories
              WHERE user_id = ? AND status = 'dead'`,
        args: [userId],
      });
      const deadJobCount = (deadResult.rows[0] as unknown as { cnt: number })?.cnt ?? 0;

      const nsResult = await db.execute({
        sql: `SELECT namespace, COUNT(*) as cnt FROM memories
              WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)
              GROUP BY namespace`,
        args: [userId, now],
      });
      const namespaceCounts: Record<string, number> = {};
      for (const r of nsResult.rows as unknown as Array<{ namespace: string; cnt: number }>) {
        namespaceCounts[r.namespace] = r.cnt;
      }

      return {
        totalMemories,
        oldestDate: dateRow?.oldest ?? null,
        newestDate: dateRow?.newest ?? null,
        mostRecalled: recalledRow && recalledRow.rc > 0
          ? { content: recalledRow.content, recallCount: recalledRow.rc }
          : null,
        deadJobCount,
        namespaceCounts,
        storageSizeKB: null, // Turso does not expose file-level size
      };
    },

    /**
     * Insert multiple memories sequentially.
     *
     * **Note:** Unlike the SQLite adapter, this is NOT wrapped in a transaction.
     * Turso's `batch()` API does not return per-row insert IDs, so sequential
     * execution is required to satisfy the `number[]` return type. If a network
     * error occurs mid-batch, earlier inserts will persist (partial write).
     *
     * For atomic batch imports, use `Memory.import()` instead.
     */
    async bulkInsertMemories(memories: InsertMemoryParams[]): Promise<number[]> {
      if (memories.length === 0) return [];
      const db = await getClient();
      // Use batch() for atomicity — all-or-nothing
      const stmts = memories.map(mem => ({
        sql: `INSERT INTO memories (user_id, namespace, content, embedding, created_at, expires_at, tags)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          mem.userId, mem.namespace, mem.content,
          JSON.stringify(mem.embedding), mem.createdAt,
          mem.expiresAt, JSON.stringify(mem.tags ?? []),
        ],
      }));
      const results = await db.batch(stmts) as Array<{ lastInsertRowid?: bigint | number }>;
      return results.map(r => Number(r.lastInsertRowid ?? 0));
    },

    // ─── Queue Operations ─────────────────────────────────────────────

    async enqueue(job: NewJob): Promise<number> {
      const db = await getClient();
      const result = await db.execute({
        sql: `INSERT INTO pending_memories (user_id, namespace, content, status, max_attempts, created_at, ttl, tags)
              VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
        args: [job.userId, job.namespace, job.content, job.maxAttempts, nowISO(), job.ttl != null ? String(job.ttl) : null, job.tags ? JSON.stringify(job.tags) : null],
      });
      return Number(result.lastInsertRowid);
    },

    async markProcessing(jobId: number): Promise<void> {
      const db = await getClient();
      await db.execute({
        sql: "UPDATE pending_memories SET status = 'processing' WHERE id = ?",
        args: [jobId],
      });
    },

    async markDone(jobId: number): Promise<void> {
      const db = await getClient();
      await db.execute({
        sql: "UPDATE pending_memories SET status = 'done' WHERE id = ?",
        args: [jobId],
      });
    },

    async markFailed(jobId: number, error: string): Promise<void> {
      const db = await getClient();
      const result = await db.execute({
        sql: 'SELECT attempts, max_attempts FROM pending_memories WHERE id = ?',
        args: [jobId],
      });
      const job = result.rows[0] as { attempts: number; max_attempts: number } | undefined;
      if (!job) return;

      const newAttempts = job.attempts + 1;
      const isDead = newAttempts >= job.max_attempts;
      const newStatus: JobStatus = isDead ? 'dead' : 'failed';
      const nextRetryAt = isDead
        ? null
        : new Date(Date.now() + computeBackoffMs(newAttempts)).toISOString();

      await db.execute({
        sql: `UPDATE pending_memories SET status = ?, attempts = ?, last_error = ?, next_retry_at = ? WHERE id = ?`,
        args: [newStatus, newAttempts, error, nextRetryAt, jobId],
      });
    },

    async getRetryable(userId?: string): Promise<MemoryJob[]> {
      const db = await getClient();
      let sql = `SELECT id, user_id, namespace, content, status, attempts, max_attempts, last_error, created_at, next_retry_at, ttl, tags
              FROM pending_memories
              WHERE status IN ('pending', 'failed') AND (next_retry_at IS NULL OR next_retry_at <= ?)`;
      const args: unknown[] = [nowISO()];

      if (userId) {
        sql += ` AND user_id = ?`;
        args.push(userId);
      }

      const result = await db.execute({ sql, args });
      return (result.rows as unknown as Record<string, unknown>[]).map(mapJobRow);
    },

    async getDeadJobs(userId: string): Promise<MemoryJob[]> {
      const db = await getClient();
      const result = await db.execute({
        sql: `SELECT id, user_id, namespace, content, status, attempts, max_attempts, last_error, created_at, next_retry_at, ttl, tags
              FROM pending_memories WHERE user_id = ? AND status = 'dead'`,
        args: [userId],
      });
      return (result.rows as unknown as Record<string, unknown>[]).map(mapJobRow);
    },

    async resetStaleProcessing(userId?: string): Promise<void> {
      const db = await getClient();
      if (userId) {
        await db.execute({
          sql: "UPDATE pending_memories SET status = 'pending' WHERE status = 'processing' AND user_id = ?",
          args: [userId],
        });
      } else {
        await db.execute({
          sql: "UPDATE pending_memories SET status = 'pending' WHERE status = 'processing'",
          args: [],
        });
      }
    },

    async cleanupDoneJobs(olderThanMs: number): Promise<number> {
      const db = await getClient();
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const result = await db.execute({
        sql: "DELETE FROM pending_memories WHERE status = 'done' AND created_at < ?",
        args: [cutoff],
      });
      return (result as unknown as { rowsAffected: number }).rowsAffected ?? 0;
    },

    async retryDeadJob(jobId: number): Promise<void> {
      const db = await getClient();
      await db.execute({
        sql: `UPDATE pending_memories SET status = 'pending', attempts = 0, last_error = NULL, next_retry_at = NULL
              WHERE id = ? AND status = 'dead'`,
        args: [jobId],
      });
    },

    close(): void {
      // Turso client doesn't require explicit close
      client = null;
    },
  };

  return adapter;
}
