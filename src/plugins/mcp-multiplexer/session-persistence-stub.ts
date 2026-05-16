/**
 * TEMPORARY STUB — published interface contract for the W1 persistence
 * layer.
 *
 * Owned by W1 in worktree `feat/session-persistence-core`. The concrete
 * implementation lives in `session-persistence.ts`. This file exists in
 * the W2 worktree only so the wire layer compiles in isolation while the
 * two worktrees are developed in parallel.
 *
 * **Delete this file once W1's `session-persistence.ts` merges and update
 * the imports in `http-handler.ts` + `index.ts` to point at the real
 * module.**
 *
 * Contract source: `.planning/mcp-session-persistence/SPEC.md` §3.2
 * (post SPEC-DELTA-2026-05-16 always-resume simplification).
 */

export interface PersistedSessionRecord {
  serverName: string;
  ptyId: string;
  sessionId: string;
  issuedAt: number;
  lastUsedAt: number;
  hash: string;
}

export interface SessionPersistenceStoreOpts {
  /** Absolute path to the storage directory. The store creates it with
   *  mode 0700 if absent; each per-server JSON file inside is mode 0600. */
  storageRoot: string;
  /** Maximum entry age in milliseconds. Entries older than this on
   *  `loadAll()` are dropped with audit `mcp_session_lost_on_restart
   *  reason=ttl_expired`. */
  maxAgeMs?: number;
}

export declare class SessionPersistenceStore {
  constructor(opts: SessionPersistenceStoreOpts);
  /** Persist or refresh a (serverName, ptyId) → sessionId binding. */
  record(serverName: string, ptyId: string, sessionId: string): Promise<void>;
  /** Drop a binding. Idempotent. */
  drop(serverName: string, ptyId: string): Promise<void>;
  /** Update `lastUsedAt` for an existing binding. Best-effort; no-op if
   *  the binding does not exist. */
  touch(serverName: string, ptyId: string): Promise<void>;
  /** Read every surviving record for a given server, filtering out
   *  TTL-expired and integrity-failed entries (which emit audit events
   *  internally). */
  loadAll(serverName: string): Promise<PersistedSessionRecord[]>;
  /** Sweep the store: drop entries older than `maxAgeMs`. Returns
   *  scan/kept/dropped counts. Emits `mcp_session_gc` per dropped entry. */
  garbageCollect(): Promise<{ scanned: number; kept: number; dropped: number }>;
  /** Test seam — wipe in-memory state. Tests only. */
  _resetForTests(): Promise<void>;
}
