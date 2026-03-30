# Project: ClaudeClaw v2 Architecture Upgrade

## One-Liner
Brownfield upgrade of moazbuilds/claudeclaw toward a full OpenClaw-style architecture with durable event bus, gateway/session mapping, policy engine, and orchestration layer.

## Vision
Transform the current ClaudeClaw plugin from a fire-and-forget daemon into a robust, production-ready agent platform with durable execution, fine-grained governance, and multi-channel session management. This is Phase 1 of the v2 architecture — the foundation for a scalable, observable, and auditable AI agent system.

## Status
**Phase:** 0 — Project Initialization (GSD Structure Setup)
**Next Phase:** 1 — Persistent Event Bus
**Type:** Brownfield upgrade (preserves existing modules, adds new capabilities)
**Started:** 2026-03-26
**ETA:** TBD (7 phases planned)

## Problem Statement

### Current State Issues
- **Single global session:** All channels share one `session.json`. Telegram and Discord conversations interleave in the same session. Resuming a specific thread is not possible.
- **No event persistence:** The runner is fire-and-forget. If `claude -p` crashes or OOMs, there's no recovery path.
- **No idempotency:** Re-triggering a cron job or re-sending a message produces duplicate Claude invocations.
- **Serial queue is process-local:** The `enqueue()` is a JS Promise chain. If the daemon crashes, the queue is lost.
- **Policy is config-level only:** `security.disallowedTools` is a flat list applied globally. No per-channel or per-skill refinement.
- **Model router is naive:** No cost tracking, no budget enforcement, no per-task override capability.
- **No test harness:** `package.json` has no test scripts. The repo has zero test coverage.

### Target State
- **Durable event log** with sequence numbers and replay capability
- **Channel→session mapping gateway** for per-conversation resume
- **Policy engine** with per-channel/skill rules and audit trail
- **Cost governance** with budget tracking and model routing
- **Orchestration layer** with task graphs and resumable workflows
- **Human escalation** with pause/handoff/notification mechanisms

## Architecture Overview

### Current Architecture
```
CLI Entry (src/index.ts)
├── start.ts          — Daemon orchestrator (heartbeat, cron, web, integrations)
├── telegram.ts       — Telegram bot adapter (long polling, raw fetch)
├── discord.ts        — Discord bot adapter (WebSocket gateway)
├── runner.ts         — Claude CLI subprocess runner
├── sessions.ts       — session.json persistence
├── jobs.ts           — Job file loader (.md frontmatter)
├── cron.ts           — Cron expression matcher
├── model-router.ts   — Keyword-based task classification + model selection
├── config.ts         — settings.json loader + SecurityConfig
├── skills.ts         — SKILL.md resolver
├── statusline.ts     — state.json writer (for Claude Code status bar)
├── preflight.ts      — Plugin installer
├── whisper.ts        — Voice transcription (whisper.cpp or external STT API)
├── timezone.ts       — TZ offset math + clock prompt builder
├── pid.ts            — daemon.pid file manager
├── web.ts / ui/     — HTTP dashboard + SSE chat API
└── prompts/         — Identity, user, soul prompt templates
```

### Target Architecture (v2)
```
src/
├── index.ts                    # CLI entry (existing)
├── start.ts                    # Daemon orchestrator (existing)
├── commands/                   # Telegram, Discord adapters (existing)
├── runner.ts                   # Subprocess runner (existing, preserved)
├── sessions.ts                 # Session persistence (existing)
├── config.ts                   # Configuration (existing)
├── model-router.ts             # Model routing (existing)
│
├── event-log.ts               # NEW: Append-only event log
├── event-processor.ts         # NEW: Idempotent event processor
├── retry-queue.ts             # NEW: Exponential backoff retry
├── dead-letter-queue.ts       # NEW: Failed event handling
├── replay.ts                  # NEW: Event replay from sequence
│
├── gateway/                   # NEW: Channel↔Session mapping
│   ├── session-map.ts         # Channel+thread → session mapping
│   ├── resume.ts              # Resume specific thread session
│   ├── normalizer.ts          # Unified event schema
│   └── index.ts               # Gateway orchestrator
│
├── policy/                    # NEW: Policy engine
│   ├── engine.ts              # Rule matcher + decision log
│   ├── channel-policies.ts    # Per-channel tool policies
│   ├── skill-overlays.ts      # Per-skill policy overlays
│   ├── approval-queue.ts      # Approval workflow
│   └── audit-log.ts           # Policy decision audit trail
│
├── governance/                # NEW: Cost + model governance
│   ├── cost-tracker.ts        # Per-session usage accounting
│   ├── router.ts              # Enhanced model router
│   ├── watchdog.ts            # Turn/roundcount limits
│   └── dashboard-telemetry.ts # Usage stats for dashboard
│
├── orchestrator/              # NEW: Task graph + workflow
│   ├── task-graph.ts          # DAG executor
│   ├── workflow-state.ts      # Persisted workflow state
│   └── resumable-jobs.ts      # Job recovery after restart
│
├── escalation/                # NEW: Human escalation
│   ├── pause.ts               # Pause/resume mechanism
│   ├── handoff.ts             # Operator handoff protocol
│   └── notifications.ts       # Operator alert hooks
│
└── adapters/                  # NEW: Additional channel adapters (scaffold)
    ├── slack/
    ├── teams/
    ├── email/
    └── github/
```

## Tech Stack
- **Runtime:** Bun (ESM, no transpile step)
- **Package Manager:** Bun (bun.lock)
- **Language:** TypeScript
- **Testing:** bun test (to be configured)
- **Persistence:** Flat JSON/JSONL files (no DB dependency)
- **Daemon Model:** Single long-lived process with durable state

## Key Constraints
1. **No rewrite:** All changes are additive. Existing abstractions preserved unless actively broken.
2. **ESM-first:** All new modules use ESM imports.
3. **Bun compatibility:** New modules must work with Bun runtime.
4. **No DB dependency:** Persistence via flat JSON/JSONL files.
5. **Incremental commits:** Each sub-item is a separate commit.

## Phases

| Phase | Name | Focus | Key Deliverables |
|-------|------|-------|------------------|
| 1 | Event Bus | Durable event log, idempotent processing | `event-log.ts`, `event-processor.ts`, `retry-queue.ts`, `dead-letter-queue.ts`, `replay.ts` |
| 2 | Session Gateway | Channel→session mapping, per-thread resume | `gateway/session-map.ts`, `gateway/resume.ts`, `gateway/normalizer.ts`, `gateway/index.ts` |
| 3 | Policy Engine | Fine-grained tool governance | `policy/engine.ts`, `policy/channel-policies.ts`, `policy/skill-overlays.ts`, `policy/approval-queue.ts`, `policy/audit-log.ts` |
| 4 | Cost Governance | Usage tracking, budget controls | `governance/cost-tracker.ts`, `governance/router.ts`, `governance/watchdog.ts`, `governance/dashboard-telemetry.ts` |
| 5 | Orchestration | Task graphs, resumable workflows | `orchestrator/task-graph.ts`, `orchestrator/workflow-state.ts`, `orchestrator/resumable-jobs.ts` |
| 6 | Human Escalation | Pause, handoff, notifications | `escalation/pause.ts`, `escalation/handoff.ts`, `escalation/notifications.ts` |
| 7 | Additional Adapters | Scaffold for Slack, Teams, Email, GitHub | `adapters/slack/`, `adapters/teams/`, `adapters/email/`, `adapters/github/` |

## References
- Original analysis: `.planning/research/full-spec-gap-analysis.md`
- Original roadmap: `.planning/research/full-spec-roadmap.md`
- Task breakdown: `.planning/research/full-spec-tasks.md`

## Files

### Project Root
- `PROJECT.md` — This file
- `WORKLOG.md` — Ongoing work tracking

### Planning
- `.planning/tech-stack.md` — Technology decisions and rationale
- `.planning/workflow.md` — GSD workflow configuration
- `.planning/STATE.md` — Current phase/plan state (auto-managed)
- `.planning/ROADMAP.md` — Phase roadmap (auto-managed)
- `.planning/research/` — Historical analysis documents
- `.planning/phases/` — Phase-specific plans

## Success Criteria
- [ ] All 7 phases complete
- [ ] Test coverage > 80% for new modules
- [ ] Zero breaking changes to existing functionality
- [ ] Documentation complete for all new modules
- [ ] Performance parity or improvement vs v1
