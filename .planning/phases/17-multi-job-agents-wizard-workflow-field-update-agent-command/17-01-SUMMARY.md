---
phase: 17-multi-job-agents-wizard-workflow-field-update-agent-command
plan: 01
subsystem: agents
tags: [agents, jobs, multi-job, storage-layer]
requires: [16-01, 16-02]
provides:
  - validateJobLabel
  - agentJobsDir
  - addJob
  - updateJob
  - removeJob
  - listAgentJobs
  - deleteAgent
  - AgentJob interface
affects:
  - src/agents.ts
  - src/__tests__/agents.test.ts
tech-stack:
  added: []
  patterns:
    - lazy cwd resolution via projectDir()/agentsDir()/agentJobsDir()
    - frontmatter parsing without YAML lib (parseFrontmatterValue)
    - structural cron validation (5 fields + char whitelist)
key-files:
  created: []
  modified:
    - src/agents.ts
    - src/__tests__/agents.test.ts
decisions:
  - createAgent now delegates to addJob() for scheduled task storage
  - Job files use new frontmatter shape (label/cron/enabled/model) distinct from legacy jobs.ts schema (schedule/agent/recurring/notify)
  - Cron validation strengthened with structural pre-check since cronMatches accepts garbage
metrics:
  duration: ~15 min
  completed: 2026-04-07
  tasks: 1
  files_modified: 2
---

# Phase 17 Plan 1: Multi-Job Agents Storage Layer Summary

Multi-job storage primitives added to agents module: per-agent `jobs/` subdirectory with N labelled job files, full CRUD via addJob/updateJob/removeJob/listAgentJobs/deleteAgent, plus refactor of createAgent to write scheduled tasks under `agents/<name>/jobs/default.md`.

## What Changed

- **AgentJob interface** with label/cron/enabled/model?/trigger/path
- **validateJobLabel** — kebab-case enforcement, rejects path separators, empty, invalid casing
- **addJob** — validates agent exists, label, cron; refuses duplicates; writes frontmatter file
- **updateJob** — patches cron/trigger/enabled/model selectively; preserves untouched fields; re-validates cron when changed
- **removeJob** — unlinks file, throws if missing
- **listAgentJobs** — returns sorted parsed AgentJob[], `[]` if `jobs/` missing
- **deleteAgent** — recursive `rm` of agent dir (jobs/, MEMORY.md, all files)
- **createAgent refactor** — when `opts.schedule` provided, calls `addJob(name, "default", cron, body)` instead of writing to `.claude/claudeclaw/jobs/<name>.md`
- **Cron validation hardened** — structural 5-field + char whitelist check before delegating to `cronMatches` (which accepts garbage)

## Tests

45 tests in `src/__tests__/agents.test.ts`, all passing. New Phase 17 suite covers:
- validateJobLabel (accept/reject tables)
- addJob (success, duplicate, invalid cron, invalid label, missing agent)
- updateJob (selective patch, enabled toggle, body replace, missing job)
- removeJob (success, missing)
- listAgentJobs (sorted, empty)
- deleteAgent (recursive, no-op missing)
- createAgent + multi-job integration (writes new path, not legacy)

Two pre-existing Phase 16 tests updated to assert the new `agents/<name>/jobs/default.md` path.

## Verification

- `bun test src/__tests__/agents.test.ts` → 45 pass / 0 fail
- `bun test` → 615 pass / 13 fail (13 failures match STATE.md baseline, unchanged)
- `tsc --noEmit` → no new errors in agents.ts; only pre-existing baseline errors elsewhere
- No new dependencies added

## Deviations from Plan

None — plan executed as written. One minor strengthening: added structural cron validation (5 fields + char whitelist) inside `validateCronOrThrow` because `cronMatches` does not throw on malformed input, which would have caused the "throws on invalid cron" test to fail. This is consistent with the plan's intent (Rule 1 — bug fix in dependency assumption).

## Requirements Satisfied

- **AGENT-MULTI-01** — agents own `jobs/` subdirectory with N labelled job files (label, cron, enabled, optional model, trigger body) ✓
- **AGENT-MULTI-02** — deleteAgent removes the agent dir recursively including jobs/ ✓
- **WIZARD-03** — model field captured in job frontmatter when supplied ✓

## Commits

- `3332ddf` — feat(17-01): add multi-job CRUD primitives to agents module

## Self-Check: PASSED

- src/agents.ts modified ✓
- src/__tests__/agents.test.ts modified ✓
- Commit 3332ddf exists ✓
- All Phase 17 symbols exported ✓
