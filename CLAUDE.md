# canvas-chat-tree — working rules for Claude Code

## What this is
A personal open-source project by Gustav Andersson (github.com/gcandersson). MIT licence.
An infinite canvas where every AI chat exchange is a node, and any node can be branched.
Fully separate from Liberate Me: never copy code, data, keys or config from any Liberate Me repo.

## Hard rules
- Never deploy. Gustav runs `railway up` himself, every time. Do not run `railway up`, `railway deploy` or any command that deploys.
- One active brief at a time, in /briefs/. Suffixes: __active, __queued, __paused, __shipped. Only one __active.
- Work one unit at a time. After each unit: commit, push to origin main, then stop and report what changed and exactly how Gustav verifies it. Wait for his go-ahead before the next unit.
- Push to origin main after every commit. Never force-push or rewrite pushed history. The public commit history matters.
- Never commit secrets. No .env files, API keys, passwords or real personal data in the repo. Secrets live only in Railway variables.
- Test data must be invented. Never use real people's messages, names or client material.
- Verify against real evidence: curl output, database rows, the live page. Not self-assessment.
- Domain terms come from UBIQUITOUS_LANGUAGE.md. Update that file in place when a term is added or changes; never version it.

## Stack
- Node + Express, Postgres on Railway, `pg` driver, `@anthropic-ai/sdk`.
- Frontend: single-file Preact + htm with no build step, served from public/index.html (ES modules from esm.sh).
- Schema is created on server start with CREATE TABLE IF NOT EXISTS (no migration framework in v0.1).
- Environment variables: DATABASE_URL, ANTHROPIC_API_KEY, APP_PASSWORD, ASK_MODEL (default claude-sonnet-5-5), PORT.

## UX rule
Progress feedback is mandatory everywhere: loading states, spinners with elapsed time, clear error messages with a retry. The user must never wonder whether something is happening.
