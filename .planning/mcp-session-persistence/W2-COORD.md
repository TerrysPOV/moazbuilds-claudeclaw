# W2 → W1 Coordination Notes

**Worktree:** `feat/session-persistence-wire` (W2 — wiring layer)
**Branch:** `feat/session-persistence-wire`
**Last commit:** `d77876a` (5 commits ahead of `povai/main@6ba1a7f`)

## Contract W2 consumes from W1

W2 imports `SessionPersistenceStore` from `./session-persistence-stub.ts`
as a **type-only** stub. The published interface (mirrored verbatim in
the stub file):

```ts
class SessionPersistenceStore {
  constructor(opts: { storageRoot: string; maxAgeMs?: number });
  record(serverName: string, ptyId: string, sessionId: string): Promise<void>;
  drop(serverName: string, ptyId: string): Promise<void>;
  touch(serverName: string, ptyId: string): Promise<void>;
  loadAll(serverName: string): Promise<PersistedSessionRecord[]>;
  garbageCollect(): Promise<{ scanned: number; kept: number; dropped: number }>;
  _resetForTests(): Promise<void>;
}

interface PersistedSessionRecord {
  serverName: string;
  ptyId: string;
  sessionId: string;
  issuedAt: number;
  lastUsedAt: number;
  hash: string;
}
```

## TODO(coord) markers W1 needs to address on merge

Two import statements need flipping once `session-persistence.ts` lands:

1. `src/plugins/mcp-multiplexer/http-handler.ts` line 29-32:
   ```ts
   // TODO(coord): replace with real import after W1 merges
   import type { SessionPersistenceStore } from "./session-persistence-stub.js";
   ```
   → flip to:
   ```ts
   import type { SessionPersistenceStore } from "./session-persistence.js";
   ```

2. `src/plugins/mcp-multiplexer/index.ts` line 43-48:
   ```ts
   // TODO(coord): replace with real import after W1 merges
   import type { SessionPersistenceStore } from "./session-persistence-stub.js";
   ```
   → flip to:
   ```ts
   import { SessionPersistenceStore } from "./session-persistence.js";
   ```
   (note: real `index.ts` import is a **value** import — the
   `persistenceFactory` opt's body will `new` the class.)

3. **Delete** `src/plugins/mcp-multiplexer/session-persistence-stub.ts`.

Then `src/commands/start.ts` (still untouched in this PR per scope) gets
the production factory wiring on merge:

```ts
const plugin = getMcpMultiplexerPlugin({
  persistenceFactory: ({ storageRoot, maxAgeMs }) =>
    new SessionPersistenceStore({ storageRoot, maxAgeMs }),
});
```

`getMcpMultiplexerPlugin()` itself only takes the opts once (it's a
singleton); the factory needs to flow through before the first `start()`
call. The cleanest landing is to pass it on first construction in
`start.ts` — that's a ~5 LOC change which the merge PR can carry.

## Interface gaps W2 hit

**None of substance.** The published interface in the stub is exactly
what W2's wiring needed. Two minor notes:

- `loadAll()` returns `PersistedSessionRecord[]` directly — W2 reads
  only `ptyId` + `sessionId` from each record. The other fields
  (`issuedAt`, `lastUsedAt`, `hash`) are emitted in audit payloads only
  if we extend `mcp_session_resumed` to include `age_s` /
  `last_used_age_s` per SPEC §8 row. Current wiring emits the simpler
  `{ server, pty_id, session_id }` payload. **W1 / Phase C decision:**
  do we want the `age_s` fields in the audit? If yes, the interface
  doesn't need to change — W2 just computes the deltas from the loaded
  record fields at audit time.

- `garbageCollect()` emits `mcp_session_gc` per dropped entry
  internally (per SPEC §8) — W2 doesn't double-emit. W2's
  `_runGCTick()` just calls the method and logs warnings on throw.

- W2 does NOT consume `_resetForTests()`. W2's tests inject a
  `FakeStore` directly via `persistenceFactory`, so they never touch
  the real store. The `_resetForTests` seam is W1's own internal test
  hook.

## Audit events W2 emits (the rest are W1's)

- `mcp_session_resume_attempted { server, pty_id, session_id }` —
  fires once per persisted record during `_replayPersistedSessions()`.
- `mcp_session_resumed { server, pty_id, session_id }` — fires on
  successful bucket re-install.
- `mcp_session_lost_on_restart { server, pty_id, session_id, reason:
  "replay_failed", error }` — fires when `installResumedBucket` throws
  (transport error, upstream not ready, handler closed, etc).

W1 emits: `mcp_session_persisted`, `mcp_session_dropped`,
`mcp_session_loaded`, `mcp_session_gc`,
`mcp_session_persistence_degraded`, `mcp_session_persistence_recovered`,
`mcp_session_integrity_secret_minted`,
`mcp_session_lost_on_restart { reason: ttl_expired | integrity_failed |
corrupt_file | schema_mismatch }`.

## Out of scope (deferred to follow-up PRs)

Per the spec delta + the W2 prompt:

- Auto-population of `mcp.shared` from `mcp-proxy.json` at install time
  (operator's "canonical/declared list" idea, delta §8). Separate v1.1.
- Heartbeat drift detection for new servers appearing mid-session.
  Separate v1.1.
- Optional `mcp.servers.<name>.probeReadTool` for the
  `mcp_session_first_call_state_indicator` telemetry event (delta §7).
  Defer to v2.5.0.
- Synthetic-init replay mechanism per SPEC §4.5 — W2 currently relies
  on the SDK's `sessionIdGenerator` override approach (cleaner than
  the synthetic-init monkey-patch). If the SDK changes and breaks the
  override approach, fall back to the synthetic init path documented in
  §4.5. Phase C integration test should fail loudly if so.

## Test results

- `src/plugins/mcp-multiplexer/__tests__/index.test.ts` — 21 pass, 0 fail
  (16 pre-existing + 5 new persistence-wiring tests).
- `src/__tests__/pty-config.test.ts` — 39 pass, 0 fail (29 pre-existing
  + 10 new persistence-settings tests).
- Full repo: 1157 pass, 27 fail — all 27 failures predate this branch
  (Phase 17/18 jobs, Event Processor, Gateway, Policy — none touch
  MCP code).
