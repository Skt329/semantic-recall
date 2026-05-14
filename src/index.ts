/**
 * semantic-recall — Memory Class (Public API)
 *
 * The single entry point for the package. Provides:
 *   - remember(text)      — fire-and-forget memory storage
 *   - recall(query)       — semantic similarity search
 *   - extractAndRemember  — LLM-powered auto-extraction
 *
 * Extends EventEmitter for observability without breaking the
 * fire-and-forget contract.
 *
 * @example
 * ```typescript
 * import { Memory } from 'semantic-recall'
 *
 * const memory = new Memory({ userId: 'user_123' })
 * memory.remember("user is vegetarian")
 * const context = await memory.recall("dietary preferences")
 * ```
 */

import { EventEmitter } from 'node:events';
import type {
  MemoryOptions,
  RememberOptions,
  RecallOptions,
  MemoryResult,
  RememberResult,
  MemoryJob,
  StorageAdapter,
  EmbedderFunction,
  ConversationMessage,
  LLMFunction,
  MemoryEventMap,
} from './types.js';
import { injectBackground } from './inject.js';
import { recallMemories, recallContents } from './recall.js';
import { SQLiteStorageAdapter } from './adapters/storage/sqlite.js';
import { createLocalEmbedder } from './adapters/embedder/local.js';
import { createOpenAIEmbedder } from './adapters/embedder/openai.js';
import { createCustomEmbedder } from './adapters/embedder/custom.js';
import { parseTTL } from './utils.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = './semantic-recall.db';
const DEFAULT_NAMESPACE = 'default';
const DEFAULT_DEDUP_THRESHOLD = 0.92;
const DEFAULT_RECALL_THRESHOLD = 0.70;
const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Auto-extraction Prompt ─────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a memory extraction assistant.
Given the following conversation, extract facts about the user that are worth remembering long-term.
Rules:
- Only extract facts about the USER, not the assistant.
- Each fact must be a short, standalone sentence.
- Do not extract temporary context (e.g. "user is asking about X").
- Do not extract facts already implied by common sense.
- Return facts as a JSON array of strings. If nothing is worth remembering, return [].

Conversation:
`;

// ─── Memory Class ───────────────────────────────────────────────────────────

export class Memory extends EventEmitter {
  private readonly userId: string;
  private readonly namespace: string;
  private readonly dedupThreshold: number;
  private readonly recallThreshold: number;
  private readonly topK: number;
  private readonly maxAttempts: number;
  private readonly retryIntervalMs: number;

  private readonly storage: StorageAdapter;
  private readonly embedder: EmbedderFunction;
  private readonly llmFn: LLMFunction | null;

  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private initialized: boolean = false;
  private initPromise: Promise<void>;

  constructor(options: MemoryOptions) {
    super();

    // ─── Validate required options ─────────────────────────────────────
    if (!options.userId || typeof options.userId !== 'string') {
      throw new Error(
        '[semantic-recall] userId is required and must be a non-empty string.'
      );
    }

    // ─── Assign defaults ───────────────────────────────────────────────
    this.userId = options.userId;
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.dedupThreshold = options.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;
    this.recallThreshold = options.recallThreshold ?? DEFAULT_RECALL_THRESHOLD;
    this.topK = options.topK ?? DEFAULT_TOP_K;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

    // ─── Resolve storage adapter ───────────────────────────────────────
    this.storage = this.resolveStorage(options);

    // ─── Resolve embedder ──────────────────────────────────────────────
    this.embedder = this.resolveEmbedder(options);

    // ─── Resolve LLM (for auto-extraction) ─────────────────────────────
    this.llmFn = this.resolveLLM(options);

    // ─── Initialize asynchronously ─────────────────────────────────────
    this.initPromise = this.initialize();
  }

  // ─── Resolver Methods ─────────────────────────────────────────────────

  private resolveStorage(options: MemoryOptions): StorageAdapter {
    const storageOption = options.storage ?? 'sqlite';

    if (typeof storageOption === 'object') {
      // Custom storage adapter — use as-is
      return storageOption;
    }

    switch (storageOption) {
      case 'sqlite':
        return new SQLiteStorageAdapter(options.dbPath ?? DEFAULT_DB_PATH);

      case 'turso':
        // Lazy-loaded in the turso adapter
        throw new Error(
          '[semantic-recall] Turso adapter: use `storage: createTursoAdapter(...)` ' +
          'from "semantic-recall/adapters/storage/turso".'
        );

      case 'supabase':
        throw new Error(
          '[semantic-recall] Supabase adapter: use `storage: createSupabaseAdapter(...)` ' +
          'from "semantic-recall/adapters/storage/supabase".'
        );

      default:
        throw new Error(`[semantic-recall] Unknown storage adapter: ${storageOption}`);
    }
  }

  private resolveEmbedder(options: MemoryOptions): EmbedderFunction {
    const embedderOption = options.embedder ?? 'local';

    if (typeof embedderOption === 'function') {
      return createCustomEmbedder(embedderOption);
    }

    switch (embedderOption) {
      case 'local':
        return createLocalEmbedder(options.embeddingModel);

      case 'openai': {
        if (!options.openaiApiKey) {
          throw new Error(
            '[semantic-recall] OpenAI embedder requires `openaiApiKey` in options.'
          );
        }
        return createOpenAIEmbedder(options.openaiApiKey, options.embeddingModel);
      }

      default:
        throw new Error(`[semantic-recall] Unknown embedder: ${embedderOption}`);
    }
  }

  private resolveLLM(options: MemoryOptions): LLMFunction | null {
    if (!options.llmProvider) return null;

    if (typeof options.llmProvider === 'function') {
      return options.llmProvider;
    }

    // Built-in LLM providers use the OpenAI SDK with different base URLs
    const apiKey = options.llmApiKey;
    if (!apiKey) {
      throw new Error(
        `[semantic-recall] LLM provider '${options.llmProvider}' requires 'llmApiKey' in options.`
      );
    }

    switch (options.llmProvider) {
      case 'openai':
        return this.createOpenAILLM(apiKey, options.llmModel ?? 'gpt-4o-mini');
      case 'gemini':
        return this.createOpenAICompatibleLLM(
          apiKey,
          options.llmModel ?? 'gemini-2.0-flash',
          'https://generativelanguage.googleapis.com/v1beta/openai/',
        );
      case 'claude':
        return this.createOpenAICompatibleLLM(
          apiKey,
          options.llmModel ?? 'claude-sonnet-4-20250514',
          'https://api.anthropic.com/v1/',
        );
      default:
        throw new Error(`[semantic-recall] Unknown LLM provider: ${options.llmProvider}`);
    }
  }

  private createOpenAILLM(apiKey: string, model: string): LLMFunction {
    return async (prompt: string): Promise<string> => {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey });
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });
      return response.choices[0]?.message?.content ?? '[]';
    };
  }

  private createOpenAICompatibleLLM(
    apiKey: string,
    model: string,
    baseURL: string,
  ): LLMFunction {
    return async (prompt: string): Promise<string> => {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey, baseURL });
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });
      return response.choices[0]?.message?.content ?? '[]';
    };
  }

  // ─── Initialization ───────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    try {
      // Create tables if they don't exist
      await this.storage.init();

      // Reset any jobs stuck in 'processing' from a crashed session
      await this.storage.resetStaleProcessing();

      // Replay pending/failed jobs from previous sessions
      await this.replayPendingJobs();

      // Start the retry scheduler
      this.startRetryScheduler();

      this.initialized = true;
    } catch (err) {
      // Non-fatal — log and continue. The developer can still use recall()
      // on an existing database even if init partially fails.
      console.error('[semantic-recall] Initialization error:', err);
    }
  }

  /** Ensure initialization is complete before any operation. */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initPromise;
    }
  }

  // ─── Replay & Retry ───────────────────────────────────────────────────

  private async replayPendingJobs(): Promise<void> {
    try {
      const retryable = await this.storage.getRetryable();

      for (const job of retryable) {
        // Fire-and-forget — each job runs independently
        void injectBackground(
          {
            jobId: job.id,
            userId: job.userId,
            namespace: job.namespace,
            content: job.content,
            dedupThreshold: this.dedupThreshold,
            embedder: this.embedder,
            storage: this.storage,
            replayed: true,
            retried: job.attempts > 0,
          },
          this,
        );
      }
    } catch {
      // Swallow — replay is best-effort
    }
  }

  private startRetryScheduler(): void {
    this.retryTimer = setInterval(async () => {
      try {
        const retryable = await this.storage.getRetryable();

        for (const job of retryable) {
          void injectBackground(
            {
              jobId: job.id,
              userId: job.userId,
              namespace: job.namespace,
              content: job.content,
              dedupThreshold: this.dedupThreshold,
              embedder: this.embedder,
              storage: this.storage,
              retried: true,
            },
            this,
          );
        }
      } catch {
        // Swallow — scheduler is best-effort
      }
    }, this.retryIntervalMs);

    // Unref so the timer doesn't keep the process alive
    if (this.retryTimer && typeof this.retryTimer === 'object' && 'unref' in this.retryTimer) {
      this.retryTimer.unref();
    }
  }

  // ─── Public API: remember() ───────────────────────────────────────────

  /**
   * Store a memory. Fire and forget — returns immediately, never throws.
   *
   * The embedding, dedup check, and storage happen asynchronously
   * in the background. Subscribe to 'memory:saved' to know when
   * the memory is actually stored.
   *
   * @param text - The fact to remember (e.g., "user is vegetarian").
   * @param options - Optional namespace and TTL overrides.
   */
  remember(text: string, options?: RememberOptions): void {
    // Never throw — wrap everything in a try-catch
    void (async () => {
      try {
        await this.ensureInitialized();

        const namespace = options?.namespace ?? this.namespace;

        // Step 1: Enqueue to pending_memories (fast, synchronous write)
        const jobId = await this.storage.enqueue({
          userId: this.userId,
          namespace,
          content: text,
          maxAttempts: this.maxAttempts,
        });

        // Step 2: Fire background injection pipeline
        void injectBackground(
          {
            jobId,
            userId: this.userId,
            namespace,
            content: text,
            ttl: options?.ttl,
            dedupThreshold: this.dedupThreshold,
            embedder: this.embedder,
            storage: this.storage,
          },
          this,
        );
      } catch {
        // Swallow — remember() must never throw
      }
    })();
  }

  /**
   * Store a memory and wait for confirmation.
   *
   * Unlike remember(), this blocks until the memory is stored
   * (or confirmed as duplicate). Use when you need synchronous
   * confirmation before proceeding.
   *
   * @param text - The fact to remember.
   * @param options - Optional namespace and TTL overrides.
   * @returns { saved: boolean, duplicate: boolean }
   */
  async rememberAndWait(
    text: string,
    options?: RememberOptions,
  ): Promise<RememberResult> {
    await this.ensureInitialized();

    const namespace = options?.namespace ?? this.namespace;

    const jobId = await this.storage.enqueue({
      userId: this.userId,
      namespace,
      content: text,
      maxAttempts: this.maxAttempts,
    });

    return injectBackground(
      {
        jobId,
        userId: this.userId,
        namespace,
        content: text,
        ttl: options?.ttl,
        dedupThreshold: this.dedupThreshold,
        embedder: this.embedder,
        storage: this.storage,
      },
      this,
    );
  }

  // ─── Public API: recall() ─────────────────────────────────────────────

  /**
   * Retrieve semantically similar memories for a query.
   *
   * Returns an array of content strings — ready to inject into
   * an LLM system prompt.
   *
   * @param query - The query to search for (e.g., "dietary preferences").
   * @param options - Optional namespace, threshold, and topK overrides.
   * @returns Array of remembered fact strings.
   */
  async recall(query: string, options?: RecallOptions): Promise<string[]> {
    await this.ensureInitialized();

    return recallContents({
      query,
      userId: this.userId,
      namespace: options?.namespace ?? this.namespace,
      recallThreshold: options?.threshold ?? this.recallThreshold,
      topK: options?.topK ?? this.topK,
      embedder: this.embedder,
      storage: this.storage,
    });
  }

  /**
   * Retrieve memories with full metadata including similarity scores.
   *
   * @param query - The query to search for.
   * @param options - Optional overrides.
   * @returns Array of MemoryResult objects with scores.
   */
  async recallDetailed(query: string, options?: RecallOptions): Promise<MemoryResult[]> {
    await this.ensureInitialized();

    return recallMemories({
      query,
      userId: this.userId,
      namespace: options?.namespace ?? this.namespace,
      recallThreshold: options?.threshold ?? this.recallThreshold,
      topK: options?.topK ?? this.topK,
      embedder: this.embedder,
      storage: this.storage,
    });
  }

  // ─── Public API: Memory Management ────────────────────────────────────

  /**
   * Delete a specific memory by ID.
   */
  async forget(memoryId: number): Promise<void> {
    await this.ensureInitialized();
    await this.storage.deleteMemory(memoryId);
  }

  /**
   * Delete all memories for this user in a namespace.
   */
  async forgetAll(options?: { namespace?: string }): Promise<void> {
    await this.ensureInitialized();
    await this.storage.deleteAllMemories(
      this.userId,
      options?.namespace ?? this.namespace,
    );
  }

  /**
   * List all stored memories (no semantic search, raw list).
   */
  async list(options?: {
    namespace?: string;
    limit?: number;
  }): Promise<MemoryResult[]> {
    await this.ensureInitialized();

    const rows = await this.storage.listMemories(
      this.userId,
      options?.namespace ?? this.namespace,
      options?.limit ?? 100,
    );

    return rows.map(row => ({
      id: row.id,
      content: row.content,
      similarity: 1.0, // Not a search result — similarity is N/A
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  // ─── Public API: Dead Jobs ────────────────────────────────────────────

  /**
   * Return dead jobs for manual inspection or replay.
   */
  async getDeadJobs(): Promise<MemoryJob[]> {
    await this.ensureInitialized();
    return this.storage.getDeadJobs(this.userId);
  }

  /**
   * Manually retry a dead job.
   */
  async retryDead(jobId: number): Promise<void> {
    await this.ensureInitialized();
    await this.storage.retryDeadJob(jobId);

    // Re-process immediately
    const retryable = await this.storage.getRetryable();
    const job = retryable.find(j => j.id === jobId);

    if (job) {
      void injectBackground(
        {
          jobId: job.id,
          userId: job.userId,
          namespace: job.namespace,
          content: job.content,
          dedupThreshold: this.dedupThreshold,
          embedder: this.embedder,
          storage: this.storage,
          retried: true,
        },
        this,
      );
    }
  }

  /**
   * Prune old 'done' rows from the pending_memories table.
   *
   * @param options.olderThan - Age of rows to delete. Default: '7d'.
   */
  async cleanup(options?: { olderThan?: string }): Promise<{ deleted: number }> {
    await this.ensureInitialized();

    const ageMs = options?.olderThan
      ? this.parseCleanupAge(options.olderThan)
      : DEFAULT_CLEANUP_AGE_MS;

    const deleted = await this.storage.cleanupDoneJobs(ageMs);
    return { deleted };
  }

  private parseCleanupAge(age: string): number {
    return parseTTL(age);
  }

  // ─── Public API: Auto-extraction ──────────────────────────────────────

  /**
   * Extract memorable facts from a conversation using an LLM,
   * then store each extracted fact via the normal remember() pipeline.
   *
   * @param conversationHistory - Array of { role, content } messages.
   * @param options - Optional namespace and TTL for extracted facts.
   */
  async extractAndRemember(
    conversationHistory: ConversationMessage[],
    options?: RememberOptions,
  ): Promise<void> {
    if (!this.llmFn) {
      throw new Error(
        '[semantic-recall] extractAndRemember() requires an LLM provider. ' +
        "Configure 'llmProvider' and 'llmApiKey' in the Memory constructor options."
      );
    }

    const formatted = conversationHistory
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    const prompt = EXTRACTION_PROMPT + formatted;
    const response = await this.llmFn(prompt);

    // Parse the LLM response as JSON array of strings
    let facts: string[];
    try {
      const parsed: unknown = JSON.parse(response);
      if (!Array.isArray(parsed)) {
        return; // LLM returned non-array — nothing to extract
      }
      facts = parsed.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      );
    } catch {
      // LLM returned invalid JSON — nothing to extract
      return;
    }

    // Remember each extracted fact (fire and forget)
    for (const fact of facts) {
      this.remember(fact.trim(), options);
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Clean up resources: stop retry scheduler, close database connection.
   *
   * Call this when your application is shutting down to ensure
   * clean resource release.
   */
  destroy(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }

    try {
      this.storage.close();
    } catch {
      // Swallow — best-effort cleanup
    }

    this.removeAllListeners();
  }

  // ─── Typed EventEmitter Overrides ─────────────────────────────────────

  override on<K extends keyof MemoryEventMap>(
    event: K,
    listener: (payload: MemoryEventMap[K]) => void,
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof MemoryEventMap>(
    event: K,
    payload: MemoryEventMap[K],
  ): boolean {
    return super.emit(event, payload);
  }
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export type {
  MemoryOptions,
  RememberOptions,
  RecallOptions,
  MemoryResult,
  RememberResult,
  MemoryJob,
  StorageAdapter,
  EmbedderFunction,
  ConversationMessage,
  LLMFunction,
  MemorySavedEvent,
  MemoryRetryEvent,
  MemoryDeadEvent,
  MemoryEventMap,
  InsertMemoryParams,
  SearchParams,
  RawMemoryRow,
  NewJob,
  JobStatus,
} from './types.js';

export { SQLiteStorageAdapter } from './adapters/storage/sqlite.js';
export { createLocalEmbedder } from './adapters/embedder/local.js';
export { createOpenAIEmbedder } from './adapters/embedder/openai.js';
export { createCustomEmbedder } from './adapters/embedder/custom.js';
export { cosineSimilarity, parseTTL } from './utils.js';
