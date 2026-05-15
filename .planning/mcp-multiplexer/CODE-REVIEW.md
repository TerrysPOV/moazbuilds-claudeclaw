# Phase D Code Review — MCP Multiplexer Integration (#64)

**Branch:** `feat/mcp-multiplexer-integration` (HEAD `d89a956`)
**Reviewer:** Talon (Phase D code-review pass, read-only)
**Date:** 2026-05-15
**Scope:** code quality, cross-file consistency, error paths, naming, dead
code, TypeScript strictness, ESM hygiene, test quality. Security is excluded
(parallel auditor). Architecture is frozen by SPEC.

---

## 1. Executive verdict

**Approve with conditions.** The multiplexer wiring is internally consistent,
its public contract matches W1-COORD.md, the cross-worktree handshake works
both ways, and the dormant path is provably backward-compatible. The merge is
fundamentally safe to land behind `settings.mcp.shared = []` (its default
state). What stops it from being a clean approve is a small set of correctness
papercuts in the supervisor's URL construction and lifecycle bookkeeping, plus
a notable coverage gap in `pty-supervisor-mcp.test.ts` whose header advertises
tests it doesn't ship.

| Area | Verdict | Notes |
|---|---|---|
| Cross-file consistency | GREEN | W1↔W2 interfaces match in both directions; FQN namespacing partitions cleanly. |
| Error paths | AMBER | `start()` guards on `started=true` even when bailing dormant; bridgeBaseUrl divergence between plugin and supervisor. |
| Typing / ESM | AMBER | Inconsistent `.js` extension hygiene across the new files; a few `unknown` casts that look avoidable in production code. |
| Tests | AMBER | Integration tests are excellent. Supervisor-mcp tests claim coverage they don't have. Test-only side-doors used heavily in integration tests. |
| Hygiene | GREEN | No dead code of concern; perPtyOnly is documented as future surface; commits map cleanly to logical phases. |

---

## 2. Findings (grouped by severity)

### Critical (90–100)
_None._

### Important (80–89)

#### #1 supervisor hardcodes `127.0.0.1` for bridgeBaseUrl, plugin uses `settings.web.host` [IMPORTANT] [80]
**File:** `src/runner/pty-supervisor.ts:843-844`
**Description:** `synthesizeMcpConfigIfActive` builds the bridge URL as
`http://127.0.0.1:${bridgePort}`, ignoring `settings.web.host`. The
multiplexer plugin (`src/plugins/mcp-multiplexer/index.ts:201-202`) builds it
from `settings.webHost`. If the operator sets `settings.web.host = "localhost"`,
the plugin advertises `http://localhost:4632` (and the test passes with the
allowed-host check at index.ts:168) but the supervisor synthesises a config
pointed at `http://127.0.0.1:4632`. The two resolve to the same socket on every
modern host, so the bug is latent — but the two URL builders are now
de-synchronised and a future change to either will silently drift.
**Recommendation:** Either (a) read `bridgeBaseUrl()` from
`getMcpMultiplexerPlugin()` in the supervisor (preferred — single source of
truth, plugin already exposes the accessor), or (b) thread the URL through the
issuer interface (`McpIdentityIssuer` returns the URL alongside the identity).
Don't recompute it from settings in two places.

#### #2 `pty-supervisor-mcp.test.ts` header advertises coverage it doesn't ship [IMPORTANT] [82]
**File:** `src/__tests__/pty-supervisor-mcp.test.ts:14-15`
**Description:** The file header lists "Cleanup fires on shutdownSupervisor,
killAllPtys, reapIdle, LRU evict" and "Respawn rotates the bearer token via
re-synthesis on the same path." `rg reapIdle|LRU|evict|respawn` returns one
match — the header comment itself. There are no tests for reapIdle cleanup,
LRU eviction cleanup, or respawn re-synthesis. These are real code paths
(`pty-supervisor.ts` L696, L1177, L1002-1017) and they have real cleanup
semantics; an operator-visible regression here would only surface after a PTY
runs hot for 30+ minutes.
**Recommendation:** Either ship the three missing test cases (drive the
supervisor's idle clock past the cutoff; force LRU by setting maxConcurrent=1
and spawning a second entry; throw `PtyClosedError` from a fake PTY to drive
`respawnEntry`) or scope the file header down to what's actually covered.
Don't ship a header that lies about its own coverage.

#### #3 `started` flag stays `true` after dormant bail-out [IMPORTANT] [80]
**File:** `src/plugins/mcp-multiplexer/index.ts:162-196`
**Description:** `start()` sets `this.started = true` on line 163 (first line
inside the guard), then returns early on any of four dormant conditions
(non-loopback, web disabled, empty shared, config missing). `stop()` (L287)
checks `!this.started` and short-circuits — but since `started=true`, the full
teardown executes against empty maps. That's harmless today, but it also means
a caller can never `restart` the plugin: a dormant-then-reconfigured plugin
sees `started === true` and bails on the next `start()` call.
**Recommendation:** Only set `this.started = true` once the spawn loop has
committed (i.e. just before `this._startHealthProbe(...)` on line 284), or set
a distinct `this.active`-style flag for "really running". The current pattern
conflates "we've been called" with "we're hosting servers."

### Medium (70–79)

#### #4 `_toFqn` is mis-named — it returns the bridge tool-name argument, not the FQN [MEDIUM] [78]
**File:** `src/plugins/mcp-multiplexer/index.ts:56-58`
**Description:** The function is called `_toFqn` and returns
`${serverName}__${toolName}`. The actual fully-qualified name stored in the
bridge is `mcp-multiplexer__${serverName}__${toolName}` (the bridge prefixes
with pluginId, per `mcp-bridge.ts:65`). The function's job is to build the
NAME argument; the FQN is built downstream. The comments at L48-55 are
correct, but the function name is the inverse of what it returns. Anyone
reading `_toFqn` will think the value is what gets stored.
**Recommendation:** Rename to `_toBridgeToolName` (or inline — it's a
two-liner). The current name is a future-trap.

#### #5 multiplexer issues `mcp_health_degraded` AND `multiplexer_server_crashed` for the same event [MEDIUM] [75]
**File:** `src/plugins/mcp-multiplexer/index.ts:341-366` + `465-477`
**Description:** When the upstream child crashes, `_onServerCrash` audits
`multiplexer_server_crashed` immediately. On the next probe tick (default 30s
later), `_sampleHealth` sees the status transition and audits
`mcp_health_degraded`. Both events carry the server name. The Phase C
integration test (`mcp-multiplexer-integration.test.ts:647-651`) explicitly
asserts both fire. That's an OK design choice (the probe is the
"belt-and-braces" check for crashes that bypass `_onServerCrash`), but the
duplication is undocumented and operators grepping for "alpha crashed" will
get two hits per crash event.
**Recommendation:** Document in the audit-events table (wherever that lives)
that `multiplexer_server_crashed` is the immediate event and
`mcp_health_degraded` is the next-probe confirmation. Or: have
`_onServerCrash` update `lastObservedStatus` so the next probe doesn't
re-audit. The latter is cleaner. (Note: line 364 sets the observed status
after audit, but `_onServerCrash` doesn't.)

#### #6 http-handler does not enforce `allowedTools` on `tools/call` [MEDIUM] [74]
**File:** `src/plugins/mcp-multiplexer/http-handler.ts:246-268`
**Description:** `tools/list` returns the filtered `proc.tools` (L235-243),
which already honours `mcp-proxy.json`'s `allowedTools`. But the
`CallToolRequestSchema` handler forwards any name straight to `proc.call`
without validating it's in the allowed set. The upstream MCP child would
presumably reject unknown tools, but the multiplexer's tool gate is purely
advisory. The legacy bridge callback path (`index.ts:481`) has the same
property — it registers only allowed tools, so a non-allowed name isn't a
known FQN there.
**Recommendation:** Add a guard before `proc.call`: build a `Set<string>` of
allowed tool names at handler construction time and reject anything not in
the set with `isError: true`. Cheap, defence-in-depth. Flagging here as code
quality; security auditor will likely call this out too.

#### #7 mcp-proxy skip-shared and `~/.claude/mcp.json` are not in sync [MEDIUM] [72]
**File:** `src/plugins/mcp-proxy/index.ts:65-88` + `src/runner/pty-process.ts:244-251`
**Description:** The skip-shared rule prevents the daemon's `mcp-proxy` from
spawning servers claimed by the multiplexer — but Claude Code inside the PTY
still consults `~/.claude/mcp.json` because the synthesised `--mcp-config` is
additive (no `--strict-mcp-config`). If the operator has the same MCP server
in `mcp-proxy.json` AND `~/.claude/mcp.json`, the multiplexer hosts it and
the PTY's claude also stdio-spawns its own copy. The comment on L245-248
acknowledges this, but there's no validation, no warning, and no operator
guidance in the synthesised JSON itself.
**Recommendation:** Either (a) pass `--strict-mcp-config` (breaks operators
who rely on `~/.claude/mcp.json` merging), (b) emit a startup warning when the
multiplexer detects a name in both `~/.config/claudeclaw/mcp-proxy.json` and
`~/.claude/mcp.json`, or (c) document this in the README operator section
with a "remove shared names from `~/.claude/mcp.json`" instruction. Don't
leave the footgun unmarked.

#### #8 Integration test uses `lastObservedStatus` private internals via cast [MEDIUM] [72]
**File:** `src/__tests__/mcp-multiplexer-integration.test.ts:631-636`
**Description:** Tests reach into `plugin.servers`, `plugin.lastObservedStatus`,
and `_sampleHealthForTests` via `as unknown as { ... }` casts. The unit
tests have the same pattern (`index.test.ts:347-354`, `395-401`). This works
but it bakes test-only knowledge of private fields into the suite. A rename
of `lastObservedStatus` breaks five tests.
**Recommendation:** Either expose a tiny test-seam method on the plugin
(e.g. `_seedHealthStatus(name: string, status: string): void`) or accept the
fragility and consolidate the cast into a single helper function at the top
of the integration test. The current ad-hoc casts will be the first thing to
rot during follow-up work.

### Low (51–71)

#### #9 ESM `.js` extension usage is inconsistent across new files [LOW] [68]
**File:** `src/runner/pty-supervisor.ts:52-62`, `src/runner/pty-mcp-config-writer.ts:28`
**Description:** All new code in `src/plugins/mcp-multiplexer/*` uses
explicit `.js` extensions on relative imports (matches the codebase's
modern convention for ESM/Node interop). `pty-supervisor.ts` and
`pty-mcp-config-writer.ts` keep bare specifiers (no `.js`). Both work under
`moduleResolution: bundler` in `tsconfig.json`, so it's cosmetic — but the
new code split across two conventions in the same PR is noisy.
**Recommendation:** Pick one. Project-wide migration is out of scope; for
THIS PR, normalise the new mcp-multiplexer-adjacent code (writer and
supervisor's new section) to match the rest of the multiplexer code. Test
file at `mcp-multiplexer-integration.test.ts` uses `.js`,
`pty-supervisor-mcp.test.ts` uses bare — pick one.

#### #10 `_validatePtyId` regex disallows `/` but allows `:` — undocumented contract [LOW] [62]
**File:** `src/plugins/mcp-multiplexer/pty-identity.ts:74-81`
**Description:** The regex `/^[A-Za-z0-9_.:-]+$/` allows colons (for
session-key shapes like `agent:suzy`, `UUID:f47...`) and dots, but bans
slashes. This is correct for the current sessionKey shape, but the contract
isn't documented anywhere; W1-COORD doesn't restate it. If future code
introduces a new sessionKey shape (e.g. `workspace/agent`), this will fail
with a confusing error.
**Recommendation:** Either (a) reference the supervisor's sessionKey grammar
in the comment, or (b) document the allowed shapes in W1-COORD.md as the
authoritative interface contract. The function comment says "named-agent
names, thread IDs, or 'global'" but `agent:suzy` doesn't match any of those —
it's the supervisor's actual sessionKey grammar that matters.

#### #11 `_readBody` clones the request for audit observability [LOW] [60]
**File:** `src/plugins/mcp-multiplexer/http-handler.ts:61-73`, called L152
**Description:** Every multiplexer call clones the request body to extract
the JSON-RPC method name for audit. For tool calls with large arguments
(`large_result` fixture returns 2MB), this doubles peak memory per request.
Not a real concern at MCP body sizes, but it's per-call overhead for
metadata that could often be extracted lazily.
**Recommendation:** Optional — skip the audit body peek when the request
body is over some small threshold (4KB), or move the audit into the SDK
transport's request handler so the body is parsed once. Defer to follow-up
if not landing in this PR.

#### #12 multiplexer doesn't proxy resources/prompts, only tools [LOW] [58]
**File:** `src/plugins/mcp-multiplexer/http-handler.ts:235-268`
**Description:** The handler only wires `ListToolsRequestSchema` and
`CallToolRequestSchema`. MCP servers also expose resources, prompts, and
completions. If a shared MCP server advertises any of these, the PTY's
`claude` won't see them through the multiplexer (but would see them through
`mcp-proxy`'s in-process bridge — which is also tools-only, so this matches
the existing limitation). Not a regression, but it's a known constraint that
should be in the README.
**Recommendation:** Document in the operator-facing docs that shared
multiplexed servers expose tools only. Resources / prompts require the
operator to keep the server out of `settings.mcp.shared` and let Claude Code
spawn it per-PTY.

#### #13 `try { ... } catch {}` swallows all errors around audit calls [LOW] [55]
**File:** `src/plugins/mcp-multiplexer/index.ts:172-176`, `184-186`, `192-194`, `208-211`, `253-258`, `292-294`, `406-411`, `420-424`, `465-477`
**Description:** Twelve call sites wrap `getMcpBridge().audit(...)` in a
bare `try {} catch {}`. The bridge is initialised at module load; the only
realistic failure mode is `_resetMcpBridge()` running mid-flight in a test.
Wrapping every audit in a silent swallow makes the production code look
defensive against a failure mode that exists only in tests.
**Recommendation:** Drop the audit-call try/catches in production paths and
let the bridge guarantee its own contract (the `audit` method should never
throw against an initialised bridge). If a test concern remains, wrap once at
the bridge level. The current pattern is noise.

### Info (≤50)

#### #14 `_toPublic` rebuilds the bearer string on every `getIdentity` call [INFO] [40]
**File:** `src/plugins/mcp-multiplexer/pty-identity.ts:83-95`
**Description:** Each call to `getIdentity` allocates a fresh bearer string
and headers object. The store could cache `_toPublic(record)` once on
`issueIdentity`. Not a real concern (hex encoding is microsecond-fast,
secrets rotate on respawn so the cache wouldn't live long), but worth
noting as cleanup opportunity.

#### #15 Test fixture name drift from spec [INFO] [35]
**File:** `src/__tests__/mcp-multiplexer-integration.test.ts:43-45`
**Description:** The review brief references
`src/__tests__/fixtures/mcp-stdio-echo.ts`. The actual fixture is
`fixtures/mock-mcp-server.ts` (reused from earlier mcp-proxy tests). The
reuse is correct; the brief is the one out of date. Mention because it's
indicative of the SPEC referring to filenames that diverged during
implementation — minor doc drift, easy to miss in PR review.

---

## 3. Top-5 things to fix before PR opens

1. **Fix #1 — unify `bridgeBaseUrl` construction.** Make the supervisor
   read `getMcpMultiplexerPlugin().bridgeBaseUrl()` instead of recomputing.
   `src/runner/pty-supervisor.ts:843-844`. 4 lines.
2. **Fix #2 — either land the missing supervisor cleanup tests or scope the
   file header down.** `src/__tests__/pty-supervisor-mcp.test.ts:14-15`.
   Three test cases or three lines of header.
3. **Fix #3 — only set `this.started = true` once the plugin commits.**
   `src/plugins/mcp-multiplexer/index.ts:163` → move down to L284.
   Five-line move plus a "have we ever attempted start" flag if needed.
4. **Fix #4 — rename `_toFqn` to `_toBridgeToolName` (or inline it).**
   `src/plugins/mcp-multiplexer/index.ts:56-58`, `L482`. Two-line edit.
5. **Fix #6 — add the `allowedTools` gate in `CallToolRequestSchema`.**
   `src/plugins/mcp-multiplexer/http-handler.ts:246-268`. Defence-in-depth;
   security auditor will likely flag too.

---

## 4. Top-3 things worth a note in the PR description

1. **Backward-compat is enforced four ways**: `settings.mcp.shared=[]` →
   plugin dormant, supervisor skips synthesis, mcp-proxy spawns everything,
   PTY argv has no `--mcp-config`. Each gate is independently tested. This is
   load-bearing — reviewers should be able to confirm the dormant path is
   byte-identical to today's PTY behaviour without reading the multiplexer at
   all.
2. **`~/.claude/mcp.json` vs `settings.mcp.shared` is an operator footgun.**
   The synthesised config is additive — operators must remove shared names
   from `~/.claude/mcp.json` themselves or claude will stdio-spawn shadow
   copies inside each PTY. See finding #7. Worth a README line.
3. **The integration tests stand in for production gateway routing.** The
   route-forwarding fix in `src/ui/server.ts` (commit `2693774`) was a Phase B
   blind spot caught by Phase C. The integration test gateway is hermetic;
   the production gateway now routes `/mcp/<server>/*` correctly. Reviewers
   should confirm both surfaces (UI server + http-gateway) route together.

---

## 5. Summary for operator

**Verdict:** Approve with conditions. The multiplexer is correctly wired,
dormant-by-default, and the W1↔W2 interface is symmetric. The blockers are
small and structural: the supervisor and plugin compute the same
bridgeBaseUrl from two different sources of truth (finding #1), and
`pty-supervisor-mcp.test.ts` advertises coverage of reapIdle/LRU/respawn
cleanup paths that aren't actually tested (finding #2). **Top two actions:**
unify the bridgeBaseUrl construction by reading from the plugin instead of
recomputing in the supervisor, and either ship the missing three cleanup
tests or scope the test file's header down to what's covered. Everything
else (FQN naming, audit duplication, ESM hygiene, the operator footgun
between `mcp-proxy.json` and `~/.claude/mcp.json`) is comment-and-document
work that doesn't block the merge.
