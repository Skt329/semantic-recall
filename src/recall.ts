/**
 * semantic-recall — Recall Pipeline
 *
 * Semantic similarity search against stored memories:
 *   embed query → load candidates → filter by date/tags → cosine similarity → sort → return top-K
 *
 * Returns either plain string[] (content only) or MemoryResult[]
 * (with similarity scores and metadata) depending on the caller.
 *
 * Fire-and-forget recall_count increment happens after results are computed
 * to protect the hot path from analytics latency.
 */

import type {
  RecallParams,
  MemoryResult,
} from './types.js';
import { cosineSimilarity, parseEmbedding, parseTags } from './utils.js';


/**
 * Recall semantically similar memories for a query.
 *
 * Steps:
 * 1. Embed the query string using the same embedder as inject
 * 2. Load all non-expired candidate memories for user+namespace
 * 3. Apply date range and tag filters
 * 4. Compute cosine similarity between query vector and each stored embedding
 * 5. Filter results with score ≥ recallThreshold
 * 6. Sort descending by similarity score
 * 7. Return top-K results
 * 8. Fire-and-forget: increment recall_count on returned memories
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
    after,
    before,
    tags,
  } = params;

  // Step 1: Embed the query
  const queryVector = await embedder(query);

  // Step 2: Load all non-expired candidate memories
  let candidates = await storage.searchMemories({ userId, namespace });

  if (candidates.length === 0) {
    return [];
  }

  // Step 3: Apply date range filters
  if (after) {
    const afterDate = new Date(after).getTime();
    candidates = candidates.filter(r => new Date(r.created_at).getTime() >= afterDate);
  }
  if (before) {
    const beforeDate = new Date(before).getTime();
    candidates = candidates.filter(r => new Date(r.created_at).getTime() <= beforeDate);
  }

  // Step 3b: Apply tag filters (AND logic — memory must have ALL specified tags)
  if (tags && tags.length > 0) {
    candidates = candidates.filter(row => {
      const rowTags = parseTags(row.tags);
      return tags.every(t => rowTags.includes(t));
    });
  }

  // Step 4 + 5: Compute similarity and filter
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
        tags: parseTags(row.tags),
        recallCount: row.recall_count ?? 0,
      });
    }
  }

  // Step 6: Sort descending by similarity
  scored.sort((a, b) => b.similarity - a.similarity);

  // Step 7: Return top-K
  const results = scored.slice(0, topK);

  // Step 8: Fire-and-forget recall_count increment (analytics only)
  if (results.length > 0) {
    const ids = results.map(r => r.id);
    void storage.incrementRecallCount(ids).catch(() => {
      // Swallow — analytics failure must never break recall
    });
  }

  return results;
}

/**
 * Recall memories and return only the content strings.
 *
 * This is the convenience method used by most developers —
 * they just need the text to inject into their LLM system prompt.
 */
export async function recallContents(params: RecallParams): Promise<string[]> {
  const results = await recallMemories(params);
  return results.map(r => r.content);
}
