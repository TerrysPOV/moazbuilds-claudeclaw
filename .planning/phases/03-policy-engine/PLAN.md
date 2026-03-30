---
phase: 3
name: Policy Engine
description: Fine-grained, contextual tool governance with persisted approval workflow and audit trail
objective: Implement a rule-based policy engine that controls tool access per channel, user, skill, and context, with durable decisions, operator approvals, and full auditability
---

# Phase 3: Policy Engine

## Goal
Implement a contextual policy engine that governs tool use with explicit allow / deny / require-approval decisions, durable approval state, and a comprehensive audit trail.

This phase replaces the current flat security model with policy evaluation based on channel, user, skill, tool, and execution context.

## Why This Matters

### Current state
- Security is effectively flat or daemon-wide.
- Tool access cannot be refined per channel, per user, or per skill.
- Approval decisions are not modeled as durable workflow state.
- Auditability is incomplete or too coarse for production operations.

### Target state
- Every tool-use request is evaluated against explicit policy rules.
- Policies can be scoped globally, per channel, per user, and per skill.
- Some requests can be denied outright, some allowed, and some routed into a durable approval workflow.
- Every decision is logged with rule provenance and operator actions.
- Policy enforcement is replay-safe and compatible with the Phase 1 event bus and Phase 2 gateway/session model.

## Non-goals for Phase 3
Do **not** implement:
- full human takeover / escalation workflow beyond approval primitives
- major dashboard redesign
- adapter expansion
- policy-driven model routing and budget governance beyond tool governance hooks
- broad workflow orchestration beyond what is required for policy enforcement

This phase is specifically about **tool governance, approvals, and auditability**.

## Success Criteria
- every tool-use request is evaluated by the policy engine before execution
- policy rules support global, channel, user, and skill scope
- policy actions are: `allow`, `deny`, `require_approval`
- policy decisions are deterministic, auditable, and replay-safe
- approvals are durably stored and survive restart/crash
- approval resolution re-enters the event flow safely without bypassing policy state
- every decision is written to an audit log with rule provenance
- policy enforcement integrates at the correct layer: gateway/processor coordination, not ad hoc runner-only checks
- tests cover rule evaluation, precedence, approval workflow, restart recovery, and audit logging

## Prerequisites
- Phase 1 (Persistent Event Bus) complete
- Phase 2 (Session Gateway) complete
- all previous tests passing

## Core design constraints
- persisted state is the source of truth
- no approval or policy-critical state may live only in memory
- policy evaluation must be deterministic for the same request context
- intentional replay must preserve policy provenance while remaining operationally controllable
- approval workflow must integrate with event processing without creating hidden side channels
- policy engine must be usable from gateway/processor layers and not depend on UI presence

## Policy model

### Request model
Policy evaluation should operate on a normalized request shape similar to:

```ts
interface ToolRequestContext {
  eventId: string;
  source: string;               // telegram, discord, slack, web, etc.
  channelId?: string;
  threadId?: string;
  userId?: string;
  skillName?: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  sessionId?: string;           // local session mapping ID
  claudeSessionId?: string | null;
  timestamp: string;
  metadata?: Record<string, unknown>;
}
```

### Decision model
```ts
interface PolicyDecision {
  requestId: string;
  action: "allow" | "deny" | "require_approval";
  matchedRuleId?: string;
  reason: string;
  evaluatedAt: string;
  cacheable?: boolean;
}
```

### Rule model
```ts
interface PolicyRule {
  id: string;
  enabled?: boolean;
  priority?: number;            // higher priority evaluated first
  scope?: {
    source?: string | string[]; // "telegram", ["telegram","discord"], "*"
    channelId?: string | string[];
    userId?: string | string[];
    skillName?: string | string[];
  };
  tool: string | string[];      // specific tool(s) or "*"
  action: "allow" | "deny" | "require_approval";
  conditions?: {
    timeWindow?: { start: string; end: string };
    argConstraints?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  reason?: string;
}
```

## Policy evaluation semantics
- evaluation order must be deterministic
- rule precedence should be:
  1. highest priority first
  2. most specific scope beats less specific scope when priorities tie
  3. explicit `deny` beats `allow`
  4. `require_approval` beats `allow`
- default behavior should be **deny unless explicitly allowed**
- do **not** use default-allow behavior; that would undercut the whole policy layer
- cache may be used as an optimization, but cache must not become a source of truth

## Tasks

### C.1 — Policy Engine Core
- **File:** `src/policy/engine.ts`
- **Status:** TODO
- **Prerequisites:** Phase 1 event persistence available

#### Goal
Implement deterministic rule evaluation over normalized tool-use requests.

#### Done When
- [ ] rule schema defined and documented
- [ ] policy file stored at `.claude/claudeclaw/policies.json`
- [ ] evaluation order and precedence rules are explicit and tested
- [ ] default decision is `deny` if no allow rule matches
- [ ] API includes:
  - `evaluate(request: ToolRequestContext): PolicyDecision`
  - `loadRules(): PolicyRule[]`
  - `validateRules(rules): ValidationResult`
- [ ] invalid rules fail closed and are surfaced clearly
- [ ] optional cache is configurable and bounded
- [ ] cache invalidates on policy reload

#### Important Notes
- do not encode channel-specific logic directly into the engine
- engine should operate over normalized request context only
- rules must remain serializable and auditable

#### Tests
- explicit deny rule blocks request
- require_approval rule returns approval decision
- no matching allow rule results in deny
- precedence and specificity ordering are deterministic
- policy reload invalidates cache correctly

---

### C.2 — Scoped Channel and User Policies
- **File:** `src/policy/channel-policies.ts`
- **Status:** TODO
- **Prerequisites:** C.1

#### Goal
Support policy authoring patterns for channel/user-specific governance without hard-coding those concerns into the engine.

#### Done When
- [ ] helper layer resolves channel/user scoped policy rules into normalized engine rules
- [ ] supports per-source and per-channel rule sets
- [ ] supports user-specific overrides within a channel/source context
- [ ] configuration format is documented and stable
- [ ] API includes:
  - `getScopedRules(context): PolicyRule[]`
  - `mergeScopedPolicies(globalRules, scopedRules): PolicyRule[]`

#### Important Notes
- this layer should produce normalized rules, not a parallel evaluator
- avoid magic keys like `"telegram:allowedUserIds"` unless the repo already uses that pattern and it is clearly documented
- prefer an explicit structured config shape over stringly-typed config hacks

#### Tests
- channel-specific deny overrides broader allow
- user-specific allow does not bypass explicit higher-priority deny
- discord and telegram contexts resolve to different effective rule sets

---

### C.3 — Skill Policy Overlays
- **File:** `src/policy/skill-overlays.ts`
- **Status:** TODO
- **Prerequisites:** C.1

#### Goal
Allow skills to declare tool constraints that integrate with the policy engine without becoming an unsafe bypass.

#### Done When
- [ ] skill metadata can declare:
  - `requiredTools`
  - `preferredTools`
  - `deniedTools`
- [ ] skill metadata is parsed from supported skill descriptors (e.g. `SKILL.md` frontmatter or equivalent repo-native structure)
- [ ] skill overlays are translated into policy-relevant constraints
- [ ] skill constraints cannot override explicit higher-priority denies unless designed and documented intentionally
- [ ] API includes:
  - `getSkillOverlay(skillName): SkillOverlay | null`
  - `overlayToRules(skillOverlay): PolicyRule[]`

#### Important Notes
- skill overlays must not become a privilege-escalation path
- "preferredTools" should influence recommendation or resolution, not silently override security rules
- "requiredTools" should surface actionable policy errors when unavailable

#### Tests
- skill denied tool is blocked even when globally allowed, if overlay is designed to restrict
- skill preferred tool does not override explicit deny
- missing required tool yields clear decision/reason

---

### C.4 — Approval Workflow
- **File:** `src/policy/approval-queue.ts`
- **Status:** TODO
- **Prerequisites:** C.1

#### Goal
Implement a durable approval workflow for requests that require operator authorization.

#### Done When
- [ ] approval requests are durably stored
- [ ] storage path is `.claude/claudeclaw/approval-queue.jsonl` or another durable append-friendly format
- [ ] queue entries include:
  - `eventId`
  - `request`
  - `decision`
  - `requestedAt`
  - `status`
  - `approvedBy?`
  - `approvedAt?`
  - `deniedBy?`
  - `deniedAt?`
  - `resolutionReason?`
- [ ] statuses include:
  - `pending`
  - `approved`
  - `denied`
  - `expired` (optional but recommended)
- [ ] approval resolution is restart-safe
- [ ] event processing pauses or defers correctly when approval is pending
- [ ] approval resolution re-enqueues or resumes processing through the normal event path
- [ ] API includes:
  - `enqueue(request, decision)`
  - `approve(eventId, actor, reason?)`
  - `deny(eventId, actor, reason?)`
  - `listPending()`
  - `loadState()`

#### API / integration requirements
- provide programmatic API first
- HTTP endpoints and dashboard SSE may be added if the repo already has a stable API/web layer
- do not make UI/SSE a hard dependency of the approval mechanism

#### Important Notes
- approval queue state must not live only in memory
- approval must not bypass policy/audit logging
- approval should result in a durable audit event and a controlled continuation path

#### Tests
- require_approval request is persisted and marked pending
- approve after restart works correctly
- deny after restart works correctly
- approved request resumes through the intended processing path
- duplicate approval attempts are handled safely/idempotently

---

### C.5 — Audit Log
- **File:** `src/policy/audit-log.ts`
- **Status:** TODO
- **Prerequisites:** C.1

#### Goal
Capture all policy-relevant decisions and operator actions in a durable audit trail.

#### Done When
- [ ] every policy decision is logged
- [ ] every approval/denial action is logged
- [ ] log format is durable and queryable
- [ ] file stored at `.claude/claudeclaw/audit-log.jsonl`
- [ ] entry schema includes:
  - `timestamp`
  - `eventId`
  - `requestId`
  - `source`
  - `channelId?`
  - `threadId?`
  - `userId?`
  - `skillName?`
  - `toolName`
  - `action`
  - `reason`
  - `matchedRuleId?`
  - `operatorId?`
  - `metadata?`
- [ ] retention/rotation policy is configurable and documented
- [ ] API includes:
  - `log(entry)`
  - `query(filters)`
  - `export(start, end)`

#### CLI
- `claudeclaw audit --since <date> --channel <channel>`
- add more query flags only if the existing CLI architecture supports them cleanly

#### Important Notes
- audit log is not a replacement for event log provenance; it is a complementary control-plane audit record
- audit entries must be attributable to the exact rule/operator action that produced them

#### Tests
- policy decision produces audit entry
- approval action produces audit entry
- query/export functions return expected slices
- rotation/retention behavior is documented and tested where feasible

## Integration Points

### With Phase 1 & 2
- **gateway** coordinates normalized request flow into the policy engine before tool execution
- **event-processor** respects `deny` and `require_approval` outcomes and uses durable approval state
- **session gateway/mapping** provides channel/user/skill/session context used for evaluation

### With existing execution path
- **runner.ts** should not become the primary policy engine
- runner may enforce final execution constraints or receive policy-derived allowed tool sets
- central decision-making should live in policy modules invoked by gateway/processor layers

### Future phases
- Phase 4/5 may extend policy hooks into model routing and orchestration controls
- Phase 6 (Escalation) can build on approval workflow and audit trail for operator takeover

## Test Strategy

### Unit tests
- rule matching
- priority ordering
- specificity ordering
- condition evaluation
- policy reload behavior
- skill overlay conversion
- audit entry generation

### Integration tests
- event -> gateway -> policy -> approval -> resumed execution
- deny path blocks execution cleanly
- approval survives restart and resumes correctly
- audit trail records all steps

### Security / correctness tests
- attempt policy bypass via runner-only path
- duplicate approval/denial actions remain idempotent
- malformed policy file fails closed
- replayed events remain policy-auditable

## Policy Rule Examples

```json
{
  "rules": [
    {
      "id": "deny-dangerous-bash-global",
      "priority": 100,
      "tool": "Bash",
      "action": "deny",
      "reason": "Bash disabled globally unless explicitly re-allowed in narrower policy."
    },
    {
      "id": "allow-telegram-admin-view",
      "priority": 200,
      "scope": {
        "source": "telegram",
        "userId": ["admin_user_id"]
      },
      "tool": ["View", "GlobTool", "GrepTool"],
      "action": "allow",
      "reason": "Telegram admin can use read-only inspection tools."
    },
    {
      "id": "discord-edit-requires-approval",
      "priority": 150,
      "scope": {
        "source": "discord"
      },
      "tool": "Edit",
      "action": "require_approval",
      "reason": "Edit on discord requires operator approval."
    },
    {
      "id": "skill-code-review-read-only",
      "priority": 120,
      "scope": {
        "skillName": "code-review"
      },
      "tool": ["View", "GlobTool", "GrepTool"],
      "action": "allow",
      "reason": "Code review skill is read-only by default."
    }
  ]
}
```

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Policy too permissive | Default deny unless explicitly allowed |
| Policy too restrictive | Provide clear rule provenance and override path via approvals |
| Performance: heavy rule evaluation | Bounded cache, normalized request shape, deterministic matching |
| Approval queue drift or loss | Persist queue state durably; rebuild on restart |
| Audit log growth | Rotation and retention policy |
| Skill overlays become bypass path | Skill overlays converted into governed rules, not privileged shortcuts |
| Runner bypasses central policy | Enforce policy at gateway/processor layer and test bypass attempts |

## Dependencies
- Phase 1 event log and durable state primitives
- Phase 2 gateway/session normalization context
- existing skill metadata/parsing path if present
- existing HTTP/API layer only if approval endpoints are implemented there cleanly

## Expected Output
- `src/policy/engine.ts`
- `src/policy/channel-policies.ts`
- `src/policy/skill-overlays.ts`
- `src/policy/approval-queue.ts`
- `src/policy/audit-log.ts`
- `src/__tests__/policy/engine.test.ts`
- `src/__tests__/policy/channel-policies.test.ts`
- `src/__tests__/policy/skill-overlays.test.ts`
- `src/__tests__/policy/approval-queue.test.ts`
- `src/__tests__/policy/audit-log.test.ts`
- supporting docs describing precedence, storage, and approval semantics

## Checkpoint
Before Phase 4 begins:
1. run all tests: `bun test`
2. verify deny / allow / require_approval behavior with representative events
3. verify approval persistence across restart
4. verify audit log entries and rule provenance
5. verify no policy bypass through runner-only execution path
6. approve Phase 4 start
