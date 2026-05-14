/**
 * semantic-memory — Deduplication Engine
 *
 * Prevents storing semantically identical memories by comparing
 * the incoming vector against all existing memories for a user+namespace.
 *
 * Uses cosine similarity with a configurable threshold (default: 0.92).
 * A score ≥ threshold means the memory is considered a duplicate and
 * will be silently skipped.
 */

import type { StorageAdapter } from './types.js';
import { cosineSimilarity, parseEmbedding } from './utils.js';

/**
 * Check if a new memory vector is a duplicate of any existing memory.
 *
 * Loads all current embeddings for the user+namespace and computes
 * cosine similarity against each one. Returns true if any existing
 * memory exceeds the dedup threshold.
 *
 * @param params.vector - The new embedding vector to check.
 * @param params.userId - User ID for isolation.
 * @param params.namespace - Namespace for isolation.
 * @param params.threshold - Cosine similarity threshold (0.0–1.0).
 * @param params.storage - Storage adapter to query existing memories.
 * @returns `true` if the vector is a duplicate, `false` otherwise.
 */
export async function isDuplicate(params: {
  vector: number[];
  userId: string;
  namespace: string;
  threshold: number;
  storage: StorageAdapter;
}): Promise<boolean> {
  const { vector, userId, namespace, threshold, storage } = params;

  // Load all existing memories for this user+namespace
  const existingRows = await storage.searchMemories({ userId, namespace });

  if (existingRows.length === 0) {
    return false;
  }

  for (const row of existingRows) {
    let existingVector: number[];
    try {
      existingVector = parseEmbedding(row.embedding);
    } catch {
      // Skip rows with corrupted embeddings
      continue;
    }

    // Dimension mismatch means different embedder was used — skip comparison
    if (existingVector.length !== vector.length) {
      continue;
    }

    const similarity = cosineSimilarity(vector, existingVector);

    if (similarity >= threshold) {
      return true;
    }
  }

  return false;
}

/**
 * Check that the new vector's dimensionality matches existing memories.
 *
 * If the database has existing memories with a different dimension,
 * it means the developer switched embedding models. This will cause
 * garbage similarity scores, so we throw a clear error.
 *
 * @throws {Error} If dimension mismatch is detected.
 */
export async function checkDimensionMismatch(params: {
  vector: number[];
  userId: string;
  namespace: string;
  storage: StorageAdapter;
}): Promise<void> {
  const { vector, userId, namespace, storage } = params;

  const existingRows = await storage.searchMemories({ userId, namespace });

  if (existingRows.length === 0) {
    return; // No existing memories — nothing to compare against
  }

  // Check the first valid memory's embedding dimension
  for (const row of existingRows) {
    let existingVector: number[];
    try {
      existingVector = parseEmbedding(row.embedding);
    } catch {
      continue;
    }

    if (existingVector.length !== vector.length) {
      throw new Error(
        `[semantic-memory] Dimension mismatch. ` +
        `Existing memories use ${existingVector.length}-dim vectors but ` +
        `current embedder returns ${vector.length}-dim vectors. ` +
        `Either clear the database with memory.forgetAll() or keep using the same embedder.`
      );
    }

    // Only need to check one valid row
    return;
  }
}
