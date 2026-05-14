# PTY Migration — Phase D Code Review Sign-off

**Reviewer:** Phase D Code Review (sign-off pass)
**Date:** 2026-05-14
**Branch:** feature/pty-migration (17 commits ahead of povai/main@4d3f4b9)
**Fix commits reviewed:** 689aff5, 5bacdbb, bafcd94, e784ad3, 10e18ef, c2f2fa3

---

## Final Verdict

**All CRITICALs and in-scope MAJORs RESOLVED. Spec: compliant (additive extension). 3 new findings (2 MINOR, 1 INFO). Blocks merge: NO.**

---

## Executive Summary

The fix engineer cleanly addressed every in-scope original finding. The strongest evidence is structural: instead of patching divergent code paths, the fixes consolidated `cleanSpawnEnv` and `buildSecurityArgs` into single canonical exports on `runner.ts` and made the supervisor a thin consumer via the existing lazy-import seam (matching `ensureAgentDir`). The `PtyProcessOptions` type was extended with two optional fields (`securityArgs`, `appendSystemPrompt`) — both additive, both documented inline as Phase D additions, and the canonical path is asserted by tests at three layers (runner assembly, supervisor threading, pty-process argv shape). The `/kill` integration disposes PTYs via a snapshot-then-iterate pattern that's safe under map mutation, with fire-and-forget semantics that preserve the synchronous `killActive()` boolean contract. `enforceMaxConcurrent` runs before allocation, touches `lastAccessedAt` on every `runOnPty` (not just spawn), and correctly exempts both named and global entries. The deflaking commit replaced disk-write+reloadSettings with two test-only injection seams, eliminating the cross-file settings.json race. Full test suite shows 1019 pass / 27 fail / 1 error against a pre-fix baseline of 1019 pass / 27 fail / 2 errors (1031 → 1049 tests, +18 new tests, all PTY-related; no regression). New findings are minor: a documented behavioral quirk where `appendSystemPrompt` is captured at PTY spawn time only (subsequent turns reuse the same PTY and don't re-read memory), a duplicate-JSDoc-block cosmetic issue on `cleanSpawnEnv`, and a documentation gap noting that `global`-kind entries are also exempt from LRU eviction (not just named).

---

## Original Findings — Disposition

### CRITICAL — `--append-system-prompt` payload dropped on the PTY path
**Verdict: RESOLVED**
Fix commit `bafcd94` assembles `appendSystemPrompt = appendParts.join("\n\n")` in `execClaude` (runner.ts:1394) and threads it through `runOnPty → runTurnWithRetries → spawnEntry → buildSpawnOptions → PtyProcessOptions.appendSystemPrompt → buildClaudeArgs`. The flag is emitted in `pty-process.ts:229-231` with a guard against empty strings. Three new tests in `pty-process.test.ts` pin the argv shape (payload present, empty omitted, missing omitted); one supervisor test confirms verbatim payload propagation.

### MAJOR #1 — `ANTHROPIC_API_KEY` leak via divergent local `cleanSpawnEnv`
**Verdict: RESOLVED**
Fix commit `689aff5` exports `cleanSpawnEnv` from `runner.ts:136`, deletes the divergent local copy in `pty-supervisor.ts`, and consumes it via the lazy `getCleanSpawnEnv` helper that mirrors the existing `ensureAgentDir` circular-import pattern. The test pollutes `process.env` with all four sensitive vars (`ANTHROPIC_API_KEY`, `CLAUDECODE`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`) plus a benign control key, and asserts the strip set vs. pass-through invariant. Note the canonical set strips exact names (not the `CLAUDE_CODE_*` prefix that the deleted local copy used) — already flagged by the security auditor as a deliberate scope narrowing.

### MAJOR #2 — `permissionMode` unconditionally overridden by `--dangerously-skip-permissions`
**Verdict: RESOLVED**
Fix commit `5bacdbb` exports `buildSecurityArgs` from `runner.ts:953`. `execClaude` builds `securityArgs` once at `runner.ts:1294` and threads it through to `runOnPty.opts.securityArgs`. The supervisor passes it through `buildSpawnOptions → PtyProcessOptions.securityArgs`, and `buildClaudeArgs` in `pty-process.ts:187-189` consumes it verbatim instead of injecting `DEFAULT_PERMISSION_MODE_ARGS`. Tests verify both that `securityArgs` takes precedence when supplied and that the supervisor does NOT inject `--dangerously-skip-permissions` on its own.

### MAJOR #3 — Locked-mode PTY missing the `Write` tool (memory persistence broken)
**Verdict: RESOLVED**
Same fix commit as MAJOR #2. `buildSecurityArgs` in `runner.ts` includes `Write` in the locked-mode `--tools` list. The `pty-process.ts` fallback derivation path (used only by tests that bypass the supervisor) was also updated to emit `Read,Grep,Glob,Write` at line 200. A dedicated test pins the fallback behaviour.

### MAJOR #4 — `/kill` is a silent no-op against PTY-mode sessions
**Verdict: RESOLVED**
Fix commit `e784ad3` exports `killAllPtys` from `pty-supervisor.ts:337`. `killActive` in `runner.ts:341` now also calls `void killAllPtys()` fire-and-forget, preserving its synchronous boolean return contract. `killAllPtys` snapshots `state.ptys.values()` into an array before iterating (safe against map mutation), disposes each entry best-effort, deletes the entry from the map synchronously inside the loop, and awaits all disposals via `Promise.allSettled`. Named agents are intentionally NOT exempt. Three tests cover: all-PTY disposal, named-agent inclusion, and in-flight `runOnPty` with `maxRetries=0` surfaces a structured `exitCode=1` error within milliseconds of the kill.

### MAJOR #5 — No concurrent-PTY cap; daemon vulnerable to thread-burst exhaustion
**Verdict: RESOLVED**
Fix commit `10e18ef` adds `settings.pty.maxConcurrent` (default 32) to `PtyConfig` with parser validation that falls back to 32 for `<=0`, non-finite, or non-numeric values. `enforceMaxConcurrent` runs BEFORE `getOrCreateEntry` (pty-supervisor.ts:415), evicts the LRU adhoc entry when `state.ptys.size >= cap`, and updates `lastAccessedAt` on every `runOnPty` call at line 419 (not just on spawn — confirmed). Named AND global entries are exempt from selection as eviction victims (inline comment at line 525 calls this out; the doc-comment above the function only mentions named — see NEW-3 below). Three tests cover the eviction case, the all-named-exempt case (cap briefly exceeded), and a high-cap unbounded burst.

### MAJOR #6 — cwd race between supervisor and execClaude (FA-4)
**Verdict: DEFERRED**
Explicitly deferred by operator scope decision. No fix commits touch this. The security auditor's sign-off flagged a related TOCTOU pattern in `enforceMaxConcurrent` with consistent character — both belong in the same follow-up issue.

### MINOR #1–#6 (original review)
**Verdict: DEFERRED**
Original review's MINORs were deferred per the operator's scope decision. No fix commits touch them.

### INFO #1–#4 (original review)
**Verdict: DEFERRED**
INFO-grade items were not addressed in this sprint and were not expected to be.

---

## New Findings from Fix Sprint

### NEW-1 — MINOR: `appendSystemPrompt` is captured at PTY spawn time only

**File:** `src/runner/pty-supervisor.ts:582-587` (within `runTurnWithRetries`)
**Severity:** MINOR (behavioural — not a regression)

`appendSystemPrompt` is passed to `spawnEntry` only on the lazy-spawn path. Once a PTY exists for a given `sessionKey`, subsequent `runOnPty` calls reuse the same PTY and never re-emit `--append-system-prompt`. If `CLAUDE.md`, `MEMORY.md`, or the agent's `IDENTITY.md` / `SOUL.md` changes mid-session, the running PTY does not see the update until it's reaped (idle-reap window or `/kill`).

This is consistent with how `--append-system-prompt` works for interactive PTY-mode `claude` — the flag is applied once at boot, not per turn — and matches the legacy `claude -p` path which also re-reads files only on each fresh subprocess. The legacy path effectively re-reads on every turn because every turn is a new subprocess; under PTY mode, turns share a long-lived process. Operator-facing implication: a memory edit by an agent in one turn IS visible to that same agent in the next turn (because Claude itself loads MEMORY.md from disk via its own filesystem reads, not via the system prompt), but a memory edit by an out-of-band tool would not propagate to the live system-prompt buffer. Recommend documenting this behavioural difference in operator-facing notes. Not a blocker.

### NEW-2 — MINOR: Duplicate JSDoc block above `cleanSpawnEnv`

**File:** `src/runner.ts:102-135`
**Severity:** MINOR (cosmetic)

The fix added a new short JSDoc block (lines 129-135) immediately above the function declaration, but the original detailed JSDoc block (lines 102-128) — which documents the rationale for stripping each individual env var — was left in place. The two blocks are now adjacent. TypeScript / IDE / TypeDoc tooling will display only the lower (newer) block as the function's documentation; the upper block reads as an orphaned comment. The detailed rationale is the more valuable of the two and should be preserved. Suggest merging the two blocks into a single JSDoc above `cleanSpawnEnv`.

### NEW-3 — INFO: `enforceMaxConcurrent` doc-comment doesn't mention `global` is also exempt

**File:** `src/runner/pty-supervisor.ts:502-513`
**Severity:** INFO (documentation accuracy)

The JSDoc block above `enforceMaxConcurrent` says "named agents are exempt" but the actual implementation at line 528 also exempts `global`-kind entries (`if (entry.kind !== "adhoc") continue;`). The inline comment at line 525 does call this out (`// Find LRU candidate among adhoc entries (skip named + global).`), so the implementation is self-documenting at the code level — but the function-level doc-comment is incomplete. Suggest updating the JSDoc to read "named and global entries are exempt" for consistency.

---

## Sign-off Checklist Verification

1. **`cleanSpawnEnv` canonical export.** Confirmed clean: named export at `runner.ts:136`, JSDoc'd (twice, see NEW-2), explicit `Record<string, string>` return type, supervisor imports via lazy `getCleanSpawnEnv` helper. No circular-import damage — same pattern as `ensureAgentDir` which has been stable since v2.0.
2. **`buildSecurityArgs` export.** Confirmed clean: named export at `runner.ts:953`, JSDoc'd, `SecurityConfig → string[]` signature, supervisor imports via the same lazy `getRunnerHelpers` helper. Two consumers in `pty-supervisor.ts` (preferred path + fallback derivation in `buildSpawnOptions`) and one in `pty-process.ts` (the legacy fallback derivation kept for tests).
3. **`PtyProcessOptions` extension.** Two new optional fields with comprehensive JSDoc explaining why each was added and which Phase D fix introduced it. Both are `?:` optional, preserving backward compatibility. File-header still says "frozen per SPEC §3.1" at line 33 — that comment is now slightly stale; recommend appending "(plus Phase D additive extensions: securityArgs, appendSystemPrompt — both optional)" to the type's header block. Treat as INFO not MINOR — the new fields are individually documented at their declaration sites.
4. **`killAllPtys` semantics.** Idempotent (returns 0 + no-op when nothing to kill — covered by a test). Map-mutation-during-iteration safe (snapshot-then-iterate at line 339). In-flight `runOnPty` receives `PtyClosedError` rather than hanging — confirmed by the test that sets `maxRetries=0` and uses a hand-rolled FakePty whose `runTurn` blocks on a manually-rejectable promise; the test asserts both `exitCode=1` and a stderr match against `/max retries|PTY|closed/i`. Named agents intentionally NOT exempt — the auditor's load-bearing argument carried through, with the engineering rationale documented at lines 297-311.
5. **`enforceMaxConcurrent`.** LRU touched on every `runOnPty` at line 419, not just on spawn. Named genuinely exempt (not just from selection as victim — they cannot be evicted at all, and they CAN push the cap over its limit; this is documented in the comment at line 534 and is intentional per the operator's "named-agent slate is sacrosanct" framing). The soft-cap behaviour is acceptable; idle-reap eventually catches up unless `namedAgentsAlwaysAlive=true` AND every entry is named, which represents a pathological operator configuration.
6. **Test quality.** All 18 new tests are deterministic. The earlier flake-prone disk-write+reloadSettings pattern was correctly identified and replaced with `injectMaxConcurrentForTests` / `injectMaxRetriesForTests` injection seams in `c2f2fa3`. Both overrides are cleared in `__resetSupervisorForTests`. Per-test clock injection via `injectClock` gives the LRU tests determinism without sleep loops.
7. **No regression.** Baseline (pre-fix-sprint, commit 0ef6fa0): 1031 tests, 27 fail, 2 errors. Post-fix-sprint (commit c2f2fa3): 1049 tests, 27 fail, 1 error. Net: +18 tests passing, -1 error, -0 fails. All 27 remaining failures live outside `pty-*.test.ts` and are pre-existing (Event Processor, Policy Wiring, Telemetry, Phase 17/18 model wiring — unrelated to this sprint).

---

## Spec-Compliance Verdict

**Compliant (additive extension).** The supervisor still implements SPEC §3.2's contract; `runOnPty`'s public signature only grew optional opts (`securityArgs`, `appendSystemPrompt`) which is a legal additive change. `PtyProcessOptions` (SPEC §3.1) grew two optional fields with the same property. No spec-required behaviour was removed or weakened. The file-header in `pty-process.ts` saying "Implements the contract from SPEC §3.1 verbatim" is now slightly stale; recommend a doc-only follow-up to note that two additive fields were appended in Phase D.

---

## Regression Checks

- **No new divergent copies.** Verified `pty-supervisor.ts` and `pty-process.ts` do NOT introduce new local env-stripping or permission-building logic that could diverge from the canonical `runner.ts` exports.
- **Test seam hygiene.** All test overrides (`injectSpawnPty`, `injectClock`, `injectSleep`, `injectEnsureAgentDir`, `injectRunnerHelpers`, `injectCleanSpawnEnv`, `injectMaxConcurrentForTests`, `injectMaxRetriesForTests`) are explicitly cleared by `__resetSupervisorForTests` (lines 213-221).
- **`/kill` synchronous-return contract preserved.** `killActive()` remains synchronous; the fire-and-forget `void killAllPtys()` does not change its return shape.
- **Fallback paths preserved.** The `pty-process.ts` local derivation is correctly described as "reached only when callers (typically unit tests) skip the supervisor and pass a bare `PtyProcessOptions`." Supervisor ALWAYS sets `securityArgs`.
