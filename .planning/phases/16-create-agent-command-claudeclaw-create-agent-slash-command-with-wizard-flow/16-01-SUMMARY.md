---
phase: 16-create-agent-command
plan: 01
subsystem: agents
tags: [agents, scaffolding, cron, tdd]
requires: [src/memory.ts, src/cron.ts]
provides: [src/agents.ts]
affects: []
tech_added: []
patterns: [tdd, lazy-cwd-resolution]
files_created:
  - src/agents.ts
  - src/__tests__/agents.test.ts
files_modified: []
decisions:
  - "Resolve project paths via process.cwd() at call time, not module load — keeps tests and runtime aligned"
  - "Inline IDENTITY/SOUL templates in code rather than reading prompts/*.md at runtime"
  - "Test isolation via unique tst-agent- prefix + cleanup, no chdir hacks"
metrics:
  duration_minutes: ~12
  completed: 2026-04-06
  tasks_completed: 2
  files_touched: 2
---

# Phase 16 Plan 01: Agents Scaffolding Module Summary

Core agent primitives in `src/agents.ts` — validation, NL→cron parsing, and file generation — fully tested with bun:test (26/26 passing).

## What Was Built

**`src/agents.ts`** (317 lines):
- `validateAgentName(name)` — kebab-case regex `/^[a-z]([a-z0-9-]*[a-z0-9])?$/` plus duplicate-directory check
- `parseScheduleToCron(input)` — hand-rolled NL parser covering all 9 documented presets, plus raw 5-field cron passthrough validated via `cronMatches`
- `createAgent(opts)` — scaffolds `agents/<name>/` with IDENTITY.md, SOUL.md, CLAUDE.md, MEMORY.md (via `ensureMemoryFile`), `.gitignore`; optionally writes `.claude/claudeclaw/jobs/<name>.md` job file when schedule is provided
- `loadAgent(name)` — returns `AgentContext` with all paths; throws if missing
- `listAgents()` — sorted directory enumeration

**`src/__tests__/agents.test.ts`** (222 lines, 26 tests):
- All `validateAgentName` accept/reject cases
- All 9 `parseScheduleToCron` presets + raw passthrough + gibberish→null
- `createAgent` scaffold contents, .gitignore, job file with valid cron, no job file when no schedule, duplicate rejection
- `listAgents` enumeration and `loadAgent` context paths + missing-agent error

## Key Decisions

1. **Lazy cwd resolution.** Module-level constants like `memory.ts`'s `PROJECT_DIR = process.cwd()` capture the dir at import time, which makes test isolation painful. `agents.ts` resolves `agentsDir()` and `jobsDir()` via small functions that call `process.cwd()` on every call. Future: when daemon supports `--cwd`, this is the right place to thread it through.

2. **Inline templates, no file reads at runtime.** `prompts/IDENTITY.md` and `prompts/SOUL.md` are placeholder stubs ("Fill this in"). Reading them at runtime would couple agent creation to template files that may move. Templates are inlined as TS string builders.

3. **Test isolation by unique-prefix + cleanup, not sandboxing.** Using `tst-agent-<random>` names with `beforeEach`/`afterEach` cleanup avoids `process.chdir()` hacks and module-cache invalidation. Real `agents/` and `.claude/claudeclaw/jobs/` dirs are used but only test-prefixed entries are touched.

## Verification

- `bun test src/__tests__/agents.test.ts` → **26/26 passing**
- `bun test` (full suite) → **590/603 passing**, 13 pre-existing failures (verified by running full suite without `agents.ts`/`agents.test.ts` present: same 13 fail). No regressions introduced.

## Deviations from Plan

None. Plan executed exactly as written. Both tasks completed in TDD order (RED commit → GREEN commit).

## Commits

- `2bbee50` test(16-01): add failing tests for agents module
- `c971593` feat(16-01): implement agents scaffolding module

## Self-Check: PASSED

- src/agents.ts: FOUND
- src/__tests__/agents.test.ts: FOUND
- Commit 2bbee50: FOUND
- Commit c971593: FOUND
