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
      id: row['id'] as number,
      userId: row['user_id'] as string,
      namespace: row['namespace'] as string,
      content: row['content'] as string,
      status: row['status'] as JobStatus,
      attempts: row['attempts'] as number,
      maxAttempts: row['max_attempts'] as number,
      lastError: (row['last_error'] as string) ?? null,
      createdAt: row['created_at'] as string,
      nextRetryAt: (row['next_retry_at'] as string) ?? null,
    };
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
    },

    async insertMemory(params: InsertMemoryParams): Promise<number> {
      const db = await getClient();
      const result = await db.execute({
        sql: `INSERT INTO memories (user_id, namespace, content, embedding, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          params.userId,
          params.namespace,
          params.content,
          JSON.stringify(params.embedding),
          params.createdAt,
          params.expiresAt,
        ],
      });
      return Number(result.lastInsertRowid);
    },

    async searchMemories(params: SearchParams): Promise<RawMemoryRow[]> {
      const db = await getClient();
      const result = await db.execute({
        sql: `SELECT id, user_id, namespace, content, embedding, created_at, expires_at
              FROM memories
              WHERE user_id = ? AND namespace = ?
                AND (expires_at IS NULL OR expires_at > ?)`,
        args: [params.userId, params.namespace, nowISO()],
      });
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
        sql: `SELECT id, user_id, namespace, content, embedding, created_at, expires_at
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

    async enqueue(job: NewJob): Promise<number> {
      const db = await getClient();
      const result = await db.execute({
        sql: `INSERT INTO pending_memories (user_id, namespace, content, status, max_attempts, created_at)
              VALUES (?, ?, ?, 'pending', ?, ?)`,
        args: [job.userId, job.namespace, job.content, job.maxAttempts, nowISO()],
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

    async getRetryable(): Promise<MemoryJob[]> {
      const db = await getClient();
      const result = await db.execute({
        sql: `SELECT id, user_id, namespace, content, status, attempts, max_attempts, last_error, created_at, next_retry_at
              FROM pending_memories
              WHERE status IN ('pending', 'failed') AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
        args: [nowISO()],
      });
      return (result.rows as unknown as Record<string, unknown>[]).map(mapJobRow);
    },

    async getDeadJobs(userId: string): Promise<MemoryJob[]> {
      const db = await getClient();
      const result = await db.execute({
        sql: `SELECT id, user_id, namespace, content, status, attempts, max_attempts, last_error, created_at, next_retry_at
              FROM pending_memories WHERE user_id = ? AND status = 'dead'`,
        args: [userId],
      });
      return (result.rows as unknown as Record<string, unknown>[]).map(mapJobRow);
    },

    async resetStaleProcessing(): Promise<void> {
      const db = await getClient();
      await db.execute({
        sql: "UPDATE pending_memories SET status = 'pending' WHERE status = 'processing'",
        args: [],
      });
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
