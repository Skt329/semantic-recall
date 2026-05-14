# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in `semantic-recall`, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email the maintainers directly or use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability).

### What to Include

- A description of the vulnerability
- Steps to reproduce the issue
- Potential impact assessment
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 1 week
- **Fix & Disclosure**: We aim to release a patch within 30 days of confirmation

### Scope

The following are in scope:
- SQL injection in storage adapters
- Embedding data leakage across user/namespace boundaries
- Denial of service via crafted inputs
- Worker thread escape or escalation
- Dependency vulnerabilities

### Out of Scope

- Issues in optional dependencies (`@libsql/client`, `@supabase/supabase-js`, `openai`) — report these to their respective maintainers
- Self-inflicted issues from using custom storage/embedder adapters without proper validation

## Security Design

`semantic-recall` is designed with security in mind:

- **User isolation**: All queries are scoped by `userId` and `namespace` — no cross-tenant data leakage
- **No network by default**: The default configuration (SQLite + local embedder) makes zero network calls after initial model download
- **Input validation**: The `userId` parameter is validated at construction time
- **SQL parameterization**: All storage adapters use parameterized queries — no string concatenation in SQL
- **Worker isolation**: Embedding runs in an isolated `worker_threads` context
