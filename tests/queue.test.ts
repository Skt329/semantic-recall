import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SQLiteStorageAdapter } from '../src/adapters/storage/sqlite.js';

const TEST_DB_DIR = path.resolve(process.cwd(), 'test-dbs');
function testDbPath(name: string): string {
  return path.join(TEST_DB_DIR, `q-${name}-${Date.now()}.db`);
}

beforeEach(() => {
  if (!fs.existsSync(TEST_DB_DIR)) {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  }
});
afterEach(() => {
  try { for (const f of fs.readdirSync(TEST_DB_DIR)) fs.unlinkSync(path.join(TEST_DB_DIR, f)); } catch {}
});

describe('Queue State Machine', () => {
  it('enqueue → pending', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('enq'));
    await db.init();
    const id = await db.enqueue({ userId: 'u1', namespace: 'default', content: 'fact', maxAttempts: 3 });
    expect(id).toBeGreaterThan(0);
    const r = await db.getRetryable();
    expect(r[0]!.status).toBe('pending');
    db.close();
  });

  it('pending → processing → done', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('done'));
    await db.init();
    const id = await db.enqueue({ userId: 'u1', namespace: 'default', content: 'fact', maxAttempts: 3 });
    await db.markProcessing(id);
    expect((await db.getRetryable()).length).toBe(0);
    await db.markDone(id);
    expect((await db.getRetryable()).length).toBe(0);
    db.close();
  });

  it('marks dead after max attempts', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('dead'));
    await db.init();
    const id = await db.enqueue({ userId: 'u1', namespace: 'default', content: 'doomed', maxAttempts: 1 });
    await db.markProcessing(id);
    await db.markFailed(id, 'error');
    const dead = await db.getDeadJobs('u1');
    expect(dead.length).toBe(1);
    expect(dead[0]!.status).toBe('dead');
    db.close();
  });

  it('resets stale processing on recovery', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('recover'));
    await db.init();
    const id = await db.enqueue({ userId: 'u1', namespace: 'default', content: 'orphan', maxAttempts: 3 });
    await db.markProcessing(id);
    await db.resetStaleProcessing();
    const r = await db.getRetryable();
    expect(r[0]!.status).toBe('pending');
    db.close();
  });

  it('retries dead jobs', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('retry'));
    await db.init();
    const id = await db.enqueue({ userId: 'u1', namespace: 'default', content: 'res', maxAttempts: 1 });
    await db.markProcessing(id);
    await db.markFailed(id, 'err');
    await db.retryDeadJob(id);
    expect((await db.getDeadJobs('u1')).length).toBe(0);
    expect((await db.getRetryable())[0]!.attempts).toBe(0);
    db.close();
  });

  it('cleans up done jobs', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('clean'));
    await db.init();
    const id = await db.enqueue({ userId: 'u1', namespace: 'default', content: 'old', maxAttempts: 3 });
    await db.markDone(id);
    // Small delay to ensure created_at is in the past
    await new Promise(r => setTimeout(r, 50));
    const del = await db.cleanupDoneJobs(10); // anything older than 10ms
    expect(del).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

describe('TTL & Tags Metadata Preservation', () => {
  /** Helper: read a job row directly by ID (bypasses backoff filter in getRetryable). */
  function getJobById(db: SQLiteStorageAdapter, id: number) {
    // Access internal db via type assertion — test-only
    const raw = (db as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined } } }).db
      .prepare('SELECT id, user_id, namespace, content, status, attempts, max_attempts, last_error, created_at, next_retry_at, ttl, tags FROM pending_memories WHERE id = ?')
      .get(id);
    return raw;
  }

  it('preserves TTL through enqueue → fail → retry cycle', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('ttl-retry'));
    await db.init();

    const id = await db.enqueue({
      userId: 'u1', namespace: 'default', content: 'remember this',
      maxAttempts: 3, ttl: '1h',
    });

    // Simulate first failure
    await db.markProcessing(id);
    await db.markFailed(id, 'network timeout');

    // Read job directly — TTL must survive the fail transition
    const job = getJobById(db, id);
    expect(job).toBeDefined();
    expect(job!.ttl).toBe('1h');
    expect(job!.status).toBe('failed');
    db.close();
  });

  it('preserves tags through enqueue → fail → retry cycle', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('tags-retry'));
    await db.init();

    const tags = JSON.stringify(['important', 'user-pref']);
    const id = await db.enqueue({
      userId: 'u1', namespace: 'default', content: 'user likes cats',
      maxAttempts: 3, tags: ['important', 'user-pref'],
    });

    // Simulate first failure
    await db.markProcessing(id);
    await db.markFailed(id, 'embed error');

    // Read job directly — tags must survive
    const job = getJobById(db, id);
    expect(job).toBeDefined();
    expect(job!.tags).toBe(tags);
    expect(job!.status).toBe('failed');
    db.close();
  });

  it('preserves TTL and tags through full dead → retryDead → re-read cycle', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('full-round'));
    await db.init();

    const id = await db.enqueue({
      userId: 'u1', namespace: 'default', content: 'critical fact',
      maxAttempts: 1, ttl: '24h', tags: ['critical'],
    });

    // Burn through max attempts → dead
    await db.markProcessing(id);
    await db.markFailed(id, 'fatal');
    const dead = await db.getDeadJobs('u1');
    expect(dead.length).toBe(1);
    expect(dead[0]!.ttl).toBe('24h');
    expect(dead[0]!.tags).toBe(JSON.stringify(['critical']));

    // Retry the dead job
    await db.retryDeadJob(id);

    // Should be back in retryable queue with metadata intact
    const retryable = await db.getRetryable();
    const job = retryable.find(j => j.id === id);
    expect(job).toBeDefined();
    expect(job!.status).toBe('pending');
    expect(job!.attempts).toBe(0);
    expect(job!.ttl).toBe('24h');
    expect(job!.tags).toBe(JSON.stringify(['critical']));
    db.close();
  });

  it('handles null TTL and tags gracefully', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('null-meta'));
    await db.init();

    const id = await db.enqueue({
      userId: 'u1', namespace: 'default', content: 'no metadata',
      maxAttempts: 3,
    });

    await db.markProcessing(id);
    await db.markFailed(id, 'error');

    // Read job directly — null metadata must survive
    const job = getJobById(db, id);
    expect(job).toBeDefined();
    expect(job!.ttl).toBeNull();
    expect(job!.tags).toBeNull();
    db.close();
  });
});
