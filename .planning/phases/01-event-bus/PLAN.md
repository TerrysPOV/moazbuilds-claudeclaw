---
phase: 1
name: Persistent Event Bus
description: Replace fire-and-forget runner.ts invocations with a durable, replayable event log
objective: Build the foundation for reliable event processing with idempotency, retries, and replay capability
---

Phase 1 — Persistent Event Bus

Objective
Replace fire-and-forget runner.ts invocations with a durable, replayable event-processing foundation.

This phase must establish the reliability substrate for all later work:
- durable append-only event storage
- persisted processing state
- idempotent handling
- retry scheduling
- dead-letter handling
- replay with provenance

This phase is foundational. Do not implement higher-level channel/session orchestration beyond what is required for durable event ingestion and processing.

Why this matters
Current state:
- events are effectively fire-and-forget
- process crash or Claude CLI failure can lose work
- retries/replay are not first-class
- no durable processing history exists

Target state:
- every inbound event is durably recorded before processing
- processing state survives restart/crash
- duplicate delivery is handled safely
- failed events are retried with backoff
- permanently failed events go to a dead-letter queue
- events can be replayed intentionally and safely

Non-goals for Phase 1
Do not fully implement:
- channel-to-session mapping
- cross-platform identity unification
- full workflow orchestration
- expanded platform adapters
- full dashboard UX for these features

Only build the persistence and processing primitives those later phases will depend on.

Success criteria
- all events are durably appended before processing begins
- events have monotonically increasing sequence numbers
- persisted state is sufficient to recover after restart/crash
- duplicate deliveries are handled idempotently
- failed events are retried with exponential backoff
- permanently failed events move to a dead-letter queue
- replay is supported from sequence number, range, and DLQ
- replay creates new event records and preserves provenance
- readFrom(seq) works across rotated log segments
- test suite covers normal flow, restart recovery, dedupe, retry, replay, DLQ, and log rotation

Core design constraints
- persisted state is the source of truth
- in-memory queues or indexes may be used only as rebuildable caches
- no critical state may exist only in memory
- all write paths must be crash-conscious and documented
- design must allow future partitioned concurrency, even if Phase 1 processing is serial

Data model requirements

Event record minimum schema:
{
  id,
  seq,
  type,
  source,
  timestamp,
  createdAt,
  updatedAt,
  status,
  channelId,
  threadId,
  payload,
  dedupeKey,
  retryCount,
  nextRetryAt,
  correlationId,
  causationId,
  replayedFromEventId,
  lastError
}

Notes:
- id must be globally unique
- seq must increase monotonically across all log segments
- dedupeKey should prefer upstream event/message IDs where available
- replayed events must get new id and seq values
- replayed events must reference the original via replayedFromEventId

Status model
Use an explicit status lifecycle, for example:
- pending
- processing
- done
- retry_scheduled
- dead_lettered

A.1 — Durable Event Log
File: src/event-log.ts
Status: TODO
Prerequisites: None

Goal
Implement segmented append-only event storage as the canonical source of truth.

Done when:
- event log stored under .claude/claudeclaw/event-log/
- log is append-only and segmented
- seq is monotonically increasing across segments
- supports segment rotation daily or by size threshold
- rotation does not break readFrom(seq)
- API includes:
  - append(entry)
  - readFrom(seq)
  - readRange(seqStart, seqEnd)
  - getLastSeq()
- write path is crash-conscious and documented
- storage format and segment/index strategy are documented

Implementation notes:
- do not rely on a single monolithic file
- use segment metadata or an index so replay across rotated logs is reliable
- document crash behavior and recovery assumptions clearly

Tests:
- append entry and read back
- seq increases monotonically
- segment rotation preserves readFrom(seq)
- restart/reopen preserves continuity

A.2 — Idempotent Event Processor
File: src/event-processor.ts
Status: TODO
Prerequisites: A.1

Goal
Process persisted events safely and idempotently.

Done when:
- processor consumes persisted events in order
- Phase 1 may process serially for correctness
- design must not preclude future partitioned concurrency
- dedupe prefers upstream event IDs where available
- otherwise dedupe uses canonical normalized key based on:
  - source
  - event type
  - channel/thread context
  - normalized payload
- dedupe state is persisted and replay-safe
- on success: mark event done
- on failure: increment retryCount and schedule retry
- API includes:
  - processNext()
  - processPending()
  - getPendingCount()

Important:
- do not use “last 1000 events” as the dedupe rule
- dedupe must be based on persisted keys and an explicit retention strategy

Tests:
- duplicate delivery only processes once
- same event after restart is still deduped
- intentional replay is not blocked by normal dedupe behavior

A.3 — Retry Scheduler
File: src/retry-queue.ts
Status: TODO
Prerequisites: A.2

Goal
Add retry scheduling for failed events.

Done when:
- retry state is durably represented in persisted state
- an in-memory priority queue may exist, but only as a rebuildable execution index
- queue ordering is by nextRetryAt
- exponential backoff:
  delay = min(5s * 2^retryCount, 10min)
- scheduler can rebuild itself completely from persisted state on restart
- retry loop runs on a configurable interval
- API includes:
  - schedule(eventId, retryCount)
  - popDue()
  - remove(eventId)
  - rebuildFromState()

Important:
- retry-queue.json must not become an independent competing source of truth
- persisted event-processing state must remain canonical

Tests:
- failed event schedules retry correctly
- backoff increases correctly
- restart rebuilds scheduler state correctly
- due retries are processed after restart

A.4 — Dead Letter Queue
File: src/dead-letter-queue.ts
Status: TODO
Prerequisites: A.3

Goal
Capture permanently failed events with full failure provenance.

Done when:
- events exceeding maxRetries move to DLQ
- default maxRetries is configurable, default 5
- DLQ stored at .claude/claudeclaw/dlq.jsonl or equivalent durable format
- DLQ record contains:
  - full event
  - retry history
  - firstFailureAt
  - lastFailureAt
  - final error
  - error class/type if available
  - handler/processor context
- API includes:
  - enqueue(event, attempts, error)
  - list()
  - replay(eventId)

CLI:
- claudeclaw dlq list
- claudeclaw dlq replay <id>

Tests:
- max retries exceeded creates DLQ entry
- DLQ entry includes provenance and retry history
- replay from DLQ creates a new event record

A.5 — Replay Support
File: src/replay.ts
Status: TODO
Prerequisites: A.1, A.2, A.4

Goal
Allow safe intentional reprocessing.

Done when:
- replayFrom(seq) replays all events from seq N onward
- replayRange(seqStart, seqEnd) replays a bounded range
- replayDLQ() re-enqueues dead-lettered events intentionally
- replay never mutates prior done records
- replay always creates new event records
- replayed events carry replayedFromEventId
- replay behavior explicitly handles dedupe so intentional replay is not suppressed

CLI:
- claudeclaw replay --from <seq>
- claudeclaw replay --range <start> <end>
- claudeclaw replay --dlq

Tests:
- replay from seq reprocesses expected events
- replayed entries receive new ids and seq values
- provenance is preserved
- replay does not mutate original records

Integration points
Existing code:
- runner.ts will later be changed to enqueue durable events instead of direct execution
- sessions.ts may be referenced but should not be materially changed in this phase
- config.ts may gain event bus configuration
- current daemon startup should load/rebuild scheduler state safely

Future phases:
- Gateway phase will consume this event bus and add channel/thread/session mapping
- Policy phase will intercept or evaluate events before execution
- Orchestration phase will build workflow state on top of this persistence layer

Test strategy
Unit tests:
- each module in isolation

Integration tests:
- append → process → retry → DLQ → replay
- restart recovery
- segment rotation and read continuity

Reliability tests:
- duplicate delivery
- crash/restart reconstruction
- replay of completed events
- intentional replay bypasses ordinary dedupe suppression
- corrupted/partial segment handling behavior is defined and tested where feasible

Coverage target:
- target >80% coverage on new modules
- but correctness and recovery invariants matter more than raw coverage percentage

Risks and mitigations
Risk: log growth
Mitigation: segmented logs, rotation, retention/compaction plan

Risk: crash during write
Mitigation: crash-conscious write strategy, documented guarantees, atomic patterns where applicable

Risk: duplicate handling errors
Mitigation: explicit persisted dedupe keys, canonical normalization, replay-aware semantics

Risk: scheduler state drift
Mitigation: persisted state is canonical; scheduler rebuilt from persisted state

Risk: future concurrency bottleneck
Mitigation: preserve ordering semantics without hard-coding a globally serialized architecture

Dependencies
- Bun runtime
- crypto module
- fs/path modules
- no external queue system required in Phase 1 unless already present in repo and clearly justified

Expected outputs
- src/event-log.ts
- src/event-processor.ts
- src/retry-queue.ts
- src/dead-letter-queue.ts
- src/replay.ts
- tests for all of the above
- documentation describing storage model, crash semantics, and replay semantics

Checkpoint
Before Phase 2 begins:
- run full tests
- manually verify daemon startup/restart behavior
- verify scheduler rebuild from persisted state
- verify replay semantics
- review storage design for future gateway/session mapping compatibility