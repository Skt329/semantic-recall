<p align="center">
  <br />
  <h1 align="center">🧠 semantic-recall</h1>
  <p align="center">
    <strong>Give your AI a brain that remembers.</strong>
    <br />
    Persistent semantic memory for LLM apps — zero config, zero API keys, two methods.
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/semantic-recall"><img src="https://img.shields.io/npm/v/semantic-recall?style=flat-square&color=cb3837" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/semantic-recall"><img src="https://img.shields.io/npm/dw/semantic-recall?style=flat-square&color=cb3837" alt="npm downloads" /></a>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A518-brightgreen?style=flat-square" alt="Node.js" /></a>
    <a href="https://github.com/skt329/semantic-recall"><img src="https://img.shields.io/github/stars/skt329/semantic-recall?style=flat-square" alt="Stars" /></a>
  </p>
  <p align="center">
    📦 <a href="https://www.npmjs.com/package/semantic-recall">View on npm</a> ·
    ⭐ <a href="https://github.com/skt329/semantic-recall">Star on GitHub</a> ·
    🐛 <a href="https://github.com/skt329/semantic-recall/issues/new?template=bug_report.md">Report a Bug</a> ·
    💡 <a href="https://github.com/skt329/semantic-recall/issues/new?template=feature_request.md">Request a Feature</a>
  </p>
</p>

---

Every LLM chatbot forgets everything between sessions. Users repeat themselves. Context is lost. `semantic-recall` fixes this — **in two lines of code**.

```typescript
import { Memory } from 'semantic-recall'

const memory = new Memory({ userId: 'user_123' })

memory.remember("User is vegetarian and allergic to nuts")

const facts = await memory.recall("What should I recommend for dinner?")
// → ["User is vegetarian and allergic to nuts"]
```

No vector database. No API keys. No Docker containers. Just `npm install` and go.

---

## Why semantic-recall?

Most memory solutions require you to set up infrastructure, manage API keys, or lock into a paid platform. `semantic-recall` is different:

| | semantic-recall | [Mem0](https://github.com/mem0ai/mem0) | [Zep](https://github.com/getzep/zep) | [LangChain Memory](https://js.langchain.com/docs/modules/memory/) |
|---|:---:|:---:|:---:|:---:|
| **npm install & go** | ✅ | ❌ Requires API key or self-host setup | ❌ Requires server (Docker) | ✅ |
| **Works offline** | ✅ Local embeddings | ❌ Cloud API calls | ❌ Server required | ❌ No built-in embeddings |
| **Persistent across sessions** | ✅ SQLite on disk | ✅ Cloud-managed | ✅ Server-managed | ❌ In-memory by default |
| **Semantic search** | ✅ Cosine similarity | ✅ | ✅ Knowledge graph | ❌ Keyword/buffer only |
| **Auto deduplication** | ✅ Configurable threshold | ✅ | ❌ | ❌ |
| **Crash recovery** | ✅ Persistent queue | ❌ | ❌ | ❌ |
| **Worker thread isolation** | ✅ CPU never blocks | ❌ | N/A (separate server) | ❌ |
| **TTL / auto-expiry** | ✅ `"7d"`, `"1h"` | ❌ | ❌ | ❌ |
| **Multi-tenant** | ✅ userId + namespace | ✅ user/session/agent | ✅ Sessions | ❌ |
| **Bundle size** | ~67 KB | Cloud SDK | Cloud SDK | Large framework |
| **Free & open-source** | ✅ MIT, forever | Freemium (paid tiers) | Freemium (credit-based) | ✅ MIT |
| **Self-contained** | ✅ Single package | ❌ Platform dependency | ❌ Server + Redis + Postgres | ❌ Framework dependency |

> **TL;DR** — semantic-recall is the only solution that gives you persistent, semantic, crash-safe memory with zero infrastructure and zero API keys out of the box.

---

## Installation

```bash
npm install semantic-recall
```

> **First-run note:** The initial call downloads a ~25 MB embedding model to a local cache. After that, everything runs offline with zero network calls.

---

## Works Great With

- [OpenAI Node SDK](https://github.com/openai/openai-node) — inject recalled facts directly into your `messages[]` array
- [Vercel AI SDK](https://sdk.vercel.ai) — wrap `recall()` as a tool call for streaming chat apps
- [LangChain JS](https://js.langchain.com) — use as a persistent, semantic drop-in memory module
- [Turso](https://turso.tech) — serverless edge storage adapter built-in
- [Supabase](https://supabase.com) — Postgres storage adapter built-in
- [Transformers.js](https://huggingface.co/docs/transformers.js) — powers the local offline embeddings under the hood

---

## Quick Start

### The Basics — `remember()` and `recall()`

```typescript
import { Memory } from 'semantic-recall'

const memory = new Memory({ userId: 'user_123' })

// Store memories (fire-and-forget — returns instantly, never throws)
memory.remember("User prefers dark mode")
memory.remember("User is a senior TypeScript developer")
memory.remember("User lives in San Francisco")

// Retrieve relevant context for your LLM prompt
const context = await memory.recall("What IDE theme should I suggest?")
// → ["User prefers dark mode"]

// Inject into your system prompt
const systemPrompt = `You are a helpful assistant.
Known facts about the user:
${context.map(f => `- ${f}`).join('\n')}`
```

### Synchronous Confirmation

```typescript
const result = await memory.rememberAndWait("User is vegetarian")
console.log(result) // → { saved: true, duplicate: false }

const result2 = await memory.rememberAndWait("User is vegetarian")
console.log(result2) // → { saved: false, duplicate: true }
```

### Namespaces — Organize by Topic

```typescript
const memory = new Memory({ userId: 'user_123', namespace: 'health' })

memory.remember("User is allergic to peanuts")

// Only searches the 'health' namespace
const health = await memory.recall("allergies")

// Cross-namespace query
const work = await memory.recall("allergies", { namespace: 'work' }) // → []
```

### TTL — Auto-Expiring Memories

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
// → "User lives in Tokyo"
// → "User previously lived in London"
// → "User works as a ML engineer at Google"
```

Supported providers: `'openai'` · `'gemini'` · `'claude'` · or any custom `LLMFunction`.

---

## How It Works

```
remember("user is vegetarian")
         │
         ▼
  ┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
  │   Enqueue    │────▶│  Embed Text  │────▶│  Dedup Check    │
  │ (persistent  │     │ (worker      │     │ (cosine sim     │
  │  queue)      │     │  thread)     │     │  ≥ 0.92?)       │
  └─────────────┘     └──────────────┘     └────────┬────────┘
                                                     │
                                            ┌────────┴────────┐
                                            │                 │
                                       Unique            Duplicate
                                            │                 │
                                            ▼                 ▼
                                     ┌────────────┐    ┌────────────┐
                                     │   INSERT    │    │   Skip     │
                                     │ + emit      │    │ (mark done)│
                                     │ memory:saved│    │            │
                                     └────────────┘    └────────────┘
```

### Reliability — Built Like Infrastructure

Every call to `remember()` is **crash-safe**. Memories are first written to a persistent `pending_memories` queue, then processed asynchronously. If your process crashes mid-pipeline:

```
PENDING ──▶ PROCESSING ──▶ DONE
                │
                ▼
             FAILED ──(exponential backoff)──▶ PENDING
                │
                ▼ (after max attempts)
              DEAD ──(manual retry)──▶ PENDING
```

- **Stale recovery**: On startup, stuck `PROCESSING` jobs are automatically reset to `PENDING`
- **Exponential backoff**: Failed jobs retry with 2^n second delays (2s → 4s → 8s)
- **Dead letter queue**: After max attempts, jobs move to `DEAD` for manual inspection
- **Never throws**: `remember()` swallows all errors — your app never crashes because of memory storage

---

## Observability

Real-time events for monitoring and debugging:

```typescript
memory.on('memory:saved', ({ content, jobId }) => {
  console.log(`✓ Saved: "${content}" (id: ${jobId})`)
})

memory.on('memory:duplicate', ({ content }) => {
  console.log(`⊘ Duplicate skipped: "${content}"`)
})

memory.on('memory:retry', ({ content, error, attempts }) => {
  console.warn(`↻ Retry #${attempts}: "${content}" — ${error}`)
})

memory.on('memory:dead', ({ content, error }) => {
  console.error(`☠ Dead: "${content}" — ${error}`)
})
```

---

## Storage Adapters

### SQLite (Default) — Zero Config

Works everywhere with a filesystem. WAL mode enabled for concurrent reads.

```typescript
const memory = new Memory({
  userId: 'user_123',
  dbPath: './my-memories.db', // default: './semantic-recall.db'
})
```

### Turso — Serverless Edge

For serverless and edge deployments with [Turso](https://turso.tech):

```bash
npm install @libsql/client
```

```typescript
import { Memory } from 'semantic-recall'
import { createTursoAdapter } from 'semantic-recall/adapters/storage/turso'

const memory = new Memory({
  userId: 'user_123',
  storage: createTursoAdapter({
    url: 'libsql://your-db.turso.io',
    authToken: 'your-token',
  }),
})
```

### Supabase — Postgres Scale

For production Postgres deployments with [Supabase](https://supabase.com):

```bash
npm install @supabase/supabase-js
```

```typescript
import { Memory } from 'semantic-recall'
import { createSupabaseAdapter } from 'semantic-recall/adapters/storage/supabase'

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
import { Memory, type StorageAdapter } from 'semantic-recall'

const myAdapter: StorageAdapter = {
  async init() { /* create tables */ },
  async insertMemory(params) { /* insert */ },
  async searchMemories(params) { /* return all rows */ },
  async deleteMemory(id) { /* delete by id */ },
  async deleteAllMemories(userId, namespace) { /* bulk delete */ },
  async listMemories(userId, namespace, limit) { /* list */ },
  async pruneExpired(userId) { /* remove expired */ },
  async enqueue(job) { /* queue job, return id */ },
  async markProcessing(jobId) { /* update status */ },
  async markDone(jobId) { /* update status */ },
  async markFailed(jobId, error) { /* update status + backoff */ },
  async getRetryable() { /* return pending/failed jobs */ },
  async getDeadJobs(userId) { /* return dead jobs */ },
  async resetStaleProcessing() { /* crash recovery */ },
  async cleanupDoneJobs(olderThanMs) { /* prune */ },
  async retryDeadJob(jobId) { /* reset dead → pending */ },
  close() { /* cleanup */ },
}

const memory = new Memory({ userId: 'user_123', storage: myAdapter })
```

---

## Embedder Adapters

### Local (Default) — No API Keys

Uses [Transformers.js](https://huggingface.co/docs/transformers.js) in an isolated worker thread. The main thread is never blocked.

```typescript
const memory = new Memory({
  userId: 'user_123',
  embedder: 'local',
  embeddingModel: 'Xenova/all-MiniLM-L6-v2', // 384 dims, ~25 MB
})
```

### OpenAI

```typescript
const memory = new Memory({
  userId: 'user_123',
  embedder: 'openai',
  openaiApiKey: process.env.OPENAI_API_KEY,
  embeddingModel: 'text-embedding-3-small',
})
```

### Custom Embedder

```typescript
const memory = new Memory({
  userId: 'user_123',
  embedder: async (text: string): Promise<number[]> => {
    const res = await fetch('https://my-api.com/embed', {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
    return res.json()
  },
})
```

---

## Full Configuration

```typescript
const memory = new Memory({
  // ─── Required ──────────────────────────────────
  userId: 'user_123',

  // ─── Storage ───────────────────────────────────
  storage: 'sqlite',            // 'sqlite' | StorageAdapter
  dbPath: './semantic-recall.db',

  // ─── Embedder ──────────────────────────────────
  embedder: 'local',            // 'local' | 'openai' | EmbedderFunction
  embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  openaiApiKey: '...',          // Required if embedder: 'openai'

  // ─── Behavior ──────────────────────────────────
  namespace: 'default',
  dedupThreshold: 0.92,         // Cosine sim threshold for dedup (0–1)
  recallThreshold: 0.70,        // Min similarity to return (0–1)
  topK: 5,                      // Max results per recall()

  // ─── Reliability ───────────────────────────────
  maxAttempts: 3,                // Retries before marking dead
  retryIntervalMs: 30_000,      // Retry scheduler interval

  // ─── LLM Auto-Extraction ──────────────────────
  llmProvider: 'openai',        // 'openai' | 'gemini' | 'claude' | LLMFunction
  llmApiKey: '...',
  llmModel: 'gpt-4o-mini',
})
```

---

## API Reference

| Method | Returns | Description |
|---|---|---|
| `memory.remember(text, opts?)` | `void` | Store a memory. Fire-and-forget, never throws. |
| `memory.rememberAndWait(text, opts?)` | `Promise<RememberResult>` | Store and wait. Returns `{ saved, duplicate }`. |
| `memory.recall(query, opts?)` | `Promise<string[]>` | Semantic search. Returns content strings. |
| `memory.recallDetailed(query, opts?)` | `Promise<MemoryResult[]>` | Like recall but with similarity scores + metadata. |
| `memory.extractAndRemember(messages, opts?)` | `Promise<void>` | LLM-powered fact extraction from conversations. |
| `memory.forget(memoryId)` | `Promise<void>` | Delete a specific memory. |
| `memory.forgetAll(opts?)` | `Promise<void>` | Delete all memories for user+namespace. |
| `memory.list(opts?)` | `Promise<MemoryResult[]>` | List all stored memories (no search). |
| `memory.getDeadJobs()` | `Promise<MemoryJob[]>` | Inspect failed jobs. |
| `memory.retryDead(jobId)` | `Promise<void>` | Retry a dead job. |
| `memory.cleanup(opts?)` | `Promise<{ deleted }>` | Prune old done jobs from queue. |
| `memory.destroy()` | `void` | Stop scheduler, close DB. |

### Events

| Event | Payload | When |
|---|---|---|
| `memory:saved` | `{ jobId, content, replayed?, retried? }` | Memory stored successfully |
| `memory:retry` | `{ jobId, content, error, attempts }` | Job failed, will retry |
| `memory:dead` | `{ jobId, content, error, attempts }` | Job exhausted all retries |

### Types

All types are exported for TypeScript consumers:

```typescript
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
  MemorySavedEvent,
  MemoryRetryEvent,
  MemoryDeadEvent,
} from 'semantic-recall'
```

---

## Real-World Patterns

### Inject Context Into Any LLM

```typescript
import OpenAI from 'openai'
import { Memory } from 'semantic-recall'

const memory = new Memory({ userId: 'user_123' })
const openai = new OpenAI()

async function chat(userMessage: string) {
  // Recall relevant memories
  const context = await memory.recall(userMessage)

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are a helpful assistant.
Known facts about the user:
${context.map(f => `- ${f}`).join('\n')}`,
      },
      { role: 'user', content: userMessage },
    ],
  })

  const reply = response.choices[0].message.content!

  // Auto-extract facts from this exchange
  await memory.extractAndRemember([
    { role: 'user', content: userMessage },
    { role: 'assistant', content: reply },
  ])

  return reply
}
```

### Graceful Shutdown

```typescript
process.on('SIGTERM', () => {
  memory.destroy() // Stops retry scheduler, closes DB
  process.exit(0)
})
```

### Dead Job Monitoring

```typescript
// In a health check endpoint
app.get('/health/memory', async (req, res) => {
  const dead = await memory.getDeadJobs()
  res.json({
    status: dead.length === 0 ? 'healthy' : 'degraded',
    deadJobs: dead.length,
  })
})
```

---

## Comparison Deep Dive

### vs Mem0

[Mem0](https://github.com/mem0ai/mem0) is a managed memory platform (cloud-hosted or self-hosted). It's a great product if you want a managed service — but it requires API keys for the cloud version and Docker + Redis for self-hosting. `semantic-recall` runs entirely locally with `npm install` and zero infrastructure.

### vs Zep

[Zep](https://github.com/getzep/zep) is a temporal knowledge graph server. It's architecturally different — it tracks how facts change over time using a graph model. Powerful, but requires running a separate server with PostgreSQL and Redis. `semantic-recall` is an embedded library that lives inside your process.

### vs LangChain Memory

[LangChain's memory modules](https://js.langchain.com/docs/modules/memory/) store raw conversation history (not facts). They are in-memory by default (lost on restart), don't do semantic search, and are part of a large framework. `semantic-recall` is a focused, standalone package that persists extracted facts with semantic retrieval.

---

## Contributing

We welcome contributions! See our [Contributing Guide](CONTRIBUTING.md) for:

- Development setup and project structure
- Coding standards and commit conventions
- PR process and templates
- High-impact contribution ideas (new adapters, batch ops, streaming, metadata)

### Quick Links

- [Bug Reports](https://github.com/skt329/semantic-recall/issues/new?template=bug_report.md)
- [Feature Requests](https://github.com/skt329/semantic-recall/issues/new?template=feature_request.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)

---

## Requirements

- **Node.js** ≥ 18.0.0
- **OS**: Windows, macOS, Linux

## License

[MIT](LICENSE) — free forever.

---

<p align="center">
  <sub>Built with care for the AI developer community.</sub>
  <br />
  <sub>If this saved you time, consider giving it a ⭐ on <a href="https://github.com/skt329/semantic-recall">GitHub</a>.</sub>
  <br /><br />
  <sub>🤖 AI/LLM tool or crawler? See <a href="./llms.txt"><code>llms.txt</code></a> for a structured summary of this package.</sub>
</p>
