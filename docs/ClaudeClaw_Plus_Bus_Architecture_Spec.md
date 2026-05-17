# ClaudeClaw+ Bus Architecture — Engineering Spec

**Status:** Draft v2 — for community review
**Author:** Claude (POVIEW.AI engineering assist) — v1: 2 May 2026 — v2: 17 May 2026
**Target audience:** Coding agent / engineer implementing the refactor; ClaudeClaw+ maintainers and contributors
**Supersedes:** PTY stdin/stdout runner (`src/runner.ts` PTY codepath, `src/runner/pty-*.ts` helpers)

### What changed in v2

- **Sprint 0 de-risking spikes** added (§10.0): permission-prompt flow, JSONL schema snapshot, IPC primitive choice — must complete before Sprint 1.
- **tmux moved from required to optional** (§5.3): process supervision + stdio control is the default; tmux is an opt-in operator convenience on Unix only. Removes Windows friction (was Open Q §14.4).
- **IPC mechanism hardened** (§5.4, §14.3): explicit UDS path conventions, permission bits, atomic create pattern, and a localhost-TCP+token fallback when UDS / named pipes are not viable.
- **Plugin API migration formalised** (§11.7, §12.5 new): translation shim spec, deprecation timeline, plugin-author migration guide as a Sprint 4 deliverable.
- **Sprint estimate revised** (§10, §13): ~3 weeks full-time / ~8–10 weeks at part-time cadence (was 5 sprints/5 weeks part-time — under-estimated Sprint 3 reality).
- **Empirical motivation** added (§2): three PTY-parser regressions in two months (issues #81, #84, #105), with #105 explicitly traceable to TUI markdown-code-fence rendering — the structural class the Bus eliminates.

---

## 1. Summary

Replace ClaudeClaw+'s default runtime — PTY stdin-write / stdout-parse — with a Plus-internal **Bus** that wraps two supported Claude Code primitives:

| Direction | Mechanism | What it replaces |
|---|---|---|
| **Write** (Plus → Claude) | Channels MCP notifications (`notifications/claude/channel`) | `pty.write(prompt + "\r")` |
| **Read** (Claude → Plus) | Live tail of Claude Code's session JSONL log + structured event stream | Sentinel-echo TUI parser |

This single Bus then feeds all external surfaces — Discord, Telegram, Slack, Web UI, REST/CLI — through a uniform internal API. The PTY runner is **retained behind a config flag (`runtime: pty`)** as a deprecated fallback path; the default for fresh installs is `runtime: bus`. A schema-compatibility test harness runs at startup and on `claude` version changes to detect Anthropic-side schema drift without requiring Plus to pin a `claude` version.

## 2. Why

The PTY runner has two structural risks that are unfixable in its current shape:

1. **TUI-rendering breakage risk.** Anthropic can change the interactive `claude` TUI at any time. The Bus architecture has zero dependence on TUI byte-level output.
2. **PTY scraping is the part of Plus that critics point at first.** Even if it's not a Consumer Terms §3 violation (see compliance proposal §1.6), it's the surface that invites the question. The Bus uses Anthropic-published structured primitives (Channels MCP + JSONL log), neither of which can be characterised as "scraping a human-facing UI."

### 2.1 Empirical evidence — three PTY-parser regressions in two months

The TUI-rendering risk is not theoretical. Between March and May 2026 the project shipped three sentinel-echo parser fixes, each addressing a distinct class of TUI rendering that the parser had previously handled correctly:

| Issue | Symptom | Root cause | Resolution |
|---|---|---|---|
| [#81](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/81) | Turn-boundary detection failing on `claude` 2.1.89 | OSC sequence emission semantics changed | Sentinel-echo parser rewrite ([#82](https://github.com/TerrysPOV/ClaudeClaw-Plus/pull/82)) |
| [#84](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/84) | `_waitForReadySettle` returning before TUI paint completed | Repaint timing race | Settle-detection retune ([#85](https://github.com/TerrysPOV/ClaudeClaw-Plus/pull/85)) |
| [#105](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/105) | DM-mode model output captured as `*\n↓\n1` glyphs | TUI rendering of markdown code-fence backticks produced framed code box; parser extracted box chrome instead of textual content | **Open** — band-aid in PTY mode (constrain assistant output to plain prose); structural fix is this Bus migration |

The #105 case is the cleanest demonstration. The model's actual assistant message in the canonical JSONL was:

```
Saved to `/home/claw/project/example-com-screenshot.png`
```

What the operator received through Discord was three control glyphs and three runs of blank lines. The tool call succeeded, the file was written, the session was healthy — only the user-visible reply was corrupted, and only because the PTY parser was looking at terminal output instead of the structured JSONL event the model already emitted.

Under the Bus runtime, #105 is impossible to reproduce: the JSONL tailer reads `message.content[].text` directly. There is no rendering layer between the model and Plus.

### 2.2 Side benefit — Channels GA path

When Anthropic GA's the Channels feature (and allowlists community channel plugins), the Bus's Discord/Telegram adapters can swap to Anthropic's official channel plugins as a configuration change rather than a rewrite. The Bus core, JSONL tailer, and Slack/Web UI adapters are unaffected. See §9.

## 3. Design principles

1. **One Bus, many surfaces.** All Plus surfaces (Discord, Telegram, Slack, Web UI, REST/CLI) talk to one internal API. No surface ever talks directly to `claude`.
2. **Two primitives only.** Channels notifications (write) and JSONL tail (read). Anything that can't be expressed in those two primitives doesn't exist in this architecture.
3. **One `claude` process per Plus agent.** Matches the §1.6 Pattern A migration target. Each agent has its own session, JSONL log, system prompt, working directory, and channel plugin instance.
4. **No PTY in the Bus runtime.** The Bus runtime itself must not depend on terminal byte output. If a feature can't be served by structured JSONL events, it gets deprecated under `runtime: bus`. The PTY runtime is retained separately as a config-gated fallback (`runtime: pty`) and shares no code paths with the Bus runtime at execution time.
5. **Compatible with Channels GA.** The internal Channel plugin written for the Bus is structurally identical to Anthropic's official plugins (declares `experimental: { 'claude/channel': {} }`, sends `notifications/claude/channel`, exposes `reply` tool). When Anthropic GAs Channels, the Discord/Telegram surfaces can swap to the official plugins; the Bus continues to serve Slack and Web UI as a custom Channel.

## 4. High-level architecture

```
                    External Surfaces
    ┌───────────┬───────────┬─────────┬────────┬───────────┐
    │  Discord  │  Telegram │  Slack  │ Web UI │ REST/CLI  │
    └─────┬─────┴─────┬─────┴────┬────┴───┬────┴─────┬─────┘
          │           │          │        │          │
          └───────────┴──────────┴────────┴──────────┘
                              │
                              ▼
        ┌───────────────────────────────────────────────┐
        │                Plus Bus                       │
        │  ┌──────────────┐  ┌──────────────────────┐   │
        │  │ Prompt       │  │  Response broker     │   │
        │  │ router       │  │  + pub/sub event bus │   │
        │  └──────┬───────┘  └──────────┬───────────┘   │
        │         │                     │               │
        │  ┌──────▼────────┐    ┌──────▼─────────┐      │
        │  │ Bus MCP       │    │ JSONL tailer   │      │
        │  │ (channels svr)│    │ pool           │      │
        │  └──────┬────────┘    └──────┬─────────┘      │
        └─────────│────────────────────│────────────────┘
                  │                    │
                  │   ┌────────────────┘
                  │   │
            ┌─────▼───▼──────┐    ┌────────────────────┐
            │ claude (agent  │    │ ~/.claude/projects/│
            │   #1) — tmux   │    │  <enc-cwd>/        │
            │ --channels     │    │  <session-id>.jsonl│
            │ plus-bus@local │    └────────────────────┘
            └────────────────┘             ▲
                  │                        │
                  └─ writes ───────────────┘

            ┌────────────────┐
            │ claude (agent  │     (one process per Plus agent)
            │   #2) — tmux   │
            │ --channels     │
            │ plus-bus@local │
            └────────────────┘
```

Key points from the diagram:

- **External surfaces are stateless adapters.** Discord adapter speaks Discord; it does not know what `claude` is. It calls `bus.send_prompt(agent, user, text)` and subscribes to `bus.events(agent, session)`.
- **The Bus has two MCP-shaped components.** The Bus MCP (write path) is loaded by `claude` as a channel plugin. The JSONL tailer (read path) runs as a Plus-internal worker.
- **One `claude` process per agent.** Each process is wrapped in a tmux pane (for `/compact`, `/clear`, restart-on-crash). Each process loads the same Bus MCP plugin but identifies itself by `agent_id` in the plugin handshake.

## 5. Component specifications

### 5.1 Plus Bus MCP Server (`src/bus/mcp-server.ts`)

**Role:** Acts as a Claude Code Channel. Receives prompt events from the Plus Bus core and pushes them into the connected `claude` session via `notifications/claude/channel`. Exposes tools that Claude can call to reply or stream intermediate output back.

**MCP capability declaration:**
```js
capabilities: {
  experimental: {
    'claude/channel': {},
    'claude/channel/permission': {}   // optional, for permission prompts
  }
}
```

**Initialisation handshake:**
- The plugin reads a per-invocation env var `CCAW_AGENT_ID` (set by Session Manager when spawning `claude`).
- On `initialize` from Claude Code, the server registers itself with the Plus Bus core (over Unix domain socket at `~/.claudeclaw/bus.sock` or named pipe on Windows), tagged with `agent_id`.

**Inbound (from Plus Bus core → Claude session):**
- The Bus core sends a prompt to the MCP server via UDS: `{type: 'prompt', text, origin: 'discord|telegram|slack|webui|cli', origin_id, agent_id}`.
- The MCP server emits `notifications/claude/channel` with `params: {channel_id: 'plus-bus', payload: { text, metadata: { origin, origin_id } }}`.
- Claude Code receives the notification and treats it as a new turn in the conversation.

**Outbound (from Claude → Plus Bus core):**
- The MCP server exposes a `reply` tool with schema `{message: string, metadata?: { intent?: 'final' | 'progress' | 'tool_status' }}`.
- When Claude calls `reply`, the MCP server forwards to the Bus core: `{type: 'reply', text, agent_id, intent}`.
- (Optional) Exposes `request_human` for clarifying questions; `cancel` for graceful turn termination.

**Channel-side permission prompts:**
- Use `notifications/claude/channel/permission` for permission requests that should surface to the operator (e.g. "Allow this tool call?"). The Bus core routes these to whichever surface is currently active for that agent.

### 5.2 JSONL Tailer (`src/bus/jsonl-tailer.ts`)

**Role:** Continuously tails each agent's session JSONL file and emits structured events on the Bus pub/sub topic for that agent.

**Inputs:**
- File path: `~/.claude/projects/<url-encoded-cwd>/<session-id>.jsonl`. Discovered via Session Manager (which knows each agent's cwd and session-id).
- One tailer goroutine/worker per agent.

**Implementation:**
- Use `fs.watchFile` (Node.js) or equivalent + a seek pointer per session. On new bytes: read, split on `\n`, JSON.parse each line, dispatch.
- On daemon restart: read from byte 0 to repopulate state; emit a `bus.events.replay_done` marker so subscribers can distinguish historical from live.

**JSONL line types to handle (these are Claude Code's session-log shapes — verify exact schema against current `claude` version):**
- `{type: 'user', message: {...}}` → emit `event: 'prompt'` (correlates with what Bus MCP just pushed in)
- `{type: 'assistant', message: {content: [...]}, usage: {...}}` → emit `event: 'response'`. Content blocks include text, tool_use, thinking. Split into sub-events: `event: 'response.text'`, `event: 'response.tool_use'`, `event: 'response.thinking'`.
- `{type: 'tool_result', tool_use_id, content}` → emit `event: 'tool_result'`.
- `{type: 'system', subtype: 'init'}` or similar bootstrap → emit `event: 'session.init'`.
- Any line containing `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens` → emit `event: 'usage'` and update the cache-hit dashboard.

**Emit format (single normalised schema):**
```ts
type BusEvent = {
  ts: number;            // ms since epoch
  agent_id: string;
  session_id: string;
  topic: 'prompt' | 'response.text' | 'response.tool_use' | 'response.thinking' | 'tool_result' | 'usage' | 'session.init' | 'session.end' | 'channel.permission';
  payload: any;          // topic-specific
  raw?: any;             // original JSONL line, for audit log
};
```

### 5.3 Session Manager (`src/bus/session-manager.ts`)

**Role:** Spawns and supervises one `claude` process per Plus agent.

**Supervision modes (operator-selectable):**

| Mode | Implementation | Platforms | Use case |
|---|---|---|---|
| `process` (default) | Direct `Bun.spawn` of `claude`; supervisor watches exit; stdin pipe held open for slash-command relay | macOS, Linux, Windows | Default for fresh installs; smallest dependency surface |
| `tmux` (opt-in) | Wraps `claude` in a detached tmux session; operator can `tmux attach` to inspect | macOS, Linux | Operators who want to attach into a running session for debugging or to issue commands by hand |

Default is `process`. tmux moves from required (v1 spec) to opt-in operator convenience because:
- tmux is friction on Windows (no first-class install path).
- Slash-command relay does **not** require tmux when the supervisor owns the stdin file descriptor — it can write the slash text and a newline directly.
- Bus runtime is supposed to be lightweight; binding it to tmux contradicts that goal.

**Per-agent spawn (default `process` mode):**
```ts
function spawnAgent(agent: AgentConfig): Promise<AgentProcess> {
  const args = [
    '--dangerously-load-development-channels', 'plugin:plus-bus@local',
    '--permission-mode', agent.permissionMode ?? 'plan',
    '--append-system-prompt', renderSystemPrompt(agent),
    '--mcp-config', agent.mcpConfigPath,
    '--session-id', agent.sessionId,   // stable across restarts
  ];
  const env = {
    ...sanitisedParentEnv(),           // cleanSpawnEnv equivalent for Bus runtime
    CCAW_AGENT_ID: agent.id,
    CCAW_BUS_SOCK: BUS_SOCK_PATH,
  };
  const proc = Bun.spawn(['claude', ...args], {
    cwd: agent.cwd,
    env,
    stdin: 'pipe',                     // for slash-command relay
    stdout: 'ignore',                  // we read JSONL, not stdout
    stderr: 'pipe',                    // for crash diagnostics
  });
  return { agentId: agent.id, proc, supervisor: makeSupervisor(proc) };
}
```

The `tmux` mode wraps the same `args` array under `tmux new-session -d -s claudeclaw-<agentId>` and uses `tmux send-keys` for slash commands. Selecting between modes is config: `bus.supervision: 'process' | 'tmux'`.

**Lifecycle (both modes):**
- `start()` — spawn all configured agents.
- `stop(agent_id)` — send `/quit` via stdin (`process` mode) or `send-keys` (`tmux` mode); wait for JSONL `session.end`; reap process / kill tmux session.
- `restart(agent_id)` — stop then start, preserve `session_id` for `--resume` continuity.
- `health()` — for each agent, check process alive + JSONL file is receiving updates within the heartbeat interval. Optional: detect "alive but JSONL stalled" as a degraded state.

**Slash command relay:**
- `process` mode: write `"/compact\n"` to the supervised process's stdin. Claude Code accepts slash commands on stdin in interactive sessions. Supported commands: `/compact`, `/clear`, `/model <name>`, `/quit`. This is the same control surface as aerolalit's reference implementation, just without the tmux indirection.
- `tmux` mode: keep the existing `tmux send-keys` path for operators who prefer it.
- Either way: **never used for prompts** — prompts flow through the Bus MCP `notifications/claude/channel` path. Slash commands are the only stdin / `send-keys` write.

### 5.4 Bus Core (`src/bus/core.ts`)

**Role:** In-process pub/sub broker that ties together: MCP server, JSONL tailer, all external adapters. Single source of truth for "which agent is connected to which Claude session" and "which surfaces care about which agent."

**Internal API (TypeScript, exposed via UDS to MCP server and via in-process imports to adapters):**

```ts
interface BusCore {
  // surface → Bus
  sendPrompt(req: {
    agent_id: string;
    origin: 'discord' | 'telegram' | 'slack' | 'webui' | 'cli' | 'cron' | 'heartbeat';
    origin_id: string;       // channel ID, chat ID, etc.
    user_id: string;         // allow-list checked here
    text: string;
    metadata?: Record<string, any>;
  }): Promise<{ promise_id: string }>;

  // surface ← Bus  (pub/sub)
  subscribe(filter: {
    agent_id?: string;
    topics?: BusEvent['topic'][];
    origin?: string;
  }, handler: (e: BusEvent) => void): Subscription;

  // surface → Bus, ops
  invokeSlashCommand(agent_id: string, cmd: '/compact' | '/clear' | '/quit' | string): Promise<void>;

  // Bus internal — called by MCP server when claude calls reply()
  ingestReply(req: { agent_id: string; text: string; intent: string }): void;

  // Bus internal — called by JSONL tailer
  ingestSessionEvent(e: BusEvent): void;

  // health / introspection
  state(): BusState;
}
```

**Concurrency model:**
- Single event loop. All ingest/dispatch is non-blocking.
- Backpressure: ringbuffer per subscriber (size N, drop-oldest with metric increment if exceeded).
- Audit log: every `BusEvent` written to append-only JSONL at `~/.claudeclaw/bus-audit.jsonl` (subset of the existing event log; integrates with Plus's current audit infrastructure).

**IPC transport (Bus core ↔ Bus MCP server):**

The Bus MCP runs inside the `claude` process (loaded as a plugin), so it is necessarily out-of-process from Bus core. Three transports, selected by capability detection in this order:

1. **Unix Domain Socket** (default on macOS, Linux). Path: `${XDG_RUNTIME_DIR:-$HOME/.claudeclaw/run}/bus-<agentId>.sock`.
   - **macOS path-length cap:** `sun_path` is 104 bytes. The default path stays well under it; if the operator overrides `XDG_RUNTIME_DIR` to something long, validate at startup and fail fast with a clear error.
   - **Permission bits:** `0600`, owner-only. Daemon and MCP server run as the same user (this is a requirement, not optional).
   - **Atomic create:** create-temporary-then-rename pattern to avoid races where the MCP server connects before the daemon has bound + chmod'd. Bind to `<path>.tmp`, chmod, then `rename` → `<path>`.
   - **Cleanup on exit:** SIGTERM handler unlinks the socket; orphaned sockets from crashed daemons are unlinked on next start after a `connect()` probe confirms no listener.

2. **Windows named pipe** (default on Windows). Path: `\\.\pipe\claudeclaw-bus-<agentId>`.
   - Use Bun's `node:net` named-pipe support via `net.createServer({ allowHalfOpen: false })` listening on the pipe path.
   - Security descriptor: restrict to the current user SID. Bun exposes this via the underlying libuv flags; if not exposed in current Bun version, document the limitation and fall back to transport #3.

3. **Localhost TCP + token** (fallback). When UDS / named pipe are unavailable or known-broken in the current runtime:
   - Bus core binds to `127.0.0.1:<random-ephemeral-port>`.
   - Generates a 32-byte random token, writes it to `~/.claudeclaw/agents/<agentId>/bus-token` (mode `0600`).
   - MCP server reads token via the same env channel (`CCAW_BUS_PORT`, `CCAW_BUS_TOKEN`) used for socket path discovery.
   - Token sent as `Authorization: Bearer <token>` on every request; rejected with `403` on mismatch.
   - **Never bind to `0.0.0.0` and never enable on a non-loopback interface.** Startup config validation enforces this.

The transport choice is logged at daemon start so operators can confirm which one is active. The Bus MCP uses identical protocol framing across all three (length-prefixed JSON).

### 5.5 External Adapters

Each external adapter is a self-contained module under `src/adapters/`. **None of them imports the runner. None of them spawns `claude`.** They speak only to `BusCore` and to their respective platform.

#### 5.5.1 Discord adapter (`src/adapters/discord.ts`)

- Auths to Discord via existing bot token.
- Inbound message:
  - Check sender against allow-list. Reject otherwise.
  - Determine `agent_id` from channel/thread mapping (config: `{discord_channel_id → agent_id}`).
  - Call `bus.sendPrompt({agent_id, origin: 'discord', origin_id: channel_id, user_id: discord_user_id, text})`.
- Outbound (subscription):
  - `bus.subscribe({agent_id, topics: ['response.text', 'response.tool_use', 'channel.permission']})`.
  - On `response.text`: post to Discord channel. Coalesce multi-block responses into a single message (Telegram-style "lazy streaming").
  - On `channel.permission`: post a permission prompt with Discord buttons; route the choice back via `bus.ingestReply` or a dedicated permission API.

#### 5.5.2 Telegram adapter (`src/adapters/telegram.ts`)

- Same shape as Discord. Different platform SDK. Allow-list per user ID, not per chat ID (Telegram is DM-only by default per the existing Plus single-user-bot pattern).

#### 5.5.3 Slack adapter (`src/adapters/slack.ts`)

- Same shape. Slack-side specifics (events API, socket mode, Block Kit for richer rendering). **Slack is not on Anthropic's Channels allowlist, so the Bus MCP is the only viable plumbing for Slack regardless of Channels GA.**

#### 5.5.4 Web UI adapter (`src/adapters/webui/`)

- Express/Fastify HTTP server + WebSocket.
- On user prompt submission: `bus.sendPrompt`.
- WebSocket subscriptions: `bus.subscribe({agent_id, topics: '*'})` — surface every event to the front-end.
- Real-time visibility:
  - Conversation view: subscribes to `response.text`, `prompt`, `tool_result`
  - Agent activity panel: subscribes to `response.tool_use`, `response.thinking`
  - Token / cache panel: subscribes to `usage`
  - System panel: subscribes to `session.init`, `session.end` + Plus governance events (existing)
- **Loses sub-message token streaming** (message-granularity from JSONL, not token-granularity from PTY). Acceptable trade per §1.6 of the compliance proposal.

#### 5.5.5 REST/CLI adapter (`src/adapters/rest.ts`)

- HTTP endpoint for scripted prompt submission, status queries, slash-command invocation. Existing CLI (`claudeclaw plus prompt …`) wraps this.

### 5.6 Cron / heartbeat / scheduler

- Replaces today's heartbeat / cron features. Internal scheduler emits prompts via `bus.sendPrompt({origin: 'cron' | 'heartbeat', user_id: 'system', …})`.
- The Bus auto-tags `system`-originated traffic so it can be routed differently by hybrid auth router in the compliance proposal §2.3 C.1 (e.g., autonomous traffic gets pushed to API key when configured).

## 6. Data flows

### 6.1 Inbound prompt (Discord → Claude)

```
1. User sends message in #triage Discord channel
2. Discord adapter receives event from Discord gateway
3. Discord adapter checks allow-list — passes
4. Discord adapter looks up channel → agent_id mapping → 'triage-agent'
5. Discord adapter calls bus.sendPrompt({agent_id: 'triage-agent', origin: 'discord', origin_id: <channel>, user_id: <userid>, text: 'fix the build'})
6. Bus core forwards to Bus MCP server (which is loaded inside triage-agent's claude session)
7. Bus MCP emits notifications/claude/channel with payload {text: 'fix the build', metadata: {origin: 'discord', origin_id: <channel>}}
8. claude (triage-agent) processes the new turn, possibly calls tools, emits text response
9. claude calls the reply() tool exposed by Bus MCP
10. Bus MCP forwards to Bus core → bus.ingestReply
11. Discord adapter (subscribed to topics for 'triage-agent') receives event → posts to channel
```

### 6.2 Outbound visibility (Web UI live updates)

```
A. User opens Web UI → WebSocket connects → bus.subscribe({agent_id: 'triage-agent', topics: '*'})
B. (Independently) Discord traffic arrives per 6.1 above
C. Bus core ingests events from BOTH MCP server (reply) AND JSONL tailer (assistant messages, tool calls, usage)
D. Bus core pushes every event to Web UI subscriber via WebSocket
E. Web UI renders conversation, tool calls, token usage live
```

### 6.3 Slash command execution

```
1. Operator clicks "Compact" in Web UI
2. Web UI calls bus.invokeSlashCommand('triage-agent', '/compact')
3. Session Manager invokes tmux send-keys '/compact' Enter on triage-agent's tmux pane
4. claude executes /compact, writes new session state to JSONL
5. JSONL tailer emits 'session.compact' event
6. Web UI shows completion status
```

### 6.4 Heartbeat tick

```
1. Plus scheduler (cron) fires heartbeat for triage-agent
2. bus.sendPrompt({agent_id: 'triage-agent', origin: 'heartbeat', user_id: 'system', text: <heartbeat prompt>})
3. Bus core consults hybrid auth router config:
   - If PLUS_AUTONOMY=on AND user has API key configured → route through API-key claude process
   - Otherwise → route through subscription-quota Claude session
4. Same downstream flow as 6.1 from step 6 onward
```

## 7. Identity & session model

- Each Plus agent has a stable `agent_id` (string slug) and a stable `session_id` (UUID). Both live in `~/.claudeclaw/agents/<agent_id>/state.json`.
- `session_id` is passed to `claude --session-id <uuid>` so the JSONL file path is deterministic and survives restarts.
- The MCP server identifies its agent via `CCAW_AGENT_ID` env var; this is the binding that lets a single Bus core multiplex many `claude` processes.
- Allow-list scoping is per-adapter (Discord/Telegram/Slack/Web UI each define their own user ID allow-list), enforced before `bus.sendPrompt` is called. The Bus core itself trusts callers — adapters are the security boundary.

## 8. Multi-agent scaling

- **N agents = N `claude` processes = N tmux panes = N JSONL files.** All routed through the single Bus core.
- Resource ceiling: practical limit is per-machine memory + Anthropic's per-account concurrency limits. Plus's existing watchdog (PR #72) becomes the enforcement layer.
- The Bus MCP server can be **a single process serving multiple agents** (via the `CCAW_AGENT_ID` env var routing), or **one Bus MCP process per agent** (simpler isolation). Recommendation: **one process, multi-agent multiplex** — less overhead, single audit log, easier to reason about. The MCP per-session handshake includes `CCAW_AGENT_ID`, so the Bus knows which agent each notification/reply is for.

## 9. Channels GA migration path

When Anthropic GAs Channels (drops the `--dangerously-load-development-channels` flag, allowlists community plugins):

1. **Discord & Telegram adapters become thin wrappers around Anthropic's official channel plugins.** Replace the Bus MCP's Discord-side adapter with `plugin:discord@claude-plugins-official`; replace the Telegram adapter with `plugin:telegram@claude-plugins-official`. Plus's job for these surfaces becomes: bot-token storage, allow-list management, agent routing (channel_id → agent_id).
2. **Slack and Web UI stay on the Bus MCP** (Slack because it's not on the Channels allowlist; Web UI because there's no official Anthropic plugin for it).
3. **The JSONL tailer is unchanged.** It's reading a file Claude Code writes — no Channels dependency.

**Net engineering cost of the GA migration:** ~1 sprint, mostly a config refactor and removing the `--dangerously-load-development-channels` flag.

## 10. Engineering plan

### Sprint 0 (pre-Sprint 1) — De-risking spikes

Three spikes that must complete before Sprint 1 starts. Each produces a written finding and either unblocks Sprint 1 as-specified or triggers a spec revision.

**Spike 0.1 — Permission-prompt flow.** Manually load a minimal Channels plugin into `claude --dangerously-load-development-channels` and trigger a permission-gated tool call. Observe whether Anthropic emits a structured `notifications/claude/channel/permission` event, or whether the permission prompt only ever appears in the TUI. Findings:
- **If structured:** §11.4 is unblocked, permission flow ships in Sprint 4.
- **If TUI-only:** ship v1.0 with `--permission-mode plan` everywhere as the workaround (Claude proposes, operator approves via slash command or Web UI button). Defer interactive permission flow until Anthropic adds it.

**Spike 0.2 — JSONL schema snapshot.** Capture a complete JSONL trace of a representative session under the current `claude` version: text reply, single tool call, parallel tool calls, thinking blocks, `/compact`, `/clear`. Document every line type and field used. Outputs:
- `docs/jsonl-schema-snapshot.md` with annotated examples for each line type.
- `src/bus/types.ts` skeleton populated with the discovered schema.
- Test fixtures (`src/__tests__/fixtures/jsonl/`) for the schema-probe harness to validate against.

**Spike 0.3 — IPC primitive choice.** Stand up a throwaway Bus core skeleton and connect a stub MCP server via each of the three transports (UDS, named pipe, localhost-TCP). Measure: connection establishment latency, message round-trip, behaviour under daemon crash + restart, behaviour under MCP-server crash + restart. Decide whether named pipes are viable in Bun on Windows or if Windows installs should default to localhost-TCP.

**Sprint 0 budget:** ~3–5 days full-time, ~1–2 weeks part-time. Sprint 1 cannot start until 0.1, 0.2, 0.3 are written up.

### Sprint 1 (week 1) — Bus skeleton + Bus MCP

- Implement Bus core (pub/sub, in-process API).
- Implement Bus MCP server (`claude/channel` capability, `notifications/claude/channel` emit, `reply` tool).
- Stand up Session Manager (spawns one agent with tmux, loads Bus MCP).
- End-to-end test: prompt-in → notification-emit → claude processes → reply tool → bus.ingestReply.

### Sprint 2 (week 2) — JSONL tailer + audit + dashboard

- Implement JSONL tailer with per-agent worker pool.
- Wire JSONL events into Bus pub/sub.
- Implement Web UI WebSocket subscriber rendering conversation + tool calls + usage.
- Wire existing cache-hit dashboard (compliance proposal Layer D) onto JSONL `usage` events.

### Sprint 3 (week 3) — Discord/Telegram adapters

- Port existing Discord/Telegram bot logic to talk to Bus core instead of PTY runner.
- Allow-list enforcement, channel → agent_id mapping.
- Per-adapter integration tests.

### Sprint 4 (week 4) — Slack adapter + cron/heartbeat + slash commands

- Port Slack bot logic.
- Reimplement cron/heartbeat scheduler on top of Bus.
- Wire slash command relay (limited tmux send-keys for `/compact`, `/clear`, `/quit`).

### Sprint 5 (week 5) — Bus default + PTY behind a flag + multi-agent + ship

- Set Bus as the default runtime (`runtime: bus` in config).
- **Retain** the PTY runner gated behind config: `runtime: pty` (legacy, off by default, documented as fallback only).
- All four PTY runner files (`pty-process.ts`, `pty-output-parser.ts`, `pty-supervisor.ts`, and the `-p`-path in `runner.ts`) stay in the tree but are unreachable unless the operator opts in via config.
- The two code paths share neither IPC nor state; the runtime switch happens at Session Manager spawn time.
- Multi-agent multiplex testing (5 agents, mixed Discord + Telegram + Web UI traffic).
- Documentation, migration guide, CHANGELOG.

**Total estimate (revised v2):**
- **~3 weeks full-time** with Claude Code-assisted development.
- **~8–10 weeks at part-time cadence** (1–2 hour daily blocks). v1 spec said 5 weeks part-time; that under-estimated Sprint 3 (Discord/Telegram port — most existing logic ends up needing rework, not just rewiring) and assumed zero schema-drift maintenance during the build. Add Sprint 0 (~1–2 weeks part-time) on top of either figure if running for the first time.
- Maintain a 20% time budget for unplanned schema-probe failures + parser additions during the build window; we expect at least one Anthropic-side change during a 10-week window based on the PR #82 / PR #85 / #105 cadence.

## 11. Risks & open questions

### 11.1 JSONL schema stability

Claude Code's session JSONL format is structured but not (as far as we know) formally versioned as a public API. The Bus depends on it. We're explicitly **not** version-pinning Claude Code — Plus should keep working as `claude` updates ship. The mitigation is a **schema-compatibility test harness** that runs on every Plus install and on every `claude` version change detected at startup.

**Schema-compatibility harness design (`src/bus/schema-probe.ts`):**

- **Trigger points:**
  - On daemon startup, capture `claude --version`. Compare against the last-known-good version stored in `~/.claudeclaw/schema-probe-cache.json`. If different, run the full probe before accepting traffic.
  - On `--force-probe` CLI flag (operator-invokable).
  - Optional: a daily cron-driven probe to detect silent in-place updates.

- **Probe procedure:**
  1. Spawn a disposable `claude` interactive session with `--session-id <ephemeral-uuid>`, an empty cwd, and the Bus MCP plugin loaded.
  2. Send a fixed canonical prompt via `notifications/claude/channel`: e.g. `"Reply with exactly the text TEST_OK and call no tools."`
  3. Wait for the corresponding JSONL file to appear at the predicted path. **Probe assertion 1:** JSONL path follows the expected `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` convention.
  4. Tail the JSONL and collect all emitted lines until the assistant message arrives.
  5. **Probe assertions 2–N:** validate each event line against the Bus's expected schema:
     - `user` event present, with `message.content` extractable
     - `assistant` event present, with `message.content` array of typed blocks (`text`, `tool_use`, `thinking`)
     - `usage` block present on the assistant event, containing `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
     - Field names and nesting match what the JSONL Tailer's parser expects
  6. Send a tool-use-eliciting prompt (e.g. invoke a known MCP tool the Bus exposes). Validate `tool_use` and `tool_result` event shapes.
  7. Test slash command relay: send `/clear` via tmux `send-keys`. Validate a `session.compact` or equivalent JSONL marker is emitted.
  8. Send `/quit`. Validate `session.end` event.

- **Probe outcomes (default mode: warn-only):**
  - **All assertions pass:** write `{claude_version, last_passed_at, schema_hash}` to `schema-probe-cache.json`. Daemon proceeds normally.
  - **Any assertion fails (default behaviour):** daemon emits a structured warning to stderr + log file + a prominent status on the Web UI dashboard, showing which assertions failed and the raw JSONL lines that triggered the failure. The daemon **continues to start in `runtime: bus` mode**, and the parser falls back to "best-effort" handling (unknown event types emit a `bus.event.unknown` topic with raw payload; missing expected fields default to `null` rather than crashing). Operator is informed but not blocked. This is the appropriate default while the parser is hardening and we're tracking `claude` updates.
  - **Optional fail-closed mode (`on_version_change: required`):** daemon refuses to start in `runtime: bus` mode on any probe failure. Available for operators who want stricter safety in production. Operator is directed to either: (a) downgrade `claude` to last-known-good version, (b) switch to `runtime: pty` legacy fallback, or (c) file an issue with the diagnostic for a Plus update.

  Recommendation: ship v1.0 with `warn-only` as the default. After a few releases of real-world parser hardening, evaluate whether to flip the default to `required`. The config is per-install, so individual operators can opt into stricter behaviour earlier.

- **Schema versioning of the parser itself:**
  - The Bus JSONL parser declares a `SCHEMA_VERSION` constant. Schema-probe cache stores the parser version that passed. If the parser is updated (e.g. to handle a new event type), the cache invalidates and the probe re-runs.
  - Parser additions are forward-compatible (unknown event types emit a `bus.event.unknown` topic with raw payload and don't crash); only structural changes to known event types break the probe.

- **Probe runtime:** budget under 5 seconds end-to-end. The probe is throwaway — its session-id is discarded immediately after, so it doesn't pollute the operator's session list.

This harness gives Plus the resilience to track Claude Code updates without manual intervention. In the default `warn-only` mode the daemon stays up and surfaces a visible diagnostic; operators who want stricter behaviour can flip to `required` and fail closed. Either way, schema drift is never silent: it always produces a structured warning that the operator can see and act on, rather than corrupted Bus events propagating downstream.

### 11.2 `notifications/claude/channel` protocol stability

Channels is research preview. The protocol contract may change before GA. **Mitigation:** keep the Bus MCP server thin, version-detect Claude Code, and treat the Channels API surface as a single point of contact behind which Plus's internal logic is isolated. When the protocol changes, only `src/bus/mcp-server.ts` needs updates.

### 11.3 Streaming granularity

Plus is not currently doing token-by-token streaming of Claude's responses through any surface, so the message-granularity of JSONL events is not a regression. Web UI and bridges receive completed responses + intermediate tool-call events at the same granularity they do today. Non-issue.

### 11.4 Permission prompts

Today, when `claude` asks for permission (e.g., "run this command?"), the PTY parser sees it in the TUI and surfaces to the user. With Channels, this **should** arrive as `notifications/claude/channel/permission` — but this is unverified on community plugins.

**Resolution path:** Spike 0.1 in Sprint 0 settles this empirically before any sprint commits to the structured-permission flow. Two branches:
- Structured permission events fire → Sprint 4 ships the interactive flow as specified.
- Structured permission events do not fire (TUI-only) → v1.0 ships with `--permission-mode plan` everywhere as the documented mode. Plan mode means Claude proposes, operator approves explicitly via slash command (`/approve <id>`) or Web UI button. Interactive permission is deferred until Anthropic exposes it on Channels.

In either case the Bus does not lose user-facing functionality vs the PTY runner — the PTY parser's "see permission prompt in TUI" path was already brittle and would have broken on the same TUI changes that broke #105.

### 11.5 Multi-channel-per-bot identity

This refactor uses Pattern A from §1.6 of the compliance proposal — one `claude` process per agent — which means one Discord bot identity per agent (or carefully scoped channel routing via Discord guild channel IDs). If preserving the single-bot-identity property is critical, run Plus's Discord adapter as a single bot that routes by channel ID to multiple `agent_id`s in Bus core. This is supported by the Bus design — the binding `channel_id → agent_id` is config in the Discord adapter.

### 11.6 Slack future

Slack is not on the Channels allowlist. If Anthropic later releases an official Slack channel plugin with a different shape (e.g., the cloud-spawned "Claude in Slack" model), the Slack adapter may need a rewrite. **Mitigation:** keep the Slack adapter's interface to the Bus narrow and stable — adapter swaps don't ripple.

### 11.7 Daemon plugin API (Plus PR #144)

The existing daemon plugin API (`before_agent_start`, `before_prompt_build`, etc.) was designed around the PTY model. Map each existing hook to a Bus event:
- `before_prompt_build` → emitted by Bus core just before `bus.sendPrompt` dispatches.
- `tool_result_persist` → emitted by JSONL tailer on `tool_result`.
- `agent_end` → emitted by Session Manager on stop.
- New hook: `before_channel_notification` (lets plugins intercept the MCP-side push).

External plugin authors get a one-time migration. To minimise breakage, the daemon ships a **translation shim** (see §12.5) that exposes the legacy hook signatures on top of the new Bus event topics. The shim is in-process, zero-config for plugin authors, and tagged for removal one minor release after the Bus runtime becomes default.

### 11.8 Hetzner production deployment notes

The current production daemon on Hetzner runs PTY-mode with one operator (Discord channels + DMs) and uses a long-lived OAuth token (PR #104). The Bus migration plan retains PTY runtime as `runtime: pty` fallback (§10 Sprint 5), so the Hetzner deployment can stay PTY-mode through the build and switch to Bus only after `runtime: bus` is verified on a staging deployment. Staging plan:
1. Deploy daemon with `runtime: bus` and one agent, no external surfaces. Verify schema-probe (§11.1) passes against the same `claude` version Hetzner runs.
2. Add Web UI adapter as the lowest-risk surface. Smoke test 5 prompts.
3. Add Discord adapter. Mirror the Hetzner channel routing config. Smoke test all 4 channels + DM in parallel for one day.
4. Cut over Hetzner: change one daemon at a time. Roll back is a config-line revert + daemon restart — no code change.

## 12. Files to add / modify / retain (gated)

### Add
```
src/bus/core.ts
src/bus/mcp-server.ts
src/bus/jsonl-tailer.ts
src/bus/session-manager.ts
src/bus/schema-probe.ts             # JSONL/notification schema compatibility harness (§11.1)
src/bus/types.ts                    # BusEvent, AgentConfig, etc.
src/bus/auth-router.ts              # Hybrid OAuth vs API-key routing (compliance proposal Layer C C.1)
src/adapters/discord.ts             # (rewrite, smaller)
src/adapters/telegram.ts            # (rewrite, smaller)
src/adapters/slack.ts               # (rewrite, smaller)
src/adapters/webui/                 # WebSocket + HTTP server
src/adapters/rest.ts
.claude-plugin/bus-mcp/             # Plus Bus MCP plugin (loaded by claude)
docs/BUS_ARCHITECTURE.md            # User-facing migration guide
docs/PTY_LEGACY_FALLBACK.md         # How to enable runtime: pty if the operator needs it
```

### Modify
```
src/commands/start.ts               # branch on config.runtime: 'bus' (default) | 'pty' (legacy)
src/commands/stop.ts                # graceful shutdown via Session Manager OR PTY supervisor depending on runtime
src/config.ts                       # AgentConfig schema, runtime selector, allow-list config
README.md                           # Architecture section rewrite, default runtime now Bus
src/runner.ts                       # add runtime-branch dispatch at the spawn boundary
```

### Retain (gated behind `runtime: pty`, not deleted)
```
src/runner/pty-process.ts           # only reachable when runtime == 'pty'
src/runner/pty-output-parser.ts     # only reachable when runtime == 'pty'
src/runner/pty-supervisor.ts        # only reachable when runtime == 'pty'
                                    # the legacy -p path stays in runner.ts as a sub-branch
```

**Why retained:** keeps a known-working escape hatch if the Bus runtime hits a problem in the field that the schema-probe (§11.1) doesn't catch (e.g. a regression in `notifications/claude/channel` protocol semantics). Operators can switch with a config change instead of a downgrade. The PTY code path is on a deprecation track but does not block v1.0.

### 12.5 Plugin translation shim

**Goal:** existing daemon plugins continue to load and run unchanged under the Bus runtime for one full minor-release cycle after the cutover.

**Implementation:** `src/bus/plugin-shim.ts` registers legacy hook names (`before_agent_start`, `before_prompt_build`, `tool_result_persist`, `agent_end`, etc.) and translates each invocation into a Bus event subscription or dispatch:

```ts
// Legacy hook signature (preserved):
//   pluginApi.on('before_prompt_build', async (ctx) => { ctx.text = transform(ctx.text); })
//
// Shim internals: registers a 'prompt' topic interceptor on the Bus core
// that builds the legacy `ctx` shape from the BusEvent and calls the
// legacy handler. Any mutations the handler makes to ctx.text are written
// back to the Bus event before dispatch continues.
```

**Deprecation timeline:**

| Release | Behaviour |
|---|---|
| First release with Bus default | Legacy API works via shim. Deprecation warning logged on each invocation: `"plugin '<name>' uses legacy hook 'before_prompt_build' — see docs/PLUGIN_MIGRATION.md"`. |
| +1 minor release | Warning becomes a stderr boot banner: legacy plugins still load, but a "PLUGINS_USING_LEGACY_API=[…]" line appears at daemon start. |
| +2 minor releases | Legacy hooks removed. Plugins not migrated by this point fail to load with a pointer to the migration guide. |

**Migration guide deliverable (Sprint 4):** `docs/PLUGIN_MIGRATION.md` — hook-by-hook rewrite recipes with before/after code snippets for each of the seven existing hooks. Shipped alongside the first Bus-default release.

**Out of scope:** the shim does not attempt to translate hooks that read TUI bytes (none of the existing seven do; flagged here as a forward-looking invariant — new legacy hooks must not be added).

## 13. Acceptance criteria for v1.0

- [ ] **Default runtime is Bus.** Fresh installs run `runtime: bus` with zero PTY-dependent code in the active call path.
- [ ] All four external surfaces (Discord, Telegram, Slack, Web UI) can send prompts and receive responses via the Bus.
- [ ] **Schema-compatibility harness (`src/bus/schema-probe.ts`) runs on startup against the current `claude` version**. Default mode is `warn-only` — failures surface as structured diagnostics to stderr / log / Web UI dashboard but do not block daemon startup. `required` mode (fail-closed) is available as a config opt-in and is verified to refuse startup when assertions fail.
- [ ] JSONL tailer reproduces conversation history accurately after daemon restart (replay test: 100 prompts, verify all events delivered).
- [ ] Cache-hit dashboard widget (compliance proposal Layer D D.3) renders live from JSONL `usage` events.
- [ ] Multi-agent test: 5 agents running concurrently, each on a distinct Discord channel, no cross-contamination of sessions.
- [ ] Slash command relay works for `/compact`, `/clear`, `/quit` via tmux send-keys under both `runtime: bus` and `runtime: pty`.
- [ ] Channels GA migration sketch verified: replace Bus MCP's Discord adapter with `plugin:discord@claude-plugins-official` in a staging branch and confirm Plus continues to function.
- [ ] **PTY runtime fallback verified:** with `runtime: pty` in config, all existing PTY-mode functionality continues to work unchanged. The two runtimes share no state at runtime; the switch is a daemon-restart config change.
- [ ] All existing Plus features pass regression under both runtimes: heartbeat, cron, MEMORY.md split (compliance proposal Layer D D.1), DAG executor (Layer D D.2), watchdog, policy engine, audit log.
- [ ] Documentation: migration guide + architecture doc + PTY legacy fallback doc + updated README.

## 14. Open implementation questions

### 14.1 Resolved in v2

- ~~JSONL schema snapshot~~ → Spike 0.2 (Sprint 0). Output: `docs/jsonl-schema-snapshot.md`.
- ~~IPC mechanism~~ → §5.4 IPC transport, defaults specified, fallback documented. Spike 0.3 validates empirically.
- ~~tmux dependency~~ → §5.3 makes tmux optional; `process` supervision is default. Removes the Windows-friction concern.
- ~~Permission flow~~ → Spike 0.1 validates structured vs TUI-only; §11.4 has both branches documented.

### 14.2 Still open — investigate during build

1. **`notifications/claude/channel` payload shape verification.** Confirm against Anthropic's `channels-reference` doc and aerolalit's working implementation (`plugins/telegram/server.ts:506-512` and surrounding). Sprint 1 deliverable.
2. **`claude --session-id` flag behaviour.** Verify it accepts a caller-supplied UUID and produces a stable JSONL filename. If not, capture the auto-assigned session ID from the JSONL `system.init` event and store it. Sprint 1 deliverable.
3. **`/compact` reliability via stdin in `process` supervision mode.** If `claude` accepts slash commands only on a TTY (not on plain stdin), the `process` mode loses slash-command support and the `tmux` mode becomes the only path with full operator control. Validate during Spike 0.3 or early Sprint 1.

---

## Appendix A — Inter-component sequence (Discord prompt)

```
User                  Discord            DiscordAdapter      BusCore        BusMCPserver      Claude        JSONLfile     JSONLtailer    WebUIadapter
  |                      |                      |               |                |               |               |               |              |
  |--"fix the build"-->  |                      |               |                |               |               |               |              |
  |                      |--message event------>|               |                |               |               |               |              |
  |                      |                      |--sendPrompt-->|                |               |               |               |              |
  |                      |                      |               |--prompt msg--->|               |               |               |              |
  |                      |                      |               |                |--notifications/claude/channel->|              |               |              |
  |                      |                      |               |                |               | (processes)   |               |              |
  |                      |                      |               |                |               |--writes------>|               |              |
  |                      |                      |               |                |               |               |--tail event-->|              |
  |                      |                      |               |<--ingestEvent--|---------------|---------------|---------------|              |
  |                      |                      |<--event-------|                |               |               |               |--event------>|
  |                      |                      |               |                |               |--calls reply->|               |              |
  |                      |                      |               |                |<--reply tool--|               |               |              |
  |                      |                      |               |<--ingestReply--|               |               |               |              |
  |                      |                      |<--event-------|                |               |               |               |              |
  |                      |<-- bot post ---------|               |                |               |               |               |              |
  |<--"Build green"------|                      |               |                |               |               |               |              |
```

## Appendix B — Configuration sketch

```yaml
# ~/.claudeclaw/config.yaml
runtime: bus                        # 'bus' (default) | 'pty' (legacy fallback)

bus:
  socket: ~/.claudeclaw/bus.sock
  audit_log: ~/.claudeclaw/bus-audit.jsonl
  schema_probe:
    enabled: true
    on_version_change: warn-only    # 'warn-only' (default) | 'required' (fail-closed) | 'skip'
    daily_probe: false              # optional periodic re-validation
    cache_file: ~/.claudeclaw/schema-probe-cache.json

agents:
  - id: triage-agent
    cwd: ~/projects/triage
    session_id: 11111111-1111-1111-1111-111111111111
    permission_mode: plan
    system_prompt_file: ~/.claudeclaw/agents/triage/SYSTEM.md
    memory_file: ~/.claudeclaw/agents/triage/MEMORY.md
    mcp_config: ~/.claudeclaw/agents/triage/mcp.json

  - id: research-agent
    cwd: ~/projects/research
    session_id: 22222222-2222-2222-2222-222222222222
    permission_mode: bypassPermissions
    # ...

surfaces:
  discord:
    bot_token_env: DISCORD_BOT_TOKEN
    allow_list_user_ids: [123456789]
    channel_routing:
      "987654321": triage-agent       # channel snowflake → agent_id
      "987654322": research-agent

  telegram:
    bot_token_env: TELEGRAM_BOT_TOKEN
    allow_list_user_ids: [987654321]
    chat_routing:
      "456789": triage-agent

  slack:
    bot_token_env: SLACK_BOT_TOKEN
    allow_list_user_ids: [U12345678]
    channel_routing:
      "C0123456": triage-agent

  webui:
    bind: 127.0.0.1:7878
    session_token_env: CCAW_WEBUI_TOKEN

  rest:
    bind: 127.0.0.1:7879

scheduler:
  heartbeat:
    triage-agent: 30m

cron_jobs:
  - agent: triage-agent
    schedule: "0 9 * * 1-5"
    prompt: "Daily standup: check overnight build failures, summarise PRs."
```
