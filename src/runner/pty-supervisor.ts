/**
 * pty-supervisor.ts — owns the lifecycle of N+M long-lived `claude` PTYs.
 *
 * Public contract: SPEC.md §3.2 (frozen, do not change exported types).
 *
 * Design decisions for this implementation (operator-locked, see SPEC §3.2 and
 * the parent plan):
 *
 *   - OR-5 (named-agent spawn strategy): **LAZY**. Named-agent PTYs are spawned
 *     on the first event for that agent, not at initSupervisor(). The
 *     `namedAgentsAlwaysAlive` flag still governs post-spawn behaviour — named
 *     agents are never reaped once alive. This keeps daemon startup fast and
 *     simplifies the supervisor (no eager enumerate-agents-dir pass).
 *
 *   - PTY-supervisor is decoupled from engineer-pty-core's worktree via the
 *     `injectSpawnPty` / `injectClock` test seams. At runtime the supervisor
 *     dynamically imports the real `spawnPty` from `./pty-process` on first
 *     use; in tests, a fake `spawnPty` is injected before any `runOnPty` call.
 *
 *   - One write-lock per sessionKey enforces sequential `runTurn` invocations
 *     on the same PTY (per the §3.1 concurrency contract). Different keys
 *     proceed in parallel.
 *
 *   - Crash-respawn-replay: on PtyClosedError or PtyTurnTimeoutError, the
 *     supervisor disposes the dead PTY, sleeps `backoffMs[i]`, respawns
 *     (via cached spawn options + last-known sessionId for --resume), and
 *     retries the SAME prompt up to `maxRetries` times. After exhaustion the
 *     supervisor surfaces a structured error in RunOnPtyResult.stderr and
 *     exitCode=1; execClaude treats this as any other non-zero exit.
 *
 *   - Settings are re-read via getSettings() on every call — never cached
 *     across calls — so hot-reload works. The reap interval is rebuilt
 *     whenever initSupervisor() is called with a new idleReapMinutes.
 *
 *   - Phase D fix #5 (FA-3a): `settings.pty.maxConcurrent` (default 32) caps
 *     the number of concurrent live PTYs. On overflow, the LRU AD-HOC PTY is
 *     evicted (disposed + entry removed). Named agents are exempt — they're
 *     the operator-configured slate and shouldn't shrink under thread burst.
 *
 *   - Phase D fix #4 (FA-6a): `killAllPtys()` is exposed so `runner.ts:
 *     killActive()` (the `/kill` command) can dispose every live PTY. The
 *     in-flight turn surfaces a `PtyClosedError`, mirroring how `/kill`
 *     behaves against legacy `Bun.spawn` subprocesses. Session IDs survive
 *     on disk via the Claude Code JSONL; the next event for the same key
 *     re-spawns and `--resume`s.
 */
import type {
  PtyProcess,
  PtyProcessOptions,
  SpawnPty,
} from "./pty-process";
import { PtyClosedError, PtyTurnTimeoutError } from "./pty-process";
import { getSettings, type SecurityConfig } from "../config";
import { getSession, createSession } from "../sessions";
import { getThreadSession, createThreadSession } from "../sessionManager";

// Lazy import for `ensureAgentDir` to avoid the circular-import hazard
// (runner.ts imports this module to route into the supervisor; importing
// runner.ts at module load time would observe a partially-initialised
// module). We resolve the symbol on first agent-PTY spawn.
type EnsureAgentDirFn = (name: string) => Promise<string>;
let _ensureAgentDir: EnsureAgentDirFn | null = null;
async function ensureAgentDirLazy(name: string): Promise<string> {
  if (!_ensureAgentDir) {
    const mod = (await import("../runner")) as { ensureAgentDir?: EnsureAgentDirFn };
    if (!mod.ensureAgentDir) {
      throw new Error("[pty-supervisor] runner.ts does not export ensureAgentDir");
    }
    _ensureAgentDir = mod.ensureAgentDir;
  }
  return _ensureAgentDir(name);
}

/** For tests only. Stub the agent-dir resolver. */
export function injectEnsureAgentDir(fn: EnsureAgentDirFn | null): void {
  _ensureAgentDir = fn;
}

// Lazy imports of the canonical env-sanitiser + security-args builder +
// child-env shim from runner.ts (same circular-import dance as
// ensureAgentDir). Phase D fixes #1 / #3 and Codex Phase D #1: keep one
// source of truth for the strip list, the permission-mode argv, AND the
// provider env so the PTY path can't silently diverge from `claude -p`
// policy.
type CleanSpawnEnvFn = () => Record<string, string>;
type BuildSecurityArgsFn = (security: SecurityConfig) => string[];
type BuildChildEnvFn = (
  baseEnv: Record<string, string>,
  model: string,
  api: string,
) => Record<string, string>;
let _cleanSpawnEnv: CleanSpawnEnvFn | null = null;
let _buildSecurityArgs: BuildSecurityArgsFn | null = null;
let _buildChildEnv: BuildChildEnvFn | null = null;
async function getRunnerHelpers(): Promise<{
  cleanSpawnEnv: CleanSpawnEnvFn;
  buildSecurityArgs: BuildSecurityArgsFn;
  buildChildEnv: BuildChildEnvFn;
}> {
  if (_cleanSpawnEnv && _buildSecurityArgs && _buildChildEnv) {
    return {
      cleanSpawnEnv: _cleanSpawnEnv,
      buildSecurityArgs: _buildSecurityArgs,
      buildChildEnv: _buildChildEnv,
    };
  }
  const mod = (await import("../runner")) as {
    cleanSpawnEnv?: CleanSpawnEnvFn;
    buildSecurityArgs?: BuildSecurityArgsFn;
    buildChildEnv?: BuildChildEnvFn;
  };
  if (!mod.cleanSpawnEnv) {
    throw new Error("[pty-supervisor] runner.ts does not export cleanSpawnEnv");
  }
  if (!mod.buildSecurityArgs) {
    throw new Error("[pty-supervisor] runner.ts does not export buildSecurityArgs");
  }
  if (!mod.buildChildEnv) {
    throw new Error("[pty-supervisor] runner.ts does not export buildChildEnv");
  }
  _cleanSpawnEnv = _cleanSpawnEnv ?? mod.cleanSpawnEnv;
  _buildSecurityArgs = _buildSecurityArgs ?? mod.buildSecurityArgs;
  _buildChildEnv = _buildChildEnv ?? mod.buildChildEnv;
  return {
    cleanSpawnEnv: _cleanSpawnEnv,
    buildSecurityArgs: _buildSecurityArgs,
    buildChildEnv: _buildChildEnv,
  };
}
async function getCleanSpawnEnv(): Promise<CleanSpawnEnvFn> {
  const h = await getRunnerHelpers();
  return h.cleanSpawnEnv;
}

/** For tests only. Stub the runner helpers (cleanSpawnEnv + buildSecurityArgs
 *  + buildChildEnv). */
export function injectRunnerHelpers(opts: {
  cleanSpawnEnv?: CleanSpawnEnvFn | null;
  buildSecurityArgs?: BuildSecurityArgsFn | null;
  buildChildEnv?: BuildChildEnvFn | null;
}): void {
  if (opts.cleanSpawnEnv !== undefined) _cleanSpawnEnv = opts.cleanSpawnEnv;
  if (opts.buildSecurityArgs !== undefined) _buildSecurityArgs = opts.buildSecurityArgs;
  if (opts.buildChildEnv !== undefined) _buildChildEnv = opts.buildChildEnv;
}

/** Back-compat shim — fix #1's test used this name. Same behaviour. */
export function injectCleanSpawnEnv(fn: CleanSpawnEnvFn | null): void {
  _cleanSpawnEnv = fn;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — frozen by SPEC §3.2.

export interface SupervisorOptions {
  idleReapMinutes: number;
  maxRetries: number;
  backoffMs: number[];
  namedAgentsAlwaysAlive: boolean;
}

export interface RunOnPtyResult {
  rawStdout: string;
  stderr: string;
  exitCode: number;
  sessionId?: string;
}

export interface SupervisorSnapshot {
  ptys: Array<{
    sessionKey: string;
    label: string;
    pid: number;
    sessionId: string;
    cwd: string;
    isAlive: boolean;
    lastTurnEndedAt: number;
    /** "named" → never reaped; "adhoc" → reaped after idle. */
    kind: "named" | "adhoc" | "global";
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test seams.

let _spawnPty: SpawnPty | null = null;
let _clock: () => number = () => Date.now();
let _sleep: (ms: number) => Promise<void> = (ms) =>
  new Promise<void>((r) => setTimeout(r, ms));
/** Injectable UUID generator. Used to pre-allocate a session ID for fresh
 *  PTY spawns so the conversation survives daemon restart. Phase D fix
 *  (Codex HIGH #2). */
let _newSessionId: () => string = () => crypto.randomUUID();

/** For tests only. Inject a fake spawnPty before any runOnPty call. */
export function injectSpawnPty(fn: SpawnPty | null): void {
  _spawnPty = fn;
}

/** For tests only. Inject a deterministic clock. */
export function injectClock(fn: () => number): void {
  _clock = fn;
}

export function resetClock(): void {
  _clock = () => Date.now();
}

/** For tests only. Inject a deterministic sleep (so backoff delays don't
 *  consume wall-clock time in unit tests). */
export function injectSleep(fn: (ms: number) => Promise<void>): void {
  _sleep = fn;
}

export function resetSleep(): void {
  _sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms));
}

/** For tests only. Inject a deterministic UUID generator so fresh-session
 *  persistence can be pinned without randomness. */
export function injectNewSessionId(fn: (() => string) | null): void {
  _newSessionId = fn ?? (() => crypto.randomUUID());
}

/**
 * For tests only. Force one reap pass using the caller-supplied clock.
 * Bypasses the timer cadence so tests can advance fake time arbitrarily.
 */
export async function __reapNowForTests(clock?: () => number): Promise<void> {
  if (clock) injectClock(clock);
  const opts = readSupervisorOptions();
  await reapIdle(opts);
}

/** For tests only. Inspect the lazy-init flag.
 *  Returns true iff `initSupervisor()` has run (and `shutdownSupervisor` /
 *  `__resetSupervisorForTests` haven't cleared it since). */
export function __isSupervisorInitialisedForTests(): boolean {
  return state.initialised;
}

/** For tests only. Wipe all internal state. */
export function __resetSupervisorForTests(): void {
  for (const entry of state.ptys.values()) {
    try {
      void entry.pty?.dispose();
    } catch {
      // ignore
    }
  }
  state.ptys.clear();
  if (state.reapTimer) {
    clearInterval(state.reapTimer);
    state.reapTimer = null;
  }
  state.initialised = false;
  _initPromise = null;
  _spawnPty = null;
  _ensureAgentDir = null;
  _cleanSpawnEnv = null;
  _buildSecurityArgs = null;
  _buildChildEnv = null;
  _maxConcurrentOverride = null;
  _maxRetriesOverride = null;
  _newSessionId = () => crypto.randomUUID();
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal state.

type SessionKind = "named" | "adhoc" | "global";

interface PtyEntry {
  sessionKey: string;
  kind: SessionKind;
  threadId?: string;
  agentName?: string;
  /** May be null while a spawn-or-respawn is in flight. */
  pty: PtyProcess | null;
  /** Cached options used for the most recent spawn — reused when respawning
   *  after a crash. Never null once the first spawn has been attempted. */
  spawnOpts: PtyProcessOptions | null;
  /** Per-key serial lock. The promise resolves once the in-flight turn finishes. */
  lock: Promise<void>;
  /** Last time `runOnPty` was called against this key. Drives LRU eviction
   *  when `pty.maxConcurrent` is hit. Adhoc-only — named agents are exempt. */
  lastAccessedAt: number;
}

interface SupervisorState {
  ptys: Map<string, PtyEntry>;
  reapTimer: ReturnType<typeof setInterval> | null;
  initialised: boolean;
}

const state: SupervisorState = {
  ptys: new Map(),
  reapTimer: null,
  initialised: false,
};

/**
 * Phase D fix #3 (Codex review HIGH #3): cache the in-flight init promise so
 * concurrent first-callers don't double-init the reaper. Cleared by
 * `__resetSupervisorForTests` and by `shutdownSupervisor`.
 */
let _initPromise: Promise<void> | null = null;

/**
 * Idempotently start the supervisor (reaper interval). Called lazily from
 * `runOnPty` so the daemon runtime — which goes directly through `runOnPty`,
 * never through `initSupervisor` — picks up `settings.pty.idleReapMinutes`.
 *
 * Race-safe: concurrent first-callers await the same in-flight promise. The
 * underlying `initSupervisor` is itself idempotent (it clears + rebuilds the
 * reap timer), so a fresh call after `__resetSupervisorForTests` re-installs
 * the timer cleanly.
 */
async function ensureSupervisorInitialised(): Promise<void> {
  if (state.initialised) return;
  if (_initPromise) {
    await _initPromise;
    return;
  }
  _initPromise = initSupervisor().finally(() => {
    _initPromise = null;
  });
  await _initPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API.

/**
 * Initialise the supervisor at daemon startup. Idempotent.
 * Lazy-spawn strategy: named-agent PTYs spawn on first event, not here.
 *
 * In practice the daemon runtime never calls this directly — it's invoked
 * lazily by `runOnPty` via `ensureSupervisorInitialised()` so the reap
 * interval reliably starts on first PTY use. See Phase D fix #3.
 */
export async function initSupervisor(): Promise<void> {
  const settings = getSettings();
  const opts: SupervisorOptions = {
    idleReapMinutes: settings.pty.idleReapMinutes,
    maxRetries: settings.pty.maxRetries,
    backoffMs: settings.pty.backoffMs,
    namedAgentsAlwaysAlive: settings.pty.namedAgentsAlwaysAlive,
  };

  // Reap interval — rebuild on re-init (in case idleReapMinutes changed).
  if (state.reapTimer) {
    clearInterval(state.reapTimer);
    state.reapTimer = null;
  }
  // Tick once a minute; reaper itself decides what's stale.
  state.reapTimer = setInterval(() => {
    void reapIdle(opts).catch(() => {
      // Reap errors are swallowed — they're best-effort housekeeping.
    });
  }, 60_000);
  // Don't keep the daemon alive solely because of the reaper.
  if (typeof (state.reapTimer as { unref?: () => void }).unref === "function") {
    (state.reapTimer as { unref: () => void }).unref();
  }

  state.initialised = true;
}

/**
 * Graceful shutdown. Disposes all live PTYs.
 */
export async function shutdownSupervisor(): Promise<void> {
  if (state.reapTimer) {
    clearInterval(state.reapTimer);
    state.reapTimer = null;
  }
  const disposals: Promise<void>[] = [];
  for (const entry of state.ptys.values()) {
    if (entry.pty) {
      disposals.push(
        entry.pty.dispose().catch(() => {
          // Best-effort.
        }),
      );
    }
  }
  await Promise.allSettled(disposals);
  state.ptys.clear();
  state.initialised = false;
  _initPromise = null;
}

/**
 * Phase D fix #4: dispose every live PTY managed by the supervisor.
 *
 * Called from `runner.ts:killActive()` so that `/kill` reaches PTY-mode
 * sessions. Tradeoff:
 *   - Destroying a PTY mid-turn surfaces `PtyClosedError` to the in-flight
 *     `runOnPty` caller (the supervisor's per-key serial lock guarantees the
 *     promise has a resolver). execClaude then propagates the failure to the
 *     user just like a `/kill` against the legacy `Bun.spawn` path does today.
 *   - The PTY is gone — the conversation session ID survives on disk (Claude
 *     Code keeps the JSONL), so the next event for the same `sessionKey`
 *     re-spawns and `--resume`s. Conversation context is preserved; the
 *     in-flight turn alone is aborted.
 *   - Named agents are NOT exempt here. `/kill` is an explicit operator
 *     command and should resolve a stuck named-agent PTY just as it does a
 *     stuck ad-hoc thread. The auditor's argument (FA-6a) is the load-bearing
 *     one: silent no-op `/kill` is worse than session loss when an agent is
 *     genuinely wedged.
 *
 * Returns the number of PTYs that were disposed. Best-effort: errors from
 * `dispose()` are swallowed.
 */
export async function killAllPtys(): Promise<number> {
  const entries = [...state.ptys.values()];
  if (entries.length === 0) return 0;
  let killed = 0;
  const disposals: Promise<void>[] = [];
  for (const entry of entries) {
    if (entry.pty) {
      killed += 1;
      disposals.push(
        entry.pty.dispose().catch(() => {
          // best-effort
        }),
      );
    }
    state.ptys.delete(entry.sessionKey);
  }
  await Promise.allSettled(disposals);
  return killed;
}

/**
 * Snapshot of supervisor state for /status and tests.
 * Order-stable: sorted by sessionKey.
 */
export function snapshotSupervisor(): SupervisorSnapshot {
  const keys = [...state.ptys.keys()].sort();
  const ptys: SupervisorSnapshot["ptys"] = [];
  for (const key of keys) {
    const entry = state.ptys.get(key)!;
    if (!entry.pty) continue;
    ptys.push({
      sessionKey: entry.sessionKey,
      label: entry.pty.label,
      pid: entry.pty.pid,
      sessionId: entry.pty.sessionId,
      cwd: entry.pty.cwd,
      isAlive: entry.pty.isAlive(),
      lastTurnEndedAt: entry.pty.lastTurnEndedAt(),
      kind: entry.kind,
    });
  }
  return { ptys };
}

/**
 * Run a single turn on the PTY associated with `sessionKey`.
 * See SPEC §3.2 for the contract.
 *
 * Phase D additions:
 *   - `securityArgs`: pre-built argv from runner.ts:buildSecurityArgs(), so
 *     the supervisor honours the operator's permissionMode + locked-mode
 *     Write tool. Without this, every PTY spawn unconditionally bypassed
 *     permissions via `--dangerously-skip-permissions`.
 *   - `appendSystemPrompt`: the assembled `--append-system-prompt` payload
 *     (CLAUDE.md + MEMORY.md + agent identity + dir-scope guard). Without
 *     this, named agents lose their identity and memory under PTY mode.
 */
export async function runOnPty(
  sessionKey: string,
  prompt: string,
  opts: {
    timeoutMs: number;
    threadId?: string;
    agentName?: string;
    modelOverride?: string;
    /** Codex Phase D #1: resolved auth token from settings/agentic routing/job
     *  override. The supervisor passes this to `buildChildEnv` so the PTY's
     *  env carries `ANTHROPIC_AUTH_TOKEN` and the GLM/Kimi base-URL shims
     *  identical to the legacy `claude -p` path. */
    api?: string;
    /** Phase D fix #3: pre-built security argv from runner.ts:buildSecurityArgs. */
    securityArgs?: string[];
    /** Phase D fix #2: assembled --append-system-prompt payload. */
    appendSystemPrompt?: string;
    onChunk?: (text: string) => void;
    onToolEvent?: (line: string) => void;
  },
): Promise<RunOnPtyResult> {
  // Phase D fix #3 (Codex HIGH #3): lazily start the reaper interval. The
  // daemon runtime enters PTY mode through `runOnPty` directly and never
  // calls `initSupervisor`, so without this `settings.pty.idleReapMinutes`
  // would be ignored in production.
  await ensureSupervisorInitialised();

  const supervisorOpts = readSupervisorOptions();

  // Phase D fix #5: enforce maxConcurrent cap with LRU eviction BEFORE
  // allocating a new entry. Named agents are exempt — they're always-alive
  // by design.
  await enforceMaxConcurrent(sessionKey);

  // Per-key serial lock. Different keys proceed in parallel.
  const entry = await getOrCreateEntry(sessionKey, opts);
  entry.lastAccessedAt = _clock();
  const previousLock = entry.lock;
  let release: () => void = () => {};
  entry.lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previousLock;
    return await runTurnWithRetries(entry, prompt, opts, supervisorOpts);
  } finally {
    release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals.

function readSupervisorOptions(): SupervisorOptions {
  const settings = getSettings();
  return {
    idleReapMinutes: settings.pty.idleReapMinutes,
    maxRetries: _maxRetriesOverride != null
      ? _maxRetriesOverride
      : settings.pty.maxRetries,
    backoffMs: settings.pty.backoffMs,
    namedAgentsAlwaysAlive: settings.pty.namedAgentsAlwaysAlive,
  };
}

function classifyKey(
  sessionKey: string,
  threadId?: string,
  agentName?: string,
): SessionKind {
  // Match the conventions in SPEC §3.2 + §5.2.
  if (sessionKey.startsWith("thread:") || threadId) return "adhoc";
  if (sessionKey.startsWith("agent:") || agentName) return "named";
  return "global";
}

async function getOrCreateEntry(
  sessionKey: string,
  opts: {
    threadId?: string;
    agentName?: string;
    modelOverride?: string;
  },
): Promise<PtyEntry> {
  const existing = state.ptys.get(sessionKey);
  if (existing) return existing;

  const kind = classifyKey(sessionKey, opts.threadId, opts.agentName);
  const entry: PtyEntry = {
    sessionKey,
    kind,
    threadId: opts.threadId,
    agentName: opts.agentName,
    pty: null,
    spawnOpts: null,
    lock: Promise.resolve(),
    lastAccessedAt: _clock(),
  };
  state.ptys.set(sessionKey, entry);
  return entry;
}

/** Test-only override for the maxConcurrent cap. When non-null, takes
 *  precedence over `settings.pty.maxConcurrent`. Cleared by
 *  __resetSupervisorForTests. */
let _maxConcurrentOverride: number | null = null;
/** Test-only override for maxRetries. */
let _maxRetriesOverride: number | null = null;

/** For tests only. Override the maxConcurrent cap without writing to disk. */
export function injectMaxConcurrentForTests(cap: number | null): void {
  _maxConcurrentOverride = cap;
}

/** For tests only. Override maxRetries without writing to disk. */
export function injectMaxRetriesForTests(n: number | null): void {
  _maxRetriesOverride = n;
}

/**
 * Phase D fix #5 (FA-3a): cap the number of concurrent live PTYs to
 * `settings.pty.maxConcurrent`. When the cap is hit, evict the
 * least-recently-accessed AD-HOC PTY (named agents are exempt — they're
 * marked `namedAgentsAlwaysAlive` by design). The evicted PTY is disposed
 * and its entry removed from the state map.
 *
 * If the cap is hit but EVERY entry is exempt (all named agents) or the
 * incoming key is for a named agent that doesn't yet exist, we let it through
 * — the operator's named-agent slate is the source of truth and shouldn't be
 * silently shrunk by a thread burst.
 */
async function enforceMaxConcurrent(incomingKey: string): Promise<void> {
  let cap: number;
  if (_maxConcurrentOverride != null) {
    cap = _maxConcurrentOverride;
  } else {
    cap = getSettings().pty.maxConcurrent;
  }
  if (!Number.isFinite(cap) || cap <= 0) return; // disabled
  if (state.ptys.has(incomingKey)) return; // existing key, no new allocation
  if (state.ptys.size < cap) return; // headroom available

  // Find LRU candidate among adhoc entries (skip named + global).
  let lruEntry: PtyEntry | null = null;
  for (const entry of state.ptys.values()) {
    if (entry.kind !== "adhoc") continue;
    if (!lruEntry || entry.lastAccessedAt < lruEntry.lastAccessedAt) {
      lruEntry = entry;
    }
  }

  if (!lruEntry) {
    // Nothing evictable — let the new spawn proceed (operator-configured
    // named agents are sacrosanct). The state.ptys.size will temporarily
    // exceed cap; the next idle-reap pass will catch up if any entry
    // becomes idle.
    return;
  }

  // Dispose and remove. Errors are best-effort.
  if (lruEntry.pty) {
    try {
      await lruEntry.pty.dispose();
    } catch {
      // ignore
    }
  }
  state.ptys.delete(lruEntry.sessionKey);
}

async function buildSpawnOptions(
  entry: PtyEntry,
  modelOverride: string | undefined,
  api: string | undefined,
  securityArgs: string[] | undefined,
  appendSystemPrompt: string | undefined,
): Promise<PtyProcessOptions> {
  const settings = getSettings();
  const { security } = settings;

  // Resolve cwd:
  //   - agent  → agents/<name> (created if needed)
  //   - thread → repo root (process.cwd())
  //   - global → repo root
  const cwd = entry.agentName
    ? await ensureAgentDirLazy(entry.agentName)
    : process.cwd();

  // Resume from stored session ID where available.
  let sessionId = "";
  if (entry.threadId) {
    const t = await getThreadSession(entry.threadId);
    sessionId = t?.sessionId ?? "";
  } else if (entry.agentName) {
    const a = await getSession(entry.agentName);
    sessionId = a?.sessionId ?? "";
  } else {
    const g = await getSession();
    sessionId = g?.sessionId ?? "";
  }

  // Phase D fix (Codex HIGH #2): no stored session ID for this key. Pre-allocate
  // a deterministic UUID and pass it via `--session-id` so the conversation
  // survives daemon restart / idle reap / `/kill` / crash. Without this, fresh
  // PTY conversations only live in the long-lived process — subsequent turns
  // would start a brand-new Claude Code session every time.
  //
  // The supervisor persists this UUID to disk immediately after spawn (see
  // `spawnEntry`), not on first-turn completion, so a daemon that dies between
  // spawn and the first response still recovers the same conversation on
  // restart.
  let newSessionId: string | undefined;
  if (!sessionId) {
    newSessionId = _newSessionId();
  }

  // Phase D fix #1: canonical env-sanitiser from runner.ts. Don't reinvent
  // the strip list — divergence here re-introduces the ANTHROPIC_API_KEY
  // billing leak.
  //
  // Phase D fix #3: derive securityArgs from runner.ts:buildSecurityArgs
  // when the caller didn't pre-build them (e.g. legacy tests). The supervisor
  // is otherwise allowed to pass through whatever the caller assembled.
  //
  // Codex Phase D #1: build the child env with the same `buildChildEnv` the
  // legacy path uses so ANTHROPIC_AUTH_TOKEN and the GLM/Kimi base-URL shims
  // are applied to PTY spawns. Without this, the PTY path always inherited
  // the daemon's raw env regardless of the resolved model/provider.
  const runnerHelpers = await getRunnerHelpers();
  const cleanEnv = runnerHelpers.cleanSpawnEnv();
  const childEnv = runnerHelpers.buildChildEnv(
    cleanEnv,
    modelOverride ?? "",
    api ?? "",
  );

  let resolvedSecurityArgs = securityArgs;
  if (!resolvedSecurityArgs) {
    try {
      resolvedSecurityArgs = runnerHelpers.buildSecurityArgs(security);
    } catch {
      // Fall through — buildClaudeArgs will use its internal legacy
      // derivation when securityArgs is undefined.
      resolvedSecurityArgs = undefined;
    }
  }

  return {
    sessionId,
    newSessionId,
    cwd,
    agentName: entry.agentName,
    modelOverride: modelOverride ?? undefined,
    security: cloneSecurity(security),
    securityArgs: resolvedSecurityArgs,
    appendSystemPrompt,
    env: childEnv,
    cols: settings.pty.cols,
    rows: settings.pty.rows,
    turnIdleTimeoutMs: settings.pty.turnIdleTimeoutMs,
  };
}

function cloneSecurity(security: SecurityConfig): SecurityConfig {
  return {
    level: security.level,
    allowedTools: [...security.allowedTools],
    disallowedTools: [...security.disallowedTools],
  };
}

// Note: the supervisor consumes runner.ts's `cleanSpawnEnv` via the lazy
// import in `getCleanSpawnEnv()`. The old local copy was deleted in Phase D
// because it diverged from the canonical strip list (missing
// `ANTHROPIC_API_KEY`), which silently re-introduced API-credit billing on
// every PTY spawn. Don't add a local copy — always go through
// `getCleanSpawnEnv()`.

async function ensureSpawnPty(): Promise<SpawnPty> {
  if (_spawnPty) return _spawnPty;
  // Lazy real import. In Phase C, this resolves to engineer-pty-core's
  // pty-process.ts implementation. In Phase B (this worktree), the file
  // doesn't exist yet — but every test path injects a fake via
  // injectSpawnPty() before calling runOnPty, so this branch is never
  // taken in tests. If it IS taken at runtime without the real module
  // present, we throw a clear error.
  try {
    // The string is constructed to avoid bundler resolution at build time.
    // Phase C ships ./pty-process.ts in the merged worktree and this works.
    const moduleSpecifier = "./pty-process";
    const mod = (await import(moduleSpecifier)) as { spawnPty?: SpawnPty };
    if (mod.spawnPty) {
      _spawnPty = mod.spawnPty;
      return mod.spawnPty;
    }
    throw new Error("module loaded but spawnPty not exported");
  } catch (err) {
    throw new Error(
      `[pty-supervisor] spawnPty implementation not available. ` +
        `In tests, call injectSpawnPty() before any runOnPty. ` +
        `At runtime, engineer-pty-core's pty-process.ts must be present. ` +
        `Cause: ${(err as Error).message}`,
    );
  }
}

async function spawnEntry(
  entry: PtyEntry,
  modelOverride: string | undefined,
  api: string | undefined,
  securityArgs: string[] | undefined,
  appendSystemPrompt: string | undefined,
): Promise<void> {
  const spawn = await ensureSpawnPty();
  const spawnOpts = await buildSpawnOptions(
    entry,
    modelOverride,
    api,
    securityArgs,
    appendSystemPrompt,
  );
  entry.spawnOpts = spawnOpts;
  entry.pty = await spawn(spawnOpts);

  // Phase D fix (Codex HIGH #2): persist a freshly pre-allocated session ID
  // to disk immediately after spawn — not on first-turn completion. If the
  // daemon dies between spawn and the first response (idle reap, /kill,
  // crash, restart), the conversation is still resumable via --resume <id>
  // on next message for the same sessionKey.
  if (spawnOpts.newSessionId) {
    try {
      await persistSessionId(entry, spawnOpts.newSessionId);
    } catch {
      // Best-effort. If the on-disk write fails (filesystem error), the live
      // PTY still has the UUID in its own state; persistence will be retried
      // on the first runTurn completion via the existing post-turn path.
    }
  }
}

async function respawnEntry(entry: PtyEntry): Promise<void> {
  if (!entry.spawnOpts) {
    throw new Error(`[pty-supervisor] cannot respawn ${entry.sessionKey} — no cached spawn options`);
  }
  // Always resume against the last-known session ID — Claude Code keeps the
  // JSONL on disk after a crash, so --resume <id> picks up where we left off.
  const lastSessionId = entry.pty?.sessionId ?? entry.spawnOpts.sessionId;
  const opts: PtyProcessOptions = {
    ...entry.spawnOpts,
    sessionId: lastSessionId ?? "",
  };
  const spawn = await ensureSpawnPty();
  // Best-effort dispose of the dead one (may already be exited).
  if (entry.pty) {
    try {
      await entry.pty.dispose();
    } catch {
      // ignore
    }
  }
  entry.pty = null;
  entry.pty = await spawn(opts);
  entry.spawnOpts = opts;
}

async function runTurnWithRetries(
  entry: PtyEntry,
  prompt: string,
  callOpts: {
    timeoutMs: number;
    threadId?: string;
    agentName?: string;
    modelOverride?: string;
    api?: string;
    securityArgs?: string[];
    appendSystemPrompt?: string;
    onChunk?: (text: string) => void;
    onToolEvent?: (line: string) => void;
  },
  supervisorOpts: SupervisorOptions,
): Promise<RunOnPtyResult> {
  // Lazy spawn on first turn for this key.
  if (!entry.pty) {
    try {
      await spawnEntry(
        entry,
        callOpts.modelOverride,
        callOpts.api,
        callOpts.securityArgs,
        callOpts.appendSystemPrompt,
      );
    } catch (err) {
      return errorResult(
        `[pty-supervisor] failed to spawn PTY for ${entry.sessionKey}: ${(err as Error).message}`,
      );
    }
  }

  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt <= supervisorOpts.maxRetries) {
    if (!entry.pty) {
      return errorResult(
        `[pty-supervisor] PTY for ${entry.sessionKey} unexpectedly null after spawn`,
      );
    }
    try {
      const result = await entry.pty.runTurn(prompt, {
        timeoutMs: callOpts.timeoutMs,
        onChunk: callOpts.onChunk,
        onToolEvent: callOpts.onToolEvent,
      });
      // Persist session ID if newly captured.
      await persistSessionId(entry, result.sessionId);
      return {
        rawStdout: result.text,
        stderr: "",
        exitCode: 0,
        sessionId: result.sessionId || undefined,
      };
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof PtyClosedError || err instanceof PtyTurnTimeoutError;
      if (!retryable) {
        return errorResult(
          `[pty-supervisor] non-retryable error on ${entry.sessionKey}: ${(err as Error).message}`,
        );
      }
      // Exhausted?
      if (attempt >= supervisorOpts.maxRetries) break;

      const delay = pickBackoff(supervisorOpts.backoffMs, attempt);
      attempt += 1;
      await _sleep(delay);
      try {
        await respawnEntry(entry);
      } catch (respawnErr) {
        return errorResult(
          `[pty-supervisor] respawn failed for ${entry.sessionKey} after ${attempt} attempt(s): ${(respawnErr as Error).message}`,
        );
      }
    }
  }

  return errorResult(
    `[pty-supervisor] max retries (${supervisorOpts.maxRetries}) exhausted for ${entry.sessionKey}: ${(lastErr as Error)?.message ?? "unknown"}`,
  );
}

function pickBackoff(backoffMs: number[], attempt: number): number {
  if (backoffMs.length === 0) return 0;
  const idx = Math.min(attempt, backoffMs.length - 1);
  return Math.max(0, backoffMs[idx] ?? 0);
}

function errorResult(message: string): RunOnPtyResult {
  return {
    rawStdout: "",
    stderr: message,
    exitCode: 1,
    sessionId: undefined,
  };
}

async function persistSessionId(entry: PtyEntry, sessionId: string): Promise<void> {
  if (!sessionId) return;
  // Did we already know this ID? Then nothing to do.
  if (entry.spawnOpts?.sessionId && entry.spawnOpts.sessionId === sessionId) {
    return;
  }
  // First-time capture — write to the right store and update our cached opts.
  if (entry.threadId) {
    const existing = await getThreadSession(entry.threadId);
    if (!existing) {
      await createThreadSession(entry.threadId, sessionId);
    }
  } else {
    const existing = await getSession(entry.agentName);
    if (!existing) {
      await createSession(sessionId, entry.agentName);
    }
  }
  if (entry.spawnOpts) {
    entry.spawnOpts = { ...entry.spawnOpts, sessionId };
  }
}

async function reapIdle(opts: SupervisorOptions): Promise<void> {
  const cutoff = _clock() - opts.idleReapMinutes * 60_000;
  const toReap: PtyEntry[] = [];
  for (const entry of state.ptys.values()) {
    if (!entry.pty) continue;
    // Named agents stay alive forever when the flag is on.
    if (entry.kind === "named" && opts.namedAgentsAlwaysAlive) continue;
    const last = entry.pty.lastTurnEndedAt();
    // A PTY that has never finished a turn is mid-spawn — leave it alone.
    if (last === 0) continue;
    if (last < cutoff) toReap.push(entry);
  }
  for (const entry of toReap) {
    if (entry.pty) {
      try {
        await entry.pty.dispose();
      } catch {
        // ignore
      }
    }
    state.ptys.delete(entry.sessionKey);
  }
}
