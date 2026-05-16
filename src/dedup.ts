/**
 * semantic-recall — Deduplication Engine
 *
 * Prevents storing semantically identical memories by comparing
 * the incoming vector against all existing memories for a user+namespace.
 *
 * Uses cosine similarity with a configurable threshold (default: 0.92).
 * A score ≥ threshold means the memory is considered a duplicate and
 * will be silently skipped.
 *
 * `checkAndDedup` performs dimension validation AND dedup in a single
 * pass over the stored memories — one `searchMemories` call per inject.
 */

import type { StorageAdapter } from './types.js';
import { cosineSimilarity, parseEmbedding } from './utils.js';

/**
 * Single-pass dimension check + deduplication.
 *
 * Loads all existing embeddings for the user+namespace once, validates
 * dimensions on the first valid row, and checks cosine similarity
 * against every row. Returns true if the vector is a duplicate.
 *
 * @throws {Error} If the first valid stored embedding has a different
 *   dimensionality than the incoming vector (model mismatch).
 */
export async function checkAndDedup(params: {
  vector: number[];
  userId: string;
  namespace: string;
  threshold: number;
  storage: StorageAdapter;
}): Promise<boolean> {
  const { vector, userId, namespace, threshold, storage } = params;
  const existingRows = await storage.searchMemories({ userId, namespace });

  if (existingRows.length === 0) return false;

  let dimensionChecked = false;

  for (const row of existingRows) {
    let existingVector: number[];
    try { existingVector = parseEmbedding(row.embedding); } catch { continue; }

    // Dimension check — only on first valid row
    if (!dimensionChecked) {
      if (existingVector.length !== vector.length) {
        throw new Error(
          `[semantic-recall] Dimension mismatch. ` +
          `Existing memories use ${existingVector.length}-dim vectors but ` +
          `current embedder returns ${vector.length}-dim vectors. ` +
          `Either clear the database with memory.forgetAll() or keep using the same embedder.`
        );
      }
      dimensionChecked = true;
    }

    // Dimension mismatch on subsequent rows — skip silently
    if (existingVector.length !== vector.length) continue;

    // Dedup check
    if (cosineSimilarity(vector, existingVector) >= threshold) return true;
  }

  return false;
}

// ─── Deprecated — kept for backward compatibility ───────────────────────────

/**
 * Check if a new memory vector is a duplicate of any existing memory.
 *
 * @deprecated Use `checkAndDedup` instead — it combines dimension
 * validation and dedup into a single pass (one `searchMemories` call).
 */
export async function isDuplicate(params: {
  vector: number[];
  userId: string;
  namespace: string;
  threshold: number;
  storage: StorageAdapter;
}): Promise<boolean> {
  return checkAndDedup(params);
}

/**
 * Check that the new vector's dimensionality matches existing memories.
 *
 * @deprecated Use `checkAndDedup` instead — it combines dimension
 * validation and dedup into a single pass (one `searchMemories` call).
 */
export async function checkDimensionMismatch(params: {
  vector: number[];
  userId: string;
  namespace: string;
  storage: StorageAdapter;
}): Promise<void> {
  await checkAndDedup({ ...params, threshold: Infinity });
}

