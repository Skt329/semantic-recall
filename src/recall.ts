/**
 * semantic-recall — Recall Pipeline
 *
 * Semantic similarity search against stored memories:
 *   embed query → load candidates → cosine similarity → filter → sort → return top-K
 *
 * Returns either plain string[] (content only) or MemoryResult[]
 * (with similarity scores and metadata) depending on the caller.
 */

import type {
  RecallParams,
  MemoryResult,
} from './types.js';
import { cosineSimilarity, parseEmbedding } from './utils.js';

/**
 * Recall semantically similar memories for a query.
 *
 * Steps:
 * 1. Embed the query string using the same embedder as inject
 * 2. Load all non-expired candidate memories for user+namespace
 * 3. Compute cosine similarity between query vector and each stored embedding
 * 4. Filter results with score ≥ recallThreshold
 * 5. Sort descending by similarity score
 * 6. Return top-K results
 *
 * @param params - Full recall parameters including embedder and storage.
 * @returns Array of MemoryResult with content, similarity, and metadata.
 */
export async function recallMemories(params: RecallParams): Promise<MemoryResult[]> {
  const {
    query,
    userId,
    namespace,
    recallThreshold,
    topK,
    embedder,
    storage,
  } = params;

  // Step 1: Embed the query
  const queryVector = await embedder(query);

  // Step 2: Load all non-expired candidate memories
  const candidates = await storage.searchMemories({ userId, namespace });

  if (candidates.length === 0) {
    return [];
  }

  // Step 3 + 4: Compute similarity and filter
  const scored: MemoryResult[] = [];

  for (const row of candidates) {
    let storedVector: number[];
    try {
      storedVector = parseEmbedding(row.embedding);
    } catch {
      // Skip rows with corrupted embeddings
      continue;
    }

    // Dimension mismatch — skip this row (shouldn't happen with dedup checks)
    if (storedVector.length !== queryVector.length) {
      continue;
    }

    const similarity = cosineSimilarity(queryVector, storedVector);

    if (similarity >= recallThreshold) {
      scored.push({
        id: row.id,
        content: row.content,
        similarity,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      });
    }
  }

  // Step 5: Sort descending by similarity
  scored.sort((a, b) => b.similarity - a.similarity);

  // Step 6: Return top-K
  return scored.slice(0, topK);
}

/**
 * Recall memories and return only the content strings.
 *
 * This is the convenience method used by most developers —
 * they just need the text to inject into their LLM prompt.
 */
export async function recallContents(params: RecallParams): Promise<string[]> {
  const results = await recallMemories(params);
  return results.map(r => r.content);
}
