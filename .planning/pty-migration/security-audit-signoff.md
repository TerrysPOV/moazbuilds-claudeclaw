# PTY Migration — Phase D Security Audit Sign-off

**Auditor:** Phase D Security Review (claude-sonnet-4-6)
**Date:** 2026-05-14
**Branch:** feature/pty-migration
**Fix commits reviewed:** 689aff5, 5bacdbb, bafcd94, e784ad3, 10e18ef, c2f2fa3

---

## Final Verdict

**All CRITICALs and in-scope MAJORs RESOLVED. 2 new findings (1 MINOR, 1 INFO). Blocks merge: NO.**

---

## Executive Summary

The fix engineer addressed all five in-scope findings from the original audit (1 CRITICAL and 4 MAJORs, with MAJOR #6 and all MINORs explicitly deferred by operator scope decision). Each fix is architecturally sound: `cleanSpawnEnv` and `buildSecurityArgs` are now exported canonical singletons from `runner.ts` with the supervisor importing them lazily, eliminating the divergent-copy problem entirely. The `/kill` path correctly disposes PTY sessions with a fire-and-forget pattern that preserves the synchronous return contract while surfacing `PtyClosedError` to in-flight callers. The LRU cap is enforced before allocation with named agents correctly exempted. The `--append-system-prompt` payload threads cleanly through the full call chain. Test coverage on each fix is specific, asserts the right invariants, and the deflaking commit eliminates the settings.json race that made two tests flaky in the full suite. Two new minor findings are noted: a shallow TOCTOU window in `enforceMaxConcurrent` under concurrent burst (bounded by JavaScript's single-threaded event loop) and `--append-system-prompt` payload visibility in `ps aux` output (inherent to the flag design, not a regression). Neither blocks merge.

---

## Original Findings — Disposition

### CRITICAL — ANTHROPIC_API_KEY leak into PTY env (FA-1)
**Verdict: RESOLVED**

`cleanSpawnEnv()` is now exported from `src/runner.ts:136` and strips all four vars (`CLAUDECODE`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `ANTHROPIC_API_KEY`) using a Set membership check. The divergent local copy in `pty-supervisor.ts` is deleted. The supervisor imports it lazily via `getRunnerHelpers()` using the same circular-import dance as `ensureAgentDir`. The test at `src/__tests__/pty-supervisor.test.ts` (describe "pty-supervisor env-sanitisation (Phase D fix #1)") pollutes `process.env` with all four sensitive vars, calls `runOnPty` without stubbing `injectCleanSpawnEnv`, and asserts the real lazy-imported `cleanSpawnEnv` strips each one. The invariant tested is correct and sufficient.

**One observation, not a blocker:** The old local supervisor copy used `k.startsWith("CLAUDE_CODE_")` as a prefix match, which would have stripped any future `CLAUDE_CODE_*` vars not yet known. The new canonical implementation strips only the four named vars exactly. This is a deliberate and documented scope narrowing (the known vars are enumerated in the JSDoc). Any new `CLAUDE_CODE_*` vars introduced by future Claude Code releases would need to be added explicitly. This is acceptable engineering — the comment documents the rationale — but worth flagging to the team as a maintenance note.

### MAJOR #1 — permissionMode bypass: PTY always spawns with --dangerously-skip-permissions (FA-2)
**Verdict: RESOLVED**

`buildSecurityArgs()` is exported from `src/runner.ts:953`. The PTY path in `execClaude` (runner.ts:1431-1440) assembles `securityArgs` before the PTY routing decision and passes it explicitly to `runOnPty`. The supervisor threads it through `runOnPty → runTurnWithRetries → spawnEntry → buildSpawnOptions → PtyProcessOptions.securityArgs`. `buildClaudeArgs` in `pty-process.ts:187` uses the caller-supplied `securityArgs` verbatim when present. The fallback path (no `securityArgs`) now also includes `Write` in locked-mode, matching the canonical implementation. Tests confirm: the supervisor does not inject `--dangerously-skip-permissions` when `securityArgs` is provided, and explicit args take precedence over the local derivation.

### MAJOR #2 — locked-mode PTY missing Write tool (FA-2, locked-mode sub-issue)
**Verdict: RESOLVED**

Covered by the same fix as MAJOR #1. `buildSecurityArgs` in `runner.ts:959-963` explicitly includes `Write` in the `locked` case. The `pty-process.ts` fallback path also now includes `Write` in locked mode (`src/runner/pty-process.ts:199-201`). Test in `pty-process.test.ts` (describe "PtyProcess — buildClaudeArgs honours securityArgs (Phase D fix #3)") verifies the locked-mode fallback emits `Read,Grep,Glob,Write`.

### MAJOR #3 — appendSystemPrompt not threaded to PTY spawns (FA-3, system-prompt sub-issue)
**Verdict: RESOLVED**

`appendSystemPrompt` is assembled in `execClaude` at `runner.ts:1430` (`appendParts.join("\n\n")`) and passed to `runOnPty`. It propagates through the full chain: `runOnPty → runTurnWithRetries → spawnEntry → buildSpawnOptions → PtyProcessOptions.appendSystemPrompt → buildClaudeArgs → --append-system-prompt <payload>`. Guards at `pty-process.ts:229` ensure an empty string is not emitted. Three `pty-process.test.ts` tests pin the argv shape. One `pty-supervisor.test.ts` test confirms the payload reaches `PtyProcessOptions` verbatim.

### MAJOR #4 — /kill is a no-op against PTY sessions (FA-6a)
**Verdict: RESOLVED**

`killAllPtys()` is exported from `pty-supervisor.ts:337`. It snapshots `state.ptys.values()` into an array before iterating, disposes each entry's PTY best-effort, deletes all entries from the map atomically within the loop, and awaits all disposals via `Promise.allSettled`. `killActive()` in `runner.ts:341` calls `void killAllPtys()` fire-and-forget after disposing legacy procs, preserving the synchronous boolean return contract. Named agents are NOT exempt, consistent with the auditor's original load-bearing argument. Three tests cover: all PTYs disposed, named agents not exempt, and in-flight `runOnPty` with `maxRetries=0` receives a `PtyClosedError` surfaced as `exitCode=1`.

**Synchronization note (not a blocker):** `killAllPtys` snapshots entries to an array first (`const entries = [...state.ptys.values()]`), then deletes from the map inside the loop. This correctly avoids modifying-while-iterating the Map. There is no concurrent-modification hazard here because JavaScript is single-threaded; `state.ptys.delete` is synchronous and the loop does not yield between the delete call and the next iteration.

### MAJOR #5 — No concurrent PTY cap; daemon vulnerable to resource exhaustion (FA-3a)
**Verdict: RESOLVED**

`settings.pty.maxConcurrent` (default 32) is added to `PtyConfig` at `src/config.ts:210-217` with parser validation that falls back to 32 for zero, negative, or non-finite values. `enforceMaxConcurrent` is called at `pty-supervisor.ts:415` — **before** `getOrCreateEntry` — and evicts the LRU adhoc PTY when `state.ptys.size >= cap`. Named and global entries are exempt from eviction. `lastAccessedAt` is initialized at entry creation and updated on every `runOnPty` call at `pty-supervisor.ts:419`. Three tests cover: LRU eviction of oldest adhoc, named agents not evicted, and high cap is effectively unbounded.

**TOCTOU observation (MINOR — see New Findings below).**

### MAJOR #6 — cwd race between supervisor and execClaude (FA-4)
**Verdict: DEFERRED**

Explicitly deferred by operator scope decision. No fix commits touch this.

### MINOR #1 — Uncapped retry backoff amplification
**Verdict: DEFERRED**

Explicitly deferred. No fix commits touch this.

### MINOR #2 — Missing audit log for PTY spawns
**Verdict: DEFERRED**

Explicitly deferred. No fix commits touch this.

### MINOR #3 — PtyProcess dispose does not SIGKILL after timeout
**Verdict: DEFERRED**

Explicitly deferred. No fix commits touch this.

### MINOR #4 — Session ID collision risk on concurrent global PTY creation
**Verdict: DEFERRED**

Explicitly deferred. No fix commits touch this.

---

## New Findings from Fix Sprint

### NEW-1 — MINOR: `enforceMaxConcurrent` has a narrow TOCTOU window under concurrent burst

**File:** `src/runner/pty-supervisor.ts:514-551`
**Severity:** MINOR

`enforceMaxConcurrent` is `async` and calls `await lruEntry.pty.dispose()` at line 545. This creates an event-loop yield point. If two concurrent `runOnPty` calls arrive for two new session keys simultaneously when `state.ptys.size == cap - 1` (one slot left), both callers reach the `state.ptys.size < cap` guard synchronously, both pass it (size is still `cap - 1` at both checks), and both proceed without eviction, temporarily putting `state.ptys.size` at `cap + 1`. Similarly, if `state.ptys.size == cap`, both callers could select the same LRU entry, both call `await lruEntry.pty.dispose()`, and both call `state.ptys.delete(lruEntry.sessionKey)` — the second delete is a no-op but the second `dispose()` call on an already-disposed PTY depends on `dispose()` being idempotent (it is, per the implementation, which swallows errors best-effort).

The practical impact is bounded: the cap is a soft limit that can temporarily be exceeded by at most the number of concurrent new-key arrivals during a burst. The `dispose()` double-call is safe. JavaScript's event loop serializes microtasks, so only one `runOnPty` call runs at a time between yields. The supervisor's per-key serial lock prevents concurrent calls on the same key. The risk is accepted for this implementation (consistent with the operator's decision to defer the cwd race, which has a similar TOCTOU character). Track as a follow-up.

### NEW-2 — INFO: `--append-system-prompt` payload visible in `ps aux` on shared systems

**File:** `src/runner/pty-process.ts:229-231`
**Severity:** INFO (not a regression — same exposure exists on the legacy `claude -p` path)

The `--append-system-prompt <payload>` flag is passed as a command-line argument to the `claude` interactive process. On Linux and macOS, any local user can read the full argv of any process they can see via `ps aux` or `/proc/<pid>/cmdline`. If `CLAUDE.md` or `MEMORY.md` contain sensitive content (API endpoints, internal system descriptions, partial credentials), they are now world-readable to any user with `ps` access to the daemon's process tree.

This is the same exposure already present on the legacy `claude -p` path (where `--append-system-prompt` is also passed as argv at `runner.ts:1372`). The PTY fix does not widen the attack surface — it achieves parity with the existing behavior. On single-user developer machines and containerized deployments, this is acceptable. On shared Linux servers where multiple users have shell access, operators should ensure `CLAUDE.md` / `MEMORY.md` contain no secrets (consistent with the existing advisory in the security rules). No code change required; documented here for operator awareness.

---

## Regression Checks

**cleanSpawnEnv export widening:** `cleanSpawnEnv` is exported from `runner.ts` as a named export. It is not exposed via the plugin API (checked: no plugin-facing barrel exports reference it). The export is consumed only by the supervisor's lazy import. Acceptable.

**killAllPtys iteration safety:** Snapshots entries to an array before the loop (`const entries = [...state.ptys.values()]`). `state.ptys.delete` is called synchronously inside the loop before any yield point for that entry. No modification-while-iterating hazard. Safe.

**enforceMaxConcurrent TOCTOU:** Documented as NEW-1 MINOR above. Not a blocker.

**Test deflaking (c2f2fa3):** The `injectMaxConcurrentForTests` and `injectMaxRetriesForTests` seams avoid disk writes and `reloadSettings` calls, eliminating the settings.json race against other test files. Both overrides are cleared in `__resetSupervisorForTests`. Sound approach.

**No new divergent copies introduced:** Verified that neither `pty-supervisor.ts` nor `pty-process.ts` introduce new local env-stripping or permission-building logic that could diverge from the canonical `runner.ts` exports.
