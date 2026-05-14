# semantic-memory

> Drop-in persistent semantic memory for LLM apps.  
> Zero config. Zero API keys. Two methods: `remember()` and `recall()`.

[![npm version](https://img.shields.io/npm/v/semantic-memory)](https://www.npmjs.com/package/semantic-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)

---

## Why?

Every LLM chatbot forgets everything between sessions. Users repeat themselves. Context is lost. `semantic-memory` fixes this with **two lines of code** — no vector database, no API keys, no infrastructure.

```typescript
import { Memory } from 'semantic-memory'

const memory = new Memory({ userId: 'user_123' })

// Store facts (fire-and-forget, never throws)
memory.remember("User is vegetarian and allergic to nuts")

// Retrieve relevant memories for your LLM prompt
const facts = await memory.recall("What should I recommend for dinner?")
// → ["User is vegetarian and allergic to nuts"]
```

## Features

- **Zero Config** — Works out of the box with SQLite + local embeddings
- **Zero API Keys** — Uses [Transformers.js](https://huggingface.co/docs/transformers.js) for on-device embeddings
- **Persistent** — Memories survive restarts via SQLite (WAL mode)
- **Semantic Search** — Finds relevant memories by meaning, not keywords
- **Automatic Dedup** — Won't store "likes coffee" twice (cosine similarity check)
- **Fire-and-Forget** — `remember()` returns instantly, processes in background
- **Crash-Safe** — Persistent queue with retry + exponential backoff
- **Multi-Tenant** — Built-in `userId` and `namespace` isolation
- **TTL Support** — Auto-expire memories: `remember("in Paris", { ttl: "7d" })`
- **Observable** — EventEmitter with typed events for monitoring
- **Extensible** — Swap storage (SQLite/Turso/Supabase) or embedder (local/OpenAI/custom)
- **Dual Build** — Ships ESM + CJS with full TypeScript declarations

## Installation

```bash
npm install semantic-memory
```

> **Note:** The first call to `remember()` or `recall()` will download the embedding model (~80 MB) to a local cache. Subsequent calls are instant.

## Quick Start

### Basic Usage

```typescript
import { Memory } from 'semantic-memory'

const memory = new Memory({ userId: 'user_123' })

// Store memories
memory.remember("User prefers dark mode")
memory.remember("User is a senior TypeScript developer")
memory.remember("User lives in San Francisco")

// Later — retrieve relevant context for your LLM
const context = await memory.recall("What IDE theme should I suggest?")
// → ["User prefers dark mode"]

// Inject into your LLM prompt
const systemPrompt = `You are a helpful assistant.
Known facts about the user:
${context.map(f => `- ${f}`).join('\n')}
`
```

### With Confirmation

```typescript
// Wait for the memory to be stored (or confirmed as duplicate)
const result = await memory.rememberAndWait("User is vegetarian")
console.log(result)
// → { saved: true, duplicate: false }

const result2 = await memory.rememberAndWait("User is vegetarian")
console.log(result2)
// → { saved: false, duplicate: true }
```

### Namespaces

```typescript
const memory = new Memory({
  userId: 'user_123',
  namespace: 'health',
})

memory.remember("User is allergic to peanuts")
memory.remember("User takes vitamin D daily")

// Query across namespaces
const health = await memory.recall("allergies")
const work = await memory.recall("allergies", { namespace: 'work' }) // → []
```

### TTL (Auto-Expiry)

```typescript
// Memory expires after 7 days
memory.remember("User is in Paris for a conference", { ttl: "7d" })

// Supported formats: '500ms', '60s', '30m', '12h', '7d'
memory.remember("Session preference: compact view", { ttl: "1h" })
```

### LLM Auto-Extraction

Automatically extract memorable facts from conversations:

```typescript
const memory = new Memory({
  userId: 'user_123',
  llmProvider: 'openai',
  llmApiKey: process.env.OPENAI_API_KEY,
})

await memory.extractAndRemember([
  { role: 'user', content: "I just moved to Tokyo from London" },
  { role: 'assistant', content: "Welcome to Tokyo! How exciting..." },
  { role: 'user', content: "Yeah, I'm starting a new job as a ML engineer at Google" },
])
// Automatically extracts and stores:
// - "User lives in Tokyo"
// - "User previously lived in London"
// - "User works as a ML engineer at Google"
```

Supported LLM providers: `'openai'`, `'gemini'`, `'claude'`, or pass a custom function.

### Events

```typescript
memory.on('memory:saved', ({ content, memoryId }) => {
  console.log(`✓ Saved: "${content}" (id: ${memoryId})`)
})

memory.on('memory:duplicate', ({ content }) => {
  console.log(`⊘ Duplicate skipped: "${content}"`)
})

memory.on('memory:error', ({ content, error }) => {
  console.error(`✗ Failed: "${content}" — ${error}`)
})

memory.on('memory:dead', ({ content, error, jobId }) => {
  console.error(`☠ Dead after max retries: "${content}" — ${error}`)
})
```

### Memory Management

```typescript
// List all stored memories
const all = await memory.list()
const recent = await memory.list({ limit: 10 })

// Delete a specific memory
await memory.forget(memoryId)

// Delete all memories for this user/namespace
await memory.forgetAll()

// Detailed recall with similarity scores
const detailed = await memory.recallDetailed("food preferences")
// → [{ id: 1, content: "User is vegetarian", similarity: 0.94, createdAt: "..." }]
```

### Dead Job Recovery

```typescript
// Inspect jobs that failed after max retries
const dead = await memory.getDeadJobs()

// Retry a dead job
await memory.retryDead(dead[0].id)

// Cleanup old processed jobs
await memory.cleanup({ olderThan: '7d' })
```

### Graceful Shutdown

```typescript
process.on('SIGTERM', () => {
  memory.destroy() // Stops retry scheduler, closes DB
})
```

## Configuration

```typescript
const memory = new Memory({
  // Required
  userId: 'user_123',

  // Storage
  storage: 'sqlite',           // 'sqlite' (default) | StorageAdapter object
  dbPath: './my-memories.db',   // SQLite file path (default: './semantic-memory.db')

  // Embedder
  embedder: 'local',           // 'local' (default) | 'openai' | EmbedderFunction
  embeddingModel: 'Xenova/all-MiniLM-L6-v2', // HuggingFace model (local)
  openaiApiKey: '...',         // Required if embedder: 'openai'

  // Behavior
  namespace: 'default',        // Namespace isolation
  dedupThreshold: 0.92,        // Cosine similarity threshold for dedup (0-1)
  recallThreshold: 0.70,       // Minimum similarity to return a result (0-1)
  topK: 5,                     // Max results per recall()
  maxAttempts: 3,               // Max retry attempts before marking dead
  retryIntervalMs: 30_000,     // Retry scheduler interval

  // LLM (for extractAndRemember)
  llmProvider: 'openai',       // 'openai' | 'gemini' | 'claude' | LLMFunction
  llmApiKey: '...',
  llmModel: 'gpt-4o-mini',
})
```

## Storage Adapters

### SQLite (Default)

Zero-config, works everywhere with a filesystem:

```typescript
const memory = new Memory({
  userId: 'user_123',
  dbPath: './memories.db',
})
```

### Turso (Serverless)

For serverless/edge deployments:

```bash
npm install @libsql/client
```

```typescript
import { Memory } from 'semantic-memory'
import { createTursoAdapter } from 'semantic-memory/adapters/storage/turso'

const memory = new Memory({
  userId: 'user_123',
  storage: createTursoAdapter({
    url: 'libsql://your-db.turso.io',
    authToken: 'your-token',
  }),
})
```

### Supabase (pgvector)

For Postgres-scale deployments:

```bash
npm install @supabase/supabase-js
```

```typescript
import { Memory } from 'semantic-memory'
import { createSupabaseAdapter } from 'semantic-memory/adapters/storage/supabase'

const memory = new Memory({
  userId: 'user_123',
  storage: createSupabaseAdapter({
    url: 'https://your-project.supabase.co',
    anonKey: 'your-anon-key',
    dimensions: 384,
  }),
})
```

### Custom Adapter

Implement the `StorageAdapter` interface for any backend:

```typescript
import { Memory, type StorageAdapter } from 'semantic-memory'

const myAdapter: StorageAdapter = {
  async init() { /* create tables */ },
  async insertMemory(params) { /* ... */ },
  async searchMemories(params) { /* ... */ },
  // ... see StorageAdapter interface for all required methods
}

const memory = new Memory({
  userId: 'user_123',
  storage: myAdapter,
})
```

## Embedder Adapters

### Local (Default)

Uses Transformers.js in a worker thread — no API keys needed:

```typescript
const memory = new Memory({
  userId: 'user_123',
  embedder: 'local',
  embeddingModel: 'Xenova/all-MiniLM-L6-v2', // 384 dimensions
})
```

### OpenAI

```typescript
const memory = new Memory({
  userId: 'user_123',
  embedder: 'openai',
  openaiApiKey: process.env.OPENAI_API_KEY,
  embeddingModel: 'text-embedding-3-small', // 1536 dimensions
})
```

### Custom

Bring your own embedding function:

```typescript
const memory = new Memory({
  userId: 'user_123',
  embedder: async (text: string): Promise<number[]> => {
    const response = await fetch('https://my-api.com/embed', {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
    return response.json()
  },
})
```

## Architecture

```
remember("user is vegetarian")
         │
         ▼
  ┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
  │   Enqueue    │────▶│  Embed Text  │────▶│  Dedup Check    │
  │ (pending_    │     │ (worker      │     │ (cosine sim     │
  │  memories)   │     │  thread)     │     │  ≥ 0.92?)       │
  └─────────────┘     └──────────────┘     └────────┬────────┘
                                                     │
                                            ┌────────┴────────┐
                                            │                 │
                                       Unique            Duplicate
                                            │                 │
                                            ▼                 ▼
                                     ┌────────────┐    ┌────────────┐
                                     │ INSERT into │    │ Mark job   │
                                     │ memories    │    │ as 'done'  │
                                     │ table       │    │ (skip)     │
                                     └────────────┘    └────────────┘
```

### Queue State Machine

```
PENDING ──▶ PROCESSING ──▶ DONE
                │
                ▼
             FAILED ──(retry with backoff)──▶ PENDING
                │
                ▼ (after max attempts)
              DEAD ──(manual retry)──▶ PENDING
```

## API Reference

### `new Memory(options)`

Creates a new Memory instance. See [Configuration](#configuration) for all options.

### `memory.remember(text, options?)`

Store a memory. Fire-and-forget — returns immediately, never throws.

### `memory.rememberAndWait(text, options?)`

Store a memory and wait for confirmation. Returns `{ saved: boolean, duplicate: boolean }`.

### `memory.recall(query, options?)`

Retrieve relevant memories as an array of strings. Options: `{ namespace?, threshold?, topK? }`.

### `memory.recallDetailed(query, options?)`

Like `recall()` but returns full `MemoryResult[]` with similarity scores.

### `memory.extractAndRemember(messages, options?)`

Extract facts from a conversation using an LLM and store them.

### `memory.forget(memoryId)`

Delete a specific memory by ID.

### `memory.forgetAll(options?)`

Delete all memories for this user in a namespace.

### `memory.list(options?)`

List all stored memories (no semantic search).

### `memory.getDeadJobs()`

Return jobs that failed after max retries.

### `memory.retryDead(jobId)`

Retry a dead job.

### `memory.cleanup(options?)`

Prune old processed jobs from the queue.

### `memory.destroy()`

Stop retry scheduler and close database connection.

## Requirements

- **Node.js** ≥ 18.0.0
- **OS:** Any (Windows, macOS, Linux)

## License

MIT
