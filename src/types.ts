/**
 * semantic-recall — Core type definitions
 *
 * All shared interfaces, types, and event payloads for the package.
 * This module is the single source of truth for the type system.
 */

// ─── Storage Adapter Interface ──────────────────────────────────────────────

/**
 * Parameters for inserting a new memory into storage.
 */
export interface InsertMemoryParams {
  userId: string;
  namespace: string;
  content: string;
  embedding: number[];
  createdAt: string;
  expiresAt: string | null;
  tags?: string[];
}

/**
 * Parameters for searching memories by vector similarity.
 */
export interface SearchParams {
  userId: string;
  namespace: string;
}

/**
 * A raw row from the memories table, before cosine computation.
 */
export interface RawMemoryRow {
  id: number;
  user_id: string;
  namespace: string;
  content: string;
  embedding: string; // JSON-serialized number[]
  created_at: string;
  expires_at: string | null;
  tags?: string | null;         // JSON-serialized string[] in DB
  recall_count?: number | null; // May be NULL in older rows
}

/**
 * A new job to be enqueued in the pending_memories table.
 */
export interface NewJob {
  userId: string;
  namespace: string;
  content: string;
  maxAttempts: number;
}

/**
 * Job status values for the pending_memories state machine.
 *
 * PENDING → PROCESSING → DONE
 *                      → FAILED → PENDING (retry)
 *                      → DEAD (max attempts exceeded)
 */
export type JobStatus = 'pending' | 'processing' | 'done' | 'failed' | 'dead';

/**
 * A row from the pending_memories table.
 */
export interface MemoryJob {
  id: number;
  userId: string;
  namespace: string;
  content: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  nextRetryAt: string | null;
}

// ─── Versioned Storage Adapter Hierarchy ────────────────────────────────────

/**
 * V1 contract — the original 16 methods, frozen forever.
 *
 * When future versions add methods, this interface remains unchanged.
 * Users only see `StorageAdapter` and `BaseStorageAdapter` — this
 * exists solely for internal versioning documentation.
 *
 * @internal
 */
interface StorageAdapterV1 {
  init(): Promise<void>;
  insertMemory(params: InsertMemoryParams): Promise<number>;
  searchMemories(params: SearchParams): Promise<RawMemoryRow[]>;
  deleteMemory(id: number): Promise<void>;
  deleteAllMemories(userId: string, namespace: string): Promise<void>;
  listMemories(userId: string, namespace: string, limit: number): Promise<RawMemoryRow[]>;
  pruneExpired(userId: string): Promise<void>;
  enqueue(job: NewJob): Promise<number>;
  markProcessing(jobId: number): Promise<void>;
  markDone(jobId: number): Promise<void>;
  markFailed(jobId: number, error: string): Promise<void>;
  getRetryable(): Promise<MemoryJob[]>;
  getDeadJobs(userId: string): Promise<MemoryJob[]>;
  resetStaleProcessing(): Promise<void>;
  cleanupDoneJobs(olderThanMs: number): Promise<number>;
  retryDeadJob(jobId: number): Promise<void>;
  close(): void;
}

/**
 * Parameters for updateMemory().
 */
export interface UpdateMemoryParams {
  content: string;
  embedding: number[];
  tags?: string[];
}

/**
 * Adapter-level statistics for a user.
 */
export interface AdapterStats {
  totalMemories: number;
  oldestDate: string | null;
  newestDate: string | null;
  mostRecalled: { content: string; recallCount: number } | null;
  deadJobCount: number;
  namespaceCounts: Record<string, number>;
  storageSizeKB: number | null;
}

/**
 * Current full storage adapter contract — all 23 methods required.
 *
 * Extends StorageAdapterV1 with 7 new methods added in v1.1.0.
 * All methods are required — no optional markers.
 * Custom adapter authors should extend `BaseStorageAdapter` which
 * provides default implementations for analytics-only methods.
 */
export interface StorageAdapter extends StorageAdapterV1 {
  /** Get a single memory by ID. Returns null if not found. */
  getMemoryById(id: number): Promise<RawMemoryRow | null>;

  /** Update a memory's content, embedding, and optionally tags in-place. */
  updateMemory(id: number, params: UpdateMemoryParams): Promise<void>;

  /** Fire-and-forget recall count increment for analytics. */
  incrementRecallCount(ids: number[]): Promise<void>;

  /** Get ALL memories for a user across all namespaces. */
  getAllMemories(userId: string): Promise<RawMemoryRow[]>;

  /** List distinct namespaces for a user. */
  listNamespaces(userId: string): Promise<string[]>;

  /** Get aggregate stats for a user. */
  getStats(userId: string): Promise<AdapterStats>;

  /** Batch insert memories. Returns array of inserted IDs. */
  bulkInsertMemories(memories: InsertMemoryParams[]): Promise<number[]>;
}

// ─── Embedder Types ─────────────────────────────────────────────────────────

/**
 * Function signature for any embedder adapter.
 * Takes text, returns a vector (number[]).
 */
export type EmbedderFunction = (text: string) => Promise<number[]>;

// ─── LLM Types (for auto-extraction) ───────────────────────────────────────

/** A single message in a conversation history. */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Function signature for an LLM that extracts facts from conversation.
 * Returns an array of fact strings.
 */
export type LLMFunction = (prompt: string) => Promise<string>;

// ─── Public API Types ───────────────────────────────────────────────────────

/**
 * Configuration for the Memory class constructor.
 */
export interface MemoryOptions {
  /** Required. Unique identifier for the user. */
  userId: string;

  // ─── Storage ─────────────────────────────────────────────────────────

  /** Storage backend. Default: 'sqlite'. */
  storage?: 'sqlite' | 'turso' | 'supabase' | StorageAdapter;

  /** SQLite database file path. Default: './semantic-recall.db'. */
  dbPath?: string;

  /** Connection string for Turso or Supabase. */
  connectionString?: string;

  /** Auth token for Turso. */
  authToken?: string;

  /** Supabase anon key. */
  anonKey?: string;

  // ─── Embedder ────────────────────────────────────────────────────────

  /** Embedder backend. Default: 'local' (Transformers.js). */
  embedder?: 'local' | 'openai' | EmbedderFunction;

  /** OpenAI API key (required if embedder is 'openai'). */
  openaiApiKey?: string;

  /** Embedding model name. Default: 'Xenova/all-MiniLM-L6-v2' for local. */
  embeddingModel?: string;

  // ─── LLM (auto-extraction) ──────────────────────────────────────────

  /** LLM provider for extractAndRemember(). */
  llmProvider?: 'openai' | 'gemini' | 'claude' | LLMFunction;

  /** API key for the LLM provider. */
  llmApiKey?: string;

  /** LLM model name. */
  llmModel?: string;

  // ─── Memory Behavior ─────────────────────────────────────────────────

  /** Namespace for memory isolation. Default: 'default'. */
  namespace?: string;

  /**
   * Default TTL applied to all memories. Can be overridden per-call.
   * Pass `null` on a per-call basis to make a memory permanent.
   * Accepts: '1h', '12h', '7d', '30d', or milliseconds as a number.
   */
  defaultTtl?: string | number;

  /** Cosine similarity threshold for deduplication. Default: 0.92. Range: 0.0–1.0. */
  dedupThreshold?: number;

  /** Minimum cosine similarity for recall results. Default: 0.70. Range: 0.0–1.0. */
  recallThreshold?: number;

  /** Maximum number of memories returned by recall(). Default: 5. */
  topK?: number;

  // ─── Reliability ─────────────────────────────────────────────────────

  /** Max retry attempts for failed injection jobs. Default: 3. */
  maxAttempts?: number;

  /** Retry scheduler interval in milliseconds. Default: 30000 (30s). */
  retryIntervalMs?: number;

  // ─── Auto-extraction ─────────────────────────────────────────────────

  /** If true, extractAndRemember is available. Default: false. */
  autoExtract?: boolean;
}

/**
 * Options for the remember() / rememberAndWait() methods.
 */
export interface RememberOptions {
  /** Override the constructor namespace for this memory. */
  namespace?: string;

  /**
   * Time-to-live for this memory.
   * Accepts: '1h', '12h', '7d', '30d', or milliseconds as a number.
   * Pass `null` to explicitly make this memory permanent (overrides defaultTtl).
   */
  ttl?: string | number | null;

  /** Tags to attach to this memory for filtered recall. */
  tags?: string[];
}

/**
 * Options for the recall() / recallDetailed() methods.
 */
export interface RecallOptions {
  /** Override the constructor namespace for this query. */
  namespace?: string;

  /** Override the minimum similarity threshold. */
  threshold?: number;

  /** Override the maximum number of results. */
  topK?: number;

  /** Filter: only return memories created after this ISO date. */
  after?: string;

  /** Filter: only return memories created before this ISO date. */
  before?: string;

  /** Filter: only return memories that contain ALL of these tags. */
  tags?: string[];
}

/**
 * A memory result with similarity score and metadata.
 */
export interface MemoryResult {
  id: number;
  content: string;
  similarity: number;
  createdAt: string;
  expiresAt: string | null;
  tags: string[];
  recallCount: number;
}

/**
 * Return type for rememberAndWait().
 */
export interface RememberResult {
  saved: boolean;
  duplicate: boolean;
}

/**
 * Return type for rememberMany().
 */
export interface BatchRememberResult {
  total: number;
  saved: number;
  duplicates: number;
  errors: number;
}

/**
 * Serialized export format for import/export.
 */
export interface ExportData {
  version: number;
  exportedAt: string;
  userId: string;
  memories: Array<{
    content: string;
    namespace: string;
    embedding: number[];
    createdAt: string;
    expiresAt: string | null;
    tags: string[];
  }>;
}

/**
 * Options for the related() method.
 */
export interface RelatedOptions {
  /** Override the similarity threshold. */
  threshold?: number;
  /** Override the max number of related memories. */
  topK?: number;
  /** Override the namespace (only when crossNamespace is false). */
  namespace?: string;
  /** If true, search across ALL namespaces. Ignores options.namespace. */
  crossNamespace?: boolean;
}

/**
 * User-facing stats wrapper returned by memory.stats().
 */
export interface MemoryStats extends AdapterStats {}

// ─── Event Payloads ─────────────────────────────────────────────────────────

export interface MemorySavedEvent {
  jobId: number;
  content: string;
  /** True if this was a job from a previous crashed session. */
  replayed?: boolean;
  /** True if this succeeded after a previous failure. */
  retried?: boolean;
}

export interface MemoryRetryEvent {
  jobId: number;
  content: string;
  error: string;
  attempts: number;
}

export interface MemoryDeadEvent {
  jobId: number;
  content: string;
  error: string;
  attempts: number;
}

// ─── Event Map (for typed EventEmitter) ─────────────────────────────────────

export interface MemoryEventMap {
  'memory:saved': MemorySavedEvent;
  'memory:retry': MemoryRetryEvent;
  'memory:dead': MemoryDeadEvent;
}

// ─── Worker Messages ────────────────────────────────────────────────────────

export interface WorkerInput {
  text: string;
  modelName: string;
}

export interface WorkerSuccessOutput {
  vector: number[];
}

export interface WorkerErrorOutput {
  error: string;
}

export type WorkerOutput = WorkerSuccessOutput | WorkerErrorOutput;

// ─── Internal Pipeline Types ────────────────────────────────────────────────

export interface InjectParams {
  jobId: number;
  userId: string;
  namespace: string;
  content: string;
  ttl?: string | number;
  dedupThreshold: number;
  embedder: EmbedderFunction;
  storage: StorageAdapter;
  replayed?: boolean;
  retried?: boolean;
  tags?: string[];
}

export interface RecallParams {
  query: string;
  userId: string;
  namespace: string;
  recallThreshold: number;
  topK: number;
  embedder: EmbedderFunction;
  storage: StorageAdapter;
  after?: string;
  before?: string;
  tags?: string[];
}
