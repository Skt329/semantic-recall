---
name: Bug Report
about: Report a bug to help us improve
title: "[BUG] "
labels: bug
assignees: ''
---

## Describe the Bug

A clear and concise description of what the bug is.

## To Reproduce

```typescript
import { Memory } from 'semantic-recall'

// Minimal code to reproduce the issue
const memory = new Memory({ userId: 'test' })
// ...
```

## Expected Behavior

What you expected to happen.

## Actual Behavior

What actually happened. Include error messages and stack traces if applicable.

## Environment

- **Node.js version**: `node --version`
- **OS**: (e.g., Windows 11, macOS 14, Ubuntu 22.04)
- **Package version**: (e.g., 1.0.0)
- **Storage adapter**: (sqlite / turso / supabase / custom)
- **Embedder**: (local / openai / custom)

## Additional Context

Add any other context about the problem here (logs, screenshots, etc).
