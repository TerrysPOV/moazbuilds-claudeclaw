---
phase: 18-per-job-model-override-runtime-wiring-milestone-blocker
plan: 01
subsystem: runner+jobs
tags: [runner, jobs, model-override, cron, milestone-blocker]
requires:
  - src/runner.ts execClaude primaryConfig branch
  - src/jobs.ts parseJobFile model field
  - src/commands/start.ts cron tick
provides:
  - RunOptions.modelOverride threaded through run() -> execClaude() -> runClaudeOnce()
  - VALID_MODEL_STRINGS allowlist + validateModelString() + resolveJobModel() in jobs.ts
  - Load-time rejection of invalid model strings in loadJobs()
  - Cron tick resolves job.model and passes modelOverride
affects:
  - src/runner.ts
  - src/jobs.ts
  - src/commands/start.ts
  - src/__tests__/jobs.test.ts
  - src/__tests__/runner.test.ts (new)
tech-stack:
  added: []
  patterns:
    - spy-on-runClaudeOnce-with-sentinel-throw
key-files:
  created:
    - src/__tests__/runner.test.ts
  modified:
    - src/jobs.ts
    - src/runner.ts
    - src/commands/start.ts
    - src/__tests__/jobs.test.ts
decisions:
  - Override branch precedes agentic branch (override wins over agentic routing)
  - Invalid models skipped at loadJobs() with console.error, not thrown (so one bad job doesn't kill daemon)
  - resolveJobModel returns undefined for empty string (agent default lookup deferred to Plan 02)
  - runClaudeOnce exported (one-keyword change) to enable spy-based unit testing
metrics:
  duration: ~25min
  completed: 2026-04-08
---

# Phase 18 Plan 01: Per-Job Model Override Runtime Wiring Summary

Threaded `model` field from job frontmatter through `run() -> execClaude() -> runClaudeOnce()` so cron jobs actually execute on the requested model. Added load-time validation in `loadJobs()` so invalid model strings (typos like `opuz`) fail fast at daemon startup with a clear log line, not at 3am when the cron fires.

## Tasks Completed

| Task | Name                                            | Commit  |
| ---- | ----------------------------------------------- | ------- |
| 1    | jobs.ts model validation + load-time rejection | 9ffb0bf |
| 2    | runner.ts modelOverride wiring + start.ts tick | 7e6dae9 |

## Implementation Notes

**runner.ts** — `execClaude` now branches in this order:
1. `options?.modelOverride` set → `primaryConfig = { model: override, api }`, taskType=`job-override`
2. `agentic.enabled` → existing governance routing path (preserved verbatim)
3. else → `primaryConfig = { model, api }` (settings default)

The existing `glm` sentinel logic in `runClaudeOnce` (suppressing `--model glm` and setting `ANTHROPIC_BASE_URL` via `buildChildEnv`) is unchanged — it operates on the model string regardless of how it arrived, so `modelOverride: "glm"` Just Works.

**jobs.ts** — `VALID_MODEL_STRINGS` is a frozen `Set<string>` of `["opus", "sonnet", "haiku", "glm"]`. `validateModelString` is case-insensitive and trim-tolerant. Empty/undefined are no-ops. `loadJobs()` wraps the validation in try/catch per job — invalid jobs are logged and skipped, valid siblings still load.

**start.ts** — cron tick now `await`s `resolveJobModel(job)` and passes `{ modelOverride }` to `run()` only when set (so back-compat: jobs without `model:` get `undefined` options).

## Test Results

| Suite                          | Pass / Fail |
| ------------------------------ | ----------- |
| src/__tests__/jobs.test.ts     | 16 / 0      |
| src/__tests__/runner.test.ts   | 3 / 0       |
| Full suite                     | 710 / 13    |

13 failures are pre-existing (unchanged from baseline). No regressions.

## Deviations from Plan

None of substance.

- Plan suggested cases 3-5 in runner.test.ts could defer to Plan 03. Implemented case 1 (override forwarded), case 2 (back-compat settings.model), and case 3 (glm forwarded). Cases 4-5 (agentic-collision, governanceSelectModel sanity) deferred to Plan 03 — would require mocking `governanceSelectModel`, which is more invasive than the spy-on-`runClaudeOnce` pattern justifies for this plan.
- `runClaudeOnce` was made `export` (one keyword) per plan option (b). This is the only public API surface change to runner.ts beyond `RunOptions` + `run()` signature.

## Self-Check: PASSED

- src/runner.ts contains `RunOptions`, `modelOverride.*primaryConfig`, exported `runClaudeOnce`
- src/jobs.ts contains `VALID_MODEL_STRINGS`, `validateModelString`, `resolveJobModel`
- src/commands/start.ts contains `resolveJobModel(job)` at cron tick
- src/__tests__/runner.test.ts created and passing
- Commits 9ffb0bf and 7e6dae9 present in `git log`
