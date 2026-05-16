/**
 * semantic-recall — Vector math utilities and TTL parsing.
 *
 * Pure functions with zero side effects. These are the mathematical
 * foundation for similarity search and memory expiry.
 */

/**
 * Compute cosine similarity between two vectors.
 *
 * Returns a value in [-1, 1] where 1 = identical direction,
 * 0 = orthogonal, -1 = opposite direction.
 *
 * @throws {Error} If vectors have different lengths or are empty.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    throw new Error('Vectors must not be empty');
  }
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: got ${a.length} and ${b.length}. ` +
      `Ensure both vectors come from the same embedding model.`
    );
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dotProduct += ai * bi;
    magnitudeA += ai * ai;
    magnitudeB += bi * bi;
  }

  const magnitude = Math.sqrt(magnitudeA * magnitudeB);

  // Guard against zero-magnitude vectors (all-zeros)
  if (magnitude === 0) {
    return 0;
  }

  return dotProduct / magnitude;
}

// ─── TTL Parsing ────────────────────────────────────────────────────────────

/** Regex for human-readable TTL strings like '1h', '7d', '30d'. */
const TTL_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

/** Multipliers for each TTL unit, in milliseconds. */
const TTL_MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a TTL value into milliseconds.
 *
 * Accepts:
 * - Number: treated as milliseconds directly.
 * - String: `'1h'`, `'12h'`, `'7d'`, `'30d'`, `'500ms'`, `'60s'`, `'30m'`.
 *
 * @throws {Error} If the TTL format is invalid.
 */
export function parseTTL(ttl: string | number): number {
  if (typeof ttl === 'number') {
    if (ttl <= 0) {
      throw new Error(`TTL must be a positive number, got ${ttl}`);
    }
    return ttl;
  }

  const match = TTL_PATTERN.exec(ttl.trim());
  if (!match) {
    throw new Error(
      `Invalid TTL format: '${ttl}'. ` +
      `Expected a number or a string like '1h', '7d', '30d', '500ms'.`
    );
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multiplier = TTL_MULTIPLIERS[unit];

  if (multiplier === undefined) {
    throw new Error(`Unknown TTL unit: '${unit}'`);
  }

  const result = value * multiplier;
  if (result > MAX_TTL_MS) {
    throw new Error(
      `[semantic-recall] TTL value '${ttl}' exceeds the maximum of 10 years.`
    );
  }
  return result;
}

/**
 * Compute an ISO 8601 expiry timestamp from a TTL value.
 *
 * @returns ISO string if TTL is provided, null otherwise.
 */
export function generateExpiresAt(ttl?: string | number): string | null {
  if (ttl === undefined || ttl === null) {
    return null;
  }

  const ms = parseTTL(ttl);
  return new Date(Date.now() + ms).toISOString();
}

/**
 * Check if an ISO timestamp is in the past.
 */
export function isExpired(isoTimestamp: string): boolean {
  return new Date(isoTimestamp).getTime() <= Date.now();
}

/**
 * Parse a JSON-serialized embedding back to a number array.
 * Validates that the result is actually an array of numbers.
 */
export function parseEmbedding(json: string): number[] {
  const parsed: unknown = JSON.parse(json);

  if (!Array.isArray(parsed)) {
    throw new Error('Embedding is not an array');
  }

  for (let i = 0; i < parsed.length; i++) {
    if (typeof parsed[i] !== 'number') {
      throw new Error(`Embedding contains non-number at index ${i}`);
    }
  }

  return parsed as number[];
}

/**
 * Compute exponential backoff delay in milliseconds.
 *
 * Formula: min(2^attempts * 1000ms, MAX_BACKOFF_MS)
 * Attempt 1 → 2s, Attempt 2 → 4s, Attempt 3 → 8s, etc.
 *
 * Cap prevents unbounded delays for high maxAttempts configurations.
 * Default maxAttempts is 3, so attempts never reach this cap in typical use.
 */
const MAX_BACKOFF_MS = 3_600_000; // 1 hour
const MAX_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000; // 10 years

export function computeBackoffMs(attempts: number): number {
  const base = Math.min(Math.pow(2, attempts) * 1000, MAX_BACKOFF_MS);
  // ±25% jitter to prevent thundering herd when multiple instances restart
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(1000, Math.round(base + jitter));
}

/**
 * Get the current time as an ISO 8601 string.
 */
export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Parse a JSON-serialized tags string from DB into a string array.
 * Gracefully handles null, undefined, empty, and malformed data.
 *
 * This is the single source of truth for tag parsing — used in
 * recall, list, related, and export paths.
 */
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}
