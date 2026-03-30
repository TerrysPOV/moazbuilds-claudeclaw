---
phase: 2-session-gateway
plan: 04
version: revised
wave: 3
type: execute
depends_on:
  - 2-01
  - 2-02
  - 2-03
files_modified:
  - src/gateway/index.ts
  - src/__tests__/gateway/index.test.ts
autonomous: true
requirements:
  - adapter-decoupling
  - session-isolation
  - per-thread-resume
  - event-normalization
must_haves:
  truths:
    - "Gateway is the single entry point for all inbound events"
    - "Events flow: Adapter -> Normalizer -> Gateway -> Event Log -> Processor"
    - "Channel adapters do not call runner.ts directly"
    - "Gateway coordinates, it does not duplicate processor responsibilities"
    - "Sequence numbers are assigned by the event log, not by getLastSeq()+1 in gateway code"
  artifacts:
    - path: "src/gateway/index.ts"
      provides: "Gateway orchestrator with processInboundEvent"
      exports: ["Gateway", "createGateway", "getGateway", "processInboundEvent", "processEventWithFallback", "isGatewayEnabled"]
    - path: "src/__tests__/gateway/index.test.ts"
      provides: "Integration tests for gateway"
---

# Objective

Create the Gateway Orchestrator that serves as the single entry point for all inbound normalized events.

Purpose: decouple adapters from processing logic, centralize session lookup and event persistence, and establish the correct control flow for later policy/orchestration work.

# Critical corrections

1. Gateway should **not** directly become a second runner implementation.
2. The canonical flow is:
   `Adapter -> Normalizer -> Gateway -> Event Log -> Processor`
3. Sequence numbers must come from the event log append path, not from `getLastSeq() + 1` in gateway code.
4. Gateway should coordinate session mapping and enqueue/trigger processing, not own all downstream business logic.

# Success criteria

- `processInboundEvent()` is the main inbound entry point
- gateway accepts `NormalizedEvent`
- gateway resolves or creates the session mapping
- gateway appends the inbound event to the event log
- gateway invokes or signals the processor using persisted event state
- successful processing updates mapping metadata
- feature flag allows gradual migration from legacy handlers
- adapters can move to gateway helpers without breaking current behavior

# Suggested architecture

```ts
export interface GatewayDependencies {
  eventLog: {
    append: (entry: EventEntryInput) => Promise<EventRecord>;
  };
  processor: {
    processPersistedEvent: (eventId: string) => Promise<ProcessorResult>;
  };
  resume: {
    getOrCreateSessionMapping: typeof getOrCreateSessionMapping;
    getResumeArgsForEvent: typeof getResumeArgsForEvent;
    updateSessionAfterProcessing: typeof updateSessionAfterProcessing;
    recordClaudeSessionId?: typeof recordClaudeSessionId;
  };
}
```

Dependency injection is preferred over hard-coded module globals where practical.

# Tasks

## Task 1 — Create `gateway/index.ts` with Gateway class

### Done when
- exports `Gateway`, `createGateway`, `getGateway`, `processInboundEvent`
- gateway constructor accepts config and/or injected dependencies
- `start()` and `stop()` control running state if needed
- `processInboundEvent(event)`:
  1. validates/rationalizes normalized input
  2. resolves or creates mapping via resume/session module
  3. appends a durable event-log record
  4. triggers processor on the persisted event record
  5. updates mapping metadata after success
  6. records real Claude session ID if processor/runner exposes one on first success

### Important implementation notes
- do **not** compute sequence numbers with `getLastSeq() + 1`
- do **not** call adapters from gateway
- avoid direct duplication of processor logic in gateway
- direct `runUserMessage()` usage is acceptable only as a temporary bridge if the processor layer does not yet expose the required seam, and must be clearly marked as transitional

### Tests
- constructor/config handling
- start/stop behavior if implemented
- inbound event appends to event log
- inbound event triggers processor
- successful processing updates session mapping
- first success can record real Claude session ID

## Task 2 — Feature flag and migration helpers

### Done when
- exports:
  - `isGatewayEnabled()`
  - `processEventWithFallback(event, legacyHandler?)`
- environment variable can override settings
- feature flag defaults conservative/off unless repo standards say otherwise
- when gateway is disabled, legacy behavior still works
- when enabled, normalized events route through gateway

### Tests
- env var precedence
- settings-based enablement
- fallback path uses legacy handler when disabled
- enabled path uses gateway

## Task 3 — Adapter helpers

### Done when
- lightweight helpers exist for Telegram/Discord if useful:
  - normalize inbound platform message
  - submit normalized event to gateway
- helpers do not create tight coupling back into command modules beyond needed types

### Important caution
Do not force the gateway module to import full adapter runtime implementations if that creates circular dependencies. Keep adapter helpers thin.

### Tests
- Telegram helper normalizes then submits
- Discord helper normalizes then submits

## Task 4 — Comprehensive integration tests

**File:** `src/__tests__/gateway/index.test.ts`

### Must cover
- happy path end-to-end: normalize -> gateway -> event log -> processor
- mapping creation and reuse
- thread isolation
- feature flag behavior
- processor failure handling
- event-log append failure handling
- concurrent inbound events behave consistently

# Migration strategy

Use a feature flag:

```ts
const USE_GATEWAY = process.env.USE_GATEWAY === "true" || settings.gateway?.enabled === true;
```

Adapters should migrate from:

```ts
runUserMessage(...)
```

to:

```ts
normalizePlatformMessage(...)
-> processEventWithFallback(...)
```

This enables gradual rollout with low blast radius.

# Verification

1. `bun test src/__tests__/gateway/index.test.ts`
2. verify Telegram/Discord messages can flow through gateway under feature flag
3. verify legacy path still works when feature flag is off
4. verify event log is the source of truth for sequence assignment

# Output

After completion, create:
- `.planning/phases/2-session-gateway/2-04-SUMMARY.md`
