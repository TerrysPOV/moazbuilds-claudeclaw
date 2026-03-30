# Full-Spec Gap Analysis — moazbuilds/claudeclaw

## Current Architecture Summary

```
CLI Entry (src/index.ts)
├── start.ts          — Daemon orchestrator (heartbeat, cron, web, integrations)
├── telegram.ts       — Telegram bot adapter (long polling, raw fetch)
├── discord.ts        — Discord bot adapter (WebSocket gateway)
├── runner.ts         — Claude CLI subprocess runner
├── sessions.ts       — session.json persistence
├── jobs.ts           — Job file loader (.md frontmatter)
├── cron.ts           — Cron expression matcher
├── model-router.ts    — Keyword-based task classification + model selection
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

**Runtime:** Bun (ESM, no transpile step)
**Package Manager:** Bun (bun.lock)
**Daemon Model:** Single long-lived process; heartbeat via `setTimeout`; cron via `setInterval(60s)`; Telegram long-polling; Discord WebSocket gateway
**Persistence:** Flat JSON files in `.claude/claudeclaw/` (session.json, state.json, jobs/)

---

## Confirmed Implemented Capabilities

| Capability | Location | Status |
|---|---|---|
| Daemon lifecycle (start/stop/PID) | `start.ts`, `pid.ts` | ✅ Complete |
| Heartbeat scheduling | `start.ts:scheduleHeartbeat()`, `runner.ts` | ✅ Complete |
| Cron job scheduling | `start.ts:cron tick`, `cron.ts`, `jobs.ts` | ✅ Complete |
| Timezone-aware scheduling | `timezone.ts`, `cron.ts` | ✅ Complete |
| Telegram adapter (polling, DMs, groups, media) | `commands/telegram.ts` | ✅ Complete |
| Discord adapter (gateway, DMs, slash commands) | `commands/discord.ts` | ✅ Complete |
| Voice transcription (whisper.cpp + STT API) | `whisper.ts` | ✅ Complete |
| Security levels (locked/strict/moderate/unrestricted) | `config.ts`, `runner.ts:buildSecurityArgs()` | ✅ Complete |
| Tool allowlisting/denylisting | `config.ts:SecurityConfig`, `runner.ts` | ✅ Partial |
| User allowlisting per channel | `telegram.ts`, `discord.ts` | ✅ Complete |
| Model routing (keyword-based modes) | `model-router.ts` | ✅ Partial |
| GLM fallback on rate limit | `runner.ts:execClaude()` | ✅ Complete |
| Serial execution queue (no concurrent --resume) | `runner.ts:enqueue()` | ✅ Complete |
| Auto-compact on timeout (exit 124) | `runner.ts:runCompact()` | ✅ Partial |
| Session turn counter + compact warning | `sessions.ts`, `runner.ts` | ✅ Complete |
| Web dashboard (Bun HTTP + SSE) | `ui/server.ts`, `ui/page/` | ✅ Partial |
| Job management via API | `ui/server.ts` | ✅ Partial |
| Skill resolution (project/global/plugin) | `skills.ts` | ✅ Partial |
| Plugin preflight installation | `preflight.ts` | ✅ Complete |
| Statusline integration (Claude Code) | `statusline.ts` | ✅ Complete |
| Hot-reload config (30s interval) | `start.ts` | ✅ Complete |
| Configurable prompt templates | `prompts/`, `config.ts:resolvePrompt()` | ✅ Complete |

---

## Partial Capabilities (Need Hardening)

### 1. Session Persistence (`sessions.ts`)
- Only stores ONE global `session.json`
- **Problem:** No channel/session mapping. If the daemon dies, you cannot deterministically resume a Telegram or Discord conversation
- The session ID is shared globally; there's no per-conversation-thread mapping
- **Missing:** Durable channel→session mapping table with resume tokens

### 2. Event / Job Processing (`runner.ts`)
- `execClaude()` calls `claude -p` subprocess directly
- No event log, no idempotency keys, no retry queue, no dead-letter handling
- If Claude CLI crashes mid-execution, the job state is lost
- **Missing:** Persistent event log with idempotency, retry logic, DLQ

### 3. Tool Governance (`runner.ts:buildSecurityArgs()`)
- Security is flat — one `SecurityLevel` per entire daemon
- No per-channel tool policies (e.g., Telegram can use Bash but Discord cannot)
- No per-skill policy overlays
- No approval tiers (e.g., "run this dangerous tool only if operator approves")
- **Missing:** Policy engine with per-channel/skill rules, approval workflow

### 4. Model Routing (`model-router.ts`)
- Keyword+phrase classification only; no cost governance, no budget tracking
- No per-task model override
- No watchdogs for runaway agents
- **Missing:** Cost/budget tracking, per-task routing, usage telemetry

### 5. Orchestration (`runner.ts`)
- No task graph, no dependency execution
- Jobs run independently; no multi-step workflows with state
- No persisted workflow state for recovery after restart
- **Missing:** Task graph executor with persisted state, resumable jobs

### 6. Human Escalation
- No pause/resume/handoff mechanism
- No operator notification hooks (e.g., "this task needs human approval")
- No takeover metadata or state transitions
- **Missing:** Escalation path, operator notification, handoff protocol

### 7. Channel Adapter Coverage
- Telegram ✅
- Discord ✅
- **Missing:** Slack, Teams, Email, GitHub Events, WhatsApp, etc.

---

## Missing Capabilities (Not Present)

| Capability | Priority | Risk |
|---|---|---|
| Durable event log | Critical | High |
| Idempotent event processing | Critical | High |
| Retry queue | Critical | High |
| Dead-letter queue | Critical | High |
| Replay support | Critical | High |
| Channel→session mapping gateway | High | Medium |
| Per-channel session resume | High | Medium |
| Normalized event schema | High | Medium |
| Policy engine skeleton | High | Medium |
| Per-channel tool allowlists | Medium | Low |
| Skill-level policy overlays | Medium | Low |
| Approval tiers | Medium | Medium |
| Audit trail | Medium | Low |
| Per-task model routing | Medium | Medium |
| Cost tracking | Medium | Low |
| Runaway watchdog | Medium | Medium |
| Telemetry exposure | Low | Low |
| Task graph executor | Medium | High |
| Persisted workflow state | Medium | High |
| Resumable jobs | Medium | High |
| Pause / handoff / resume | Low | Medium |
| Operator notification | Low | Low |
| Slack adapter | Low | Low |
| Teams adapter | Low | Low |
| Email adapter | Low | Low |
| GitHub event bridge | Low | Low |

---

## Risk Areas

1. **Single global session** — All channels share one `session.json`. Telegram and Discord conversations interleave in the same session. Resuming a specific thread is not possible without a gateway layer.

2. **No event persistence** — The runner is fire-and-forget. If `claude -p` produces no output (crash, OOM), there's no recovery path except manual restart.

3. **No idempotency** — Re-triggering a cron job or re-sending a Telegram message produces duplicate Claude invocations. No deduplication.

4. **Serial queue is process-local** — The `enqueue()` in `runner.ts` is a JS Promise chain. If the daemon crashes, the queue is lost. Jobs in-flight are not recoverable.

5. **Policy is config-level only** — `security.disallowedTools` is a flat list applied globally. No per-channel or per-skill refinement.

6. **Model router is naive** — No cost tracking, no budget enforcement, no per-task override capability.

7. **No test harness** — `package.json` has no test scripts. The repo has zero test coverage.

---

## Recommended Implementation Order

### Stage A — Foundation (Durable Event Bus)
1. `src/event-log.ts` — Append-only event log with sequence numbers
2. `src/event-processor.ts` — Idempotent event processor with dedup
3. `src/retry-queue.ts` — Retry with exponential backoff
4. `src/dead-letter-queue.ts` — Failed event tracking
5. `src/replay.ts` — Replay from sequence N

### Stage B — Gateway / Session Mapping
6. `src/gateway/session-map.ts` — ChannelThread→session mapping
7. `src/gateway/resume.ts` — Resume specific channel threads
8. `src/gateway/normalizer.ts` — Unified inbound/outbound event schema

### Stage C — Policy Engine
9. `src/policy/engine.ts` — Rule engine skeleton
10. `src/policy/channel-policies.ts` — Per-channel tool allowlists
11. `src/policy/skill-overlays.ts` — Per-skill policy overrides
12. `src/policy/approval-queue.ts` — Approval tier + operator hooks
13. `src/policy/audit-log.ts` — Policy decision audit trail

### Stage D — Cost / Model Governance
14. `src/governance/cost-tracker.ts` — Per-session/channel usage accounting
15. `src/governance/router.ts` — Enhanced model router with budget controls
16. `src/governance/watchdog.ts` — Turn/roundcount watchdog

### Stage E — Orchestration
17. `src/orchestrator/task-graph.ts` — DAG-based task executor
18. `src/orchestrator/workflow-state.ts` — Persisted workflow state
19. `src/orchestrator/resumable-jobs.ts` — Job recovery after restart

### Stage F — Human Escalation
20. `src/escalation/pause.ts` — Pause/resume mechanism
21. `src/escalation/handoff.ts` — Operator handoff protocol
22. `src/escalation/notifications.ts` — Operator alert hooks

### Stage G — Additional Adapters
(Scaffold only — do not fake implementations)
23. `src/adapters/slack/` — Slack adapter skeleton
24. `src/adapters/teams/` — Teams adapter skeleton
25. `src/adapters/email/` — Email adapter skeleton
26. `src/adapters/github/` — GitHub events skeleton

---

## Proposed Module Boundaries (for new work)

```
src/
├── event-log.ts          # Append-only log, sequence numbers
├── event-processor.ts    # Idempotent processor, dedup cache
├── retry-queue.ts        # Exponential backoff retry queue
├── dead-letter-queue.ts  # Failed event store + retry trigger
├── replay.ts             # Replay from sequence N
│
├── gateway/              # NEW: Channel↔Session mapping layer
│   ├── session-map.ts    # Map channel+thread → sessionId+turn
│   ├── resume.ts         # Resume specific thread session
│   └── normalizer.ts    # Unified Event schema (all channels → normalized)
│
├── policy/               # NEW: Policy engine
│   ├── engine.ts         # Rule matcher + decision log
│   ├── channel-policies.ts
│   ├── skill-overlays.ts
│   ├── approval-queue.ts
│   └── audit-log.ts
│
├── governance/           # NEW: Cost + model governance
│   ├── cost-tracker.ts   # Per-session/channel/token accounting
│   ├── router.ts         # Enhanced model router
│   └── watchdog.ts       # Turn/roundcount limits
│
├── orchestrator/         # NEW: Task graph + workflow
│   ├── task-graph.ts     # DAG executor
│   ├── workflow-state.ts  # Persisted state machine
│   └── resumable-jobs.ts
│
├── escalation/          # NEW: Human escalation
│   ├── pause.ts
│   ├── handoff.ts
│   └── notifications.ts
│
└── adapters/            # NEW: Additional channel adapters (scaffold)
    ├── slack/
    ├── teams/
    ├── email/
    └── github/
```

---

*Document version: 1.0.0 | Repo: moazbuilds/claudeclaw | Analysis date: 2026-03-26*
