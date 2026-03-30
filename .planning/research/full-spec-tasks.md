# Full-Spec Tasks — moazbuilds/claudeclaw

## How to Use This Document

Each task has:
- **ID** — use for commit messages: `feat: add event-log module`
- **Status** — `TODO` | `IN_PROGRESS` | `DONE` | `BLOCKED`
- **Stage** — A through G
- **Prerequisites** — tasks that must be complete first
- **Verification** — how to confirm the task is done

---

## Stage A — Persistent Event Bus

### A.1 — Event Log Module
- **File:** `src/event-log.ts`
- **Status:** TODO
- **Prerequisites:** None
- **Verification:** Unit test: append entry, read back, verify seq increases

### A.2 — Idempotent Event Processor
- **File:** `src/event-processor.ts`
- **Status:** TODO
- **Prerequisites:** A.1
- **Verification:** Unit test: send duplicate event, verify only one processing

### A.3 — Retry Queue
- **File:** `src/retry-queue.ts`
- **Status:** TODO
- **Prerequisites:** A.2
- **Verification:** Unit test: simulate failure, verify exponential backoff schedule

### A.4 — Dead Letter Queue
- **File:** `src/dead-letter-queue.ts`
- **Status:** TODO
- **Prerequisites:** A.3
- **Verification:** Unit test: max retries exceeded, verify DLQ entry created

### A.5 — Replay Support
- **File:** `src/replay.ts`
- **Status:** TODO
- **Prerequisites:** A.1, A.2
- **Verification:** Integration test: create 5 events, replay from seq 3, verify 3,4,5 reprocessed

---

## Stage B — Gateway / Session Mapping

### B.1 — Session Map Store
- **File:** `src/gateway/session-map.ts`
- **Status:** TODO
- **Prerequisites:** A.1
- **Verification:** Unit test: create 2 sessions for same channel, different threads

### B.2 — Resume Logic
- **File:** `src/gateway/resume.ts`
- **Status:** TODO
- **Prerequisites:** B.1, A.1
- **Verification:** Unit test: resume session, verify correct sessionId returned

### B.3 — Normalized Event Schema
- **File:** `src/gateway/normalizer.ts`
- **Status:** TODO
- **Prerequisites:** A.1
- **Verification:** Unit test: normalize Telegram event + Discord event, verify same schema

### B.4 — Gateway Orchestrator
- **File:** `src/gateway/index.ts`
- **Status:** TODO
- **Prerequisites:** B.1, B.2, B.3, A.1
- **Verification:** Integration test: send event through gateway, verify logged + processed

---

## Stage C — Policy Engine

### C.1 — Policy Engine Core
- **File:** `src/policy/engine.ts`
- **Status:** TODO
- **Prerequisites:** A.1
- **Verification:** Unit test: deny rule matches → denied, no rule → allowed

### C.2 — Channel Policies
- **File:** `src/policy/channel-policies.ts`
- **Status:** TODO
- **Prerequisites:** C.1
- **Verification:** Unit test: telegram channel denied tool X, discord channel allowed

### C.3 — Skill Policy Overlays
- **File:** `src/policy/skill-overlays.ts`
- **Status:** TODO
- **Prerequisites:** C.1
- **Verification:** Unit test: skill with restricted tools overrides channel policy

### C.4 — Approval Queue
- **File:** `src/policy/approval-queue.ts`
- **Status:** TODO
- **Prerequisites:** C.1
- **Verification:** Unit test: require_approval event → queued; approve → released

### C.5 — Audit Log
- **File:** `src/policy/audit-log.ts`
- **Status:** TODO
- **Prerequisites:** C.1
- **Verification:** Unit test: policy decision → audit entry logged

---

## Stage D — Cost / Model Governance

### D.1 — Cost Tracker
- **File:** `src/governance/cost-tracker.ts`
- **Status:** TODO
- **Prerequisites:** B.1
- **Verification:** Unit test: simulate usage record, verify cumulative totals

### D.2 — Enhanced Model Router
- **File:** `src/governance/router.ts`
- **Status:** TODO
- **Prerequisites:** D.1
- **Verification:** Unit test: budget exhausted → route to cheaper model

### D.3 — Runaway Watchdog
- **File:** `src/governance/watchdog.ts`
- **Status:** TODO
- **Prerequisites:** D.1
- **Verification:** Unit test: maxToolCalls exceeded → watchdog triggered

### D.4 — Dashboard Telemetry
- **File:** `src/governance/dashboard-telemetry.ts`
- **Status:** TODO
- **Prerequisites:** D.1
- **Verification:** API test: GET /api/telemetry → returns usage stats

---

## Stage E — Orchestration Layer

### E.1 — Task Graph Executor
- **File:** `src/orchestrator/task-graph.ts`
- **Status:** TODO
- **Prerequisites:** D.1
- **Verification:** Unit test: 3-task graph with dep → verify execution order

### E.2 — Workflow State
- **File:** `src/orchestrator/workflow-state.ts`
- **Status:** TODO
- **Prerequisites:** E.1
- **Verification:** Integration test: stop/restart daemon, verify workflow resumed from state

### E.3 — Resumable Jobs
- **File:** `src/orchestrator/resumable-jobs.ts`
- **Status:** TODO
- **Prerequisites:** E.2
- **Verification:** Integration test: daemon restart, verify pending job resumes

---

## Stage F — Human Escalation

### F.1 — Pause Mechanism
- **File:** `src/escalation/pause.ts`
- **Status:** TODO
- **Prerequisites:** A.1
- **Verification:** Unit test: pause → new event rejected with "daemon paused"

### F.2 — Handoff Protocol
- **File:** `src/escalation/handoff.ts`
- **Status:** TODO
- **Prerequisites:** E.1
- **Verification:** Unit test: handoff triggered → state package created

### F.3 — Operator Notifications
- **File:** `src/escalation/notifications.ts`
- **Status:** TODO
- **Prerequisites:** F.1
- **Verification:** Unit test: escalation event → notification payload formatted

---

## Stage G — Additional Adapters (Scaffold Only)

### G.1 — Slack Adapter Scaffold
- **File:** `src/adapters/slack/README.md` (interface docs, not code)
- **Status:** TODO
- **Prerequisites:** B.4 (gateway complete)
- **Verification:** README documents required env vars + interface

### G.2 — Teams Adapter Scaffold
- **File:** `src/adapters/teams/README.md`
- **Status:** TODO
- **Prerequisites:** B.4
- **Verification:** README documents required env vars + interface

### G.3 — Email Adapter Scaffold
- **File:** `src/adapters/email/README.md`
- **Status:** TODO
- **Prerequisites:** B.4
- **Verification:** README documents required env vars + interface

### G.4 — GitHub Adapter Scaffold
- **File:** `src/adapters/github/README.md`
- **Status:** TODO
- **Prerequisites:** B.4
- **Verification:** README documents required env vars + interface

---

## Utility Tasks

### U.1 — Test Harness Setup
- **File:** `src/__tests__/` directory + bun test config
- **Status:** TODO
- **Prerequisites:** None
- **Verification:** `bun test` runs; at least one passing test

### U.2 — Docs: Architecture Overview
- **File:** `docs/architecture.md`
- **Status:** TODO
- **Prerequisites:** None
- **Verification:** Document exists, covers all Stage A-E modules

---

## Task Checklist

```
Stage A:
[ ] A.1 event-log.ts
[ ] A.2 event-processor.ts
[ ] A.3 retry-queue.ts
[ ] A.4 dead-letter-queue.ts
[ ] A.5 replay.ts

Stage B:
[ ] B.1 session-map.ts
[ ] B.2 resume.ts
[ ] B.3 normalizer.ts
[ ] B.4 gateway/index.ts

Stage C:
[ ] C.1 policy/engine.ts
[ ] C.2 channel-policies.ts
[ ] C.3 skill-overlays.ts
[ ] C.4 approval-queue.ts
[ ] C.5 audit-log.ts

Stage D:
[ ] D.1 cost-tracker.ts
[ ] D.2 governance/router.ts
[ ] D.3 watchdog.ts
[ ] D.4 dashboard-telemetry.ts

Stage E:
[ ] E.1 task-graph.ts
[ ] E.2 workflow-state.ts
[ ] E.3 resumable-jobs.ts

Stage F:
[ ] F.1 pause.ts
[ ] F.2 handoff.ts
[ ] F.3 notifications.ts

Stage G:
[ ] G.1 adapters/slack/README.md
[ ] G.2 adapters/teams/README.md
[ ] G.3 adapters/email/README.md
[ ] G.4 adapters/github/README.md

Utility:
[ ] U.1 test harness
[ ] U.2 architecture.md
```

---

*Document version: 1.0.0 | Repo: moazbuilds/claudeclaw | Tasks date: 2026-03-26*
