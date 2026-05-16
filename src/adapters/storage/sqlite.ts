/**
 * semantic-recall — SQLite Storage Adapter (Default)
 *
 * Uses better-sqlite3 for synchronous, fast reads/writes.
 * Stores embeddings as JSON-serialized TEXT columns.
 * Cosine similarity is computed in JavaScript after loading rows.
 *
 * This adapter works on any machine with a filesystem (Railway, Render,
 * AWS EC2, Fly.io, local dev). It does NOT work on serverless platforms
 * without persistent storage (Vercel, Cloudflare Workers).
 */

import Database from 'better-sqlite3';
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

// ─── SQL Statements ─────────────────────────────────────────────────────────

const CREATE_MEMORIES_TABLE = `
  CREATE TABLE IF NOT EXISTS memories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    namespace  TEXT    NOT NULL DEFAULT 'default',
    content    TEXT    NOT NULL,
    embedding  TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    expires_at TEXT
  );
`;

const CREATE_MEMORIES_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_memories_user
  ON memories(user_id, namespace);
`;

const CREATE_PENDING_TABLE = `
  CREATE TABLE IF NOT EXISTS pending_memories (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT    NOT NULL,
    namespace     TEXT    NOT NULL DEFAULT 'default',
    content       TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending',
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 3,
    last_error    TEXT,
    created_at    TEXT    NOT NULL,
    next_retry_at TEXT
  );
`;

const CREATE_PENDING_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_pending_status
  ON pending_memories(status, next_retry_at);
`;

// ─── Migration SQL (guarded ALTER TABLE) ────────────────────────────────────

const MIGRATION_ADD_TAGS = `
  ALTER TABLE memories ADD COLUMN tags TEXT DEFAULT '[]';
`;

const MIGRATION_ADD_RECALL_COUNT = `
  ALTER TABLE memories ADD COLUMN recall_count INTEGER DEFAULT 0;
`;

// ─── Adapter Implementation ────────────────────────────────────────────────

export class SQLiteStorageAdapter implements StorageAdapter {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read/write performance
    this.db.pragma('journal_mode = WAL');
    // Synchronous NORMAL is safe with WAL and faster than FULL
    this.db.pragma('synchronous = NORMAL');
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');
  }

  // ─── Initialization ────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.db.exec(CREATE_MEMORIES_TABLE);
    this.db.exec(CREATE_MEMORIES_INDEX);
    this.db.exec(CREATE_PENDING_TABLE);
    this.db.exec(CREATE_PENDING_INDEX);

    // Guarded migrations — only run if column doesn't exist yet
    this.migrateAddColumn('memories', 'tags', MIGRATION_ADD_TAGS);
    this.migrateAddColumn('memories', 'recall_count', MIGRATION_ADD_RECALL_COUNT);
  }

  /** Safe column addition — no-op if column already exists. */
  private migrateAddColumn(table: string, column: string, sql: string): void {
    const columns = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    const exists = columns.some(c => c.name === column);
    if (!exists) {
      this.db.exec(sql);
    }
  }

  // ─── Memory CRUD ───────────────────────────────────────────────────────

  async insertMemory(params: InsertMemoryParams): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO memories (user_id, namespace, content, embedding, created_at, expires_at, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      params.userId,
      params.namespace,
      params.content,
      JSON.stringify(params.embedding),
      params.createdAt,
      params.expiresAt,
      JSON.stringify(params.tags ?? []),
    );

    return Number(result.lastInsertRowid);
  }

  async searchMemories(params: SearchParams): Promise<RawMemoryRow[]> {
    const stmt = this.db.prepare(`
      SELECT id, user_id, namespace, content, embedding, created_at, expires_at, tags, recall_count
      FROM memories
      WHERE user_id = ? AND namespace = ?
        AND (expires_at IS NULL OR expires_at > ?)
    `);

    return stmt.all(params.userId, params.namespace, nowISO()) as RawMemoryRow[];
  }

  async deleteMemory(id: number): Promise<void> {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  async deleteAllMemories(userId: string, namespace: string): Promise<void> {
    this.db.prepare(
      'DELETE FROM memories WHERE user_id = ? AND namespace = ?'
    ).run(userId, namespace);
  }

  async listMemories(
    userId: string,
    namespace: string,
    limit: number,
  ): Promise<RawMemoryRow[]> {
    const stmt = this.db.prepare(`
      SELECT id, user_id, namespace, content, embedding, created_at, expires_at, tags, recall_count
      FROM memories
      WHERE user_id = ? AND namespace = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
      LIMIT ?
    `);

    return stmt.all(userId, namespace, nowISO(), limit) as RawMemoryRow[];
  }

  async pruneExpired(userId: string): Promise<void> {
    this.db.prepare(
      'DELETE FROM memories WHERE user_id = ? AND expires_at IS NOT NULL AND expires_at <= ?'
    ).run(userId, nowISO());
  }

  // ─── New Methods (v1.1.0) ─────────────────────────────────────────────

  async getMemoryById(id: number): Promise<RawMemoryRow | null> {
    const row = this.db.prepare(`
      SELECT id, user_id, namespace, content, embedding, created_at, expires_at, tags, recall_count
      FROM memories WHERE id = ?
    `).get(id) as RawMemoryRow | undefined;

    return row ?? null;
  }

  async updateMemory(id: number, params: UpdateMemoryParams): Promise<void> {
    this.db.prepare(`
      UPDATE memories
      SET content = ?, embedding = ?, tags = ?
      WHERE id = ?
    `).run(
      params.content,
      JSON.stringify(params.embedding),
      JSON.stringify(params.tags ?? []),
      id,
    );
  }

  async incrementRecallCount(ids: number[]): Promise<void> {
    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(
      `UPDATE memories SET recall_count = COALESCE(recall_count, 0) + 1 WHERE id IN (${placeholders})`
    ).run(...ids);
  }

  async getAllMemories(userId: string): Promise<RawMemoryRow[]> {
    return this.db.prepare(`
      SELECT id, user_id, namespace, content, embedding, created_at, expires_at, tags, recall_count
      FROM memories
      WHERE user_id = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
    `).all(userId, nowISO()) as RawMemoryRow[];
  }

  async listNamespaces(userId: string): Promise<string[]> {
    const rows = this.db.prepare(
      'SELECT DISTINCT namespace FROM memories WHERE user_id = ?'
    ).all(userId) as Array<{ namespace: string }>;

    return rows.map(r => r.namespace);
  }

  async getStats(userId: string): Promise<AdapterStats> {
    const now = nowISO();

    // Total live memories
    const countRow = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM memories
      WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)
    `).get(userId, now) as { cnt: number };

    // Oldest / Newest
    const dateRow = this.db.prepare(`
      SELECT MIN(created_at) as oldest, MAX(created_at) as newest
      FROM memories
      WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)
    `).get(userId, now) as { oldest: string | null; newest: string | null };

    // Most recalled
    const recalledRow = this.db.prepare(`
      SELECT content, COALESCE(recall_count, 0) as rc
      FROM memories
      WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY rc DESC LIMIT 1
    `).get(userId, now) as { content: string; rc: number } | undefined;

    // Dead jobs
    const deadRow = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM pending_memories
      WHERE user_id = ? AND status = 'dead'
    `).get(userId) as { cnt: number };

    // Namespace counts
    const nsRows = this.db.prepare(`
      SELECT namespace, COUNT(*) as cnt FROM memories
      WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)
      GROUP BY namespace
    `).all(userId, now) as Array<{ namespace: string; cnt: number }>;

    const namespaceCounts: Record<string, number> = {};
    for (const r of nsRows) {
      namespaceCounts[r.namespace] = r.cnt;
    }

    // Storage size via PRAGMA
    const pageCount = (this.db.pragma('page_count') as Array<{ page_count: number }>)[0]?.page_count ?? 0;
    const pageSize = (this.db.pragma('page_size') as Array<{ page_size: number }>)[0]?.page_size ?? 0;
    const storageSizeKB = Math.round((pageCount * pageSize) / 1024);

    return {
      totalMemories: countRow.cnt,
      oldestDate: dateRow.oldest,
      newestDate: dateRow.newest,
      mostRecalled: recalledRow && recalledRow.rc > 0
        ? { content: recalledRow.content, recallCount: recalledRow.rc }
        : null,
      deadJobCount: deadRow.cnt,
      namespaceCounts,
      storageSizeKB,
    };
  }

  async bulkInsertMemories(memories: InsertMemoryParams[]): Promise<number[]> {
    const stmt = this.db.prepare(`
      INSERT INTO memories (user_id, namespace, content, embedding, created_at, expires_at, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const ids: number[] = [];
    const insertAll = this.db.transaction(() => {
      for (const mem of memories) {
        const result = stmt.run(
          mem.userId,
          mem.namespace,
          mem.content,
          JSON.stringify(mem.embedding),
          mem.createdAt,
          mem.expiresAt,
          JSON.stringify(mem.tags ?? []),
        );
        ids.push(Number(result.lastInsertRowid));
      }
    });

    insertAll();
    return ids;
  }

  // ─── Queue Operations ──────────────────────────────────────────────────

  async enqueue(job: NewJob): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO pending_memories (user_id, namespace, content, status, max_attempts, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `);

    const result = stmt.run(
      job.userId,
      job.namespace,
      job.content,
      job.maxAttempts,
      nowISO(),
    );

    return Number(result.lastInsertRowid);
  }

  async markProcessing(jobId: number): Promise<void> {
    this.db.prepare(
      "UPDATE pending_memories SET status = 'processing' WHERE id = ?"
    ).run(jobId);
  }

  async markDone(jobId: number): Promise<void> {
    this.db.prepare(
      "UPDATE pending_memories SET status = 'done' WHERE id = ?"
    ).run(jobId);
  }

  async markFailed(jobId: number, error: string): Promise<void> {
    // Atomically increment attempts and decide on status
    const job = this.db.prepare(
      'SELECT attempts, max_attempts FROM pending_memories WHERE id = ?'
    ).get(jobId) as { attempts: number; max_attempts: number } | undefined;

    if (!job) return;

    const newAttempts = job.attempts + 1;
    const isDead = newAttempts >= job.max_attempts;
    const newStatus: JobStatus = isDead ? 'dead' : 'failed';
    const nextRetryAt = isDead
      ? null
      : new Date(Date.now() + computeBackoffMs(newAttempts)).toISOString();

    this.db.prepare(`
      UPDATE pending_memories
      SET status = ?, attempts = ?, last_error = ?, next_retry_at = ?
      WHERE id = ?
    `).run(newStatus, newAttempts, error, nextRetryAt, jobId);
  }

  async getRetryable(): Promise<MemoryJob[]> {
    const now = nowISO();
    const rows = this.db.prepare(`
      SELECT id, user_id, namespace, content, status, attempts,
             max_attempts, last_error, created_at, next_retry_at
      FROM pending_memories
      WHERE status IN ('pending', 'failed')
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
    `).all(now) as Array<{
      id: number;
      user_id: string;
      namespace: string;
      content: string;
      status: JobStatus;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
      created_at: string;
      next_retry_at: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      namespace: row.namespace,
      content: row.content,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      nextRetryAt: row.next_retry_at,
    }));
  }

  async getDeadJobs(userId: string): Promise<MemoryJob[]> {
    const rows = this.db.prepare(`
      SELECT id, user_id, namespace, content, status, attempts,
             max_attempts, last_error, created_at, next_retry_at
      FROM pending_memories
      WHERE user_id = ? AND status = 'dead'
    `).all(userId) as Array<{
      id: number;
      user_id: string;
      namespace: string;
      content: string;
      status: JobStatus;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
      created_at: string;
      next_retry_at: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      namespace: row.namespace,
      content: row.content,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      nextRetryAt: row.next_retry_at,
    }));
  }

  async resetStaleProcessing(): Promise<void> {
    // Jobs stuck in 'processing' from a crashed session → reset to 'pending'
    this.db.prepare(
      "UPDATE pending_memories SET status = 'pending' WHERE status = 'processing'"
    ).run();
  }

  async cleanupDoneJobs(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.db.prepare(
      "DELETE FROM pending_memories WHERE status = 'done' AND created_at < ?"
    ).run(cutoff);

    return result.changes;
  }

  async retryDeadJob(jobId: number): Promise<void> {
    this.db.prepare(`
      UPDATE pending_memories
      SET status = 'pending', attempts = 0, last_error = NULL, next_retry_at = NULL
      WHERE id = ? AND status = 'dead'
    `).run(jobId);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
