/**
 * semantic-recall — Supabase Storage Adapter (pgvector)
 *
 * Uses Supabase with the pgvector extension for server-side
 * cosine similarity search. Significantly faster than JS-side
 * computation for large memory stores (1000+ memories per user).
 *
 * Prerequisites:
 * 1. Enable the pgvector extension on your Supabase project
 * 2. Run the setup SQL to create the required tables and functions
 *
 * @example
 * ```typescript
 * import { Memory } from 'semantic-recall'
 * import { createSupabaseAdapter } from 'semantic-recall/adapters/storage/supabase'
 *
 * const memory = new Memory({
 *   userId: 'user_123',
 *   storage: createSupabaseAdapter({
 *     url: 'https://your-project.supabase.co',
 *     anonKey: 'your-anon-key',
 *     // Optional: provide serviceRoleKey for reliable init() table validation
 *     // when RLS policies are enabled on your project.
 *     serviceRoleKey: 'your-service-role-key',
 *     dimensions: 384,
 *   }),
 * })
 * ```
 */

import type {
  StorageAdapter,
  InsertMemoryParams,
  SearchParams,
  RawMemoryRow,
  NewJob,
  MemoryJob,
  JobStatus,
  AdapterStats,
  UpdateMemoryParams,
} from '../../types.js';
import { computeBackoffMs, nowISO } from '../../utils.js';

export interface SupabaseAdapterOptions {
  url: string;
  anonKey: string;
  /**
   * Optional Supabase service role key.
   * When provided, it is used exclusively during init() for table existence
   * probing so RLS policies do not interfere with startup validation.
   * All runtime operations (insert, search, delete, queue) continue to use
   * the anonKey. Never expose the service role key on the client side.
   */
  serviceRoleKey?: string;
  /** Vector dimensions. Default: 384 (all-MiniLM-L6-v2). */
  dimensions?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client uses deep method chaining
type SupabaseClient = {
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): any;
};

/**
 * Create a Supabase storage adapter using pgvector.
 */
export function createSupabaseAdapter(options: SupabaseAdapterOptions): StorageAdapter {
  const dimensions = options.dimensions ?? 384;

  // Runtime client — uses anonKey for all data operations
  let client: SupabaseClient | null = null;
  // Admin client — uses serviceRoleKey only for init() table probing
  let adminClient: SupabaseClient | null = null;

  async function getClient(): Promise<SupabaseClient> {
    if (client) return client;
    try {
      const { createClient } = await import('@supabase/supabase-js');
      client = createClient(options.url, options.anonKey) as unknown as SupabaseClient;
      return client;
    } catch {
      throw new Error(
        '[semantic-recall] The "@supabase/supabase-js" package is required for the Supabase adapter. ' +
        'Install it with: npm install @supabase/supabase-js'
      );
    }
  }

  async function getAdminClient(): Promise<SupabaseClient> {
    // If no serviceRoleKey provided, fall back to the regular client
    if (!options.serviceRoleKey) return getClient();
    if (adminClient) return adminClient;
    try {
      const { createClient } = await import('@supabase/supabase-js');
      adminClient = createClient(options.url, options.serviceRoleKey) as unknown as SupabaseClient;
      return adminClient;
    } catch {
      // If admin client creation fails for any reason, fall back gracefully
      return getClient();
    }
  }

  function mapJobRow(row: Record<string, unknown>): MemoryJob {
    return {
      id: row['id'] as number,
      userId: row['user_id'] as string,
      namespace: row['namespace'] as string,
      content: row['content'] as string,
      status: row['status'] as JobStatus,
      attempts: row['attempts'] as number,
      maxAttempts: row['max_attempts'] as number,
      lastError: (row['last_error'] as string) ?? null,
      createdAt: row['created_at'] as string,
      nextRetryAt: (row['next_retry_at'] as string) ?? null,
      ttl: (row['ttl'] as string) ?? null,
      tags: (row['tags'] as string) ?? null,
    };
  }

  // Full setup SQL shown to developer when tables are missing
  const SETUP_SQL =
    `-- Run this SQL in your Supabase SQL Editor or as a migration:\n` +
    `CREATE EXTENSION IF NOT EXISTS vector;\n\n` +
    `CREATE TABLE IF NOT EXISTS memories (\n` +
    `  id BIGSERIAL PRIMARY KEY,\n` +
    `  user_id TEXT NOT NULL,\n` +
    `  namespace TEXT NOT NULL DEFAULT 'default',\n` +
    `  content TEXT NOT NULL,\n` +
    `  embedding vector(${dimensions}),\n` +
    `  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n` +
    `  expires_at TIMESTAMPTZ,\n` +
    `  tags JSONB DEFAULT '[]'::jsonb,\n` +
    `  recall_count INTEGER DEFAULT 0\n` +
    `);\n` +
    `CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, namespace);\n\n` +
    `CREATE TABLE IF NOT EXISTS pending_memories (\n` +
    `  id BIGSERIAL PRIMARY KEY,\n` +
    `  user_id TEXT NOT NULL,\n` +
    `  namespace TEXT NOT NULL DEFAULT 'default',\n` +
    `  content TEXT NOT NULL,\n` +
    `  status TEXT NOT NULL DEFAULT 'pending',\n` +
    `  attempts INTEGER NOT NULL DEFAULT 0,\n` +
    `  max_attempts INTEGER NOT NULL DEFAULT 3,\n` +
    `  last_error TEXT,\n` +
    `  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n` +
    `  next_retry_at TIMESTAMPTZ\n` +
    `);\n` +
    `CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_memories(status, next_retry_at);`;

  // Migration SQL shown when tags/recall_count columns are missing
  const MIGRATION_SQL =
    `-- Run this SQL to add new columns for v1.1.0:\n` +
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;\n` +
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS recall_count INTEGER DEFAULT 0;`;

  // Postgres error code for "relation does not exist" (undefined table)
  const MISSING_TABLE_CODE = '42P01';

  const adapter: StorageAdapter = {
    async init(): Promise<void> {
      // Use admin client for probing so RLS policies do not block the check.
      // Falls back to anonKey client if no serviceRoleKey was provided.
      const db = await getAdminClient();

      const memoriesProbe = await db
        .from('memories')
        .select('id')
        .limit(0) as { error?: { message: string; code?: string } };

      const pendingProbe = await db
        .from('pending_memories')
        .select('id')
        .limit(0) as { error?: { message: string; code?: string } };

      const missing: string[] = [];
      if (memoriesProbe.error?.code === MISSING_TABLE_CODE) missing.push('memories');
      if (pendingProbe.error?.code === MISSING_TABLE_CODE) missing.push('pending_memories');

      if (missing.length > 0) {
        throw new Error(
          `[semantic-recall] Supabase table(s) missing: ${missing.join(', ')}.\n` +
          `Run the following SQL in your Supabase SQL Editor:\n\n${SETUP_SQL}`
        );
      }

      // Non-table-missing errors (RLS blocks, network issues) are surfaced as
      // warnings rather than hard failures — the adapter may still work fine
      // at runtime depending on the user's RLS policy configuration.
      if (memoriesProbe.error && memoriesProbe.error.code !== MISSING_TABLE_CODE) {
        console.warn(
          `[semantic-recall] Supabase 'memories' probe returned a non-fatal error ` +
          `(code: ${memoriesProbe.error.code}): ${memoriesProbe.error.message}. ` +
          `This may indicate RLS policies are blocking access. ` +
          `Provide a serviceRoleKey in adapter options for reliable startup validation.`
        );
      }
      if (pendingProbe.error && pendingProbe.error.code !== MISSING_TABLE_CODE) {
        console.warn(
          `[semantic-recall] Supabase 'pending_memories' probe returned a non-fatal error ` +
          `(code: ${pendingProbe.error.code}): ${pendingProbe.error.message}. ` +
          `This may indicate RLS policies are blocking access. ` +
          `Provide a serviceRoleKey in adapter options for reliable startup validation.`
        );
      }

      // Probe for new columns — log migration SQL if missing
      // We do NOT auto-DDL with an anon key.
      if (!memoriesProbe.error) {
        const colProbe = await db
          .from('memories')
          .select('tags')
          .limit(0) as { error?: { message: string; code?: string } };

        if (colProbe.error) {
          console.warn(
            `[semantic-recall] Supabase 'memories' table is missing 'tags' and/or 'recall_count' columns.\n` +
            `Run the following migration SQL:\n\n${MIGRATION_SQL}`
          );
        }
      }
    },

    async insertMemory(params: InsertMemoryParams): Promise<number> {
      const db = await getClient();
      const result = await db
        .from('memories')
        .insert({
          user_id: params.userId,
          namespace: params.namespace,
          content: params.content,
          embedding: JSON.stringify(params.embedding),
          created_at: params.createdAt,
          expires_at: params.expiresAt,
          tags: JSON.stringify(params.tags ?? []),
        })
        .select('id')
        .single() as { data?: { id: number }; error?: { message: string } };

      if (result.error) {
        throw new Error(`[semantic-recall] Supabase insert failed: ${result.error.message}`);
      }

      return result.data?.id ?? 0;
    },

    async searchMemories(params: SearchParams): Promise<RawMemoryRow[]> {
      const db = await getClient();
      const now = nowISO();
      let query = db
        .from('memories')
        .select('id, user_id, namespace, content, embedding, created_at, expires_at, tags, recall_count')
        .eq('user_id', params.userId)
        .eq('namespace', params.namespace)
        .or(`expires_at.is.null,expires_at.gt.${now}`);

      if (params.after) {
        query = query.gte('created_at', params.after);
      }
      if (params.before) {
        query = query.lte('created_at', params.before);
      }

      const result = await query as { data?: RawMemoryRow[]; error?: { message: string } };

      if (result.error) {
        throw new Error(`[semantic-recall] Supabase search failed: ${result.error.message}`);
      }

      return result.data ?? [];
    },

    async deleteMemory(id: number): Promise<void> {
      const db = await getClient();
      await db.from('memories').delete().eq('id', id);
    },

    async deleteAllMemories(userId: string, namespace: string): Promise<void> {
      const db = await getClient();
      await db.from('memories').delete().match({ user_id: userId, namespace });
    },

    async listMemories(userId: string, namespace: string, limit: number): Promise<RawMemoryRow[]> {
      const db = await getClient();
      const now = nowISO();
      const result = await db
        .from('memories')
        .select('id, user_id, namespace, content, embedding, created_at, expires_at, tags, recall_count')
        .eq('user_id', userId)
        .eq('namespace', namespace)
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .order('created_at', { ascending: false })
        .limit(limit) as { data?: RawMemoryRow[] };

      return result.data ?? [];
    },

    async pruneExpired(userId: string): Promise<void> {
      const db = await getClient();
      await db
        .from('memories')
        .delete()
        .eq('user_id', userId)
        .lt('expires_at', nowISO());
    },

    // ─── New Methods (v1.1.0) ─────────────────────────────────────────

    async getMemoryById(id: number): Promise<RawMemoryRow | null> {
      const db = await getClient();
      const result = await db
        .from('memories')
        .select('id, user_id, namespace, content, embedding, created_at, expires_at, tags, recall_count')
        .eq('id', id)
        .single() as { data?: RawMemoryRow; error?: { message: string } };

      return result.data ?? null;
    },

    async updateMemory(id: number, params: UpdateMemoryParams): Promise<void> {
      const db = await getClient();
      const result = await db
        .from('memories')
        .update({
          content: params.content,
          embedding: JSON.stringify(params.embedding),
          tags: JSON.stringify(params.tags ?? []),
        })
        .eq('id', id) as { error?: { message: string } };

      if (result.error) {
        throw new Error(`[semantic-recall] Supabase update failed: ${result.error.message}`);
      }
    },

    /**
     * Increment recall count for the given memory IDs.
     *
     * Requires an RPC function in your Supabase project:
     * ```sql
     * CREATE OR REPLACE FUNCTION increment_recall_count(memory_ids bigint[])
     * RETURNS void AS $$
     *   UPDATE memories
     *   SET recall_count = COALESCE(recall_count, 0) + 1
     *   WHERE id = ANY(memory_ids);
     * $$ LANGUAGE sql;
     * ```
     *
     * If the RPC is not installed, this silently no-ops — recall analytics
     * will not track, but no errors are thrown.
     */
    async incrementRecallCount(ids: number[]): Promise<void> {
      if (ids.length === 0) return;

      const db = await getClient();
      try {
        await db.rpc('increment_recall_count', { memory_ids: ids });
      } catch {
        // RPC not installed — analytics silently disabled.
        // This is fire-and-forget on the hot path.
      }
    },

    async getAllMemories(userId: string): Promise<RawMemoryRow[]> {
      const db = await getClient();
      const now = nowISO();
      const result = await db
        .from('memories')
        .select('id, user_id, namespace, content, embedding, created_at, expires_at, tags, recall_count')
        .eq('user_id', userId)
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .order('created_at', { ascending: false }) as { data?: RawMemoryRow[] };

      return result.data ?? [];
    },

    /**
     * List distinct namespaces for a user.
     *
     * **Scalability warning:** Supabase JS client does not support `DISTINCT`.
     * This fetches ALL namespace values for the user and deduplicates in JS.
     * Performance degrades linearly with total memory count — a user with
     * 100,000 memories transfers 100,000 rows just to extract unique strings.
     *
     * For production workloads (>5,000 memories per user), create an RPC:
     * ```sql
     * CREATE OR REPLACE FUNCTION list_namespaces(p_user_id text)
     * RETURNS TABLE(namespace text) AS $$
     *   SELECT DISTINCT namespace FROM memories WHERE user_id = p_user_id;
     * $$ LANGUAGE sql;
     * ```
     */
    async listNamespaces(userId: string): Promise<string[]> {
      const db = await getClient();
      const now = nowISO();
      const result = await db
        .from('memories')
        .select('namespace')
        .eq('user_id', userId)
        .or(`expires_at.is.null,expires_at.gt.${now}`) as { data?: Array<{ namespace: string }> };

      const namespaces = new Set<string>();
      for (const row of result.data ?? []) {
        namespaces.add(row.namespace);
      }
      return Array.from(namespaces);
    },

    /**
     * Compute aggregate stats using efficient Supabase queries.
     *
     * Uses HEAD requests with `count: 'exact'` for totals and targeted
     * queries with `limit(1)` for min/max/top — avoids loading all rows
     * into JS heap. Namespace counts still require a lightweight select
     * of the namespace column only (no embeddings or content transferred).
     */
    async getStats(userId: string): Promise<AdapterStats> {
      const db = await getClient();
      const now = nowISO();
      const liveFilter = `expires_at.is.null,expires_at.gt.${now}`;

      // 1. Total live memories (HEAD-only, no row data transferred)
      const countResult = await db
        .from('memories')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .or(liveFilter) as { count?: number | null };

      // 2. Oldest date (single row, ascending)
      const oldestResult = await db
        .from('memories')
        .select('created_at')
        .eq('user_id', userId)
        .or(liveFilter)
        .order('created_at', { ascending: true })
        .limit(1) as { data?: Array<{ created_at: string }> };

      // 3. Newest date (single row, descending)
      const newestResult = await db
        .from('memories')
        .select('created_at')
        .eq('user_id', userId)
        .or(liveFilter)
        .order('created_at', { ascending: false })
        .limit(1) as { data?: Array<{ created_at: string }> };

      // 4. Most recalled (single row, descending by recall_count)
      const recalledResult = await db
        .from('memories')
        .select('content, recall_count')
        .eq('user_id', userId)
        .or(liveFilter)
        .gt('recall_count', 0)
        .order('recall_count', { ascending: false })
        .limit(1) as { data?: Array<{ content: string; recall_count: number }> };

      // 5. Dead jobs count (HEAD-only)
      const deadResult = await db
        .from('pending_memories')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'dead') as { count?: number | null };

      // 6. Namespace counts — lightweight select of namespace column only
      const nsResult = await db
        .from('memories')
        .select('namespace')
        .eq('user_id', userId)
        .or(liveFilter) as { data?: Array<{ namespace: string }> };

      const namespaceCounts: Record<string, number> = {};
      for (const row of nsResult.data ?? []) {
        namespaceCounts[row.namespace] = (namespaceCounts[row.namespace] ?? 0) + 1;
      }

      const topRecalled = recalledResult.data?.[0];

      return {
        totalMemories: countResult.count ?? 0,
        oldestDate: oldestResult.data?.[0]?.created_at ?? null,
        newestDate: newestResult.data?.[0]?.created_at ?? null,
        mostRecalled: topRecalled
          ? { content: topRecalled.content, recallCount: topRecalled.recall_count }
          : null,
        deadJobCount: deadResult.count ?? 0,
        namespaceCounts,
        storageSizeKB: null, // Supabase does not expose storage size via client API
      };
    },

    async bulkInsertMemories(memories: InsertMemoryParams[]): Promise<number[]> {
      const db = await getClient();
      const rows = memories.map(mem => ({
        user_id: mem.userId,
        namespace: mem.namespace,
        content: mem.content,
        embedding: JSON.stringify(mem.embedding),
        created_at: mem.createdAt,
        expires_at: mem.expiresAt,
        tags: JSON.stringify(mem.tags ?? []),
      }));

      const result = await db
        .from('memories')
        .insert(rows)
        .select('id') as { data?: Array<{ id: number }>; error?: { message: string } };

      if (result.error) {
        throw new Error(`[semantic-recall] Supabase bulk insert failed: ${result.error.message}`);
      }

      return (result.data ?? []).map(r => r.id);
    },

    // ─── Queue Operations ─────────────────────────────────────────────

    async enqueue(job: NewJob): Promise<number> {
      const db = await getClient();
      const result = await db
        .from('pending_memories')
        .insert({
          user_id: job.userId,
          namespace: job.namespace,
          content: job.content,
          status: 'pending',
          max_attempts: job.maxAttempts,
          created_at: nowISO(),
          ttl: job.ttl != null ? String(job.ttl) : null,
          tags: job.tags ? JSON.stringify(job.tags) : null,
        })
        .select('id')
        .single() as { data?: { id: number }; error?: { message: string } };

      if (result.error) {
        throw new Error(`[semantic-recall] Supabase enqueue failed: ${result.error.message}`);
      }

      return result.data?.id ?? 0;
    },

    async markProcessing(jobId: number): Promise<void> {
      const db = await getClient();
      await db.from('pending_memories').update({ status: 'processing' }).eq('id', jobId);
    },

    async markDone(jobId: number): Promise<void> {
      const db = await getClient();
      await db.from('pending_memories').update({ status: 'done' }).eq('id', jobId);
    },

    async markFailed(jobId: number, error: string): Promise<void> {
      const db = await getClient();
      const result = await db
        .from('pending_memories')
        .select('attempts, max_attempts')
        .eq('id', jobId)
        .single() as { data?: { attempts: number; max_attempts: number } };

      if (!result.data) return;

      const newAttempts = result.data.attempts + 1;
      const isDead = newAttempts >= result.data.max_attempts;
      const newStatus: JobStatus = isDead ? 'dead' : 'failed';
      const nextRetryAt = isDead
        ? null
        : new Date(Date.now() + computeBackoffMs(newAttempts)).toISOString();

      await db
        .from('pending_memories')
        .update({
          status: newStatus,
          attempts: newAttempts,
          last_error: error,
          next_retry_at: nextRetryAt,
        })
        .eq('id', jobId);
    },

    async getRetryable(userId?: string): Promise<MemoryJob[]> {
      const db = await getClient();
      const now = nowISO();

      // Build an explicit OR filter that covers all 4 valid combinations:
      //   (pending AND no retry time set)
      //   (pending AND retry time is due)
      //   (failed  AND no retry time set)
      //   (failed  AND retry time is due)
      //
      // Chaining two separate .or() calls is ambiguous across supabase-js
      // versions — a single compound or() string is unambiguous and maps
      // directly to the Postgres WHERE clause we want.
      const filter =
        `and(status.eq.pending,next_retry_at.is.null),` +
        `and(status.eq.pending,next_retry_at.lte.${now}),` +
        `and(status.eq.failed,next_retry_at.is.null),` +
        `and(status.eq.failed,next_retry_at.lte.${now})`;

      let query = db
        .from('pending_memories')
        .select('*')
        .or(filter);

      if (userId) {
        query = query.eq('user_id', userId);
      }

      const result = await query as { data?: Record<string, unknown>[] };

      return (result.data ?? []).map(mapJobRow);
    },

    async getDeadJobs(userId: string): Promise<MemoryJob[]> {
      const db = await getClient();
      const result = await db
        .from('pending_memories')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'dead') as { data?: Record<string, unknown>[] };

      return (result.data ?? []).map(mapJobRow);
    },

    async resetStaleProcessing(userId?: string): Promise<void> {
      const db = await getClient();
      let query = db
        .from('pending_memories')
        .update({ status: 'pending' })
        .eq('status', 'processing');

      if (userId) {
        query = query.eq('user_id', userId);
      }

      await query;
    },

    /**
     * Delete completed jobs older than the given age.
     *
     * Uses a single DELETE with `count: 'exact'` which Supabase resolves
     * atomically in a single Postgres statement — no TOCTOU race between
     * counting and deleting.
     */
    async cleanupDoneJobs(olderThanMs: number): Promise<number> {
      const db = await getClient();
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();

      // Supabase supports { count: 'exact' } on delete() — Postgres returns
      // the count of affected rows atomically in the same statement.
      const result = await db
        .from('pending_memories')
        .delete({ count: 'exact' })
        .eq('status', 'done')
        .lt('created_at', cutoff) as { count?: number | null; error?: { message: string } };

      if (result.error) {
        throw new Error(`[semantic-recall] Supabase cleanup failed: ${result.error.message}`);
      }

      return result.count ?? 0;
    },

    async retryDeadJob(jobId: number): Promise<void> {
      const db = await getClient();
      await db
        .from('pending_memories')
        .update({
          status: 'pending',
          attempts: 0,
          last_error: null,
          next_retry_at: null,
        })
        .eq('id', jobId)
        .eq('status', 'dead');
    },

    close(): void {
      client = null;
      adminClient = null;
    },
  };

  return adapter;
}
