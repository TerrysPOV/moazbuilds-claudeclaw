---
phase: 2
name: Session Gateway
description: Map each channel+thread combination to its own session, enabling per-conversation resume
objective: Build the gateway layer that decouples channel adapters from event processing and enables per-thread session management
---

# Phase 2: Session Gateway

## Goal
Map each channel+thread combination to its own session, enabling per-conversation resume. This replaces the single global session with proper session isolation.

## Why This Matters
- **Current state:** All channels share one `session.json`. Telegram and Discord conversations interleave.
- **Target state:** Each Telegram chat / Discord thread gets its own Claude session with independent resume capability.

## Success Criteria
1. Each channel+thread combination has its own session mapping
2. Sessions can be resumed deterministically by channel+thread
3. All inbound events are normalized to a common schema
4. Gateway orchestrator routes events from adapters to event log
5. Adding new channels requires no changes to event processing
6. All modules have >80% test coverage

## Prerequisites
- Phase 1 (Event Bus) must be complete
- All Phase 1 tests passing

## Tasks

### B.1 — Session Map Store
- **File:** `src/gateway/session-map.ts`
- **Status:** TODO
- **Prerequisites:** A.1 (Event Log)
- **Done When:**
  - [ ] File: `.claude/claudeclaw/session-map.json`
  - [ ] Schema: `{ [channelId: string]: { [threadId: string]: { sessionId, createdAt, lastSeq, turnCount } } }`
  - [ ] `channelId` format: `"telegram:123456"` / `"discord:channelId:msgId"`
  - [ ] API: `get(channel, thread)`, `set(channel, thread, sessionId)`, `delete(channel, thread)`
  - [ ] Auto-cleanup: Remove sessions older than 30 days (configurable)
- **Tests:** Unit test: create 2 sessions for same channel, different threads

### B.2 — Resume Logic
- **File:** `src/gateway/resume.ts`
- **Status:** TODO
- **Prerequisites:** B.1, A.1
- **Done When:**
  - [ ] On inbound message: look up session for channel+thread
  - [ ] Pass `--resume <sessionId>` to `claude -p` (integration with runner.ts)
  - [ ] If no session found: create new session and register in session map
  - [ ] Update `lastSeq` on each successful event processing
  - [ ] API: `getResumeArgs(channel, thread)` → `{ sessionId, args: ["--resume", sessionId] }`
- **Tests:** Unit test: resume session, verify correct sessionId returned

### B.3 — Normalized Event Schema
- **File:** `src/gateway/normalizer.ts`
- **Status:** TODO
- **Prerequisites:** A.1
- **Done When:**
  - [ ] TypeScript interface `NormalizedEvent` defined:
    ```typescript
    interface NormalizedEvent {
      id: string;           // uuid
      channel: string;      // "telegram" | "discord" | "cron" | "webhook"
      channelId: string;    // platform-specific ID
      threadId?: string;    // thread/topic/guild ID
      userId: string;       // platform user ID
      text: string;
      attachments?: Attachment[];
      timestamp: number;
      seq: number;          // event log sequence
    }
    ```
  - [ ] Normalize Telegram events to `NormalizedEvent`
  - [ ] Normalize Discord events to `NormalizedEvent`
  - [ ] Normalize cron events to `NormalizedEvent`
  - [ ] Normalize webhook events to `NormalizedEvent`
  - [ ] Outbound: normalize back to platform-specific format before sending
- **Tests:** Unit test: normalize Telegram event + Discord event, verify same schema

### B.4 — Gateway Orchestrator
- **File:** `src/gateway/index.ts`
- **Status:** TODO
- **Prerequisites:** B.1, B.2, B.3, A.1
- **Done When:**
  - [ ] Single gateway entry point: `processInboundEvent(event: NormalizedEvent)`
  - [ ] Route `NormalizedEvent` → event log → processor
  - [ ] Decouple channel adapters from processing logic
  - [ ] Integration with existing `runner.ts` for execution
  - [ ] API: `start()`, `stop()`, `processEvent(event)`
- **Tests:** Integration test: send event through gateway, verify logged + processed

## Integration Points

### With Existing Code
- **commands/telegram.ts:** Will call `gateway.processEvent()` instead of direct runner
- **commands/discord.ts:** Will call `gateway.processEvent()` instead of direct runner
- **runner.ts:** Will receive events from gateway instead of direct calls
- **sessions.ts:** Will be replaced by session-map for new sessions (old preserved for compatibility)

### With Phase 1
- **event-log.ts:** Gateway appends all inbound events to log
- **event-processor.ts:** Processor reads from log, gateway coordinates

### Future Phases
- **Phase 3 (Policy):** Gateway will call policy engine before event processing
- **Phase 7 (Adapters):** New adapters only need to normalize events, no other changes

## Test Strategy
- **Unit tests:** Each module in isolation
- **Integration tests:** Telegram/Discord → normalizer → gateway → event log
- **E2E tests:** Full flow: message → gateway → processing → response

## Migration Strategy
1. Create gateway alongside existing code
2. Add feature flag: `USE_GATEWAY=true/false` in settings.json
3. Test gateway with single channel
4. Gradually migrate channels
5. Remove feature flag and old direct paths

## Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Breaking existing adapters | Feature flag for gradual migration |
| Session data loss | Keep existing sessions.ts as fallback |
| Performance overhead | Measure before/after, optimize if needed |
| Thread ID format changes | Version the channelId format |

## Dependencies
- Phase 1 modules (event-log, event-processor)
- Existing Telegram/Discord adapters (for integration)
- `crypto.randomUUID()` for event IDs

## Output
- `src/gateway/session-map.ts`
- `src/gateway/resume.ts`
- `src/gateway/normalizer.ts`
- `src/gateway/index.ts`
- `src/__tests__/gateway/session-map.test.ts`
- `src/__tests__/gateway/resume.test.ts`
- `src/__tests__/gateway/normalizer.test.ts`
- `src/__tests__/gateway/index.test.ts`

## Checkpoint
After this phase completes, manual verification required:
1. Run all tests: `bun test`
2. Test Telegram → gateway → event log flow (manual)
3. Test Discord → gateway → event log flow (manual)
4. Verify existing daemon still works with feature flag off
5. Approve Phase 3 start
