# Contributing to semantic-recall

First off, thank you for considering contributing to **semantic-recall**! Every contribution — whether it's a bug fix, feature proposal, documentation improvement, or a typo fix — makes this project better for everyone.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Commit Convention](#commit-convention)
- [Pull Request Process](#pull-request-process)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [Architecture Overview](#architecture-overview)
- [Testing Guidelines](#testing-guidelines)
- [Style Guide](#style-guide)

---

## Code of Conduct

This project follows our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to the maintainers.

---

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/semantic-recall.git
   cd semantic-recall
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Run the test suite** to make sure everything works:
   ```bash
   npm test
   ```

---

## Development Setup

### Prerequisites

- **Node.js** ≥ 18.0.0
- **npm** ≥ 9.0.0
- **Git** ≥ 2.0

### Scripts

| Script | Description |
|---|---|
| `npm run build` | Build ESM + CJS output with tsup |
| `npm run dev` | Build in watch mode |
| `npm test` | Run all tests with Vitest |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | Run TypeScript type checking (`tsc --noEmit`) |
| `npm run clean` | Remove the `dist/` directory |

### Recommended VS Code Extensions

- [TypeScript](https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-typescript-next)
- [Vitest Explorer](https://marketplace.visualstudio.com/items?itemName=vitest.explorer)
- [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)

---

## Project Structure

```
semantic-recall/
├── src/
│   ├── index.ts               # Memory class — public API entry point
│   ├── types.ts               # All shared TypeScript interfaces
│   ├── utils.ts               # Cosine similarity, TTL parsing, backoff
│   ├── dedup.ts               # Deduplication engine (cosine threshold)
│   ├── inject.ts              # Background injection pipeline
│   ├── recall.ts              # Semantic recall pipeline
│   ├── adapters/
│   │   ├── storage/
│   │   │   ├── sqlite.ts      # SQLite adapter (default, WAL mode)
│   │   │   ├── turso.ts       # Turso/LibSQL adapter
│   │   │   ├── supabase.ts    # Supabase/pgvector adapter
│   │   │   └── custom.ts      # Custom adapter validator
│   │   └── embedder/
│   │       ├── local.ts       # Transformers.js worker thread embedder
│   │       ├── openai.ts      # OpenAI embeddings adapter
│   │       └── custom.ts      # Custom embedder wrapper
│   └── workers/
│       └── embedder.worker.ts # Worker thread for CPU-isolated embedding
├── tests/
│   ├── memory.test.ts         # Integration tests (17 tests)
│   ├── queue.test.ts          # Queue state machine tests (6 tests)
│   └── utils.test.ts          # Unit tests for utils (14 tests)
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

---

## Making Changes

### Branch Naming

Create a branch from `main` with a descriptive name:

```bash
git checkout -b feat/add-redis-adapter
git checkout -b fix/dedup-threshold-edge-case
git checkout -b docs/improve-api-reference
```

Prefixes: `feat/`, `fix/`, `docs/`, `test/`, `refactor/`, `chore/`

### Before Submitting

Run the full verification suite:

```bash
npm run typecheck    # TypeScript must pass with zero errors
npm test             # All 37+ tests must pass
npm run build        # Dual ESM/CJS build must succeed
```

---

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]
[optional footer]
```

### Types

| Type | Description |
|---|---|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation changes |
| `test` | Adding or updating tests |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `chore` | Maintenance tasks (deps, config, CI) |

### Examples

```
feat(storage): add Redis storage adapter
fix(dedup): handle zero-magnitude vectors in cosine similarity
docs(readme): add Turso setup instructions
test(queue): add stale job recovery edge case
```

---

## Pull Request Process

1. **Ensure all checks pass** — typecheck, tests, build.
2. **Update documentation** if your change affects the public API.
3. **Add tests** for new features or bug fixes.
4. **Keep PRs focused** — one feature or fix per PR.
5. **Write a clear description** — explain *what* and *why*, not just *how*.
6. A maintainer will review your PR and may request changes.
7. Once approved, a maintainer will merge your PR.

### PR Template

```markdown
## What

Brief description of the change.

## Why

What problem does this solve?

## How

Technical approach taken.

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (all tests)
- [ ] `npm run build` succeeds
- [ ] Documentation updated (if applicable)
- [ ] Tests added (if applicable)
```

---

## Reporting Bugs

Open a [GitHub Issue](https://github.com/skt329/semantic-recall/issues/new) with:

1. **Title**: Clear, concise summary (e.g., "recall() returns expired memories")
2. **Environment**: Node.js version, OS, package version
3. **Steps to Reproduce**: Minimal code snippet that demonstrates the bug
4. **Expected Behavior**: What you expected to happen
5. **Actual Behavior**: What actually happened (include error messages/stack traces)

---

## Suggesting Features

We welcome feature ideas! Open a [GitHub Issue](https://github.com/skt329/semantic-recall/issues/new) with the `enhancement` label:

1. **Problem**: What are you trying to accomplish?
2. **Proposed Solution**: How do you think it should work?
3. **Alternatives Considered**: What other approaches did you consider?
4. **API Sketch** (optional): How would the developer use this feature?

### High-Impact Contribution Ideas

- **New storage adapters** — Redis, PostgreSQL (raw), DynamoDB, MongoDB
- **Batch operations** — `rememberMany()`, `recallMany()`
- **Streaming recall** — Async iterator for large result sets
- **Metadata tagging** — Attach arbitrary metadata to memories
- **Import/export** — JSON dump and restore for migrations
- **Instrumentation** — OpenTelemetry spans for pipeline stages
- **Web/Edge support** — Wasm-based embedder for edge runtimes

---

## Architecture Overview

Understanding the architecture helps you contribute effectively:

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

### Key Design Principles

1. **Never throw from `remember()`** — Fire-and-forget by design. Errors flow through events.
2. **Queue-first** — Every memory goes through the persistent `pending_memories` table before processing. Crash-safe by default.
3. **Adapter pattern** — Storage and embedder are pluggable. Implement `StorageAdapter` (in `types.ts`) for any backend.
4. **Worker isolation** — Embedding runs in a `worker_threads` Worker so heavy models never block the main thread.

---

## Testing Guidelines

### Running Tests

```bash
# Run all tests
npm test

# Run in watch mode
npm run test:watch

# Run a specific test file
npx vitest run tests/memory.test.ts
```

### Writing Tests

- Use **mock embedders** (deterministic, fast) — never call real embedding APIs in tests.
- Each test should be **independent** — use unique `dbPath` per test to avoid cross-contamination.
- Clean up test databases in `afterEach()`.
- Test files live in `tests/` and follow the pattern `*.test.ts`.

### Test Coverage Map

| Area | File | Tests |
|---|---|---|
| Utilities (math, TTL) | `tests/utils.test.ts` | 14 |
| Queue state machine | `tests/queue.test.ts` | 6 |
| Integration (full pipeline) | `tests/memory.test.ts` | 17 |

---

## Style Guide

- **TypeScript strict mode** — All code must pass `tsc --noEmit` with strict checks.
- **No `any`** — Use `unknown` and proper type guards instead.
- **JSDoc comments** — All public functions and interfaces must have JSDoc comments.
- **Named exports** — No default exports.
- **Async/await** — Prefer async/await over raw Promises.
- **Error messages** — Prefix with `[semantic-recall]` for easy grep-ability.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

---

**Thank you for helping make `semantic-recall` better!** Every contribution counts.
