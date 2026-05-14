/**
 * semantic-memory — Core type definitions
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

/**
 * Contract that every storage adapter must implement.
 * Handles both memory CRUD and queue operations.
 */
export interface StorageAdapter {
  /** Create tables/indexes if they don't exist. */
  init(): Promise<void>;

  /** Insert a memory row. Returns the new memory ID. */
  insertMemory(params: InsertMemoryParams): Promise<number>;

  /** Return all non-expired memories for a user+namespace (for JS-side cosine search). */
  searchMemories(params: SearchParams): Promise<RawMemoryRow[]>;

  /** Delete a specific memory by ID. */
  deleteMemory(id: number): Promise<void>;

  /** Delete all memories for a user+namespace. */
  deleteAllMemories(userId: string, namespace: string): Promise<void>;

  /** List memories (no vector search, raw list). */
  listMemories(userId: string, namespace: string, limit: number): Promise<RawMemoryRow[]>;

  /** Remove expired memory rows for a user. */
  pruneExpired(userId: string): Promise<void>;

  // ─── Queue Operations ───────────────────────────────────────────────

  /** Enqueue a new pending job. Returns the job ID. */
  enqueue(job: NewJob): Promise<number>;

  /** Mark a job as processing. */
  markProcessing(jobId: number): Promise<void>;

  /** Mark a job as done. */
  markDone(jobId: number): Promise<void>;

  /**
   * Mark a job as failed with error details.
   * If attempts >= maxAttempts, marks as 'dead' instead.
   */
  markFailed(jobId: number, error: string): Promise<void>;

  /** Get all retryable jobs (pending/failed with next_retry_at <= now). */
  getRetryable(): Promise<MemoryJob[]>;

  /** Get all dead jobs for a user. */
  getDeadJobs(userId: string): Promise<MemoryJob[]>;

  /** Reset stale 'processing' jobs to 'pending' (crash recovery). */
  resetStaleProcessing(): Promise<void>;

  /** Delete old 'done' rows from pending_memories. */
  cleanupDoneJobs(olderThanMs: number): Promise<number>;

  /** Retry a dead job by resetting its status. */
  retryDeadJob(jobId: number): Promise<void>;

  /** Close underlying database connection (cleanup). */
  close(): void;
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

  /** SQLite database file path. Default: './semantic-memory.db'. */
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
   */
  ttl?: string | number;
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
}

/**
 * Return type for rememberAndWait().
 */
export interface RememberResult {
  saved: boolean;
  duplicate: boolean;
}

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
}

export interface RecallParams {
  query: string;
  userId: string;
  namespace: string;
  recallThreshold: number;
  topK: number;
  embedder: EmbedderFunction;
  storage: StorageAdapter;
}
