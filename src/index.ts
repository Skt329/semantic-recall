/**
 * semantic-recall — Memory Class (Public API)
 *
 * @example
 * ```typescript
 * import { Memory } from 'semantic-recall'
 * const memory = new Memory({ userId: 'user_123' })
 * memory.remember("user is vegetarian")
 * const context = await memory.recall("dietary preferences")
 * ```
 */

import { EventEmitter } from 'node:events';
import type {
  MemoryOptions, RememberOptions, RecallOptions, MemoryResult,
  RememberResult, BatchRememberResult, MemoryJob, StorageAdapter,
  EmbedderFunction, ConversationMessage, LLMFunction, MemoryEventMap,
  ExportData, RelatedOptions, AdapterStats, UpdateMemoryParams,
} from './types.js';
import { injectBackground } from './inject.js';
import { recallMemories, recallContents } from './recall.js';
import { SQLiteStorageAdapter } from './adapters/storage/sqlite.js';
import { createLocalEmbedder } from './adapters/embedder/local.js';
import { createOpenAIEmbedder } from './adapters/embedder/openai.js';
import { createCustomEmbedder } from './adapters/embedder/custom.js';
import { validateCustomAdapter } from './adapters/storage/custom.js';
import { parseTTL, parseEmbedding, cosineSimilarity, nowISO, parseTags } from './utils.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = './semantic-recall.db';
const DEFAULT_NAMESPACE = 'default';
const DEFAULT_DEDUP_THRESHOLD = 0.92;
const DEFAULT_RECALL_THRESHOLD = 0.70;
const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_INTERVAL_MS = 30_000;
const DEFAULT_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RELATED_HARD_CAP = 5_000;

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
  private readonly defaultTtl: string | number | undefined;

  private readonly storage: StorageAdapter;
  private readonly embedder: EmbedderFunction;
  private readonly llmFn: LLMFunction | null;

  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private initialized: boolean = false;
  private initPromise: Promise<void>;
  private initError: Error | null = null;

  constructor(options: MemoryOptions) {
    super();

    if (!options.userId || typeof options.userId !== 'string') {
      throw new Error('[semantic-recall] userId is required and must be a non-empty string.');
    }

    this.userId = options.userId;
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.dedupThreshold = options.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;
    this.recallThreshold = options.recallThreshold ?? DEFAULT_RECALL_THRESHOLD;
    this.topK = options.topK ?? DEFAULT_TOP_K;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    this.defaultTtl = options.defaultTtl;

    this.storage = this.resolveStorage(options);
    this.embedder = this.resolveEmbedder(options);
    this.llmFn = this.resolveLLM(options);
    this.initPromise = this.initialize();
  }

  // ─── Resolvers ──────────────────────────────────────────────────────────

  private resolveStorage(options: MemoryOptions): StorageAdapter {
    const storageOption = options.storage ?? 'sqlite';

    if (typeof storageOption === 'object') {
      validateCustomAdapter(storageOption);
      return storageOption;
    }

    switch (storageOption) {
      case 'sqlite':
        return new SQLiteStorageAdapter(options.dbPath ?? DEFAULT_DB_PATH);
      case 'turso':
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
    if (typeof embedderOption === 'function') return createCustomEmbedder(embedderOption);

    switch (embedderOption) {
      case 'local':
        return createLocalEmbedder(options.embeddingModel);
      case 'openai': {
        if (!options.openaiApiKey) {
          throw new Error('[semantic-recall] OpenAI embedder requires `openaiApiKey` in options.');
        }
        return createOpenAIEmbedder(options.openaiApiKey, options.embeddingModel);
      }
      default:
        throw new Error(`[semantic-recall] Unknown embedder: ${embedderOption}`);
    }
  }

  private resolveLLM(options: MemoryOptions): LLMFunction | null {
    if (!options.llmProvider) return null;
    if (typeof options.llmProvider === 'function') return options.llmProvider;

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
          apiKey, options.llmModel ?? 'gemini-2.0-flash',
          'https://generativelanguage.googleapis.com/v1beta/openai/',
        );
      case 'claude':
        return this.createOpenAICompatibleLLM(
          apiKey, options.llmModel ?? 'claude-sonnet-4-20250514',
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
        model, messages: [{ role: 'user', content: prompt }], temperature: 0,
      });
      return response.choices[0]?.message?.content ?? '[]';
    };
  }

  private createOpenAICompatibleLLM(apiKey: string, model: string, baseURL: string): LLMFunction {
    return async (prompt: string): Promise<string> => {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey, baseURL });
      const response = await client.chat.completions.create({
        model, messages: [{ role: 'user', content: prompt }], temperature: 0,
      });
      return response.choices[0]?.message?.content ?? '[]';
    };
  }

  // ─── Initialization ───────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    try {
      await this.storage.init();
      await this.storage.resetStaleProcessing();
      await this.replayPendingJobs();
      this.startRetryScheduler();
      this.initialized = true;
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err));
      console.error('[semantic-recall] Initialization error:', err);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initError) throw this.initError;
    if (!this.initialized) await this.initPromise;
    if (this.initError) throw this.initError; // catch race where init just settled
  }

  // ─── Replay & Retry ───────────────────────────────────────────────────

  private async replayPendingJobs(): Promise<void> {
    try {
      const retryable = await this.storage.getRetryable();
      for (const job of retryable) {
        void injectBackground({
          jobId: job.id, userId: job.userId, namespace: job.namespace,
          content: job.content, dedupThreshold: this.dedupThreshold,
          embedder: this.embedder, storage: this.storage,
          replayed: true, retried: job.attempts > 0,
        }, this);
      }
    } catch { /* best-effort */ }
  }

  private startRetryScheduler(): void {
    this.retryTimer = setInterval(async () => {
      try {
        const retryable = await this.storage.getRetryable();
        for (const job of retryable) {
          void injectBackground({
            jobId: job.id, userId: job.userId, namespace: job.namespace,
            content: job.content, dedupThreshold: this.dedupThreshold,
            embedder: this.embedder, storage: this.storage, retried: true,
          }, this);
        }
      } catch { /* best-effort */ }
    }, this.retryIntervalMs);

    if (this.retryTimer && typeof this.retryTimer === 'object' && 'unref' in this.retryTimer) {
      this.retryTimer.unref();
    }
  }

  /** Resolve TTL: per-call > defaultTtl > undefined */
  private resolveTtl(options?: RememberOptions): string | number | undefined {
    if (options?.ttl === null) return undefined; // explicit permanent
    return options?.ttl ?? this.defaultTtl;
  }

  // ─── Public API: remember() ───────────────────────────────────────────

  /**
   * Enqueue a text for background embedding and storage.
   *
   * **Note:** `remember()` is fire-and-forget and will silently swallow
   * initialization errors. Use `rememberAndWait()` if you need to
   * detect initialization failures.
   */
  remember(text: string, options?: RememberOptions): void {
    void (async () => {
      try {
        await this.ensureInitialized();
        const namespace = options?.namespace ?? this.namespace;
        const jobId = await this.storage.enqueue({
          userId: this.userId, namespace, content: text, maxAttempts: this.maxAttempts,
          ttl: this.resolveTtl(options), tags: options?.tags,
        });
        void injectBackground({
          jobId, userId: this.userId, namespace, content: text,
          ttl: this.resolveTtl(options), dedupThreshold: this.dedupThreshold,
          embedder: this.embedder, storage: this.storage, tags: options?.tags,
        }, this);
      } catch { /* never throw */ }
    })();
  }

  async rememberAndWait(text: string, options?: RememberOptions): Promise<RememberResult> {
    await this.ensureInitialized();
    const namespace = options?.namespace ?? this.namespace;
    const jobId = await this.storage.enqueue({
      userId: this.userId, namespace, content: text, maxAttempts: this.maxAttempts,
      ttl: this.resolveTtl(options), tags: options?.tags,
    });
    return injectBackground({
      jobId, userId: this.userId, namespace, content: text,
      ttl: this.resolveTtl(options), dedupThreshold: this.dedupThreshold,
      embedder: this.embedder, storage: this.storage, tags: options?.tags,
    }, this);
  }

  /**
   * Store multiple memories with partial-failure resilience.
   *
   * Memories are processed **sequentially** so that intra-batch
   * deduplication works correctly. For large batches (100+ items),
   * consider chunking or using `import()` for pre-embedded data.
   */
  async rememberMany(
    texts: string[],
    options?: RememberOptions,
  ): Promise<BatchRememberResult> {
    await this.ensureInitialized();

    // Sequential execution: each insert completes before the next starts,
    // so cross-store dedup naturally catches intra-batch duplicates.
    let saved = 0, duplicates = 0, errors = 0;
    for (const text of texts) {
      try {
        const result = await this.rememberAndWait(text, options);
        if (result.saved) saved++;
        if (result.duplicate) duplicates++;
      } catch {
        errors++;
      }
    }

    return { total: texts.length, saved, duplicates, errors };
  }

  // ─── Public API: recall() ─────────────────────────────────────────────

  async recall(query: string, options?: RecallOptions): Promise<string[]> {
    await this.ensureInitialized();
    return recallContents({
      query, userId: this.userId,
      namespace: options?.namespace ?? this.namespace,
      recallThreshold: options?.threshold ?? this.recallThreshold,
      topK: options?.topK ?? this.topK,
      embedder: this.embedder, storage: this.storage,
      after: options?.after, before: options?.before, tags: options?.tags,
    });
  }

  async recallDetailed(query: string, options?: RecallOptions): Promise<MemoryResult[]> {
    await this.ensureInitialized();
    return recallMemories({
      query, userId: this.userId,
      namespace: options?.namespace ?? this.namespace,
      recallThreshold: options?.threshold ?? this.recallThreshold,
      topK: options?.topK ?? this.topK,
      embedder: this.embedder, storage: this.storage,
      after: options?.after, before: options?.before, tags: options?.tags,
    });
  }

  // ─── Public API: Memory Management ────────────────────────────────────

  async forget(memoryId: number): Promise<void> {
    await this.ensureInitialized();
    await this.storage.deleteMemory(memoryId);
  }

  async forgetAll(options?: { namespace?: string }): Promise<void> {
    await this.ensureInitialized();
    await this.storage.deleteAllMemories(this.userId, options?.namespace ?? this.namespace);
  }

  async list(options?: { namespace?: string; limit?: number }): Promise<MemoryResult[]> {
    await this.ensureInitialized();
    const rows = await this.storage.listMemories(
      this.userId, options?.namespace ?? this.namespace, options?.limit ?? 100,
    );
    return rows.map(row => ({
      id: row.id, content: row.content, similarity: 1.0,
      createdAt: row.created_at, expiresAt: row.expires_at,
      tags: parseTags(row.tags),
      recallCount: row.recall_count ?? 0,
    }));
  }

  /**
   * Update a memory's content in-place (re-embeds automatically).
   */
  async update(memoryId: number, newContent: string, tags?: string[]): Promise<void> {
    await this.ensureInitialized();
    const existing = await this.storage.getMemoryById(memoryId);
    if (!existing) throw new Error(`[semantic-recall] Memory ${memoryId} not found.`);
    const embedding = await this.embedder(newContent);
    const params: UpdateMemoryParams = { content: newContent, embedding };
    if (tags !== undefined) params.tags = tags;
    await this.storage.updateMemory(memoryId, params);
  }

  /**
   * Find memories related to a given memory by semantic similarity.
   * Hard-capped at 5,000 candidate memories for performance safety.
   */
  async related(memoryId: number, options?: RelatedOptions): Promise<MemoryResult[]> {
    await this.ensureInitialized();

    const source = await this.storage.getMemoryById(memoryId);
    if (!source) throw new Error(`[semantic-recall] Memory ${memoryId} not found.`);

    const sourceVector = parseEmbedding(source.embedding);
    const threshold = options?.threshold ?? this.recallThreshold;
    const topK = options?.topK ?? this.topK;

    // Resolve candidates based on crossNamespace option
    let candidates;
    if (options?.crossNamespace) {
      candidates = await this.storage.getAllMemories(this.userId);
    } else {
      const ns = options?.namespace ?? source.namespace;
      candidates = await this.storage.listMemories(this.userId, ns, RELATED_HARD_CAP);
    }

    // Enforce hard cap + explicit recency sort
    candidates = candidates
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, RELATED_HARD_CAP);

    const scored: MemoryResult[] = [];
    for (const row of candidates) {
      if (row.id === memoryId) continue; // exclude self

      let storedVector: number[];
      try { storedVector = parseEmbedding(row.embedding); } catch { continue; }
      if (storedVector.length !== sourceVector.length) continue;

      const similarity = cosineSimilarity(sourceVector, storedVector);
      if (similarity >= threshold) {
        scored.push({
          id: row.id, content: row.content, similarity,
          createdAt: row.created_at, expiresAt: row.expires_at,
          tags: parseTags(row.tags),
          recallCount: row.recall_count ?? 0,
        });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  /** List distinct namespaces for this user. */
  async listNamespaces(): Promise<string[]> {
    await this.ensureInitialized();
    return this.storage.listNamespaces(this.userId);
  }

  /** Get aggregate stats for this user. */
  async stats(): Promise<AdapterStats> {
    await this.ensureInitialized();
    return this.storage.getStats(this.userId);
  }

  // ─── Public API: Import/Export ─────────────────────────────────────────

  /**
   * Export memories for this user as a portable JSON structure.
   * Optionally filter to a single namespace.
   *
   * **Note:** Namespace-scoped exports are capped at 5,000 memories.
   * Full exports (no namespace filter) have no cap.
   */
  async export(options?: { namespace?: string }): Promise<ExportData> {
    await this.ensureInitialized();

    let allMemories;
    if (options?.namespace) {
      allMemories = await this.storage.listMemories(this.userId, options.namespace, RELATED_HARD_CAP);
    } else {
      allMemories = await this.storage.getAllMemories(this.userId);
    }

    return {
      version: 1,
      exportedAt: nowISO(),
      userId: this.userId,
      memories: allMemories.map(row => ({
        content: row.content,
        namespace: row.namespace,
        embedding: parseEmbedding(row.embedding),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        tags: parseTags(row.tags),
      })),
    };
  }

  /**
   * Import memories from a previously exported JSON structure.
   * Validates embedding dimensions against existing data before inserting.
   */
  async import(data: ExportData): Promise<{ imported: number }> {
    await this.ensureInitialized();

    if (data.version !== 1) {
      throw new Error(`[semantic-recall] Unsupported export version: ${data.version}`);
    }

    // Dimension validation — embed a test string to compare against import data.
    // This works even on an empty database (unlike checking existing memories).
    if (data.memories.length > 0) {
      const testEmbedding = await this.embedder('dimension check');
      const importDim = data.memories[0]!.embedding.length;
      if (testEmbedding.length !== importDim) {
        throw new Error(
          `[semantic-recall] Dimension mismatch: current embedder produces ${testEmbedding.length} dimensions ` +
          `but imported data has ${importDim}. Cannot mix embedding models.`
        );
      }
    }

    const params = data.memories.map(m => ({
      userId: this.userId,
      namespace: m.namespace,
      content: m.content,
      embedding: m.embedding,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
      tags: m.tags,
    }));

    const ids = await this.storage.bulkInsertMemories(params);
    return { imported: ids.length };
  }

  // ─── Public API: Dead Jobs ────────────────────────────────────────────

  async getDeadJobs(): Promise<MemoryJob[]> {
    await this.ensureInitialized();
    return this.storage.getDeadJobs(this.userId);
  }

  async retryDead(jobId: number): Promise<void> {
    await this.ensureInitialized();
    await this.storage.retryDeadJob(jobId);
    const retryable = await this.storage.getRetryable();
    const job = retryable.find(j => j.id === jobId);
    if (job) {
      void injectBackground({
        jobId: job.id, userId: job.userId, namespace: job.namespace,
        content: job.content, dedupThreshold: this.dedupThreshold,
        embedder: this.embedder, storage: this.storage, retried: true,
      }, this);
    }
  }

  async cleanup(options?: { olderThan?: string }): Promise<{ deleted: number }> {
    await this.ensureInitialized();
    const ageMs = options?.olderThan ? parseTTL(options.olderThan) : DEFAULT_CLEANUP_AGE_MS;
    const deleted = await this.storage.cleanupDoneJobs(ageMs);
    return { deleted };
  }

  // ─── Public API: Auto-extraction ──────────────────────────────────────

  /**
   * Extract memorable facts from a conversation using an LLM,
   * then enqueue each for background embedding.
   *
   * **Note:** Facts are enqueued asynchronously via `remember()`.
   * When this method's Promise resolves, facts are queued but
   * not yet embedded or stored. Listen for `memory:saved` events
   * or call `recall()` after a short delay.
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

    const formatted = conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n');
    const response = await this.llmFn(EXTRACTION_PROMPT + formatted);

    let facts: string[];
    try {
      const parsed: unknown = JSON.parse(response);
      if (!Array.isArray(parsed)) return;
      facts = parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    } catch { return; }

    for (const fact of facts) {
      this.remember(fact.trim(), options);
    }
  }

  // ─── Aliases (bound for safe destructuring) ──────────────────────────

  /** Alias for `recall()` — semantic search returning content strings. */
  readonly search = (query: string, options?: RecallOptions) => this.recall(query, options);

  /** Alias for `recallDetailed()` — semantic search with scores and metadata. */
  readonly searchDetailed = (query: string, options?: RecallOptions) => this.recallDetailed(query, options);

  /** Alias for `recallDetailed()` — search with similarity sources. */
  readonly recallWithSources = (query: string, options?: RecallOptions) => this.recallDetailed(query, options);

  // ─── Lifecycle ────────────────────────────────────────────────────────

  destroy(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    try { this.storage.close(); } catch { /* best-effort */ }
    this.removeAllListeners();
  }

  // ─── Typed EventEmitter Overrides ─────────────────────────────────────

  override on<K extends keyof MemoryEventMap>(
    event: K, listener: (payload: MemoryEventMap[K]) => void,
  ): this { return super.on(event, listener); }

  override emit<K extends keyof MemoryEventMap>(
    event: K, payload: MemoryEventMap[K],
  ): boolean { return super.emit(event, payload); }
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export type {
  MemoryOptions, RememberOptions, RecallOptions, MemoryResult,
  RememberResult, BatchRememberResult, MemoryJob, StorageAdapter,
  EmbedderFunction, ConversationMessage, LLMFunction, MemorySavedEvent,
  MemoryRetryEvent, MemoryDeadEvent, MemoryEventMap, InsertMemoryParams,
  SearchParams, RawMemoryRow, NewJob, JobStatus, ExportData,
  RelatedOptions, AdapterStats, UpdateMemoryParams,
} from './types.js';

export { BaseStorageAdapter } from './adapters/storage/base.js';
export { SQLiteStorageAdapter } from './adapters/storage/sqlite.js';
export { createLocalEmbedder } from './adapters/embedder/local.js';
export { createOpenAIEmbedder } from './adapters/embedder/openai.js';
export { createCustomEmbedder } from './adapters/embedder/custom.js';
export { cosineSimilarity, parseTTL } from './utils.js';
