---
phase: 5
name: Orchestration Layer
description: Durable workflow orchestration with persisted task graph state, resumable execution, and controlled parallelism
objective: Implement a workflow engine that executes multi-step task graphs with durable state, replay-safe progression, resumability after restart, and clean integration with the event bus, gateway, policy engine, and governance controls
---

# Phase 5: Orchestration Layer

## Goal
Implement a durable orchestration layer for multi-step workflows.

This phase adds:
- task graph execution
- persisted workflow state
- resumable execution
- controlled parallelism
- retry and failure handling at workflow/task level
- orchestration integration with event, policy, session, and governance layers

This is not just “run multiple jobs in order.” It must provide a reliable workflow engine whose state survives restart/crash and whose transitions are auditable and replay-safe.

## Why This Matters

### Current state
- jobs are effectively single-step or loosely chained
- dependency management is weak or absent
- multi-step jobs do not have durable workflow state
- restart/crash can strand partially completed work
- there is no consistent model for retries, partial failure, or resumable task graphs

### Target state
- workflows are defined as task graphs with explicit dependencies
- task state is durably persisted as the workflow executes
- daemon restart resumes from durable workflow state
- execution is controlled and auditable
- orchestration integrates with existing cost, policy, and session controls
- future escalation/handoff can build on the same persisted workflow model

## Non-goals for Phase 5
Do **not** implement:
- a full BPMN-style workflow engine
- arbitrary distributed execution across multiple hosts
- broad human takeover UX beyond preserving state for later phases
- speculative auto-parallelization without explicit safety rules
- fake rollback guarantees for inherently non-reversible side effects

This phase is specifically about **durable local orchestration with explicit workflow semantics**.

## Success Criteria
- workflows can define multi-step task graphs with explicit dependencies
- dependency validation and cycle detection are implemented
- task execution state is durably persisted
- workflow progression survives daemon restart/crash
- independent tasks may execute in parallel when explicitly safe to do so
- workflow state transitions are deterministic and auditable
- task retries and workflow failure modes are explicit and tested
- orchestration integrates with event log, session mapping, policy, and cost/model governance
- tests cover graph validation, progression, restart recovery, retry behavior, controlled parallelism, and failure handling

## Prerequisites
- Phase 1 (Persistent Event Bus) complete
- Phase 2 (Session Gateway) complete
- Phase 3 (Policy Engine) complete
- Phase 4 (Cost & Model Governance) complete
- all previous tests passing

## Core design constraints
- persisted workflow state is the source of truth
- in-memory execution queues may exist only as rebuildable schedulers/caches
- task actions must be modeled so resume/retry semantics are explicit
- orchestration state transitions must be replay-safe and auditable
- parallel execution must be controlled, bounded, and policy/governance aware
- side-effectful tasks must not pretend to be safely replayable unless idempotency/compensation is explicitly defined
- aggregates and dashboards are read-side views, not canonical state

## Workflow model

### Workflow definition
```ts
interface WorkflowDefinition {
  id: string;
  type: string;
  version?: string;
  sessionId?: string;
  claudeSessionId?: string | null;
  source?: string;
  channelId?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
  tasks: TaskDefinition[];
}
```

### Task definition
```ts
interface TaskDefinition {
  id: string;
  type: string;
  deps: string[];
  actionRef: string;
  input?: Record<string, unknown>;
  onError?: "fail_workflow" | "continue" | "retry_task";
  maxRetries?: number;
  retryPolicy?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
  };
  compensationRef?: string;
  concurrencyKey?: string;
  idempotencyKey?: string;
}
```

### Workflow state
```ts
interface WorkflowState {
  workflowId: string;
  version?: string;
  status:
    | "pending"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "cancelled";
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  sessionId?: string;
  claudeSessionId?: string | null;
  source?: string;
  channelId?: string;
  threadId?: string;
  readyTasks: string[];
  runningTasks: string[];
  completedTasks: string[];
  failedTasks: string[];
  blockedTasks: string[];
  cancelledTasks?: string[];
  taskStates: Record<string, TaskRuntimeState>;
  results: Record<string, unknown>;
  error?: {
    taskId?: string;
    type?: string;
    message: string;
  };
}
```

### Task runtime state
```ts
interface TaskRuntimeState {
  taskId: string;
  status:
    | "pending"
    | "ready"
    | "running"
    | "completed"
    | "failed"
    | "blocked"
    | "cancelled";
  attemptCount: number;
  lastAttemptAt?: string;
  completedAt?: string;
  nextRetryAt?: string;
  result?: unknown;
  error?: {
    type?: string;
    message: string;
  };
}
```

## Execution semantics
- dependencies must be explicit and validated before execution
- cycles must fail validation before any work starts
- tasks may run in parallel only if:
  - they have no unmet dependencies
  - concurrency/resource constraints permit it
  - workflow/policy/governance limits permit it
- retries apply at task level unless the workflow policy says otherwise
- compensation actions are best-effort compensating steps, not magical rollback
- resume after restart must rebuild ready/running state from persisted workflow state rather than trusting stale in-memory queues
- running tasks interrupted by restart must be reclassified deterministically (e.g. back to ready/retryable/failed according to task semantics)

## Tasks

### E.1 — Task Graph Engine
- **File:** `src/orchestrator/task-graph.ts`
- **Status:** TODO
- **Prerequisites:** Phase 1 foundations available

#### Goal
Define graph validation and progression logic for workflow task graphs.

#### Done When
- [ ] task/workflow schema is defined and documented
- [ ] dependency resolution and cycle detection implemented
- [ ] topological progression logic implemented
- [ ] engine identifies ready tasks from persisted task states
- [ ] supports bounded parallelism for independent tasks
- [ ] supports task-level retry policy metadata
- [ ] supports optional compensation metadata
- [ ] API includes:
  - `createWorkflow(definition): WorkflowDefinition`
  - `validateWorkflow(definition): ValidationResult`
  - `getReadyTasks(state, definition): TaskDefinition[]`
  - `advanceWorkflow(state, taskResult): WorkflowState`

#### Important Notes
- do not store raw executable functions in persisted workflow definitions
- use handler/action registry references instead of serializing closures
- avoid “rollback” language unless the step is truly compensating and explicitly supported

#### Tests
- cycle detection rejects invalid graph
- dependency ordering is correct
- parallel-ready task selection is correct
- failed task progression follows configured onError behavior

---

### E.2 — Workflow State Store
- **File:** `src/orchestrator/workflow-state.ts`
- **Status:** TODO
- **Prerequisites:** E.1

#### Goal
Persist canonical workflow state and support restart-safe loading/reconstruction.

#### Done When
- [ ] workflow state stored durably under `.claude/claudeclaw/workflows/`
- [ ] state updates are atomic/crash-conscious
- [ ] per-workflow state file or segmented event/state model is documented
- [ ] API includes:
  - `saveState(state)`
  - `loadState(workflowId)`
  - `listActive()`
  - `rebuildExecutionView()`
- [ ] restart path reconstructs runnable workflows from persisted state
- [ ] corruption handling behavior is defined/documented
- [ ] persistence strategy is compatible with future handoff/escalation flows

#### Important Notes
- persisted workflow state must be canonical
- in-memory scheduler state must be rebuildable from persisted workflow state
- if temp-file + rename is used, crash guarantees/limitations must be documented clearly

#### Tests
- save/load round-trip works
- restart reconstruction rebuilds active workflows correctly
- interrupted running task is reclassified deterministically on restart
- partial/corrupt state handling is tested where feasible

---

### E.3 — Workflow Executor
- **File:** `src/orchestrator/executor.ts`
- **Status:** TODO
- **Prerequisites:** E.1, E.2, Phase 3/4 governance layers

#### Goal
Execute ready tasks, persist transitions, and apply policy/governance checks to workflow execution.

#### Done When
- [ ] executor dispatches ready tasks through registered handlers
- [ ] task start/completion/failure transitions are persisted
- [ ] retries are scheduled according to task retry policy
- [ ] bounded concurrency is configurable
- [ ] execution respects:
  - Phase 3 policy constraints
  - Phase 4 model routing / budget state
  - watchdog/governance limits
- [ ] workflow-level failure/completion state is derived correctly
- [ ] API includes:
  - `executeWorkflow(workflowId)`
  - `executeReadyTasks(workflowId)`
  - `resumeWorkflow(workflowId)`
  - `cancelWorkflow(workflowId)`

#### Important Notes
- executor should not bypass event/policy/governance layers
- runner may execute individual actions, but orchestration decisions belong here
- cancellation semantics must be explicit; do not silently abandon state

#### Tests
- task success advances workflow correctly
- retryable task failure reschedules correctly
- non-retryable failure moves workflow to failed when configured
- cancelled workflow stops further scheduling cleanly
- policy/budget denial blocks execution as expected

---

### E.4 — Resumable Jobs Integration
- **File:** `src/orchestrator/resumable-jobs.ts`
- **Status:** TODO
- **Prerequisites:** E.2, E.3

#### Goal
Wrap existing scheduled/job execution paths in durable workflow orchestration.

#### Done When
- [ ] existing jobs are mapped to workflow definitions where appropriate
- [ ] cron trigger -> workflow creation -> durable execution path implemented
- [ ] on daemon restart: active/pending workflows are reconstructed before normal scheduling resumes
- [ ] integration with event log is explicit and documented
- [ ] API includes:
  - `scheduleJob(jobDef)`
  - `resumePending()`
  - `getPendingCount()`
  - `createWorkflowForJob(jobDef)`

#### Important Notes
- do not simply wrap old jobs.ts in a thin shell and call it “orchestration”
- job creation, workflow persistence, and resume semantics must be explicit
- startup ordering matters: rebuild orchestration state before accepting new work where necessary

#### Tests
- cron-triggered workflow persists correctly
- daemon restart resumes pending workflows
- multiple pending workflows reconstruct cleanly
- job-to-workflow mapping preserves metadata/context

---

### E.5 — Workflow Audit & Telemetry Hooks
- **File:** `src/orchestrator/telemetry.ts`
- **Status:** TODO
- **Prerequisites:** E.2, E.3

#### Goal
Expose durable orchestration state for audit/telemetry without making telemetry canonical.

#### Done When
- [ ] workflow lifecycle transitions emit audit-friendly records
- [ ] telemetry aggregates derive from persisted workflow state
- [ ] response includes:
  - active workflows
  - completed workflows
  - failed workflows
  - queued/ready/running task counts
  - retry counts
  - average workflow duration where derivable
- [ ] API or service contract documented
- [ ] dashboard/API integration added only if current server architecture supports it cleanly

#### Important Notes
- telemetry is read-side only
- workflow audit records should complement, not replace, event log and policy audit trails
- do not force SSE if the existing architecture does not support it sanely

#### Tests
- telemetry reflects persisted workflow state
- failed/completed counts are correct
- retry metrics derive correctly from task states

## Integration Points

### With Phase 1
- workflow lifecycle and task progression should emit or reference durable events
- orchestration must remain compatible with replay/resume semantics from the event foundation

### With Phase 2
- workflows are associated with session/source/channel/thread context where appropriate
- orchestrator must use local session mapping identity rather than inventing fake Claude session IDs

### With Phase 3
- task execution must respect policy engine decisions
- approval-required tasks/workflows must pause/defer through durable state, not hidden in-memory waits
- audit trail should capture workflow-relevant governance actions

### With Phase 4
- per-task invocation usage and routing decisions should feed cost/model governance
- budget/watchdog controls may block, reroute, suspend, or cancel tasks/workflows
- orchestration must treat those governance signals as first-class control inputs

### With existing execution path
- `jobs.ts` becomes a producer of workflow definitions or workflow-backed jobs where appropriate
- `cron.ts` triggers workflow creation instead of direct fire-and-forget execution
- `runner.ts` or task handlers execute individual task actions, but not workflow coordination itself

### Future phases
- escalation/handoff can serialize and transfer workflow state cleanly
- richer operator controls can build on persisted orchestration state

## Test Strategy

### Unit tests
- graph validation
- cycle detection
- ready-task selection
- workflow state transitions
- retry scheduling
- cancellation semantics

### Integration tests
- cron -> workflow creation -> execution -> persisted completion
- restart reconstruction and resume
- policy-required pause/approval -> resumed execution
- governance-triggered block/reroute/suspend behavior

### Chaos / recovery tests
- kill daemon mid-workflow and verify deterministic resume
- interrupt while tasks are running and verify restart reclassification semantics
- partial state write/corruption behavior documented and tested where feasible

## Example Workflow

```ts
const deployWorkflow: WorkflowDefinition = {
  id: "deploy-001",
  type: "deploy",
  sessionId: "local-session-123",
  source: "cron",
  tasks: [
    {
      id: "test",
      type: "shell",
      deps: [],
      actionRef: "runTests",
      onError: "fail_workflow",
      maxRetries: 1
    },
    {
      id: "build",
      type: "shell",
      deps: ["test"],
      actionRef: "buildProject",
      onError: "fail_workflow"
    },
    {
      id: "deploy",
      type: "shell",
      deps: ["build"],
      actionRef: "deployToProd",
      onError: "retry_task",
      maxRetries: 2,
      compensationRef: "notifyDeploymentFailure"
    },
    {
      id: "notify",
      type: "notification",
      deps: ["deploy"],
      actionRef: "sendNotification",
      onError: "continue"
    }
  ]
};
```

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Cyclic dependencies | Validate graph before execution and reject invalid workflow |
| State corruption or drift | Persist canonical workflow state; atomic/crash-conscious updates; rebuild runtime state on restart |
| Parallel task conflicts | Concurrency keys/resource serialization; bounded parallelism |
| Resume inconsistencies | Explicit task state machine and restart reclassification rules |
| False rollback assumptions | Use compensation semantics, not fake rollback guarantees |
| Hidden in-memory waits | Persist approval/waiting state durably |
| Workflow engine bypasses governance | Route execution through policy and governance checks explicitly |

## Dependencies
- Phase 1 event/state foundation
- Phase 2 session gateway/mapping
- Phase 3 policy engine / approvals / audit
- Phase 4 cost/model governance / watchdog
- existing jobs.ts and cron.ts integration points

## Expected Output
- `src/orchestrator/task-graph.ts`
- `src/orchestrator/workflow-state.ts`
- `src/orchestrator/executor.ts`
- `src/orchestrator/resumable-jobs.ts`
- `src/orchestrator/telemetry.ts`
- `src/__tests__/orchestrator/task-graph.test.ts`
- `src/__tests__/orchestrator/workflow-state.test.ts`
- `src/__tests__/orchestrator/executor.test.ts`
- `src/__tests__/orchestrator/resumable-jobs.test.ts`
- `src/__tests__/orchestrator/telemetry.test.ts`
- supporting docs describing workflow semantics, retry/compensation behavior, restart recovery, and integration boundaries

## Checkpoint
Before Phase 6 begins:
1. run all tests: `bun test`
2. verify multi-step workflow with dependencies
3. kill daemon mid-workflow and verify deterministic resume
4. verify retry and failure behavior
5. verify policy/governance integration on representative workflows
6. verify workflow telemetry/audit outputs
7. approve Phase 6 start
