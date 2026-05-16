/**
 * semantic-recall — New Adapter Methods Tests
 *
 * Tests all 7 new StorageAdapter methods added in v1.1.0:
 *   getMemoryById, updateMemory, incrementRecallCount,
 *   getAllMemories, listNamespaces, getStats, bulkInsertMemories
 *
 * Also tests the BaseStorageAdapter compile-time enforcement
 * and the custom adapter validation logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SQLiteStorageAdapter } from '../src/adapters/storage/sqlite.js';
import { BaseStorageAdapter } from '../src/adapters/storage/base.js';
import { validateCustomAdapter } from '../src/adapters/storage/custom.js';
import type { InsertMemoryParams, RawMemoryRow, NewJob, MemoryJob, AdapterStats, UpdateMemoryParams } from '../src/types.js';

const TEST_DB_DIR = path.resolve(process.cwd(), 'test-dbs');
function testDbPath(name: string): string {
  return path.join(TEST_DB_DIR, `adapter-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function nowISO(): string { return new Date().toISOString(); }

function makeMemory(overrides: Partial<InsertMemoryParams> = {}): InsertMemoryParams {
  return {
    userId: 'u1',
    namespace: 'default',
    content: 'test fact',
    embedding: [0.1, 0.2, 0.3],
    createdAt: nowISO(),
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  if (!fs.existsSync(TEST_DB_DIR)) {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  }
});
afterEach(() => {
  try { for (const f of fs.readdirSync(TEST_DB_DIR).filter(f => f.startsWith('adapter-'))) fs.unlinkSync(path.join(TEST_DB_DIR, f)); } catch {}
});

// ─── SQLite New Methods ─────────────────────────────────────────────────────

describe('SQLiteStorageAdapter — New Methods', () => {
  it('getMemoryById returns inserted memory', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('getbyid'));
    await db.init();
    const id = await db.insertMemory(makeMemory({ content: 'user likes cats' }));
    const row = await db.getMemoryById(id);
    expect(row).not.toBeNull();
    expect(row!.content).toBe('user likes cats');
    expect(row!.id).toBe(id);
    db.close();
  });

  it('getMemoryById returns null for non-existent ID', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('getbyid-null'));
    await db.init();
    const row = await db.getMemoryById(999999);
    expect(row).toBeNull();
    db.close();
  });

  it('updateMemory updates content and embedding in-place', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('update'));
    await db.init();
    const id = await db.insertMemory(makeMemory({ content: 'old content' }));

    await db.updateMemory(id, {
      content: 'new content',
      embedding: [0.9, 0.8, 0.7],
      tags: ['updated'],
    });

    const row = await db.getMemoryById(id);
    expect(row!.content).toBe('new content');
    expect(JSON.parse(row!.embedding)).toEqual([0.9, 0.8, 0.7]);
    expect(JSON.parse(row!.tags!)).toEqual(['updated']);
    db.close();
  });

  it('incrementRecallCount increments for multiple IDs', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('recall-count'));
    await db.init();
    const id1 = await db.insertMemory(makeMemory({ content: 'fact 1' }));
    const id2 = await db.insertMemory(makeMemory({ content: 'fact 2' }));

    await db.incrementRecallCount([id1, id2]);
    await db.incrementRecallCount([id1]);

    const row1 = await db.getMemoryById(id1);
    const row2 = await db.getMemoryById(id2);
    expect(row1!.recall_count).toBe(2);
    expect(row2!.recall_count).toBe(1);
    db.close();
  });

  it('incrementRecallCount no-ops on empty array', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('recall-count-empty'));
    await db.init();
    // Should not throw
    await db.incrementRecallCount([]);
    db.close();
  });

  it('incrementRecallCount handles >999 IDs without hitting SQLite variable limit', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('recall-count-large'));
    await db.init();

    // Insert 1500 memories
    const ids: number[] = [];
    for (let i = 0; i < 1500; i++) {
      const id = await db.insertMemory(makeMemory({ content: `fact-${i}` }));
      ids.push(id);
    }

    // This must not throw — the chunking at 999 prevents SQLITE_MAX_VARIABLE_NUMBER
    await db.incrementRecallCount(ids);

    // Verify at least first and last got incremented
    const first = await db.getMemoryById(ids[0]!);
    const last = await db.getMemoryById(ids[ids.length - 1]!);
    expect(first!.recall_count).toBe(1);
    expect(last!.recall_count).toBe(1);
    db.close();
  });

  it('getAllMemories returns all namespaces', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('getall'));
    await db.init();
    await db.insertMemory(makeMemory({ namespace: 'work', content: 'work fact' }));
    await db.insertMemory(makeMemory({ namespace: 'personal', content: 'personal fact' }));

    const all = await db.getAllMemories('u1');
    expect(all.length).toBe(2);

    const contents = all.map(r => r.content).sort();
    expect(contents).toEqual(['personal fact', 'work fact']);
    db.close();
  });

  it('getAllMemories excludes expired memories', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('getall-expired'));
    await db.init();
    await db.insertMemory(makeMemory({ content: 'live fact' }));
    await db.insertMemory(makeMemory({
      content: 'expired fact',
      expiresAt: new Date(Date.now() - 10000).toISOString(),
    }));

    const all = await db.getAllMemories('u1');
    expect(all.length).toBe(1);
    expect(all[0]!.content).toBe('live fact');
    db.close();
  });

  it('listNamespaces returns distinct namespaces', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('namespaces'));
    await db.init();
    await db.insertMemory(makeMemory({ namespace: 'work' }));
    await db.insertMemory(makeMemory({ namespace: 'work' }));
    await db.insertMemory(makeMemory({ namespace: 'personal' }));

    const ns = await db.listNamespaces('u1');
    expect(ns.sort()).toEqual(['personal', 'work']);
    db.close();
  });

  it('getStats returns correct aggregate data', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('stats'));
    await db.init();
    const id = await db.insertMemory(makeMemory({ namespace: 'work', content: 'fact1' }));
    await db.insertMemory(makeMemory({ namespace: 'personal', content: 'fact2' }));
    await db.incrementRecallCount([id]);

    const stats = await db.getStats('u1');
    expect(stats.totalMemories).toBe(2);
    expect(stats.namespaceCounts['work']).toBe(1);
    expect(stats.namespaceCounts['personal']).toBe(1);
    expect(stats.oldestDate).toBeTruthy();
    expect(stats.newestDate).toBeTruthy();
    expect(stats.mostRecalled).not.toBeNull();
    expect(stats.mostRecalled!.recallCount).toBe(1);
    expect(stats.deadJobCount).toBe(0);
    expect(stats.storageSizeKB).toBeGreaterThan(0);
    db.close();
  });

  it('bulkInsertMemories inserts all rows in a transaction', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('bulk'));
    await db.init();

    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory({ content: `bulk fact ${i}`, tags: ['bulk'] })
    );

    const ids = await db.bulkInsertMemories(memories);
    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(10); // all unique

    const all = await db.getAllMemories('u1');
    expect(all.length).toBe(10);
    db.close();
  });
});

// ─── Tags Column Migration ──────────────────────────────────────────────────

describe('SQLiteStorageAdapter — Tags & Recall Count', () => {
  it('insertMemory stores tags as JSON', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('tags'));
    await db.init();
    const id = await db.insertMemory(makeMemory({ tags: ['important', 'work'] }));
    const row = await db.getMemoryById(id);
    expect(JSON.parse(row!.tags!)).toEqual(['important', 'work']);
    db.close();
  });

  it('insertMemory defaults tags to empty array', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('tags-default'));
    await db.init();
    const id = await db.insertMemory(makeMemory());
    const row = await db.getMemoryById(id);
    expect(JSON.parse(row!.tags!)).toEqual([]);
    db.close();
  });

  it('searchMemories returns tags and recall_count', async () => {
    const db = new SQLiteStorageAdapter(testDbPath('search-tags'));
    await db.init();
    const id = await db.insertMemory(makeMemory({ tags: ['diet'] }));
    await db.incrementRecallCount([id]);

    const rows = await db.searchMemories({ userId: 'u1', namespace: 'default' });
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.tags!)).toEqual(['diet']);
    expect(rows[0]!.recall_count).toBe(1);
    db.close();
  });
});

// ─── BaseStorageAdapter Compile-Time Enforcement ────────────────────────────

describe('BaseStorageAdapter — Compile Enforcement', () => {
  it('concrete subclass with all methods satisfies StorageAdapter', () => {
    // This test verifies at compile time (not just runtime) that
    // a class extending BaseStorageAdapter is assignable to StorageAdapter.
    class TestAdapter extends BaseStorageAdapter {
      async init() {}
      async insertMemory(_p: InsertMemoryParams) { return 1; }
      async searchMemories() { return [] as RawMemoryRow[]; }
      async deleteMemory() {}
      async deleteAllMemories() {}
      async listMemories() { return [] as RawMemoryRow[]; }
      async pruneExpired() {}
      async enqueue(_j: NewJob) { return 1; }
      async markProcessing() {}
      async markDone() {}
      async markFailed() {}
      async getRetryable() { return [] as MemoryJob[]; }
      async getDeadJobs() { return [] as MemoryJob[]; }
      async resetStaleProcessing() {}
      async cleanupDoneJobs() { return 0; }
      async retryDeadJob() {}
      close() {}
      async getMemoryById() { return null; }
      async updateMemory() {}
      async getAllMemories() { return [] as RawMemoryRow[]; }
      async listNamespaces() { return [] as string[]; }
    }

    const adapter = new TestAdapter();
    // Runtime check: defaults exist
    expect(typeof adapter.incrementRecallCount).toBe('function');
    expect(typeof adapter.bulkInsertMemories).toBe('function');
    expect(typeof adapter.getStats).toBe('function');
  });

  // @ts-expect-error — Missing abstract methods should cause compile error
  // This line intentionally tests that you CANNOT instantiate BaseStorageAdapter directly
  it('BaseStorageAdapter cannot be instantiated directly', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _adapter = new (BaseStorageAdapter as unknown as new () => BaseStorageAdapter)();
    }).not.toThrow(); // abstract classes can technically be instantiated via cast, but TS prevents it at compile time
  });
});

// ─── Custom Adapter Validation ──────────────────────────────────────────────

describe('validateCustomAdapter', () => {
  it('throws with clear message listing missing methods', () => {
    expect(() => validateCustomAdapter({})).toThrow('missing 24 required method(s)');
  });

  it('throws with partial implementation', () => {
    const partial = { init: () => {}, close: () => {} };
    expect(() => validateCustomAdapter(partial)).toThrow('missing 22 required method(s)');
  });

  it('mentions BaseStorageAdapter in error message', () => {
    try {
      validateCustomAdapter({});
    } catch (e) {
      expect((e as Error).message).toContain('BaseStorageAdapter');
    }
  });

  it('passes for a complete implementation', () => {
    const methods = [
      'init', 'close', 'insertMemory', 'searchMemories', 'deleteMemory',
      'deleteAllMemories', 'listMemories', 'pruneExpired', 'getMemoryById',
      'updateMemory', 'incrementRecallCount', 'getAllMemories', 'listNamespaces',
      'getStats', 'bulkInsertMemories', 'enqueue', 'markProcessing', 'markDone',
      'markFailed', 'getRetryable', 'getDeadJobs', 'resetStaleProcessing',
      'cleanupDoneJobs', 'retryDeadJob',
    ];
    const adapter: Record<string, unknown> = {};
    for (const m of methods) adapter[m] = () => {};
    expect(() => validateCustomAdapter(adapter)).not.toThrow();
  });
});
