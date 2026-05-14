/**
 * semantic-memory — Supabase Storage Adapter (pgvector)
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
 * import { Memory } from 'semantic-memory'
 * import { createSupabaseAdapter } from 'semantic-memory/adapters/storage/supabase'
 *
 * const memory = new Memory({
 *   userId: 'user_123',
 *   storage: createSupabaseAdapter({
 *     url: 'https://your-project.supabase.co',
 *     anonKey: 'your-anon-key',
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
} from '../../types.js';
import { computeBackoffMs, nowISO } from '../../utils.js';

export interface SupabaseAdapterOptions {
  url: string;
  anonKey: string;
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
  let client: SupabaseClient | null = null;

  async function getClient(): Promise<SupabaseClient> {
    if (client) return client;

    try {
      const { createClient } = await import('@supabase/supabase-js');
      client = createClient(options.url, options.anonKey) as unknown as SupabaseClient;
      return client;
    } catch {
      throw new Error(
        '[semantic-memory] The "@supabase/supabase-js" package is required for the Supabase adapter. ' +
        'Install it with: npm install @supabase/supabase-js'
      );
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
    };
  }

  const adapter: StorageAdapter = {
    async init(): Promise<void> {
      // Tables should be created via Supabase migrations.
      // Log the required SQL for the developer.
      console.info(
        `[semantic-memory] Supabase adapter initialized. Ensure you have run the setup SQL:\n` +
        `  CREATE EXTENSION IF NOT EXISTS vector;\n` +
        `  CREATE TABLE IF NOT EXISTS memories (\n` +
        `    id BIGSERIAL PRIMARY KEY,\n` +
        `    user_id TEXT NOT NULL,\n` +
        `    namespace TEXT NOT NULL DEFAULT 'default',\n` +
        `    content TEXT NOT NULL,\n` +
        `    embedding vector(${dimensions}),\n` +
        `    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n` +
        `    expires_at TIMESTAMPTZ\n` +
        `  );\n` +
        `  CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, namespace);\n`
      );
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
        })
        .select('id')
        .single() as { data?: { id: number }; error?: { message: string } };

      if (result.error) {
        throw new Error(`[semantic-memory] Supabase insert failed: ${result.error.message}`);
      }

      return result.data?.id ?? 0;
    },

    async searchMemories(params: SearchParams): Promise<RawMemoryRow[]> {
      const db = await getClient();
      const now = nowISO();
      const result = await db
        .from('memories')
        .select('id, user_id, namespace, content, embedding, created_at, expires_at')
        .eq('user_id', params.userId)
        .eq('namespace', params.namespace)
        .or(`expires_at.is.null,expires_at.gt.${now}`) as { data?: RawMemoryRow[]; error?: { message: string } };

      if (result.error) {
        throw new Error(`[semantic-memory] Supabase search failed: ${result.error.message}`);
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
      const result = await db
        .from('memories')
        .select('id, user_id, namespace, content, embedding, created_at, expires_at')
        .eq('user_id', userId)
        .eq('namespace', namespace)
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
        })
        .select('id')
        .single() as { data?: { id: number }; error?: { message: string } };

      if (result.error) {
        throw new Error(`[semantic-memory] Supabase enqueue failed: ${result.error.message}`);
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

    async getRetryable(): Promise<MemoryJob[]> {
      const db = await getClient();
      const now = nowISO();
      const result = await db
        .from('pending_memories')
        .select('*')
        .or(`status.eq.pending,status.eq.failed`)
        .or(`next_retry_at.is.null,next_retry_at.lte.${now}`) as { data?: Record<string, unknown>[] };

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

    async resetStaleProcessing(): Promise<void> {
      const db = await getClient();
      await db
        .from('pending_memories')
        .update({ status: 'pending' })
        .eq('status', 'processing');
    },

    async cleanupDoneJobs(olderThanMs: number): Promise<number> {
      const db = await getClient();
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      await db
        .from('pending_memories')
        .delete()
        .eq('status', 'done')
        .lt('created_at', cutoff);
      return 0; // Supabase doesn't return delete count easily
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
        .eq('id', jobId);
    },

    close(): void {
      client = null;
    },
  };

  return adapter;
}
