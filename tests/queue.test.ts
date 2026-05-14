import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SQLiteStorageAdapter } from '../src/adapters/storage/sqlite.js';

const TEST_DB_DIR = path.resolve(process.cwd(), 'test-dbs');
function testDbPath(name: string): string {
  return path.join(TEST_DB_DIR, `q-${name}-${Date.now()}.db`);
}

beforeEach(() => { fs.mkdirSync(TEST_DB_DIR, { recursive: true }); });
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
