/**
 * semantic-recall — New Feature Integration Tests
 *
 * Tests all new public API methods added in v1.1.0:
 *   update(), related(), rememberMany(), listNamespaces(),
 *   stats(), export(), import(), defaultTtl, tags filtering,
 *   date range filtering, and MemoryResult enrichment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Memory } from '../src/index.js';
import type { EmbedderFunction, ExportData } from '../src/index.js';

const TEST_DB_DIR = path.resolve(process.cwd(), 'test-dbs');
const activeInstances: Memory[] = [];

function createMemory(opts: ConstructorParameters<typeof Memory>[0]): Memory {
  const instance = new Memory(opts);
  activeInstances.push(instance);
  return instance;
}

function testDbPath(name: string): string {
  return path.join(TEST_DB_DIR, `feat-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function createMockEmbedder(dimensions = 384): EmbedderFunction {
  return async (text: string): Promise<number[]> => {
    const vector = new Array(dimensions).fill(0);
    for (let i = 0; i < text.length && i < dimensions; i++) {
      vector[i] = text.charCodeAt(i) / 255;
    }
    const mag = Math.sqrt(vector.reduce((sum: number, v: number) => sum + v * v, 0));
    if (mag > 0) for (let i = 0; i < dimensions; i++) vector[i] /= mag;
    return vector;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

beforeEach(() => {
  if (!fs.existsSync(TEST_DB_DIR)) {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  }
});
afterEach(() => {
  while (activeInstances.length > 0) {
    try { activeInstances.pop()!.destroy(); } catch {}
  }
});

// ─── update() ───────────────────────────────────────────────────────────────

describe('Memory — update()', () => {
  it('should update content and re-embed', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('update'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('user likes coffee');
    const list1 = await memory.list();
    expect(list1.length).toBe(1);

    await memory.update(list1[0]!.id, 'user likes tea');

    const list2 = await memory.list();
    expect(list2.length).toBe(1);
    expect(list2[0]!.content).toBe('user likes tea');
    // Same ID — in-place update
    expect(list2[0]!.id).toBe(list1[0]!.id);
  });

  it('should update tags via update()', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('update-tags'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('user likes Python');
    const list = await memory.list();

    await memory.update(list[0]!.id, 'user likes Python', ['tech', 'language']);

    const list2 = await memory.list();
    expect(list2[0]!.tags).toEqual(['tech', 'language']);
  });
});

// ─── rememberMany() ─────────────────────────────────────────────────────────

describe('Memory — rememberMany()', () => {
  it('should store multiple memories with partial failure resilience', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('many'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    // Texts must start with different characters and have different lengths
    // to produce low cosine similarity with the charCode mock embedder
    const result = await memory.rememberMany([
      'AAAA the capital of France is Paris',
      '9999 quantum physics explains duality',
      'zzzz zebras have stripes on the plains of Africa near the equator region',
    ]);

    expect(result.total).toBe(3);
    expect(result.saved).toBe(3);
    expect(result.duplicates).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('should report duplicates in batch', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('many-dedup'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('the capital of France is Paris');

    const result = await memory.rememberMany([
      'the capital of France is Paris', // exact duplicate text — will be caught
      'quantum physics explains subatomic particles', // completely different — new
    ]);

    expect(result.total).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.saved).toBe(1);
  });
});

// ─── Tags Filtering ─────────────────────────────────────────────────────────

describe('Memory — Tags', () => {
  it('should store and retrieve memories with tags', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('tags-store'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('user is vegetarian', { tags: ['diet', 'health'] });
    const list = await memory.list();
    expect(list[0]!.tags).toEqual(['diet', 'health']);
  });

  it('should filter recall by tags (AND logic)', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('tags-filter'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
      recallThreshold: 0.01, // low threshold to ensure all match semantically
    });

    await memory.rememberAndWait('user eats salad daily', { tags: ['diet'] });
    await memory.rememberAndWait('user codes in Python', { tags: ['tech'] });
    await memory.rememberAndWait('user is health-conscious coder', { tags: ['diet', 'tech'] });

    const dietOnly = await memory.recallDetailed('user habits', { tags: ['diet'] });
    const dietContents = dietOnly.map(r => r.content);
    expect(dietContents).toContain('user eats salad daily');
    expect(dietContents).toContain('user is health-conscious coder');
    expect(dietContents).not.toContain('user codes in Python');

    const both = await memory.recallDetailed('user habits', { tags: ['diet', 'tech'] });
    expect(both.length).toBe(1);
    expect(both[0]!.content).toBe('user is health-conscious coder');
  });
});

// ─── Date Range Filtering ───────────────────────────────────────────────────

describe('Memory — Date Filters', () => {
  it('should filter by after date', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('date-after'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
      recallThreshold: 0.01,
    });

    await memory.rememberAndWait('the quick brown fox jumps over the lazy dog');
    await sleep(100);
    const cutoff = new Date().toISOString();
    await sleep(100);
    await memory.rememberAndWait('the quick brown fox jumps over the lazy dog again today');

    const results = await memory.recallDetailed('the quick brown fox', { after: cutoff });
    const contents = results.map(r => r.content);
    expect(contents).toContain('the quick brown fox jumps over the lazy dog again today');
    expect(contents).not.toContain('the quick brown fox jumps over the lazy dog');
  });
});

// ─── defaultTtl ─────────────────────────────────────────────────────────────

describe('Memory — defaultTtl', () => {
  it('should apply defaultTtl to all memories', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('default-ttl'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
      defaultTtl: 1, // 1ms — will expire immediately
    });

    await memory.rememberAndWait('ephemeral fact');
    await sleep(50);

    const list = await memory.list();
    expect(list.length).toBe(0);
  });

  it('should allow per-call ttl to override defaultTtl', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('override-ttl'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
      defaultTtl: 1, // 1ms default
    });

    // Override with a long TTL
    await memory.rememberAndWait('permanent fact', { ttl: '1h' });
    await sleep(50);

    const list = await memory.list();
    expect(list.length).toBe(1);
  });
});

// ─── listNamespaces() ───────────────────────────────────────────────────────

describe('Memory — listNamespaces()', () => {
  it('should list all namespaces for user', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('list-ns'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('fact in default');
    await memory.rememberAndWait('fact in work', { namespace: 'work' });
    await memory.rememberAndWait('fact in personal', { namespace: 'personal' });

    const ns = await memory.listNamespaces();
    expect(ns.sort()).toEqual(['default', 'personal', 'work']);
  });
});

// ─── stats() ────────────────────────────────────────────────────────────────

describe('Memory — stats()', () => {
  it('should return correct aggregate stats', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('stats'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('the capital of France is Paris and it has the Eiffel Tower');
    await memory.rememberAndWait('quantum physics explains wave-particle duality in subatomic systems');

    const stats = await memory.stats();
    expect(stats.totalMemories).toBe(2);
    expect(stats.deadJobCount).toBe(0);
    expect(stats.storageSizeKB).toBeGreaterThan(0);
    expect(stats.oldestDate).toBeTruthy();
    expect(stats.newestDate).toBeTruthy();
  });
});

// ─── related() ──────────────────────────────────────────────────────────────

describe('Memory — related()', () => {
  it('should find related memories excluding the source', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('related'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
      recallThreshold: 0.01,
    });

    await memory.rememberAndWait('user likes cats');
    await memory.rememberAndWait('user likes cats and dogs');
    await memory.rememberAndWait('user works at NASA');

    const list = await memory.list();
    const catMemory = list.find(m => m.content === 'user likes cats')!;

    const related = await memory.related(catMemory.id, { threshold: 0.01 });
    // Should not include self
    expect(related.every(r => r.id !== catMemory.id)).toBe(true);
    // Should include at least one other memory
    expect(related.length).toBeGreaterThan(0);
  });

  it('should throw for non-existent memory ID', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('related-404'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    await expect(memory.related(999999)).rejects.toThrow('not found');
  });
});

// ─── export() / import() ────────────────────────────────────────────────────

describe('Memory — export/import', () => {
  it('should round-trip export and import', async () => {
    const dbPath1 = testDbPath('export');
    const memory1 = createMemory({
      userId: 'u1', dbPath: dbPath1,
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    await memory1.rememberAndWait('the capital of France is Paris and it has the Eiffel Tower');
    await memory1.rememberAndWait('quantum physics explains wave-particle duality in subatomic systems');

    const exported = await memory1.export();
    expect(exported.version).toBe(1);
    expect(exported.userId).toBe('u1');
    expect(exported.memories.length).toBe(2);

    // Import into a fresh DB
    const dbPath2 = testDbPath('import');
    const memory2 = createMemory({
      userId: 'u1', dbPath: dbPath2,
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    const result = await memory2.import(exported);
    expect(result.imported).toBe(2);

    const list = await memory2.list();
    expect(list.length).toBe(2);
  });

  it('should reject import with dimension mismatch (empty DB)', async () => {
    // No pre-inserted memories — the check uses the embedder directly
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('import-dim'),
      embedder: createMockEmbedder(384), retryIntervalMs: 60_000,
    });

    const badData: ExportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      userId: 'u1',
      memories: [{
        content: 'foreign fact',
        namespace: 'default',
        embedding: [0.1, 0.2], // wrong dimensions (2 vs 384)
        createdAt: new Date().toISOString(),
        expiresAt: null,
        tags: [],
      }],
    };

    await expect(memory.import(badData)).rejects.toThrow('Dimension mismatch');
  });

  it('should reject unsupported export version', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('import-version'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    const badData = { version: 99, exportedAt: '', userId: 'u1', memories: [] } as ExportData;
    await expect(memory.import(badData)).rejects.toThrow('Unsupported export version');
  });
});

// ─── MemoryResult Enrichment ────────────────────────────────────────────────

describe('Memory — MemoryResult enrichment', () => {
  it('list() should return tags and recallCount', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('enriched'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('user likes tea', { tags: ['food'] });
    const list = await memory.list();
    expect(list[0]!.tags).toEqual(['food']);
    expect(list[0]!.recallCount).toBe(0);
  });

  it('recallDetailed() should return tags and recallCount', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('enriched-recall'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
      recallThreshold: 0.01,
    });

    await memory.rememberAndWait('user likes coffee', { tags: ['beverage'] });
    const results = await memory.recallDetailed('coffee');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.tags).toEqual(['beverage']);
    expect(typeof results[0]!.recallCount).toBe('number');
  });
});

// ─── Custom Adapter Validation via Memory Constructor ───────────────────────

describe('Memory — Custom adapter rejection', () => {
  it('should throw on incomplete custom adapter', () => {
    expect(() => createMemory({
      userId: 'u1',
      storage: { init: () => {} } as any,
      embedder: createMockEmbedder(),
    })).toThrow('missing');
  });
});

// ─── update() existence check ───────────────────────────────────────────────

describe('Memory — update() existence check', () => {
  it('should throw on non-existent memory ID', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('update-404'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    await expect(memory.update(999999, 'new content')).rejects.toThrow('not found');
  });
});

// ─── export() namespace filter ──────────────────────────────────────────────

describe('Memory — export() namespace filter', () => {
  it('should export only the specified namespace', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('export-ns'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('fact in default');
    await memory.rememberAndWait('fact in work', { namespace: 'work' });

    const all = await memory.export();
    expect(all.memories.length).toBe(2);

    const workOnly = await memory.export({ namespace: 'work' });
    expect(workOnly.memories.length).toBe(1);
    expect(workOnly.memories[0]!.content).toBe('fact in work');
  });
});

// ─── Aliases ────────────────────────────────────────────────────────────────

describe('Memory — search aliases', () => {
  it('search() should work as alias for recall()', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('alias-search'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
      recallThreshold: 0.01,
    });

    await memory.rememberAndWait('user likes cats');
    const results = await memory.search('cats');
    expect(results.length).toBeGreaterThan(0);
  });

  it('searchDetailed() should work as alias for recallDetailed()', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('alias-detailed'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
      recallThreshold: 0.01,
    });

    await memory.rememberAndWait('user likes dogs');
    const results = await memory.searchDetailed('dogs');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.similarity).toBeDefined();
  });

  it('search alias should work after destructuring', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('alias-destruct'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
      recallThreshold: 0.01,
    });

    await memory.rememberAndWait('user likes fish');
    const { search } = memory;
    const results = await search('fish');
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─── rememberMany intra-batch dedup ─────────────────────────────────────────

describe('Memory — rememberMany intra-batch dedup', () => {
  it('should deduplicate near-identical texts within a batch', async () => {
    const memory = createMemory({
      userId: 'u1', dbPath: testDbPath('intra-dedup'),
      embedder: createMockEmbedder(), retryIntervalMs: 60_000,
    });

    // Two identical texts in the same batch
    const result = await memory.rememberMany([
      'the capital of France is Paris',
      'the capital of France is Paris',
    ]);

    expect(result.total).toBe(2);
    expect(result.saved).toBe(1);
    expect(result.duplicates).toBe(1);
  });
});
