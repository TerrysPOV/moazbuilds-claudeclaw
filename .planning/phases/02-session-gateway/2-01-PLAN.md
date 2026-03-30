---
phase: 2-session-gateway
plan: 01
version: revised
wave: 1
type: execute
depends_on: []
files_modified:
  - src/gateway/session-map.ts
  - src/__tests__/gateway/session-map.test.ts
autonomous: true
requirements:
  - session-isolation
must_haves:
  truths:
    - "Each channel+thread combination has its own mapping entry"
    - "Mappings are stored hierarchically by channel then thread"
    - "Local mapping state and Claude session state are distinct"
    - "Write operations are serialized to prevent corruption"
    - "Cleanup must not delete active mappings unexpectedly"
  artifacts:
    - path: "src/gateway/session-map.ts"
      provides: "Session map store with get/set/delete/update API"
      exports: ["get", "set", "delete", "update", "cleanup", "getOrCreateMapping"]
    - path: ".claude/claudeclaw/session-map.json"
      provides: "Session mapping persistence file"
    - path: "src/__tests__/gateway/session-map.test.ts"
      provides: "Unit tests for session map"
---

# Objective

Create the Session Map Store that manages per-channel+thread mapping state.

This replaces the global `session.json` model with hierarchical storage so each conversation thread can maintain its own Claude session context without cross-channel interleaving.

## Important correction

This module must **not invent a Claude CLI session ID**. The store should track mapping state and hold `claudeSessionId: string | null` until the first real session ID is returned by Claude/runner.

# Why this matters

Current risk:
- one global session state causes channel/thread collisions
- session persistence is not isolated per conversation
- later resume logic has nowhere reliable to store real Claude session identifiers

Target state:
- each `channelId + threadId` pair has an isolated mapping entry
- mapping state is durable and concurrency-safe
- real Claude session IDs can be attached later without redesign

# Success criteria

- mappings are stored at `.claude/claudeclaw/session-map.json`
- same channel + different threads produce different mapping entries
- same thread looked up repeatedly returns the same mapping entry
- write operations are serialized
- malformed or missing files are handled gracefully
- cleanup is explicit and conservative
- tests cover CRUD, isolation, cleanup, malformed state, and concurrent writes

# Data model

```ts
export interface SessionEntry {
  mappingId: string;
  claudeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  lastSeq: number;
  turnCount: number;
  status: "pending" | "active" | "stale" | "reset";
  metadata?: Record<string, unknown>;
}

export interface SessionMap {
  [channelId: string]: {
    [threadId: string]: SessionEntry;
  };
}
```

## Notes

- `mappingId` is a local UUID for internal identity.
- `claudeSessionId` is nullable until the first successful Claude run returns a real value.
- `updatedAt` and `lastActiveAt` are required so later stale/resume logic is grounded in activity, not only creation time.

# Key design constraints

- persisted file is the source of truth
- write queue pattern must be used for all writes
- reads may be optimistic, writes must be serialized
- cleanup must not remove entries merely because they are old if they are still active or resumable
- this module should stay storage-focused; do not fold resume logic into it

# Tasks

## Task 1 — Create `session-map.ts` with core structures and storage

**File:** `src/gateway/session-map.ts`

### Done when
- exports `SessionEntry` and `SessionMap`
- stores data at `.claude/claudeclaw/session-map.json`
- uses write queue serialization pattern from `event-log.ts`
- implements:
  - `get(channelId, threadId = "default")`
  - `set(channelId, threadId, entry)`
  - `delete(channelId, threadId)`
  - `loadMap()` internal
  - `saveMap(map)` internal
- missing file returns empty map
- malformed JSON is handled explicitly and safely

### Implementation notes
- default thread is `"default"`
- use temp-file + rename or equivalent documented write pattern if feasible
- do not rely on blind `Bun.write` claims for durability; document behavior clearly

### Tests
- missing mapping returns `null`
- `set()` then `get()` returns the same entry
- `delete()` removes only the targeted thread mapping
- malformed file handling does not crash the module

## Task 2 — Add metadata updates and mapping helpers

### Done when
- implements:
  - `update(channelId, threadId, patch)`
  - `updateLastSeq(channelId, threadId, seq)`
  - `incrementTurnCount(channelId, threadId)`
  - `attachClaudeSessionId(channelId, threadId, claudeSessionId)`
  - `getOrCreateMapping(channelId, threadId)`
  - `listChannels()`
  - `listThreads(channelId)`
- `getOrCreateMapping()` creates a local mapping with:
  - `mappingId = randomUUID()`
  - `claudeSessionId = null`
  - timestamps initialized consistently
- `attachClaudeSessionId()` never overwrites an existing non-null Claude session ID unless explicitly forced

### Tests
- `getOrCreateMapping()` returns existing entry if present
- new mapping has `claudeSessionId = null`
- `attachClaudeSessionId()` sets a real session ID once available
- `updateLastSeq()` and `incrementTurnCount()` update the expected fields

## Task 3 — Conservative cleanup and lifecycle helpers

### Done when
- implements:
  - `cleanup(maxAgeDays = DEFAULT_TTL_DAYS)`
  - optional `markStale(channelId, threadId)`
- cleanup removes entries only when clearly safe, for example:
  - explicitly reset entries
  - entries past TTL with no activity and no Claude session attached
- empty channel buckets are removed after cleanup
- cleanup actions are logged/debuggable

### Important correction
Do **not** auto-delete active mappings during ordinary `get()` calls. Cleanup should be explicit or tightly controlled. Silent deletion during reads is dangerous for resume semantics.

### Tests
- old inert entries are removed
- active entries are preserved
- empty channels are removed after cleanup

## Task 4 — Comprehensive unit tests

**File:** `src/__tests__/gateway/session-map.test.ts`

### Must cover
- basic CRUD
- same channel / different thread isolation
- same thread repeat lookup consistency
- concurrent writes are serialized
- malformed JSON handling
- attach real Claude session ID after creation
- cleanup semantics preserve active mappings

# Verification

1. `bun test src/__tests__/gateway/session-map.test.ts`
2. inspect `.claude/claudeclaw/session-map.json` shape manually
3. verify concurrent writes do not corrupt file
4. verify mappings start with `claudeSessionId: null`

# Output

After completion, create:
- `.planning/phases/2-session-gateway/2-01-SUMMARY.md`
