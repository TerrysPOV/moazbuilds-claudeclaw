# Phase 18: Per-job model override runtime wiring — Research

**Researched:** 2026-04-08
**Domain:** ClaudeClaw runner/job plumbing (Bun + TypeScript)
**Confidence:** HIGH (self-contained internal plumbing; no external API questions)

## Summary

Phase 17 already landed the **data model** (`model?: string` in job frontmatter, parsed in both `src/jobs.ts` and `src/agents.ts`, surfaced in wizard + update-agent skills). What it did NOT do is thread that value through the runner — `src/commands/start.ts` line 744 calls `run(job.name, prompt, job.agent)` and `runner.ts` then ignores `job.model` entirely and uses the global `settings.model` via `getSettings()` (runner.ts:452, :489, :581).

Phase 18 is a small, surgical plumbing job:

1. Extend `run()` / `execClaude()` / `runCompact()` in `runner.ts` to accept an optional `model` override.
2. Resolve precedence at the call site: **job.model → agent default model → settings.model** (daemon default).
3. Introduce an agent-level default model field (new — doesn't exist yet; see Open Question 1).
4. Validate model strings at **load time** in `loadJobs()` / `addJob()` / `updateJob()` against a known allowlist.
5. Surface model selection at both agent-create and per-job level in `create-agent` + `update-agent` skills (agent level is new UI).
6. Tests: precedence cascade, allowlist rejection, `--model` flag emission, `glm` special-case preserved.

**Primary recommendation:** Add a single optional `modelOverride?: string` param to `run()` and `execClaude()`, resolve precedence in `start.ts` cron tick before calling `run()`, and keep `runClaudeOnce()` unchanged — it already takes `model` as an arg (runner.ts:123) and already handles the `glm` sentinel correctly. The change is ~40 lines in runner.ts, ~15 lines in start.ts, plus validation + tests.

<user_constraints>
## User Constraints (from CONTEXT.md)

No CONTEXT.md exists for Phase 18 — this phase was spec'd directly from the roadmap blocker. Treat the phase description in ROADMAP.md as the locked scope:

### Locked Decisions (from ROADMAP.md Phase 18 scope)
- Extend `runner.ts` to accept a `model` parameter per invocation
- Wire `jobs.ts` cron loop to pass `job.model` (falls back to agent default, then daemon default)
- Wizard + update-agent expose model selection at both **agent level (default)** and **job level (per-task override)**
- Validation: reject unknown model strings at **load time**, not at runtime
- Tests: each supported model string resolves correctly, overrides cascade agent → job, invalid strings error cleanly

### Claude's Discretion
- Exact shape of the agent-level default model field (new frontmatter in SOUL.md? new field in CLAUDE.md managed block? new field in `AgentCreateOpts`?) — recommend in plan
- Where the allowlist lives (constant in `runner.ts`, `config.ts`, or new `src/models.ts`?)
- Whether to pipe `modelOverride` all the way through `enqueue → execClaude → runClaudeOnce` or resolve it to a concrete `ModelConfig` at `run()` entry (recommend the latter — fewer touch points)

### Deferred / Out of Scope
- Agentic routing (`agentic.enabled` path in runner.ts:466) — leave untouched; per-job override only applies when `agentic.enabled === false` OR takes precedence over agentic routing (decide in plan, lean toward "job override wins if set")
- Fallback model behavior — keep existing rate-limit fallback logic as-is; per-job override only affects the *primary* model
- Streaming path (`streamClaude` in runner.ts:775) — not used by cron jobs, out of scope
</user_constraints>

<phase_requirements>
## Phase Requirements

Phase 18 requirement IDs are TBD (to be assigned in `/gsd:plan-phase`). Candidate requirements derived from ROADMAP.md scope:

| Candidate ID | Description | Research Support |
|----|-------------|-----------------|
| MODEL-RT-01 | `run()` / `execClaude()` accept an optional per-invocation model override | §Architecture Patterns — Runner Signature Extension |
| MODEL-RT-02 | Cron loop in `start.ts` resolves precedence `job.model → agent.defaultModel → settings.model` before calling `run()` | §Architecture Patterns — Precedence Resolution |
| MODEL-RT-03 | Agent-level default model field added to agent scaffold (new) | §Open Question 1 — Agent Default Storage |
| MODEL-VAL-01 | Unknown model strings rejected at load time in `loadJobs()` and in `addJob()`/`updateJob()` | §Don't Hand-Roll — Allowlist Validation |
| MODEL-VAL-02 | Error message from validation names the offending file + label + allowed values | §Common Pitfalls — Silent Runtime Fallback |
| MODEL-UI-01 | `create-agent` skill prompts for agent-level default model | §Code Examples — Skill Integration |
| MODEL-UI-02 | `update-agent` skill adds "Change agent default model" menu item | §Code Examples — Skill Integration |
| MODEL-TEST-01 | Tests cover: each valid model string, precedence cascade (3 levels), invalid string rejection, `glm` sentinel preservation | §Validation Architecture |
</phase_requirements>

## Standard Stack

No new dependencies. Pure internal refactor.

| Component | Existing | Purpose |
|---|---|---|
| Runtime | Bun | Spawns `claude` CLI subprocesses via `Bun.spawn` |
| Language | TypeScript (strict) | Existing codebase |
| Test framework | `bun:test` | Existing `src/__tests__/*.test.ts` suite (~710 tests, 13 pre-existing failures) |
| CLI flag emission | Direct arg push to `args` array in `runClaudeOnce` | `--model <name>` already wired (runner.ts:130) |

## Architecture Patterns

### Current Call Chain (before Phase 18)

```
start.ts cron tick (line 744)
  └─ run(job.name, prompt, job.agent)
       └─ enqueue(() => execClaude(name, prompt, agentName))
            └─ const { model, api } = getSettings()   ← model hard-wired from global settings
            └─ primaryConfig = { model, api }         ← runner.ts:489
            └─ runClaudeOnce(args, primaryConfig.model, primaryConfig.api, ...)
                 └─ args.push("--model", model)       ← runner.ts:130
```

`job.model` is parsed (jobs.ts:73-75) but never read anywhere.

### Target Call Chain (Phase 18)

```
start.ts cron tick
  ├─ const resolvedModel = job.model ?? agent?.defaultModel ?? undefined
  └─ run(job.name, prompt, job.agent, { modelOverride: resolvedModel })
       └─ enqueue(() => execClaude(name, prompt, agentName, { modelOverride }))
            └─ if (modelOverride) primaryConfig = { model: modelOverride, api }
               else if (agentic.enabled) ... existing routing ...
               else primaryConfig = { model: settings.model, api }
```

**Why resolve in `start.ts` rather than inside `run()`:** Keeps `run()` ignorant of job/agent concepts. Cron loop already has both `job` and agent name in scope. Agent default lookup is a file read we want to cache/avoid per tick anyway (see Pitfall: Per-Tick I/O).

### Recommended Function Signatures

```typescript
// runner.ts — add optional options arg (back-compat: existing callers unchanged)
export interface RunOptions {
  modelOverride?: string;  // resolved model string, e.g. "opus", "sonnet", "haiku", "glm"
}

export async function run(
  name: string,
  prompt: string,
  agentName?: string,
  options?: RunOptions
): Promise<RunResult>;

async function execClaude(
  name: string,
  prompt: string,
  agentName?: string,
  options?: RunOptions
): Promise<RunResult>;
```

### Precedence Resolution Helper

```typescript
// new helper in src/jobs.ts or src/agents.ts
export async function resolveJobModel(job: Job): Promise<string | undefined> {
  if (job.model) return job.model;                          // 1. job frontmatter
  if (job.agent) {
    const agent = await loadAgent(job.agent);
    if (agent?.defaultModel) return agent.defaultModel;     // 2. agent default
  }
  return undefined;                                         // 3. fall through → settings.model in runner
}
```

Returning `undefined` for "no override" lets the runner's existing `getSettings().model` path handle the daemon default — no need to duplicate that logic.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Model string validation | Regex or free-form strings | A small `const VALID_MODELS = new Set(["opus", "sonnet", "haiku", "glm", ""])` allowlist | Matches exactly what `runClaudeOnce` already understands; `glm` is the only sentinel; empty string means "daemon default" |
| Passing model through runner | New ModelContext class, dependency injection | Single optional `modelOverride` string in an options object | Runner already takes a raw `model: string` at the spawn boundary (runner.ts:123) — converting it back to a struct is overkill |
| Agent default lookup at every cron tick | Re-reading SOUL.md per tick | Cache on `loadAgent()` result OR read once at daemon startup + hot-reload on `loadJobs()` refresh | Cron loop currently runs every minute; SOUL.md is already loaded by `loadAgent()` for other purposes |
| Validation error reporting | `throw new Error("invalid model")` | Structured error with filepath + label + allowed list | `loadJobs()` already has `job.path` context; match existing error style in `parseJobFile` |

**Key insight:** The `--model` flag is already fully functional in `runClaudeOnce`. Phase 18 is entirely about *getting the right string* to that call site, not about changing how the CLI is invoked.

## Common Pitfalls

### Pitfall 1: Agentic Routing Collision
**What goes wrong:** `agentic.enabled === true` path (runner.ts:466-487) computes its own `primaryConfig.model` via `governanceSelectModel()`. If you naively add `if (modelOverride) primaryConfig = ...` *after* the agentic block, you silently break agentic routing. If you add it *before*, you silently break it too.
**How to avoid:** Explicit decision in the plan: **job model override wins over agentic routing** (documented, tested). The agentic block becomes `if (!modelOverride && agentic.enabled) { ... }`.
**Warning signs:** Tests pass but Reg starts ignoring opus override when `agentic.enabled` is flipped on.

### Pitfall 2: `glm` Sentinel Handling
**What goes wrong:** `glm` is not a real model flag — `runClaudeOnce` at line 130 *skips* `--model glm` and relies on `buildChildEnv` (runner.ts:110-113) setting `ANTHROPIC_BASE_URL` to z.ai. If job.model = "glm", you must pass it through the `model` parameter so `buildChildEnv` fires, but NOT add `--model glm` to the args.
**How to avoid:** Don't touch `runClaudeOnce` — it already handles this correctly. Just pass `modelOverride` up the chain to become `primaryConfig.model`.
**Warning signs:** glm jobs start hitting api.anthropic.com with invalid model name.

### Pitfall 3: Silent Runtime Fallback
**What goes wrong:** If validation happens at runtime (inside `execClaude`), a typo like `model: opuz` silently fires the job with a broken model, user gets an opaque Claude CLI error at 3am.
**How to avoid:** Validate in `loadJobs()` at daemon startup AND on every `loadJobs()` refresh tick (start.ts:501, :661). Reject invalid entries with a clear log line; job does NOT load. Also validate in `addJob()` / `updateJob()` so the skill fails fast during wizard.
**Warning signs:** Invalid model string reaches `runClaudeOnce`.

### Pitfall 4: Precedence Ordering Regression
**What goes wrong:** "fallback to agent default, then daemon default" — easy to get the chain wrong. If job.model = "" (empty string, not undefined), does that mean "use default" or "explicit override to empty"?
**How to avoid:** Normalize at parse time: `agents.ts:505` already does `|| undefined`. Treat `undefined` as "no override," everything else as explicit. Test the empty-string case explicitly.
**Warning signs:** `model: ` (empty value) in frontmatter behaves differently from omitting the line.

### Pitfall 5: Fallback Config Ignores Override
**What goes wrong:** `fallbackConfig` at runner.ts:492 is built from `settings.fallback`. If primary (now = job override) hits rate limit, fallback might swap to a model the user didn't intend.
**How to avoid:** Document that fallback remains global (settings-driven). This is the existing behavior and the least-surprising option. If user wants per-job fallback, that's a future phase.

## Code Examples

### Job Frontmatter Parsing (existing, reference only)
```typescript
// Source: src/jobs.ts:73-75 (already implemented in Phase 17)
const modelLine = lines.find((l) => l.startsWith("model:"));
const modelRaw = modelLine ? parseFrontmatterValue(modelLine.replace("model:", "")) : "";
const model = modelRaw || undefined;
```

### Validation at Load Time (new)
```typescript
// New constant — suggest src/models.ts or top of src/jobs.ts
export const VALID_MODEL_STRINGS = new Set(["opus", "sonnet", "haiku", "glm"]);

export function validateModelString(value: string | undefined, context: string): void {
  if (value === undefined || value === "") return;
  if (!VALID_MODEL_STRINGS.has(value.trim().toLowerCase())) {
    throw new Error(
      `Invalid model "${value}" in ${context}. ` +
      `Allowed: ${[...VALID_MODEL_STRINGS].join(", ")} (or omit for default)`
    );
  }
}

// In loadJobs() — wrap parseJobFile, skip invalid + log
try {
  validateModelString(job.model, `${job.agent}/${job.label}`);
} catch (err) {
  console.error(`[${ts()}] Skipping job ${job.agent}:${job.label}: ${err.message}`);
  continue;
}
```

### Runner Override Wiring (new)
```typescript
// runner.ts — inside execClaude, replace lines 461-490
let primaryConfig: ModelConfig;
let taskType = "unknown";
let routingReasoning = "";

if (options?.modelOverride) {
  // Job/agent override wins over agentic routing
  primaryConfig = { model: options.modelOverride, api };
  taskType = "job-override";
  routingReasoning = `override: ${options.modelOverride}`;
} else if (agentic.enabled) {
  ensureGovernanceRouter(agentic.modes, agentic.defaultMode);
  const routing = await governanceSelectModel({ /* ... existing ... */ });
  primaryConfig = { model: routing.selectedModel, api: routing.selectedProvider === "openai" ? "" : api };
  taskType = routing.reason;
  routingReasoning = routing.reason;
  if (routing.budgetState === "block") { /* ... existing budget block ... */ }
} else {
  primaryConfig = { model, api };
}
```

### Cron Tick Site (new)
```typescript
// src/commands/start.ts — replace line 744
for (const job of currentJobs) {
  if (cronMatches(job.schedule, now, currentSettings.timezoneOffsetMinutes)) {
    resolvePrompt(job.prompt)
      .then(async (prompt) => {
        const modelOverride = await resolveJobModel(job);
        return run(job.name, prompt, job.agent, { modelOverride });
      })
      .then((r) => { /* ... existing notify logic ... */ });
  }
}
```

### Skill Integration (update-agent menu addition)
```markdown
<!-- skills/update-agent/SKILL.md — add to menu list -->
7. Change agent default model  — set/clear `defaultModel` on the agent
```

## Validation Architecture

Phase requires `nyquist_validation` check — see `.planning/config.json`. Assuming enabled:

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `bun:test` (existing) |
| Config file | none — Bun discovers `src/__tests__/*.test.ts` |
| Quick run command | `bun test src/__tests__/runner.test.ts src/__tests__/jobs.test.ts` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map
| Req | Behavior | Type | Command | Exists? |
|---|---|---|---|---|
| MODEL-RT-01 | `run()` accepts `modelOverride` and forwards to `runClaudeOnce` | unit | `bun test src/__tests__/runner.test.ts -t "modelOverride"` | Wave 0 |
| MODEL-RT-02 | Precedence: job > agent > settings | unit | `bun test src/__tests__/jobs.test.ts -t "resolveJobModel"` | Wave 0 |
| MODEL-RT-03 | Agent `defaultModel` read/write round-trip | unit | `bun test src/__tests__/agents.test.ts -t "defaultModel"` | extends existing |
| MODEL-VAL-01 | `loadJobs()` skips jobs with invalid model | unit | `bun test src/__tests__/jobs.test.ts -t "invalid model"` | Wave 0 |
| MODEL-VAL-02 | Error message includes file + label + allowed list | unit | same file | Wave 0 |
| MODEL-TEST-01 | `glm` sentinel still suppresses `--model` flag | unit | `bun test src/__tests__/runner.test.ts -t "glm"` | Wave 0 |

### Sampling Rate
- **Per task commit:** `bun test src/__tests__/runner.test.ts src/__tests__/jobs.test.ts src/__tests__/agents.test.ts`
- **Per wave merge:** `bun test` (expect 710+ tests, 13 pre-existing failures)
- **Phase gate:** Full suite with no *new* failures, all new MODEL-* tests green

### Wave 0 Gaps
- [ ] `src/__tests__/runner.test.ts` — does NOT exist yet (runner is currently tested only indirectly). Needs creation with a mockable `runClaudeOnce` boundary — spy on the args array to assert `--model` presence/absence without actually spawning `claude`. May require a minor refactor to export `runClaudeOnce` or inject it.
- [ ] New test cases in `src/__tests__/jobs.test.ts` for `resolveJobModel` precedence cascade
- [ ] New test cases in `src/__tests__/agents.test.ts` for agent `defaultModel` field round-trip

## State of the Art

| Old Approach (pre-Phase 18) | New Approach | Impact |
|---|---|---|
| `job.model` parsed then discarded | Threaded through `run()` options | Reg on opus, Suzy on haiku actually works |
| Global `settings.model` is the only knob | Three-level cascade: job → agent → settings | Per-task cost optimization |
| Invalid model strings fail silently at runtime | Rejected at `loadJobs()` with clear error | No more 3am surprises |

## Open Questions

1. **Where does `agent.defaultModel` live?**
   - What we know: Agent has SOUL.md + CLAUDE.md, no current default-model field. `AgentCreateOpts` interface (agents.ts:32) has no `defaultModel`.
   - What's unclear: Add it as a new frontmatter field in SOUL.md? Or a new managed-block entry in the agent's CLAUDE.md? Or a small sidecar `agents/<name>/config.json`?
   - **Recommendation:** Add `defaultModel?: string` to `AgentCreateOpts`, persist as a new marker-wrapped section in CLAUDE.md (`<!-- claudeclaw:model:start -->...<!-- claudeclaw:model:end -->`). Matches existing Phase 17 marker convention. `loadAgent()` parses it out. Honors UPDATE-02 invariant (MEMORY.md untouched).

2. **What happens if `agentic.enabled === true` AND job has model override?**
   - **Recommendation:** Job override wins. Document in the plan. Test explicitly. Rationale: user explicitly configured the job; agentic routing is a global policy layer.

3. **Should `runCompact()` also accept `modelOverride`?**
   - What we know: `runCompact()` at runner.ts:297 takes its own `model` param already, called internally.
   - **Recommendation:** Out of scope unless plan discovers it's called per-job. Likely called once per compact, not per job.

4. **Do we add a `models.ts` module or inline the allowlist?**
   - **Recommendation:** Inline constant at top of `src/jobs.ts` for now — tiny, one concern, no import churn. Extract to `src/models.ts` if Phase 19+ adds more model logic.

## Sources

### Primary (HIGH confidence)
- `src/runner.ts` lines 104-170, 441-600, 771 — current runner architecture
- `src/jobs.ts` lines 16, 73-77, 80-150 — current job loading + parsing
- `src/agents.ts` lines 204-600 — AgentJob interface, addJob/updateJob, renderJobFile
- `src/commands/start.ts` lines 741-758 — cron tick site
- `src/config.ts` lines 133-150 — ModelConfig shape
- `src/governance/model-router.ts` — agentic routing path (to preserve)
- `.planning/phases/17-*/17-RESEARCH.md` — Phase 17 data model context
- `.planning/ROADMAP.md` — Phase 18 scope (locked)
- `skills/create-agent/SKILL.md`, `skills/update-agent/SKILL.md` — wizard integration points

### Secondary (MEDIUM confidence)
- Claude CLI `--model` flag behavior — inferred from existing runner.ts usage (`opus`, `sonnet`, `haiku`, `glm` are the strings currently passed; CLI accepts these as aliases)

## Metadata

**Confidence breakdown:**
- Runner/jobs plumbing: HIGH — entirely internal code with existing patterns to follow
- Validation approach: HIGH — well-established load-time validation pattern in jobs.ts already
- Agent default storage: MEDIUM — new field, recommendation is one of three viable options
- Agentic routing interaction: MEDIUM — depends on explicit design decision in plan

**Research date:** 2026-04-08
**Valid until:** 2026-05-08 (30 days — stable internal codebase)
