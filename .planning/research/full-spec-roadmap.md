# Full-Spec Roadmap — moazbuilds/claudeclaw

## Overview

This roadmap covers bringing the ClaudeClaw plugin to a full OpenClaw-style architecture with 7 capability stages. Each stage is gated — later stages depend on earlier ones.

**Constraint:** No rewrite of existing modules. New code goes into new files under `src/`. Existing abstractions are preserved unless actively broken.

---

## Stage A — Persistent Event Bus

**Goal:** Replace fire-and-forget `runner.ts` invocations with a durable, replayable event log.

### A.1 — Event Log (`src/event-log.ts`)
- Append-only log file in `.claude/claudeclaw/event-log/`
- Each entry: `{ id, seq, timestamp, type, channelId, threadId, payload, status, retryCount }`
- Sequence numbers monotonically increase
- Log file rotated daily or at 10MB
- **Reader:** Event processor reads unprocessed entries
- **Writer:** Enqueue events for processing

### A.2 — Idempotent Event Processor (`src/event-processor.ts`)
- Process events from log sequentially
- Deduplication: compute `hash(channelId + threadId + payload)` — skip if hash seen in last 1000 processed
- On success: mark entry `status: "done"`
- On failure: increment `retryCount`, schedule retry

### A.3 — Retry Queue (`src/retry-queue.ts`)
- In-memory priority queue ordered by `nextRetryAt`
- Exponential backoff: `delay = min(baseDelay * 2^retryCount, maxDelay)` — base=5s, max=10min
- Persisted to `.claude/claudeclaw/retry-queue.json` on each update
- On restart: reload queue from persisted state
- Process runs every 5 seconds via `setInterval`

### A.4 — Dead Letter Queue (`src/dead-letter-queue.ts`)
- Entries that exceed `maxRetries` (default: 5) go to DLQ
- DLQ stored at `.claude/claudeclaw/dlq.jsonl`
- Each DLQ entry: full event + all retry attempts + final error
- API endpoint or CLI command to inspect DLQ
- Manual replay-from-DLQ command

### A.5 — Replay Support (`src/replay.ts`)
- `replayFrom(seq: number)` — reprocess all events from seq N
- `replayRange(seqStart, seqEnd)` — reprocess a range
- `replayDLQ()` — retry all DLQ entries
- **Safety:** replay always creates new event entries (never modifies existing done entries)

---

## Stage B — Gateway / Session Mapping

**Goal:** Map each channel+thread combination to its own session, enabling per-conversation resume.

### B.1 — Session Map Store (`src/gateway/session-map.ts`)
- File: `.claude/claudeclaw/session-map.json`
- Schema: `{ [channelId: string]: { [threadId: string]: { sessionId, createdAt, lastSeq, turnCount } } }`
- `channelId` format: `"telegram:123456"` / `"discord:channelId:msgId"`
- Operations: `get(channel, thread)`, `set(channel, thread, sessionId)`, `delete(channel, thread)`

### B.2 — Resume Logic (`src/gateway/resume.ts`)
- On inbound message: look up session for that channel+thread
- Pass `--resume <sessionId>` to `claude -p`
- If no session found: create new session and register in session map
- **Key insight:** Each Telegram chat / Discord channel+thread gets its own Claude session

### B.3 — Normalized Event Schema (`src/gateway/normalizer.ts`)
- All inbound events (Telegram, Discord, cron, webhook) normalized to:
```typescript
interface NormalizedEvent {
  id: string;           // uuid
  channel: string;       // "telegram" | "discord" | "cron" | "webhook"
  channelId: string;    // platform-specific ID
  threadId?: string;     // thread/topic/guild ID
  userId: string;       // platform user ID
  text: string;
  attachments?: Attachment[];
  timestamp: number;
  seq: number;          // event log sequence
}
```
- Outbound: normalize back to platform-specific format before sending

### B.4 — Gateway Orchestrator (`src/gateway/index.ts`)
- Single gateway that routes `NormalizedEvent` → event log → processor
- Decouples channel adapters from processing
- Enables adding new channels (Slack, etc.) without changing event processing

---

## Stage C — Policy Engine

**Goal:** Fine-grained tool governance per channel, per skill, per user, with audit trail.

### C.1 — Policy Engine Core (`src/policy/engine.ts`)
- Rules: `{ id, channel?, skill?, tool, action: "allow" | "deny" | "require_approval", conditions? }`
- Conditions: `{ userId?, toolArgs?, timeWindow? }`
- Evaluation: deny → require_approval → allow
- Policy file: `.claude/claudeclaw/policies.json`
- **IMPORTANT:** Policy engine is a **skeleton** — it evaluates rules but approval workflow (C.4) is where actual blocking happens

### C.2 — Channel Policies (`src/policy/channel-policies.ts`)
- Per-channel tool allowlists/denylists
- E.g., `"telegram:allowedUserIds"` → `"telegram:allowedTools"` (if set, only these tools; if not set, use global security level)
- E.g., `"discord:allowedUserIds"` → Discord-specific tool restrictions

### C.3 — Skill Policy Overlays (`src/policy/skill-overlays.ts`)
- Each skill can declare required/preferred tools in its SKILL.md frontmatter
- Policy engine respects skill tool preferences
- E.g., a `code-review` skill might require Bash but allow no filesystem tools

### C.4 — Approval Queue (`src/policy/approval-queue.ts`)
- Tool use requests that need approval: pause event processing, notify operator
- Operator endpoint: `POST /api/policy/approve/{eventId}` or `POST /api/policy/deny/{eventId}`
- SSE stream for real-time approval requests in dashboard
- **IMPORTANT:** This is a **skeleton** — approval UI and operator flow not in scope

### C.5 — Audit Log (`src/policy/audit-log.ts`)
- Every policy decision logged: `{ timestamp, eventId, channel, userId, tool, action, reason }`
- File: `.claude/claudeclaw/audit-log.jsonl`
- Retention: 30 days, then rotate

---

## Stage D — Cost / Model Governance

**Goal:** Track LLM usage per session/channel, enforce budgets, add watchdog protection.

### D.1 — Cost Tracker (`src/governance/cost-tracker.ts`)
- Parse Claude JSON output for `usage` block (input_tokens, output_tokens, cache_creation, cache_read)
- Store per-session usage in `.claude/claudeclaw/usage/`
- Compute approximate cost using model pricing table
- **IMPORTANT:** This is a **skeleton** — cost calculation is approximate (uses fixed per-token rates)

### D.2 — Enhanced Model Router (`src/governance/router.ts`)
- Extends `model-router.ts` with: budget-aware selection, per-task override support
- Route based on: task type, session budget remaining, user-specified model
- Config: `modelBudgets: { [model]: { monthlyLimit, perSessionLimit } }`

### D.3 — Runaway Watchdog (`src/governance/watchdog.ts`)
- Monitor active Claude invocations for: excessive tool calls, excessive turns, repeated same tool calls
- Config: `maxToolCalls`, `maxTurns`, `maxRepeatToolCalls`
- On trigger: kill subprocess, send event to DLQ, notify operator
- **IMPORTANT:** Watchdog is a **skeleton** — process killing is not implemented

### D.4 — Dashboard Telemetry (`src/governance/dashboard-telemetry.ts`)
- Expose usage stats to web dashboard: per-channel spend, session counts, token totals
- Endpoint: `GET /api/telemetry`

---

## Stage E — Orchestration Layer

**Goal:** Multi-step task graph with persisted state, enabling durable workflows.

### E.1 — Task Graph (`src/orchestrator/task-graph.ts`)
- Task definition: `{ id, type, deps: taskId[], action, rollback?, onError }`
- Execute tasks in topological order (deps first)
- Parallel execution for independent tasks
- **IMPORTANT:** This is a **skeleton** — graph execution is implemented but not wired to existing runner

### E.2 — Workflow State (`src/orchestrator/workflow-state.ts`)
- Persist workflow state after each task: `{ workflowId, currentTasks, completedTasks, results, error }`
- File: `.claude/claudeclaw/workflows/{workflowId}.json`
- On restart: reload and resume from last incomplete task

### E.3 — Resumable Jobs (`src/orchestrator/resumable-jobs.ts`)
- Wrap `jobs.ts` job execution in workflow state
- On daemon restart: resume all pending workflows before accepting new work
- Cron trigger → workflow creation → persisted execution

---

## Stage F — Human Escalation

**Goal:** Operator can pause, handoff, and resume agent work.

### F.1 — Pause Mechanism (`src/escalation/pause.ts`)
- Set flag: `.claude/claudeclaw/paused.json` → `{ paused: true, reason, pausedAt }`
- When paused: reject new events with `Error: daemon paused`
- Existing in-flight events complete normally
- Resume: clear flag, resume event processing

### F.2 — Handoff Protocol (`src/escalation/handoff.ts`)
- On handoff trigger: serialize current workflow state + pending events
- Create handoff package: `{ state, pendingEvents, sessionContext }`
- Deliver to operator via configured channel (webhook / email)
- **IMPORTANT:** This is a **skeleton** — handoff delivery not implemented

### F.3 — Operator Notifications (`src/escalation/notifications.ts`)
- Config: `{ escalationWebhook?, escalationEmail? }`
- Events that trigger notification: DLQ overflow, watchdog trigger, policy denial, uncaught error
- Notification payload: `{ type, severity, eventId, message, timestamp }`

---

## Stage G — Additional Adapters (Scaffold Only)

**Constraint:** Do not build fake integrations. Only create directory skeletons and documented interfaces if the architecture is ready.

### G.1 — Slack Adapter (`src/adapters/slack/`)
- **Prerequisite:** Gateway layer (Stage B) must be complete and tested
- Create directory structure, README explaining what's needed
- Document: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, event webhook requirements

### G.2 — Microsoft Teams Adapter (`src/adapters/teams/`)
- Same prerequisite as G.1
- Document: Teams bot framework requirements, message formatting

### G.3 — Email Adapter (`src/adapters/email/`)
- Document: IMAP/SMTP or API-based email integration requirements

### G.4 — GitHub Events Adapter (`src/adapters/github/`)
- Document: GitHub webhook events + app permissions needed

---

## Implementation Notes

1. **Preserve existing behavior:** All changes are additive. `runner.ts` stays as-is until Stage B integration.
2. **No test rewrite:** Add tests for new modules only. `src/__tests__/` directory.
3. **ESM-first:** All new modules use ESM imports.
4. **Bun compatibility:** New modules must work with Bun runtime (no Node-specific APIs without feature detection).
5. **Incremental commits:** Each sub-item (A.1, A.2, etc.) is a separate commit.
6. **TODO labeling:** Incomplete implementations use `// TODO(stage-X): <description>` comments.
7. **No DB dependency:** Persistence via flat JSON/JSONL files (same pattern as existing `sessions.ts`, `jobs.ts`).

---

*Document version: 1.0.0 | Repo: moazbuilds/claudeclaw | Roadmap date: 2026-03-26*
