/**
 * semantic-recall — Local Embedder Adapter
 *
 * Uses @huggingface/transformers (Transformers.js v3) with the
 * all-MiniLM-L6-v2 model (384 dimensions, ~25MB).
 *
 * Embedding runs in a dedicated worker_threads Worker to keep the
 * main thread free. The model is downloaded once on first use and
 * cached for subsequent calls.
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

/**
 * Create a local embedder function that runs Transformers.js in a worker thread.
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
    return new Promise<number[]>((resolve, reject) => {
      const workerPath = resolveWorkerPath();

      const worker = new Worker(workerPath, {
        workerData: { text, modelName: model },
      });

      worker.on('message', (msg: WorkerOutput) => {
        if ('error' in msg) {
          reject(new Error(`Embedding worker error: ${msg.error}`));
        } else {
          resolve(msg.vector);
        }
        worker.terminate().catch(() => {});
      });

      worker.on('error', (err) => {
        reject(new Error(`Embedding worker crashed: ${err.message}`));
        worker.terminate().catch(() => {});
      });

      worker.on('exit', (code) => {
        if (code !== 0 && code !== 1) {
          reject(new Error(`Embedding worker exited with code ${code}`));
        }
      });
    });
  };
}
