# SPEC-DELTA — Phase C: Dashboard model picker (#70)

**Date:** 2026-05-30. Amends `.planning/llm-router/SPEC.md` + Phase B
(SPEC-DELTA-2026-05-29). Phase B shipped the `llm_models` MCP tool as the
catalogue substrate; this phase puts a UI on it.

## Scope

A searchable model picker in the legacy dashboard's Settings modal where the
operator browses the OpenRouter catalogue and assigns model ids to tiers —
writes through to `settings.llmRouter.tiers`. No frontend framework added; uses
the existing `template.ts` / `script.ts` / `styles.ts` server-rendered model.

## Server changes

### New service — `src/ui/services/llm-router-settings.ts`
Mirrors `src/ui/services/settings.ts` (heartbeat):

```
readLlmRouterSettings(): Promise<LlmRouterSettingsData>
updateLlmRouterSettings(patch: { tiers? }): Promise<LlmRouterSettingsData>
```

Reads/writes `settings.json` directly (same idiom as the heartbeat helper).
`tiers` accepts the same `{ fast, balanced, reasoning }` shape; ids are
validated as non-empty trimmed strings.

### New routes in `src/ui/server.ts` (sibling of `/api/settings/heartbeat`)
- `GET /api/settings/llm-router` → `{ ok, llmRouter }`.
- `POST /api/settings/llm-router` (CSRF) → patch tiers, return updated settings.
- `GET /api/llm-router/models?query=&maxPromptPrice=&minContext=&limit=` →
  `{ ok, models, cachedAt }`. Reuses `ModelCatalogue` + `filterModels` from
  `src/plugins/llm-router/catalogue.ts` — single source of truth for the proxy.
  Reads `OPENROUTER_API_KEY` from the daemon env at request time (never logs or
  returns it).

### Plugin live-reload (small scoped touch)
`src/plugins/llm-router/server.ts` currently reads `settings.llmRouter` once at
startup, so dashboard tier edits wouldn't take effect until a daemon restart.
Fix: `createLlmRouterHandlers` accepts a `getConfig: () => Promise<LlmRouterRuntimeConfig>`
factory; `startLlmRouterServer` provides a factory that calls
`reloadSettings()` + `buildRuntimeConfig()` per call. Disk read cost is ms; LLM
calls are seconds. Tests inject a static factory; backwards-compatible (the
existing `config` field is still accepted via a wrapper for tests).

## UI changes — Settings modal

Add one section to `settings-stack` between Heartbeat and Clock:

```
🧠 LLM Router
 ├─ Per-tier lists: fast / balanced / reasoning
 │   each shows assigned model ids as removable chips
 ├─ Search panel: [query input] → results list (id, name, context, $/Mtok)
 │   each result has "+ fast / + balanced / + reasoning" buttons
 └─ Save changes  (POSTs the new tiers)
```

V1 keeps the UI minimal:
- **Query-only search** in the UI (the route accepts price/context filters too,
  but they're not surfaced in v1).
- **No "test this tier" / no per-call model field** (operators have the MCP tool).
- Empty `OPENROUTER_API_KEY` → the section shows a clear "set the env var" hint
  instead of erroring on first search.

## Out of scope (deferred)

- Per-tier "test" smoke prompt.
- Price/context filters in the UI (route already supports them).
- Streaming / per-call cost surfacing (#68 territory).
- Touching the bus-runtime web UI (this is the *legacy* dashboard's settings
  modal, which has feature parity for operator settings — see start.ts:550
  comment).

## Verification

- Unit tests: `llm-router-settings` read/update; `/api/settings/llm-router`
  GET/POST round-trip; `/api/llm-router/models` proxy with injected fetch;
  plugin live-reload (getConfig called per call, picks up updated tiers).
- **Manual browser verification is yours to do** — I can't run the daemon +
  click through the modal from here. PR body will flag this explicitly.
