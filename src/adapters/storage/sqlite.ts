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
  }

  // ─── Memory CRUD ───────────────────────────────────────────────────────

  async insertMemory(params: InsertMemoryParams): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO memories (user_id, namespace, content, embedding, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      params.userId,
      params.namespace,
      params.content,
      JSON.stringify(params.embedding),
      params.createdAt,
      params.expiresAt,
    );

    return Number(result.lastInsertRowid);
  }

  async searchMemories(params: SearchParams): Promise<RawMemoryRow[]> {
    const stmt = this.db.prepare(`
      SELECT id, user_id, namespace, content, embedding, created_at, expires_at
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
      SELECT id, user_id, namespace, content, embedding, created_at, expires_at
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
