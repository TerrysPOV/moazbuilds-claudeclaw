# wisecron — internal tuner subsystem

> Adaptive scheduler + apply pipeline for the 8 new TunableSubjects added by
> the wisecron extension. Integrated INSIDE the tuner — not standalone, not
> MCP. See `~/agent/plugin-specs/wisecron/SPEC.md` for the full design.

## Architecture

```
src/tuner/
├── wisecron/                   ← this dir (orchestrator)
│   ├── index.ts                ← registerWisecronSubjects(registry, settings)
│   ├── types.ts                ← ScheduleState, RevisionRecord, AppliedBy, …
│   ├── state-db.ts             ← SQLite (subject_state, rollback_history, telemetry_cache)
│   ├── adaptive-scheduler.ts   ← 24h → 168h backoff math, deterministic
│   ├── proposal-engine.ts      ← collect → detect → propose → diff preview
│   └── apply-pipeline.ts       ← approve-then-apply + 5min observation window
└── subjects/                   ← 8 wisecron-managed subjects
    ├── cron-subject.ts            (high risk)
    ├── claude-md-subject.ts       (medium)
    ├── hook-subject.ts            (high risk)
    ├── mcp-plugin-subject.ts      (medium)
    ├── model-routing-subject.ts   (medium)
    ├── prompt-template-subject.ts (low)
    ├── memory-subject.ts          (low)
    └── agent-subject.ts           (low)
```

Foundation already in place at `src/skills-tuner/` (pre-rename):
- `core/interfaces.ts` — `TunableSubject` ABC, `RiskTier`
- `core/types.ts` — `Observation`, `Cluster`, `Proposal`, `Patch`
- `core/security.ts` — HMAC signing, audit log append
- `schedulers/systemd-user.ts` — `SchedulerBackend` for cron mutations
- `subjects/wisecron.ts` — `WiseCronSubject` (the legacy one, ~750 LOC, not touched)

The orchestrator REUSES the foundation. It does not duplicate anything.

## Lifecycle of one cycle

1. `AdaptiveScheduler.pickNextSubject()` reads `subject_state.next_run`, returns the soonest-due subject (or `null`).
2. `ProposalEngine.runCycle(subject, since=last_run)` calls:
   - `subject.collectObservations(since)`
   - `subject.detectProblems(observations)`
   - `subject.proposeChange(cluster)` per cluster
3. Proposals signed via `core/security.signProposal()` → diff preview rendered via `adapters/cli` or `adapters/telegram`.
4. User approves single-action → `ApplyPipeline.apply(proposal, alternativeId, appliedBy)`:
   - Snapshots current target → inverse patch.
   - `subject.apply()` → forward patch.
   - `subject.validate()` → reject if invalid.
   - Persist both patches in `rollback_history`.
   - Emit audit `wisecron_proposal_applied`.
   - If `subject.risk_tier ∈ {high, critical}`: arm 5-minute observation window. Auto-revert if errors detected.
5. `AdaptiveScheduler.recordRun(subject, proposalCount)` updates state. Zero proposals → +24h backoff. Non-zero → reset to 24h.

## Adaptive scheduling math

| consecutive_zero_runs | current_interval_hours |
|---|---|
| 0 | 24 |
| 1 | 48 |
| 2 | 72 |
| 3 | 96 |
| 4 | 120 |
| 5 | 144 |
| 6+ | 168 (cap) |

Reset trigger: any cycle with `proposalCount > 0` → `current_interval_hours = 24`, `consecutive_zero_runs = 0`.

Pure-function helpers `nextIntervalHours()` and `nextConsecutiveZero()` are exported on `AdaptiveScheduler` for unit tests.

## Rollback

- Every apply records `forward_patch` AND `inverse_patch` in `rollback_history`.
- Retention: 90 days default (`wisecron.rollback.retention_days`).
- Revert command: `tuner wisecron rollback <revision-id>` → replays inverse patch via `Subject.revert()` (or generic file-write fallback).
- High-risk subjects (Cron/Hook): observation window 5 min after apply auto-reverts if health signals fail.

### Observation-window probes are advisory by default

The 5-minute observation window only auto-reverts when a `healthProbe` is wired
— the default probe is fail-open. Wire a probe by either implementing
`healthProbe(target)` on the subject or passing `healthProbe` through
`new ApplyPipeline(registry, db, { healthProbe })`. When a high- or medium-risk
subject is registered without a probe, `registerWisecronSubjects` emits a
`console.warn` at boot so operators can spot the gap; auto-revert remains
disabled for that subject until a probe is supplied. Apply with explicit
`observe=false` if the lack of probe is intentional.

## LLM usage

- Phase 1: `core/llm.ts` directly (sonnet for `proposeChange()`, no LLM for `apply()`).
- Phase 2: swap to `llm-router-mcp` (PR #70) when merged. Zero code change in wisecron — `core/llm.ts` handles the swap.

## Settings (config.yaml)

See `WisecronSettingsSchema` in `types.ts`. Opt-in: `wisecron.enabled: true` required.

## What is NOT here (yet)

- CLI commands (`tuner wisecron list-subjects`, `run`, `next`, `status`, `rollback`, `pause`, `resume`) — wired in `src/skills-tuner/cli/index.ts` post-rename.
- Subject `collect()`/`propose()`/`apply()` implementations — every subject ships as a skeleton with TODO markers. Filling them is the `plugin-test` step.
- Multi-OS SchedulerBackend adapters (launchd, schtasks) — Phase 2, upstream PR.

## Naming note

This subsystem lives at `src/tuner/` (post-rename) but currently imports from `src/skills-tuner/` (pre-rename). The rename `skills-tuner → tuner` is in-scope for this PR and will be a separate commit before the subjects-population commits.
