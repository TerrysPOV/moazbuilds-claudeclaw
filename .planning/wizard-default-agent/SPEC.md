# SPEC — Fresh install must declare a default bus agent (#196)

**Issue:** TerrysPOV/ClaudeClaw-Plus#196 — cause #1 of the 3-cause fresh-install
breakage tracked in #193. (#195 fixed cause #3, the bypass-permissions dialog;
#197 tracks cause #2, the Telegram `busRouting` mount gap.)

## 1. Problem statement

On a fresh install the daemon writes a default `settings.json` whose `runtime`
is `"bus"` but whose `agents` list is **empty**. The bus runtime then mounts
with zero agents — the startup banner reads `no agents declared` — so nothing
is ever spawned to answer on any channel. Every surface looks healthy (daemon
up, web UI listening, channels polling), which is why the failure is hard to
spot: there is simply no agent behind the bus.

The empty default was correct when `runtime` defaulted to `"pty"`. The
`runtime` default flipped to `"bus"` on 2026-05-25 (Sprint 5.4), but the
`agents: []` default did not follow — leaving the shipped default config
internally inconsistent: a runtime that requires ≥1 agent, paired with zero
agents.

## 2. Current behaviour (as-is)

- `src/config.ts:222` — `DEFAULT_SETTINGS.runtime = "bus"`.
- `src/config.ts:225` — `DEFAULT_SETTINGS.agents = []` (comment at 223-224 still
  says "Default no agents … opt in to bus … declare explicitly" — stale).
- `src/config.ts:709-717` — `initConfig()` writes `DEFAULT_SETTINGS` verbatim to
  `<cwd>/.claude/claudeclaw/settings.json` **only when the file does not yet
  exist** (fresh install).
- `src/config.ts:972` — `parseSettings` builds `agents` from
  `parseBusAgents(raw.agents)`; `parseBusAgents(undefined)` returns `[]`
  (config.ts:1061-1062). It never falls back to `DEFAULT_SETTINGS.agents`.
- `src/commands/start.ts:472-543, 613-626` — when `runtime === "bus"`,
  `resolveBusAgentConfigs(settings.agents, …)` runs and the banner reports
  `settings.agents.length === 0 ? "no agents declared" : …`.

Net: fresh `settings.json` → `agents: []` → bus mounts, spawns nothing.

## 3. Target behaviour (to-be)

- A fresh `initConfig()` writes `settings.json` with exactly one declared agent:
  `agents: [{ "id": "default" }]`.
- On boot the bus resolves that single entry (cwd ← `process.cwd()`,
  `permission_mode` ← `"bypassPermissions"`, `supervision` ← `"pty-stdin"`,
  session_id created on demand — see `agent-resolver.ts:62-80, 116-122`; no
  pre-existing `agents/default/` dir required) and spawns one `claude`. The
  banner reads `1 agent(s) declared`, not `no agents declared`.
- Existing installs are unchanged: a `settings.json` that omits `agents`, or
  sets `agents: []` explicitly, still parses to `[]` (the parse path is
  untouched). The "empty list = operator wires agents later" escape hatch
  remains valid for anyone who has set it deliberately.

## 4. Architecture decisions (frozen)

- **Fix the default, not the parser.** Change `DEFAULT_SETTINGS.agents` to
  `[{ id: "default" }]`. Because `parseSettings` reads `raw.agents` directly and
  `parseBusAgents` never consults `DEFAULT_SETTINGS.agents`, this changes only
  what `initConfig` writes to a brand-new file — it does **not** retroactively
  inject an agent into existing installs or override an explicit `agents: []`.
  Rationale: scopes the behaviour change to the exact case the issue names
  (fresh `/start` on a clean project) and preserves the deliberate "wire later"
  semantics for existing operators.
- **Agent id `"default"`.** Matches `AGENT_ID_PATTERN`
  (`/^[a-z0-9][a-z0-9_-]{0,35}$/`), is self-describing, and collides with
  nothing. Single-agent is the common case the terse-defaults design targets
  (config.ts:586-587).
- **No new wizard prompt / no interactive step.** The issue frames this as "the
  wizard must write agents[]"; the daemon's first-run config writer
  (`initConfig`) *is* that write path. Adding an interactive question is out of
  scope and heavier than the defect warrants.
- **Update the stale comments** at config.ts:223-224 and the `Settings.agents`
  docstring (config.ts:642-646) so they describe the bus-default + one-agent
  coherence instead of "default no agents".

## 5. Key file references

- `src/config.ts:222-225` — `DEFAULT_SETTINGS.runtime`/`.agents` (the change).
- `src/config.ts:642-646` — `Settings.agents` docstring (comment update).
- `src/config.ts:709-717` — `initConfig()` fresh-write path (unchanged logic;
  now emits the default agent).
- `src/config.ts:1061-1126` — `parseBusAgents` (unchanged; confirms no leak to
  existing installs).
- `src/bus/agent-resolver.ts:62-122` — resolves a bare `{id}` entry; creates the
  session dir on demand.
- `src/commands/start.ts:472-543, 613-626` — bus mount + `no agents declared`
  banner (verification surface).
- Tests: `src/__tests__/runtime-config.test.ts` (parse path — must stay green);
  new coverage for the fresh-`initConfig` write default.

## 6. Out of scope (deferred)

- Telegram `busRouting` mount gap — #197 (cause #2 of #193).
- Bypass-permissions dialog — #195 (cause #3, already merged).
- Auto-healing existing zero-agent installs (e.g. a startup warning or migration
  that injects a default agent when `runtime==="bus"` and `agents` is empty).
  Considered, deferred: it changes behaviour for operators who set `agents: []`
  on purpose; the startup banner already states `no agents declared`.
- Any interactive wizard question for naming/configuring the default agent.
