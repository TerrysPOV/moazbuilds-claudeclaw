# ClaudeClaw+ LLM Router — Tiered Multi-Provider `llm_call` on the Multiplexer Substrate

SDC Stage-1 deliverable for issue #70 (milestone). This SPEC freezes the
Phase A architecture. No plugin code is written until Stage-3 human sign-off.

## 1. Context

### Problem statement
Every daemon and plugin LLM call today is single-provider (Anthropic). Two
consequences:

1. **Agent SDK billing split, 2026-06-15.** After that date, `claude -p` /
   headless SDK invocations drain a separate, smaller Agent-SDK credit pool.
   The PTY migration (#62) moved interactive traffic to the subscription pool,
   but several daemon flows still use `claude -p` (compact, bootstrap, fork,
   memory-save) and keep draining the Agent-SDK pool.
2. **Vendor concentration + no tiering.** Single-provider exposure is one
   failure surface (rate limits, deprecations, billing). There is no way to
   send cheap/bulk work (classification, formatting, simple completions) to a
   cheap model while reserving expensive models for reasoning, and no central
   point for per-(caller, tier, provider) cost attribution.

### Target outcome
A shared **LLM router** MCP tool — `llm_call(tier, messages, schema?)` —
reachable by every PTY-resident `claude` and every plugin, that routes by cost
tier across providers behind one interface, with structured fallback and audit.

### Why build vs buy (LiteLLM)
Rejected **LiteLLM**: the proxy is a heavy Python service (wants Postgres +
Redis for its real features) — a second runtime + DB bolted onto a lightweight
Bun daemon, and it reintroduces the per-process weight #64 exists to kill; the
SDK is Python (wrong runtime, can't embed in Bun). Instead lean on **OpenRouter**
(already the repo's preferred LLM API) for provider breadth and build only a
thin TS tiering + MCP + fallback shim (~150–300 LOC).

## 2. Frozen Decisions

These are settled for v1 and must not be re-litigated in Phase B without a SPEC
delta.

1. **Hosting = standalone stdio MCP server, registered as a multiplexer shared
   server.** One process for the whole daemon, shared by all PTYs. Reuses the
   spawn → proxy → per-PTY-auth → synth substrate **unchanged**.
   - *Rejected:* in-process bridge tool (`registerPluginTool`). Bridge tools are
     exposed only via the in-process `claudeclaw-plus` stdio server
     (`src/plugins/mcp-server.ts`), which is **not** written into a PTY's
     `--mcp-config`. Reaching PTYs that way would require teaching the
     multiplexer's shared-name accounting + `synthesizeBusMcpConfig` about an
     in-process handler — more plumbing in delicate code for no gain.
2. **OpenRouter is the breadth layer.** One OpenAI-compatible HTTP client
   (`/chat/completions`) covers Anthropic / Groq / DeepSeek / etc. No
   per-provider adapter zoo in v1.
3. **Provider keys come from env / Doppler only** (`OPENROUTER_API_KEY`), never
   from `settings.json`. Settings holds only the non-secret tier→model map +
   base URLs. (Matches the repo's "Doppler is source of truth for secrets" rule
   and avoids putting a key in the world-readable, `/api/technical-info`-exposed
   settings file.)
4. **Non-streaming v1.** `llm_call` returns a complete response.
5. **Optional local Ollama tier.** A free/local tier hits the Ollama HTTP API
   directly; off unless configured.
6. **Billing nuance (documented, not a bug):** Anthropic-via-OpenRouter is
   *OpenRouter-billed*, not the Claude subscription. The router's
   subscription-pool benefit is indirect — it moves cheap/bulk calls to cheap
   providers (Groq / DeepSeek / local Ollama), reserving the subscription pool
   for interactive PTY `claude`. A "reasoning" tier pointed at Claude-via-
   OpenRouter is a separate paid path, chosen for quality not savings.

## 3. Current behaviour (as-is, with refs)

- **How a PTY reaches MCP tools.** `synthesizeBusMcpConfig`
  (`src/bus/session-manager.ts:153`) writes each PTY's `--mcp-config` listing
  every `settings.mcp.shared` server as an HTTP-transport entry pointing at
  `/mcp/<name>` with a per-agent bearer identity. (This is the path hardened in
  #165 — it now uses `plugin.sharedServerNames()`, the actually-claimed set.)
- **How a shared server is hosted.** The multiplexer
  (`src/plugins/mcp-multiplexer/index.ts`) spawns each shared server as an
  `McpServerProcess` (`src/plugins/mcp-proxy/server-process.ts`) from
  `mcp-proxy.json`, and registers an HTTP handler via
  `getHttpGateway().registerMcpHandler(name, (req) => handler.handle(req))`
  (`index.ts:424`). The gateway dispatches `/mcp/<server>` to that handler
  (`src/plugins/http-gateway.ts:74`).
- **Existing tier inference.** `classifyTask(prompt, modes, defaultMode)`
  (`src/model-router.ts:19`) already scores a prompt against keyword/phrase
  modes — reusable for optional auto-tiering when `tier` is omitted.
- **Provider keys today.** `settings.api` / `settings.fallback.api` (GLM) and
  Anthropic OAuth / `ANTHROPIC_API_KEY` via the daemon env (`cleanSpawnEnv`,
  `src/runner.ts`). **OpenRouter is not referenced anywhere yet.**
- **Settings parsing pattern.** Each section is an `interface XConfig` + a
  `parseX(raw)` function + a `DEFAULT_SETTINGS` entry, wired into
  `parseSettings`. Templates: `interface McpConfig` (`src/config.ts:381`),
  `parseMcpConfig` (`src/config.ts:1245`), `parseAgenticConfig` wired at
  `src/config.ts:792`.

## 4. Target behaviour (to-be)

### 4.1 The tool
`llm_call({ tier, messages, schema?, providerHint? })`:
- `tier`: `"fast" | "balanced" | "reasoning"` (and `"local"` when Ollama is
  configured). Required. (Auto-inference from `messages` via `classifyTask` is a
  documented future option, not v1.)
- `messages`: OpenAI-style `{ role, content }[]`.
- `schema?`: optional JSON Schema → request structured output (OpenRouter
  `response_format`); validated before returning.
- `providerHint?`: optional model/provider override within the tier.
- Returns (non-streaming): `{ content, model, provider, usage, fellBack }`.

### 4.2 Routing + fallback
- Tier → ordered model list from `settings.llmRouter.tiers`.
- Call OpenRouter `/chat/completions` with the first model; on `429`/`5xx`/
  network error, advance to the next model in the tier's list; emit a structured
  fallback log. Exhausting the list → a typed error surfaced to the caller.
- `"local"` tier (if set) targets the Ollama HTTP API base instead of OpenRouter.

### 4.3 Hosting / wiring
- The router is a Bun **stdio MCP server** built on `@modelcontextprotocol/sdk`
  `Server` + `ListToolsRequestSchema` / `CallToolRequestSchema`, mirroring
  `src/plugins/mcp-server.ts`.
- Operator enablement (documented in README): add `"llm-router"` to
  `settings.mcp.shared` **and** an `mcp-proxy.json` entry
  `{ "command": "bun", "args": ["run", "<root>/src/plugins/llm-router/server.ts"] }`.
- On daemon start the multiplexer spawns it once and proxies `/mcp/llm-router`;
  `synthesizeBusMcpConfig` wires it into every PTY automatically. **No
  multiplexer or synth code changes required.**

### 4.4 Observability
- Audit via `getMcpBridge().audit(...)` (`src/plugins/mcp-bridge.ts`):
  `llm_call_dispatched` / `llm_call_failed` / `llm_call_fallback_taken`, each
  carrying `{ caller, tier, provider, model, latencyMs, usage }`. This is the
  natural attribution point for the #68 cost-tracking work (not built here).

## 5. Settings schema (Phase B)

New `settings.llmRouter` section, parsed with the house pattern (mirror
`parseMcpConfig` / `parseAgenticConfig`). Non-secret only:

```jsonc
"llmRouter": {
  "enabled": false,                       // dormant by default
  "openRouterBaseUrl": "https://openrouter.ai/api/v1",
  "ollamaBaseUrl": "http://127.0.0.1:11434",  // only used by the "local" tier
  "tiers": {
    "fast":      ["meta-llama/llama-3.1-8b-instruct", "google/gemini-flash-1.5"],
    "balanced":  ["deepseek/deepseek-chat"],
    "reasoning": ["anthropic/claude-3.7-sonnet"],
    "local":     ["ollama:llama3.1"]        // optional
  }
}
```

`OPENROUTER_API_KEY` is read from the env only (Doppler-sourced on Hetzner).
Dormant when `enabled: false` or the key is absent → `llm_call` returns a clear
"router not configured" error; nothing else changes.

## 6. Key file references

- **New (Phase B):**
  - `src/plugins/llm-router/server.ts` — stdio MCP server exposing `llm_call`.
  - `src/plugins/llm-router/router.ts` — tier→model resolution + fallback core.
  - `src/plugins/llm-router/openrouter.ts` — OpenAI-compatible HTTP client.
  - `src/plugins/llm-router/types.ts` — request/response + config types.
  - `src/plugins/llm-router/__tests__/` — unit + integration tests.
- **New SPEC:** `.planning/llm-router/SPEC.md` (this file).
- **Modified (Phase B):** `src/config.ts` — add `interface LlmRouterConfig` +
  `parseLlmRouterConfig` + `DEFAULT_SETTINGS.llmRouter`; wire into
  `parseSettings` (mirror `src/config.ts:381` / `:1245` / `:792`). README
  operator notes (enablement + env var).
- **Reuse, do not duplicate:** `classifyTask` (`src/model-router.ts:19`) for any
  later auto-tiering; the MCP server scaffold in `src/plugins/mcp-server.ts`;
  `getMcpBridge().audit()` (`src/plugins/mcp-bridge.ts`).
- **Test templates:** `src/__tests__/mcp_proxy_*.test.ts`,
  `src/plugins/mcp-multiplexer/__tests__/`.

## 7. Out of scope (deferred)

- Streaming responses (callers needing streaming call a provider directly).
- Per-caller tier ACLs (e.g. agent A limited to `fast`).
- Cost-overrun auto-fallback (separate cost-control milestone).
- Provider adapters beyond OpenRouter + Ollama.
- Auto-tier inference from message content (v1 requires explicit `tier`).
- The #68 cost-accounting integration (router emits the audit events that #68
  will consume; the consumer is not built here).
- The actual plugin implementation — that is Phase B.

## 8. Execution model (post-SPEC)

Per #70: **Phase B** parallel engineering (router core + OpenRouter client +
config), **Phase C** integration tests (mocked + rate-limited real endpoints),
**Phase D** security audit (key handling, outbound-call audit, no key in
settings) + 5-agent code review, **Phase E** stacked PRs. Stage-3 human review of
this SPEC gates the start of Phase B.

## 9. Failure modes to design against (Phase B)

- OpenRouter key missing/invalid → dormant + clear error, never a crash.
- All tier models 429/5xx → typed exhaustion error + `llm_call_failed` audit.
- Ollama base unreachable for the `local` tier → fall back or clear error.
- `schema` set but provider returns non-conforming JSON → validation error, not
  a silent malformed return.
- Router subprocess crash → multiplexer's existing shared-server supervision
  handles respawn (no special-casing needed).
