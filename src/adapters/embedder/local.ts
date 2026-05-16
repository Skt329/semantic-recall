/**
 * semantic-recall — Local Embedder Adapter
 *
 * Uses @huggingface/transformers (Transformers.js v3) with the
 * all-MiniLM-L6-v2 model (384 dimensions, ~25MB).
 *
 * Embedding runs in a **persistent** worker_threads Worker to keep the
 * main thread free. The worker is spawned once and reused for all
 * embed calls — the model is loaded on the first message and kept in
 * memory for the lifetime of the process.
 *
 * If the worker crashes, it is automatically respawned on the next
 * embed call, and all pending requests receive rejection errors.
 *
 * This adapter requires zero API keys and zero internet after the
 * initial model download.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { EmbedderFunction, WorkerOutput } from '../../types.js';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Track whether we've shown the first-download message. */
let hasShownDownloadMessage = false;

/**
 * Resolve the absolute path to the compiled worker script.
 *
 * In production (built with tsup), the worker is at:
 *   dist/workers/embedder.worker.js
 *
 * During development (ts-node / vitest), it may be at:
 *   src/workers/embedder.worker.ts
 */
function resolveWorkerPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // From src/adapters/embedder/ → src/workers/
  const workerPath = path.resolve(currentDir, '../../workers/embedder.worker.js');
  return workerPath;
}

// ─── Shared Worker Pool (module-level singleton) ──────────────────────────

/** Auto-incrementing request ID for message correlation. */
let nextRequestId = 0;

/** Map of pending request ID → { resolve, reject } callbacks. */
const pending = new Map<number, {
  resolve: (vector: number[]) => void;
  reject: (error: Error) => void;
}>();

/** The shared persistent worker instance. */
let sharedWorker: Worker | null = null;

/** Model name the current worker was spawned for. */
let workerModelName: string | null = null;

/**
 * Get or spawn the shared worker. If the worker has crashed or
 * hasn't been created yet, spawn a new one.
 */
function getOrSpawnWorker(model: string): Worker {
  if (sharedWorker && workerModelName === model) {
    return sharedWorker;
  }

  // If model changed, terminate old worker
  if (sharedWorker) {
    sharedWorker.terminate().catch(() => {});
    rejectAllPending('Worker terminated due to model change');
  }

  const workerPath = resolveWorkerPath();
  const worker = new Worker(workerPath);

  worker.on('message', (msg: WorkerOutput) => {
    const entry = pending.get(msg.id);
    if (!entry) return; // stale response from previous worker instance
    pending.delete(msg.id);

    if ('error' in msg) {
      entry.reject(new Error(`Embedding worker error: ${msg.error}`));
    } else {
      entry.resolve(msg.vector);
    }
  });

  worker.on('error', (err) => {
    // Worker crashed — reject all pending and clear the instance
    rejectAllPending(`Embedding worker crashed: ${err.message}`);
    sharedWorker = null;
    workerModelName = null;
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      rejectAllPending(`Embedding worker exited with code ${code}`);
    }
    sharedWorker = null;
    workerModelName = null;
  });

  sharedWorker = worker;
  workerModelName = model;
  return worker;
}

/** Reject all pending requests (called on worker crash/exit). */
function rejectAllPending(reason: string): void {
  for (const [id, entry] of pending) {
    entry.reject(new Error(reason));
    pending.delete(id);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Create a local embedder function that runs Transformers.js in a
 * persistent worker thread.
 *
 * The worker is spawned lazily on the first embed call and reused for
 * all subsequent calls. If the worker crashes, it is respawned automatically.
 *
 * @param modelName - HuggingFace model name. Default: 'Xenova/all-MiniLM-L6-v2'.
 * @returns An EmbedderFunction that embeds text into a number[] vector.
 */
export function createLocalEmbedder(modelName?: string): EmbedderFunction {
  const model = modelName ?? DEFAULT_MODEL;

  if (!hasShownDownloadMessage) {
    console.info(
      '[semantic-recall] Using local embedding model. ' +
      'First run downloads ~25MB model — this only happens once.'
    );
    hasShownDownloadMessage = true;
  }

  return async (text: string): Promise<number[]> => {
    const worker = getOrSpawnWorker(model);
    const id = nextRequestId++;

    return new Promise<number[]>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, text, modelName: model });
    });
  };
}
