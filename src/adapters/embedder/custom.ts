/**
 * semantic-recall — Custom Embedder Adapter
 *
 * Wraps a developer-supplied embedding function with validation
 * to ensure it returns a valid number[] vector.
 *
 * This allows integration with any embedding service:
 * Azure OpenAI, Google Vertex AI, Cohere, local Ollama, etc.
 */

import type { EmbedderFunction } from '../../types.js';

/**
 * Validate and wrap a custom embedder function.
 *
 * Adds runtime validation to ensure the function returns a valid
 * number[] vector on every call. This catches subtle bugs early
 * (e.g., returning undefined, returning strings, returning empty arrays).
 *
 * @param fn - Developer-supplied async function: (text: string) => Promise<number[]>
 * @returns A validated EmbedderFunction.
 * @throws {Error} If fn is not a function.
 */
export function createCustomEmbedder(fn: EmbedderFunction): EmbedderFunction {
  if (typeof fn !== 'function') {
    throw new Error(
      '[semantic-recall] Custom embedder must be a function with signature: ' +
      '(text: string) => Promise<number[]>'
    );
  }

  return async (text: string): Promise<number[]> => {
    const result = await fn(text);

    if (!Array.isArray(result)) {
      throw new Error(
        '[semantic-recall] Custom embedder must return a number[]. ' +
        `Got ${typeof result} instead.`
      );
    }

    if (result.length === 0) {
      throw new Error(
        '[semantic-recall] Custom embedder returned an empty vector. ' +
        'Embeddings must have at least one dimension.'
      );
    }

    for (let i = 0; i < result.length; i++) {
      if (typeof result[i] !== 'number' || !Number.isFinite(result[i])) {
        throw new Error(
          `[semantic-recall] Custom embedder returned invalid value at index ${i}: ${result[i]}. ` +
          'All elements must be finite numbers.'
        );
      }
    }

    return result;
  };
}
