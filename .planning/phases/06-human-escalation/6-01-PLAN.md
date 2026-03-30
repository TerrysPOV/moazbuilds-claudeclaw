---
phase: 6
plan: 01
name: Human Escalation
objective: Implement persisted pause/resume, structured handoff packages, and auditable operator notifications aligned with the event bus, orchestration layer, policy engine, and governance controls
description: Durable operator pause, handoff, and notification controls for human-in-the-loop intervention
tags: [escalation, pause, handoff, notifications, human-in-the-loop]
wave: 1
estimated_duration: 3h
autonomous: true
gap_closure: false

dependencies:
  - phase: 1
    plan: 01
    reason: Event bus integration for pause/resume events
  - phase: 2
    plan: 04
    reason: Session gateway for context references
  - phase: 3
    plan: 01
    reason: Policy engine for approval workflows
  - phase: 4
    plan: 02
    reason: Governance controls for triggers
  - phase: 5
    plan: 01
    reason: Orchestration state for handoff packages

must_haves:
  - pause state persisted and survives restart
  - pause modes work (admission_only, admission_and_scheduling)
  - gateway and orchestrator respect pause state
  - handoff packages created with workflow/session/event context
  - handoff records durable and queryable
  - escalation notifications for DLQ, watchdog, policy, errors
  - rate limiting and deduplication on notifications
  - resume restores normal operation
  - audit records for all escalation actions
  - CLI commands for pause/resume/handoff
  - tests cover pause/restart, handoff lifecycle, notifications
---

# Phase 6: Human Escalation

## Goal
Implement a durable human escalation layer that allows operators to:
- pause intake and/or execution safely
- create and manage structured handoffs
- receive and audit critical notifications
- resume controlled processing after intervention

This phase adds human-in-the-loop control for critical operations, edge cases, and governance-triggered intervention.

It must integrate cleanly with:
- Phase 1 event bus
- Phase 2 gateway/session model
- Phase 3 policy engine and approvals
- Phase 4 governance/watchdog controls
- Phase 5 orchestration state

## Why This Matters

### Current state
- there is no durable pause/resume mechanism
- handoff is not a first-class control-plane concept
- operator notifications are absent or too ad hoc
- critical events can occur without a clean human intervention path

### Target state
- operators can pause the daemon in a defined mode
- new work admission and in-flight execution are controlled explicitly during pause
- handoff packages capture the right workflow/session/event context for human review
- critical events generate auditable notifications
- escalation state survives restart/crash
- later operator takeover workflows can build on this foundation

## Non-goals for Phase 6
Do **not** implement:
- full remote-control or live co-pilot takeover UX
- rich multi-channel delivery integrations beyond clean abstractions/skeletons
- automatic distributed failover to human operators
- blanket “pause everything immediately” behavior that ignores workflow state safety
- fake encryption/security guarantees without actual implementation

This phase is specifically about **durable pause/resume, structured handoff, and operator notification primitives**.

## Success Criteria
- pause state is durably persisted and survives restart
- pause semantics are explicit and support at least admission control for new work
- in-flight behavior during pause is documented and enforced deterministically
- handoff packages include workflow/session/event context with provenance
- handoff records are durably stored and queryable
- notifications are auditable and rate-limitable
- critical triggers from policy, watchdog, DLQ, and operator action can generate escalation records
- resume returns the system to controlled operation without hidden state drift
- tests cover pause/restart behavior, handoff creation, notification generation, and integration with orchestration/governance

## Prerequisites
- Phase 1 (Persistent Event Bus) complete
- Phase 2 (Session Gateway) complete
- Phase 3 (Policy Engine) complete
- Phase 4 (Cost & Model Governance) complete
- Phase 5 (Orchestration Layer) complete
- all previous tests passing

## Core design constraints
- persisted escalation state is the source of truth
- pause/resume decisions must not live only in memory
- notification delivery is not the source of truth; escalation records are
- pause must integrate with event admission and orchestration scheduling explicitly
- handoff must preserve provenance and avoid inventing fake Claude session state
- resume must be deterministic and auditable
- UI/webhook/email delivery may be optional, but core escalation state must be usable without them

## Escalation model

### Pause modes
Use an explicit pause model rather than a single boolean only.

```ts
interface PauseState {
  paused: boolean;
  mode: "admission_only" | "admission_and_scheduling";
  reason?: string;
  pausedAt?: string;
  pausedBy?: string;
  resumeAt?: string;
  metadata?: Record<string, unknown>;
}
```

Recommended semantics:
- `admission_only`: reject or defer new inbound work, allow already-running work to complete
- `admission_and_scheduling`: reject/defer new inbound work and stop scheduling new tasks/workflows; running tasks may complete unless explicitly cancelled by a later phase

### Handoff package
```ts
interface HandoffPackage {
  handoffId: string;
  createdAt: string;
  reason: string;
  severity: "info" | "warning" | "critical";
  workflowIds?: string[];
  sessionId?: string;
  claudeSessionId?: string | null;
  source?: string;
  channelId?: string;
  threadId?: string;
  relatedEventIds?: string[];
  pendingTasks?: string[];
  pendingApprovals?: string[];
  pendingEvents?: Array<{
    eventId: string;
    type: string;
    status: string;
  }>;
  summary: string;
  attachments?: string[];
  metadata?: Record<string, unknown>;
}
```

### Notification record
```ts
interface EscalationNotification {
  notificationId: string;
  type:
    | "dlq_overflow"
    | "watchdog"
    | "policy_denial"
    | "error"
    | "manual_escalation"
    | "pause"
    | "resume";
  severity: "info" | "warning" | "critical";
  createdAt: string;
  eventId?: string;
  workflowId?: string;
  sessionId?: string;
  message: string;
  details?: Record<string, unknown>;
  delivery?: {
    attempted: boolean;
    delivered?: boolean;
    channel?: string;
    error?: string;
  };
}
```

## Control semantics

### Pause behavior
- pause applies at the control plane, not just inside `runner.ts`
- new inbound events should be rejected or deferred at the gateway/admission layer
- orchestrator scheduling should respect pause mode
- running tasks/workflows should follow documented mode semantics
- pause/resume transitions should emit escalation/audit records

### Handoff behavior
- handoff packages are snapshots for human review, not hidden mutable state blobs
- handoff creation should reference durable workflow/event/session state
- handoff acceptance should be modeled, but must not pretend to implement full remote takeover if that is not yet real
- handoff packages must not invent fake Claude session continuity

### Notification behavior
- notifications are derived from escalation-relevant state changes or triggers
- rate limiting and dedupe should prevent spam storms
- delivery integrations may be skeletons, but the notification record must still be durable and auditable

## Tasks

### F.1 — Pause Controller
- **File:** `src/escalation/pause.ts`
- **Status:** TODO
- **Prerequisites:** Phase 1 event/state foundations, Phase 5 orchestrator

#### Goal
Implement durable pause/resume control with explicit operating modes.

#### Done When
- [ ] pause state stored durably at `.claude/claudeclaw/paused.json` or equivalent persisted control-plane location
- [ ] schema supports explicit pause mode, actor, timestamps, and reason
- [ ] API includes:
  - `pause(mode, reason, pausedBy, options?)`
  - `resume(resumedBy, reason?)`
  - `getPauseState(): PauseState`
  - `isPaused(): boolean`
- [ ] gateway/admission path respects pause state for new events
- [ ] orchestrator scheduling respects pause mode
- [ ] running work behavior is documented and deterministic
- [ ] pause/resume actions generate audit/escalation records
- [ ] optional auto-resume is supported only if implemented durably and clearly documented

#### CLI
- `claudeclaw pause --mode admission_only "reason"`
- `claudeclaw pause --mode admission_and_scheduling "reason"`
- `claudeclaw resume`

#### Important Notes
- do not rely on runner-only checks for pause enforcement
- “reject” vs “defer” semantics for new work should be explicit and documented
- pause state must survive restart and be applied during startup reconstruction

#### Tests
- pause persists across restart
- new event admission is blocked/deferred according to mode
- orchestrator scheduling halts in admission_and_scheduling mode
- resume restores normal intake/scheduling

---

### F.2 — Handoff Manager
- **File:** `src/escalation/handoff.ts`
- **Status:** TODO
- **Prerequisites:** Phase 5 orchestration state available

#### Goal
Create durable, reviewable handoff packages from current workflow/session/event context.

#### Done When
- [ ] handoff package schema is defined and documented
- [ ] handoff records stored durably under `.claude/claudeclaw/handoffs/`
- [ ] API includes:
  - `createHandoff(reason, context): HandoffPackage`
  - `getHandoff(handoffId)`
  - `listHandoffs(filters?)`
  - `acceptHandoff(handoffId, actor)`
  - `closeHandoff(handoffId, actor, resolution?)`
- [ ] handoff package references current workflow/task/session/event context where available
- [ ] handoff creation emits escalation/audit records
- [ ] acceptance/closure state is durably tracked
- [ ] delivery/export abstraction exists, even if transport implementations remain skeletal

#### Important Notes
- handoff is a structured snapshot and operator workflow primitive, not a magic live transfer of agent consciousness
- if attachments or sensitive context are included, document security limitations clearly
- do not claim encryption unless actually implemented

#### CLI
- `claudeclaw handoff create "reason"`
- `claudeclaw handoff list`
- `claudeclaw handoff show <id>`
- `claudeclaw handoff accept <id>`
- `claudeclaw handoff close <id>`

#### Tests
- handoff package created from representative workflow/session context
- handoff persists and reloads correctly after restart
- accept/close transitions are durable and auditable

---

### F.3 — Notification Manager
- **File:** `src/escalation/notifications.ts`
- **Status:** TODO
- **Prerequisites:** F.1

#### Goal
Generate durable escalation notifications and support clean delivery abstractions.

#### Done When
- [ ] notification records stored durably
- [ ] API includes:
  - `notify(notification)`
  - `listNotifications(filters?)`
  - `configure(config)`
- [ ] supported trigger categories include:
  - DLQ overflow
  - watchdog trigger
  - policy denial/escalation-worthy block
  - uncaught/system error
  - manual escalation
  - pause/resume
- [ ] notification records include severity, provenance, and delivery attempt metadata
- [ ] rate limiting and dedupe are configurable
- [ ] delivery abstraction supports webhook/email skeletons without making them required for correctness

#### Configuration
```ts
interface EscalationConfig {
  webhookUrl?: string;
  emailTarget?: string;
  rateLimits?: {
    perTypePerMinute?: number;
    perSeverityPerMinute?: number;
  };
}
```

#### Important Notes
- delivery failure must not erase the notification record
- notification record is canonical; transport is best-effort
- do not let notification spam become a denial-of-service vector

#### Tests
- escalation trigger creates durable notification record
- repeated triggers are rate-limited/deduped as configured
- failed delivery attempt is recorded without losing the notification

---

### F.4 — Escalation Trigger Integration
- **File:** `src/escalation/triggers.ts`
- **Status:** TODO
- **Prerequisites:** F.1, F.2, F.3, Phases 3–5 integration points

#### Goal
Connect existing control-plane triggers to escalation actions consistently.

#### Done When
- [ ] policy denial / approval timeout can emit escalation notifications where configured
- [ ] watchdog trigger can emit escalation notifications and optional pause recommendation
- [ ] DLQ threshold crossing can emit escalation notifications
- [ ] orchestration failure patterns can emit escalation notifications
- [ ] manual operator escalation creates consistent records
- [ ] API includes:
  - `handleEscalationTrigger(triggerContext)`
  - `shouldPause(triggerContext)`
  - `shouldCreateHandoff(triggerContext)`

#### Important Notes
- triggers should be policy/config driven where practical
- not every denial/error must create a critical notification
- pause/handoff creation should be explicit outcomes, not hidden side effects

#### Tests
- watchdog trigger emits expected escalation behavior
- DLQ overflow emits expected escalation behavior
- policy-related trigger emits expected notification/handoff behavior when configured

---

### F.5 — Escalation Audit & Status View
- **File:** `src/escalation/status.ts`
- **Status:** TODO
- **Prerequisites:** F.1, F.2, F.3

#### Goal
Provide a durable read-side view of current pause/escalation/handoff status.

#### Done When
- [ ] status view derives from persisted escalation state
- [ ] includes:
  - current pause state
  - open handoffs
  - recent critical notifications
  - recent escalation actions
- [ ] API/service contract documented
- [ ] dashboard/API integration added only if current architecture supports it cleanly

#### Important Notes
- status view is read-side only
- do not make dashboard presence a prerequisite for core escalation behavior

#### Tests
- status view reflects persisted pause/handoff/notification state
- restart preserves correct status reconstruction

## Integration Points

### With Phase 1
- pause/resume, handoff creation, and escalation triggers should generate or reference durable events where appropriate
- escalation must remain compatible with replay/audit semantics

### With Phase 2
- escalation should reference local session mapping identity and normalized source/channel/thread context
- do not invent fake Claude session IDs

### With Phase 3
- policy denials, approval waits/timeouts, and operator decisions can feed escalation triggers
- audit trail should capture escalation-related control actions

### With Phase 4
- watchdog triggers, budget blocks, and governance failures can feed escalation
- notification severity should reflect governance context where practical

### With Phase 5
- handoff packages should reference workflow/task state and pending work accurately
- pause modes must integrate with orchestration scheduling and resume reconstruction

### With existing execution path
- `runner.ts` may honor final control-plane pause decisions, but it is not the primary enforcement point
- `ui/server.ts` may expose pause/handoff/notification status if the current architecture supports it cleanly

## Test Strategy

### Unit tests
- pause state transitions
- handoff package creation and lifecycle
- notification record creation
- rate limiting / dedupe behavior
- trigger evaluation logic

### Integration tests
- pause -> restart -> admission remains blocked/deferred
- workflow -> handoff package -> accept/close lifecycle
- watchdog/policy/DLQ trigger -> notification/audit/escalation record
- resume restores controlled operation

### Recovery / safety tests
- crash during pause still restores pause state
- crash after handoff creation preserves handoff record
- delivery failure does not lose notification record
- open handoffs/status reconstruct correctly on restart

## Escalation Flow

```text
Trigger Event
    |
    v
Evaluate trigger policy / severity
    |
    +-- low severity --> durable notification only
    |
    +-- higher severity
            |
            +-- create notification
            +-- optionally recommend or apply pause
            +-- optionally create handoff package
```

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Notification spam | Rate limiting, dedupe, severity thresholds |
| Pause forgotten indefinitely | Optional durable auto-resume or explicit operator status visibility |
| Handoff exposes sensitive context | Document security model clearly; add field filtering/redaction hooks |
| Operators unavailable | Keep delivery abstraction clean for future multi-channel support |
| Pause semantics inconsistent | Explicit pause modes and documented gateway/orchestrator integration |
| Hidden control-plane side effects | Make pause/handoff/notification actions explicit and auditable |

## Dependencies
- Phase 1 event/state foundation
- Phase 3 policy engine / approval queue / audit
- Phase 4 watchdog / governance signals
- Phase 5 workflow state and orchestration integration

## Expected Output
- `src/escalation/pause.ts`
- `src/escalation/handoff.ts`
- `src/escalation/notifications.ts`
- `src/escalation/triggers.ts`
- `src/escalation/status.ts`
- `src/__tests__/escalation/pause.test.ts`
- `src/__tests__/escalation/handoff.test.ts`
- `src/__tests__/escalation/notifications.test.ts`
- `src/__tests__/escalation/triggers.test.ts`
- `src/__tests__/escalation/status.test.ts`
- supporting docs describing pause modes, handoff lifecycle, notification semantics, and integration boundaries

## Checkpoint
Before Phase 7 begins:
1. run all tests: `bun test`
2. verify pause/resume via CLI or API
3. verify pause state survives restart
4. verify handoff package creation and lifecycle
5. verify escalation notifications and rate limiting
6. verify trigger integrations from watchdog/policy/DLQ/orchestration
7. approve Phase 7 start
