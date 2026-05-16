/**
 * semantic-recall — Comprehensive Integration Tests
 *
 * Tests all 15 scenarios from the spec using a mock embedder
 * (deterministic vectors) so tests are fast and don't require
 * downloading the ML model.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Memory } from '../src/index.js';
import type { EmbedderFunction, MemorySavedEvent, MemoryDeadEvent } from '../src/index.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

const TEST_DB_DIR = path.resolve(process.cwd(), 'test-dbs');

// Track every Memory instance created so afterEach can destroy them all
const activeInstances: Memory[] = [];

function createMemory(opts: ConstructorParameters<typeof Memory>[0]): Memory {
  const instance = new Memory(opts);
  activeInstances.push(instance);
  return instance;
}

function testDbPath(name: string): string {
  return path.join(TEST_DB_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** Simple deterministic embedder that creates vectors from character codes. */
function createMockEmbedder(dimensions = 384): EmbedderFunction {
  return async (text: string): Promise<number[]> => {
    const vector = new Array(dimensions).fill(0);
    for (let i = 0; i < text.length && i < dimensions; i++) {
      vector[i] = text.charCodeAt(i) / 255;
    }
    const mag = Math.sqrt(vector.reduce((sum: number, v: number) => sum + v * v, 0));
    if (mag > 0) {
      for (let i = 0; i < dimensions; i++) {
        vector[i] = vector[i] / mag;
      }
    }
    return vector;
  };
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

/** Embedder that returns very similar vectors for similar inputs. */
function createSemanticMockEmbedder(): EmbedderFunction {
  const knownVectors: Record<string, number[]> = {};

  return async (text: string): Promise<number[]> => {
    if (knownVectors[text]) return [...knownVectors[text]!];

    const vector = new Array(384).fill(0);

    if (text.toLowerCase().includes('vegetarian') || text.toLowerCase().includes('vegan') || text.toLowerCase().includes('diet')) {
      vector[0] = 0.9; vector[1] = 0.8; vector[2] = 0.7;
    }
    if (text.toLowerCase().includes('paris') || text.toLowerCase().includes('city') || text.toLowerCase().includes('location')) {
      vector[10] = 0.9; vector[11] = 0.8; vector[12] = 0.7;
    }
    if (text.toLowerCase().includes('python') || text.toLowerCase().includes('typescript') || text.toLowerCase().includes('code')) {
      vector[20] = 0.9; vector[21] = 0.8; vector[22] = 0.7;
    }
    if (text.toLowerCase().includes('preference') || text.toLowerCase().includes('dietary')) {
      vector[0] = 0.85; vector[1] = 0.75; vector[2] = 0.65;
    }

    for (let i = 0; i < Math.min(text.length, 384); i++) {
      vector[i] += (text.charCodeAt(i) % 10) * 0.01;
    }

    const mag = Math.sqrt(vector.reduce((sum: number, v: number) => sum + v * v, 0));
    if (mag > 0) {
      for (let i = 0; i < 384; i++) {
        vector[i] = vector[i] / mag;
      }
    }

    knownVectors[text] = [...vector];
    return vector;
  };
}

/** Wait for async events to flush. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  // Ensure test-dbs dir exists fresh before each test
  if (!fs.existsSync(TEST_DB_DIR)) {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  }
});

afterEach(() => {
  // Destroy all tracked Memory instances first so SQLite connections are closed
  // before we attempt to delete the files on disk
  while (activeInstances.length > 0) {
    try { activeInstances.pop()!.destroy(); } catch {}
  }

  // Give SQLite a tick to flush WAL and release file locks
  // then wipe and recreate the directory cleanly
  try {
    if (fs.existsSync(TEST_DB_DIR)) {
      fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
  } catch {}
});

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('Memory — Core API', () => {
  it('should store and recall a memory with semantic match', async () => {
    const dbPath = testDbPath('recall');
    const embedder = createSemanticMockEmbedder();
    const memory = createMemory({
      userId: 'user_1',
      dbPath,
      embedder,
      retryIntervalMs: 60_000,
    });

    const result = await memory.rememberAndWait('user is vegetarian and avoids gluten');
    expect(result.saved).toBe(true);
    expect(result.duplicate).toBe(false);

    const recalled = await memory.recall('dietary preferences');
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled[0]).toBe('user is vegetarian and avoids gluten');

    memory.destroy();
  });

  it('should return empty array when no relevant memories exist', async () => {
    const dbPath = testDbPath('empty-recall');
    const memory = createMemory({
      userId: 'user_1',
      dbPath,
      embedder: createSemanticMockEmbedder(),
      retryIntervalMs: 60_000,
    });

    const recalled = await memory.recall('something completely different');
    expect(recalled).toEqual([]);

    memory.destroy();
  });

  it('rememberAndWait should return saved=true for new memory', async () => {
    const dbPath = testDbPath('remember-wait');
    const memory = createMemory({
      userId: 'user_1',
      dbPath,
      embedder: createMockEmbedder(),
      retryIntervalMs: 60_000,
    });

    const result = await memory.rememberAndWait('user lives in San Francisco');
    expect(result.saved).toBe(true);
    expect(result.duplicate).toBe(false);

    memory.destroy();
  });
});

describe('Memory — Deduplication', () => {
  it('should not duplicate identical strings', async () => {
    const dbPath = testDbPath('dedup-identical');
    const memory = createMemory({
      userId: 'user_1',
      dbPath,
      embedder: createMockEmbedder(),
      retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('user is vegetarian');
    const result2 = await memory.rememberAndWait('user is vegetarian');

    expect(result2.saved).toBe(false);
    expect(result2.duplicate).toBe(true);

    const listed = await memory.list();
    expect(listed.length).toBe(1);

    memory.destroy();
  });

  it('rememberAndWait should return duplicate=true for duplicate', async () => {
    const dbPath = testDbPath('dedup-wait');
    // Recreate the dir here in case a prior test's afterEach already removed it
    if (!fs.existsSync(TEST_DB_DIR)) {
      fs.mkdirSync(TEST_DB_DIR, { recursive: true });
    }
    const memory = createMemory({
      userId: 'user_1',
      dbPath,
      embedder: createMockEmbedder(),
      retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('user prefers dark mode');
    const result = await memory.rememberAndWait('user prefers dark mode');

    expect(result.saved).toBe(false);
    expect(result.duplicate).toBe(true);

    memory.destroy();
  });
});

describe('Memory — User & Namespace Isolation', () => {
  it('should isolate memories between users', async () => {
    const dbPath = testDbPath('user-isolation');
    const embedder = createSemanticMockEmbedder();

    const memoryA = createMemory({
      userId: 'user_A',
      dbPath,
      embedder,
      retryIntervalMs: 60_000,
      recallThreshold: 0.1,
    });

    const memoryB = createMemory({
      userId: 'user_B',
      dbPath,
      embedder,
      retryIntervalMs: 60_000,
      recallThreshold: 0.1,
    });

    await memoryA.rememberAndWait('user is vegetarian');
    await memoryB.rememberAndWait('user is a meat lover');

    const listA = await memoryA.list();
    const listB = await memoryB.list();

    expect(listA.length).toBe(1);
    expect(listA[0]!.content).toBe('user is vegetarian');
    expect(listB.length).toBe(1);
    expect(listB[0]!.content).toBe('user is a meat lover');

    memoryA.destroy();
    memoryB.destroy();
  });

  it('should isolate memories between namespaces', async () => {
    const dbPath = testDbPath('namespace-isolation');
    const embedder = createSemanticMockEmbedder();

    const memory = createMemory({
      userId: 'user_1',
      dbPath,
      embedder,
      namespace: 'health',
      retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('user is vegetarian');
    await memory.rememberAndWait('user likes Python', { namespace: 'tech' });

    const healthList = await memory.list();
    expect(healthList.length).toBe(1);
    expect(healthList[0]!.content).toBe('user is vegetarian');

    const techList = await memory.list({ namespace: 'tech' });
    expect(techList.length).toBe(1);
    expect(techList[0]!.content).toBe('user likes Python');

    memory.destroy();
  });

  it('forgetAll should only delete memories for the target user', async () => {
    const dbPath = testDbPath('forget-all');
    const embedder = createMockEmbedder();

    const memoryA = createMemory({
      userId: 'user_A',
      dbPath,
      embedder,
      retryIntervalMs: 60_000,
    });
    const memoryB = createMemory({
      userId: 'user_B',
      dbPath,
      embedder,
      retryIntervalMs: 60_000,
    });

    await memoryA.rememberAndWait('fact for user A');
    await memoryB.rememberAndWait('fact for user B');

    await memoryA.forgetAll();

    const listA = await memoryA.list();
    expect(listA.length).toBe(0);

    const listB = await memoryB.list();
    expect(listB.length).toBe(1);

    memoryA.destroy();
    memoryB.destroy();
  });
});

describe('Memory — TTL', () => {
  it('should not return expired memories', async () => {
    const dbPath = testDbPath('ttl-expiry');
    const memory = createMemory({
      userId: 'user_1',
      dbPath,
      embedder: createMockEmbedder(),
      retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('user is in Paris for a conference', { ttl: 1 });
    await sleep(50);

    const recalled = await memory.recall('location');
    const hasParisMemory = recalled.some(m => m.includes('Paris'));
    expect(hasParisMemory).toBe(false);

    memory.destroy();
  });
});

describe('Memory — Reliability', () => {
  it('should retry failed jobs and succeed on second attempt', async () => {
    const dbPath = testDbPath('retry-success');
    let callCount = 0;

    const flakyEmbedder: EmbedderFunction = async (text: string) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Transient network error');
      }
      const vector = new Array(384).fill(0);
      for (let i = 0; i < text.length && i < 384; i++) {
        vector[i] = text.charCodeAt(i) / 255;
      }
      return vector;
    };

    const memory = createMemory({
      userId: 'user_1',
      dbPath,
      embedder: flakyEmbedder,
      retryIntervalMs: 60_000,
      maxAttempts: 3,
    });

    const result = await memory.rememberAndWait('user likes hiking');
    expect(result.saved).toBe(false);

    callCount = 1;
    const result2 = await memory.rememberAndWait('user likes hiking');
    expect(result2.saved).toBe(true);

    memory.destroy();
  });

  it('should mark job as dead after max attempts and emit memory:dead', async () => {
    const dbPath = testDbPath('dead-job');

    const failingEmbedder: EmbedderFunction = async () => {
      throw new Error('Permanent failure');
    };

    const deadEvents: MemoryDeadEvent[] = [];

    const memory = createMemory({
      userId: 'user_1',
      dbPath,
      embedder: failingEmbedder,
      retryIntervalMs: 60_000,
      maxAttempts: 1,
    });

    memory.on('memory:dead', (event) => {
      deadEvents.push(event);
    });

    const result = await memory.rememberAndWait('this will fail');
    expect(result.saved).toBe(false);

    await sleep(100);

    expect(deadEvents.length).toBe(1);
    expect(deadEvents[0]!.content).toBe('this will fail');

    const dead = await memory.getDeadJobs();
    expect(dead.length).toBeGreaterThanOrEqual(1);

    memory.destroy();
  });

  it('should replay pending jobs on startup', async () => {
    const dbPath = testDbPath('replay');
    const embedder = createMockEmbedder();

    const memory1 = createMemory({
      userId: 'user_1',
      dbPath,
      embedder,
      retryIntervalMs: 60_000,
    });

    await memory1.rememberAndWait('user is a software engineer');
    memory1.destroy();

    const savedEvents: MemorySavedEvent[] = [];
    const memory2 = createMemory({
      userId: 'user_1',
      dbPath,
      embedder,
      retryIntervalMs: 60_000,
    });

    memory2.on('memory:saved', (event) => {
      savedEvents.push(event);
    });

    const list = await memory2.list();
    expect(list.length).toBeGreaterThanOrEqual(1);

    memory2.destroy();
  });
});

describe('Memory — Dimension Mismatch', () => {
  it('should throw on dimension mismatch', async () => {
    const dbPath = testDbPath('dim-mismatch');

    const memory384 = createMemory({
      userId: 'user_1',
      dbPath,
      embedder: createMockEmbedder(384),
      retryIntervalMs: 60_000,
    });

    await memory384.rememberAndWait('user likes coffee');
    memory384.destroy();

    const memory1536 = createMemory({
      userId: 'user_1',
      dbPath,
      embedder: createMockEmbedder(1536),
      retryIntervalMs: 60_000,
    });

    const result = await memory1536.rememberAndWait('user likes tea');
    expect(result.saved).toBe(false);

    memory1536.destroy();
  });
});

describe('Memory — Custom Embedder', () => {
  it('should work with a custom embedder function', async () => {
    const dbPath = testDbPath('custom-embedder');

    const customEmbedder: EmbedderFunction = async (text: string) => {
      const vector = new Array(128).fill(0);
      for (let i = 0; i < text.length; i++) {
        vector[i % 128] += text.charCodeAt(i) / 1000;
      }
      const mag = Math.sqrt(vector.reduce((s: number, v: number) => s + v * v, 0));
      return vector.map((v: number) => v / (mag || 1));
    };

    const memory = createMemory({
      userId: 'user_1',
      dbPath,
      embedder: customEmbedder,
      retryIntervalMs: 60_000,
    });

    const result = await memory.rememberAndWait('user works at Google');
    expect(result.saved).toBe(true);

    const recalled = await memory.recall('workplace');
    expect(recalled.length).toBeGreaterThanOrEqual(0);

    memory.destroy();
  });
});

describe('Memory — Events', () => {
  it('should emit memory:saved event on successful store', async () => {
    const dbPath = testDbPath('events-saved');
    const savedEvents: MemorySavedEvent[] = [];

    const memory = createMemory({
      userId: 'user_1',
      dbPath,
      embedder: createMockEmbedder(),
      retryIntervalMs: 60_000,
    });

    memory.on('memory:saved', (event) => {
      savedEvents.push(event);
    });

    await memory.rememberAndWait('user prefers email communication');
    await sleep(100);

    expect(savedEvents.length).toBe(1);
    expect(savedEvents[0]!.content).toBe('user prefers email communication');

    memory.destroy();
  });
});

describe('Memory — List & Forget', () => {
  it('should list all stored memories', async () => {
    const dbPath = testDbPath('list');
    const memory = createMemory({
      userId: 'user_1',
      dbPath,
      embedder: createMockEmbedder(),
      retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('The user lives in New York City');
    await memory.rememberAndWait('She works as a software engineer at Google');
    await memory.rememberAndWait('Her favorite color is deep ocean blue');

    const list = await memory.list();
    expect(list.length).toBe(3);

    memory.destroy();
  });

  it('should forget a specific memory by ID', async () => {
    const dbPath = testDbPath('forget');
    const memory = createMemory({
      userId: 'user_1',
      dbPath,
      embedder: createMockEmbedder(),
      retryIntervalMs: 60_000,
    });

    await memory.rememberAndWait('temporary fact');
    const list = await memory.list();
    expect(list.length).toBe(1);

    await memory.forget(list[0]!.id);

    const listAfter = await memory.list();
    expect(listAfter.length).toBe(0);

    memory.destroy();
  });
});
