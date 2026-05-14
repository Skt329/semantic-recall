/**
 * semantic-recall — Embedder Worker Thread
 *
 * Runs in a Node.js worker_threads context, isolated from the main thread.
 * Loads the Transformers.js embedding model and converts text to vectors.
 *
 * Communication protocol:
 * - Receives: { text: string, modelName: string } via workerData
 * - Posts:    { vector: number[] } on success
 * - Posts:    { error: string } on failure
 *
 * The model is cached after first download (~25MB for all-MiniLM-L6-v2).
 */

import { workerData, parentPort } from 'node:worker_threads';
import type { WorkerInput, WorkerOutput } from '../types.js';

async function run(): Promise<void> {
  if (!parentPort) {
    throw new Error('embedder.worker.ts must run inside a worker_threads Worker');
  }

  const { text, modelName } = workerData as WorkerInput;

  try {
    // Dynamic import to keep the main thread bundle small
    const { pipeline, env } = await import('@huggingface/transformers');

    // Disable local model check warning in production
    env.allowLocalModels = true;

    // Create the feature-extraction pipeline with the specified model
    const extractor = await pipeline('feature-extraction', modelName, {
      dtype: 'fp32',
    });

    // Run inference — returns a Tensor-like object
    const output = await extractor(text, {
      pooling: 'mean',
      normalize: true,
    });

    // Convert to plain number[]
    const vector = Array.from(output.tolist()[0] as number[]);

    const result: WorkerOutput = { vector };
    parentPort.postMessage(result);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const result: WorkerOutput = { error: errorMessage };
    parentPort.postMessage(result);
  }
}

run().catch((err) => {
  if (parentPort) {
    parentPort.postMessage({ error: String(err) });
  }
});
