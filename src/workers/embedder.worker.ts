/**
 * semantic-recall — Persistent Embedder Worker Thread
 *
 * Runs in a Node.js worker_threads context, isolated from the main thread.
 * Loads the Transformers.js embedding model ONCE and keeps it in memory
 * for the lifetime of the worker.
 *
 * Communication protocol (message-based, supports multiplexing):
 * - Receives: { id: number, text: string, modelName: string }
 * - Posts:    { id: number, vector: number[] } on success
 * - Posts:    { id: number, error: string } on failure
 *
 * The model is cached after first download (~25MB for all-MiniLM-L6-v2).
 * Subsequent messages reuse the loaded pipeline — no re-import or
 * re-download overhead.
 */

import { parentPort } from 'node:worker_threads';
import type { WorkerInput, WorkerOutput } from '../types.js';

if (!parentPort) {
  throw new Error('embedder.worker.ts must run inside a worker_threads Worker');
}

/**
 * Singleton pipeline promise — guarantees the model loads exactly once
 * even if multiple messages arrive while the first import is still in flight.
 */
let extractorPromise: Promise<unknown> | null = null;

async function getExtractor(modelName: string): Promise<unknown> {
  if (!extractorPromise) {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowLocalModels = true;
    extractorPromise = pipeline('feature-extraction', modelName, {
      dtype: 'fp32',
    });
  }
  return extractorPromise;
}

parentPort.on('message', async (msg: WorkerInput) => {
  try {
    const extractor = await getExtractor(msg.modelName) as (
      text: string,
      options: { pooling: string; normalize: boolean },
    ) => Promise<{ tolist: () => number[][] }>;

    const output = await extractor(msg.text, {
      pooling: 'mean',
      normalize: true,
    });

    const vector = Array.from(output.tolist()[0] as number[]);
    const result: WorkerOutput = { id: msg.id, vector };
    parentPort!.postMessage(result);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const result: WorkerOutput = { id: msg.id, error: errorMessage };
    parentPort!.postMessage(result);
  }
});
