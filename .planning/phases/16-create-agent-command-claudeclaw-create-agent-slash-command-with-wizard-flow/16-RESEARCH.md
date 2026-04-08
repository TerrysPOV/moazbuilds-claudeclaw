# Phase 16: Create Agent Command — Research
**Researched:** 2026-04-06
**Question answered:** What do I need to know to PLAN this phase well?

---

## 1. What Already Exists (Reusable Infrastructure)

### 1.1 `src/memory.ts` — Agent memory is ALREADY done
The memory module is fully agent-aware. Key functions are already in place:
- `getMemoryPath(agentName?)` → returns `agents/<name>/MEMORY.md` when agentName is passed
- `ensureMemoryFile(agentName?)` → creates `agents/<name>/MEMORY.md` from `MEMORY_TEMPLATE` if absent
- `loadMemory(agentName?)` → reads the file content
- `AGENTS_MEMORY_DIR = join(PROJECT_DIR, "agents")` — the directory convention is set

The `agents/` directory lives in project root (NOT `.claude/`) because Claude Code blocks writes to `.claude/` even with `--dangerously-skip-permissions`. This constraint is already documented in `memory.ts:14-16`.

**Planning implication:** `src/agents.ts` just needs to call `ensureMemoryFile(agentName)` during scaffold — no new memory logic needed.

### 1.2 `src/sessions.ts` — Needs extension for per-agent sessions
Currently the module hardcodes a single path: `.claude/claudeclaw/session.json`. The interface and functions (`getSession`, `createSession`, `peekSession`, `incrementTurn`, `markCompactWarned`, `resetSession`, `backupSession`) are solid.

To support agents, the plan needs to:
- Add an optional `agentName?: string` parameter to key functions
- Compute session path as `agents/<name>/session.json` when agentName is provided
- Keep the existing global path for the main session (backwards compatible)
- The in-memory `current` cache will need to be scoped per-agent (or dropped for agent sessions given they run infrequently)

**Planning implication:** This is a moderate refactor — needs care to avoid breaking the main session. The cleanest approach is a second code path that doesn't touch the existing `current` module-level variable.

### 1.3 `src/runner.ts` — Needs `agentName` parameter
`execClaude` is the core function. It currently:
1. Calls `getSession()` (global) for resume
2. Calls `loadPrompts()` → loads IDENTITY.md, USER.md, SOUL.md from `prompts/`
3. Calls `getMemoryPath()` (global) and `loadMemory()` (global)
4. Passes everything via `--append-system-prompt`

For agents, the runner needs to:
- Call `getSession(agentName)` to load the agent's session
- Load `agents/<name>/IDENTITY.md`, `agents/<name>/SOUL.md`, `agents/<name>/CLAUDE.md` instead of the global prompts
- Call `loadMemory(agentName)` and `getMemoryPath(agentName)`
- `loadMemoryInstructions(agentName)` already passes the correct path

The public surface that jobs/send use is `run(name, prompt)` and `runUserMessage(name, prompt)`. These need an optional `agentName` parameter threaded through.

**Planning implication:** The agentName parameter should flow: `run(name, prompt, agentName?)` → `execClaude(name, prompt, agentName?)`. The existing `enqueue()` serial queue may need to be per-agent to avoid blocking the main session queue with agent invocations.

### 1.4 `src/jobs.ts` — Minimal change: add `agent?` field
Current `Job` interface:
```ts
interface Job {
  name: string;
  schedule: string;
  prompt: string;
  recurring: boolean;
  notify: true | false | "error";
}
```
Just add `agent?: string`. The frontmatter parser `parseFrontmatterValue` is a simple pattern — adding `agent` follows the exact same pattern as `notify` or `schedule`. The cron loop in `index.ts` (or wherever jobs are executed) needs to read `job.agent` and pass it to the runner.

**Planning implication:** Truly minimal — 1 field in the interface + 1 line in `parseJobFile` + 1 argument passthrough in the cron execution loop.

### 1.5 `src/commands/send.ts` — Add `--agent <name>` flag
The current `send` command already handles `--telegram` and `--discord` flags. The same flag-parsing pattern works for `--agent`. When `--agent` is set, pass it through to `runUserMessage(name, message, agentName)`.

**Planning implication:** Clean, simple extension — under 10 lines of new code.

### 1.6 `src/cron.ts` — Use for cron validation
`cronMatches(expr, date, offsetMinutes)` is the validator. For NL→cron, the plan should generate a candidate cron expression and then validate it parses cleanly with a test call to `cronMatches`. No changes to `cron.ts` needed.

### 1.7 `skills/create-skill/SKILL.md` — The wizard pattern to mirror
The existing skill wizard is simple:
1. Ask conversational questions (one at a time)
2. Generate a file
3. Write to disk using the Write tool

The `create-agent` skill should follow the same structure: YAML frontmatter with `name` + `description` trigger phrases, then a body with step-by-step wizard instructions. The skill markdown instructs Claude to ask questions and call primitives from `src/agents.ts` via Bash tool.

**Planning implication:** The skill file is almost entirely prose instructions. The key design choice is: does the skill file call `src/agents.ts` directly (via `bun src/agents.ts create ...`) or does it write files itself step by step? Given the scaffold is simple file generation, Claude can write files directly via the Write tool — similar to how create-skill works.

### 1.8 `prompts/IDENTITY.md` and `prompts/SOUL.md` — Templates
These are short markdown files with placeholder text. For agents:
- `IDENTITY.md` template: replace the placeholder lines with the agent's `name` and `role` from wizard inputs
- `SOUL.md` template: append or replace the core section with the agent's `personality` free-text

The templates are simple enough that the wizard can inline the rendering — no templating library needed.

---

## 2. New Module: `src/agents.ts`

This is the new module to create. Based on the CONTEXT decisions, it needs:

```ts
createAgent(opts: AgentCreateOpts): Promise<void>
  // Validates name (kebab-case, unique), creates agents/<name>/ directory,
  // writes IDENTITY.md, SOUL.md, CLAUDE.md, MEMORY.md from templates.
  // Writes .claude/claudeclaw/jobs/<name>.md if schedule provided.

loadAgent(name: string): Promise<AgentContext>
  // Returns agent context: paths to identity, soul, CLAUDE.md, memory files.
  // Used by runner.ts to build --append-system-prompt for agent invocations.

listAgents(): Promise<string[]>
  // Reads agents/ directory, returns list of agent names.

validateAgentName(name: string): { valid: boolean; error?: string }
  // Checks: kebab-case regex, not already in agents/, not empty.

parseScheduleToCron(input: string): string | null
  // NL→cron parser. Returns a valid 5-field cron expression or null.
```

The NL→cron parser is the most interesting piece. Based on the CONTEXT's "Claude's Discretion" note, a hand-rolled regex approach is preferred over adding a library dependency. Key presets to handle:

| Input | Cron |
|---|---|
| `hourly` / `every hour` | `0 * * * *` |
| `daily` / `every day at midnight` | `0 0 * * *` |
| `daily at 9am` / `every day at 9` | `0 9 * * *` |
| `daily at 5pm` | `0 17 * * *` |
| `weekly` / `every week` | `0 0 * * 0` |
| `every weekday at 9am` | `0 9 * * 1-5` |
| `every monday` | `0 0 * * 1` |
| `every 30 minutes` | `*/30 * * * *` |
| Direct cron `0 9 * * 1-5` | pass through as-is |

---

## 3. File Layout for a Scaffolded Agent

```
agents/<name>/
  IDENTITY.md    — generated from name + role
  SOUL.md        — generated from personality
  CLAUDE.md      — agent-specific role layer (NOT a full copy)
  MEMORY.md      — empty template (created by ensureMemoryFile)
  # session.json — NOT created at scaffold time, created on first run
  # .gitignore   — ignores session.json and MEMORY.md (TBD)
```

Job file (only if schedule provided):
```
.claude/claudeclaw/jobs/<name>.md
---
schedule: <cron expression>
agent: <name>
recurring: true
notify: error
---
<agent's default prompt / task description>
```

---

## 4. Session Handling Design — Key Decision

The CONTEXT says agents get their own `session.json` in `agents/<name>/`. The current `sessions.ts` has a module-level `let current: GlobalSession | null = null` cache. For agents, there are two clean options:

**Option A: Add `agentName?` parameter to all functions** — Every function takes an optional agent name and resolves the path conditionally. The cache (`current`) becomes keyed by agent name or is bypassed for agents (agents run infrequently, caching is less critical).

**Option B: Create a new `createAgentSession(agentName)` factory** — Returns a session handle scoped to that agent. Completely separate from the main session module.

Option A is simpler and preserves backwards compatibility. Option B is cleaner but more lines. Given the CONTEXT says "extend `sessions.ts`", Option A is the planned approach.

**Watch out for:** The `current` module-level cache. If the agent session is loaded while the main session is cached (or vice versa), they'll collide. The safest pattern is to NOT cache agent sessions in `current` — always read from disk for agent sessions.

---

## 5. Runner Integration — Thread-Through Pattern

The cleanest change to `runner.ts` is:

```ts
// Public API change
export async function run(name: string, prompt: string, agentName?: string): Promise<RunResult>
export async function runUserMessage(name: string, prompt: string, agentName?: string): Promise<RunResult>
```

Inside `execClaude`:
- When `agentName` is set: use `getSession(agentName)` + `loadAgentPrompts(agentName)` + `loadMemory(agentName)`
- When not set: existing code path unchanged

A new helper `loadAgentPrompts(agentName)` reads from `agents/<name>/` instead of `prompts/`. This is the cleanest separation.

**Serial queue consideration:** The current `queue` variable is global. If an agent run is enqueued alongside a main session run, they serialize unnecessarily. For Phase 16, this is acceptable — the queue can be per-agent in a future phase. The CONTEXT doesn't flag this as a concern.

---

## 6. Cron Loop Integration (index.ts / jobs)

Looking at how jobs are processed: the cron loop calls `loadJobs()` → iterates → checks `cronMatches()` → calls `run(job.name, job.prompt)`. With the `agent` field added:

```ts
// After adding agent field to Job interface:
await run(job.name, job.prompt, job.agent);  // agent is optional, undefined for regular jobs
```

This is the only change needed in the job execution path.

---

## 7. Wizard Flow — 6 Steps (from Issue #78)

The create-agent wizard must ask 6 questions conversationally:

1. **Name** — kebab-case slug (e.g. `suzy`, `daily-digest`). Validate: unique + valid format.
2. **Role** — one-line description of what the agent does (injected into IDENTITY.md).
3. **Personality** — free-text (injected into SOUL.md).
4. **Schedule** — NL input or raw cron or "none" (skip = manual-only agent).
5. **Discord channels** — which channels the agent can post to (metadata only in Phase 16 — not wired to routing yet, stored in CLAUDE.md).
6. **Data sources** — what information sources it uses (free-text, stored in CLAUDE.md for context).

After all 6 answers are collected, the wizard:
1. Validates name (unique, kebab-case)
2. Parses schedule to cron (if provided)
3. Creates `agents/<name>/` directory
4. Writes all 4 files
5. Writes job file (if schedule)
6. Confirms with path summary

**Important:** The skill markdown instructs Claude to perform the file writes using the Write tool — Claude doesn't call a binary, it writes files directly. This is the same pattern as `create-skill`.

---

## 8. CLAUDE.md Content for an Agent

The agent's `CLAUDE.md` is a role layer, not a full copy of the main `CLAUDE.md`. It should contain:

```markdown
# Agent: <name>

## Role
<role text>

## Discord Channels
<channel list or "none specified">

## Data Sources
<data sources or "none specified">
```

The agent inherits all base behavior from the project's root `CLAUDE.md` (loaded first by the runner). This avoids duplication. The layer just adds agent-specific role context.

---

## 9. Testing Strategy

The CONTEXT specifies:
- Unit tests for `src/agents.ts` in `src/__tests__/agents.test.ts`
- Integration test: programmatically create an agent, verify file structure
- Manual wizard test: end-to-end before PR is marked complete

The Bun test runner is already in use across the project (`bun:test`). Test patterns from existing files like `retry-queue.test.ts` and the gateway tests show the convention: `describe` blocks, `beforeEach` cleanup of real data directories, `afterEach` cleanup.

For `agents.ts` tests, the pattern should:
- Use `tmp_` prefixed directories or `mkdtemp` to avoid polluting `agents/`
- Test `validateAgentName` with valid/invalid names
- Test `parseScheduleToCron` with the full preset table
- Test `createAgent` end-to-end with a real temp directory
- Test `listAgents` with an empty/populated directory

---

## 10. PR Scope Summary

Files to create/modify for the PR:

| File | Action | Notes |
|---|---|---|
| `src/agents.ts` | Create | Core scaffolding module |
| `src/sessions.ts` | Modify | Add `agentName?` to getSession/createSession |
| `src/runner.ts` | Modify | Add `agentName?` to run/runUserMessage/execClaude |
| `src/jobs.ts` | Modify | Add `agent?: string` to Job interface |
| `src/commands/send.ts` | Modify | Add `--agent <name>` CLI flag |
| `skills/create-agent/SKILL.md` | Create | Wizard skill markdown |
| `src/__tests__/agents.test.ts` | Create | Unit + integration tests |
| `index.ts` (or job runner) | Modify | Pass `job.agent` to run() |

NOT included in PR: `.planning/` directory, existing agent scripts on Hetzner.

---

## 11. Key Risks and Gotchas

1. **sessions.ts cache collision** — The module-level `current` variable caches the global session. If agent sessions use the same variable, a race condition can corrupt the global session. Solution: agent sessions must bypass `current` and always read/write from disk.

2. **runner.ts size** — Already ~900 lines. Adding the agentName parameter path will add complexity. Consider whether `loadAgentPrompts()` should be a clearly-separate helper to keep `execClaude` readable.

3. **NL→cron parser edge cases** — "every weekday" vs "every weekday at 9am" — the parser needs to handle time parsing (12h vs 24h, "9am" vs "9:00 AM") as well as day patterns. Keep the preset list explicit; don't try to be exhaustive. Unmatchable inputs return `null` and the wizard asks the user to provide a raw cron expression.

4. **Write permissions for `agents/<name>/`** — Since `agents/` lives in project root (not `.claude/`), Claude's Write tool can create files there. This is already confirmed by the memory.ts design.

5. **`session.json` in agents dir** — This file should be in `.gitignore`. The wizard (or `createAgent`) should write a `.gitignore` in `agents/<name>/` with `session.json` and `MEMORY.md` ignored — these are ephemeral/local state.

6. **Backwards compatibility** — All changes to `sessions.ts`, `runner.ts`, `jobs.ts`, and `send.ts` must be strictly additive with optional parameters. The existing test suite (574 passing) must stay green.

---

## 12. Plan Breakdown Preview

Based on this research, Phase 16 should break into these plans:

| Plan | Description | Key Files |
|---|---|---|
| 16-01 | `src/agents.ts` core module + unit tests | agents.ts, agents.test.ts |
| 16-02 | sessions.ts + runner.ts agent support | sessions.ts, runner.ts |
| 16-03 | jobs.ts + index.ts + send.ts wiring | jobs.ts, send.ts, index.ts |
| 16-04 | `skills/create-agent/SKILL.md` wizard | SKILL.md |
| 16-05 | Integration verification + PR | agents.test.ts (integration), PR |

Alternatively, 16-01 through 16-03 could be merged into a single "backend" plan and 16-04 + 16-05 kept separate, for a 3-plan phase. This is a planning decision — the key constraint is that the skill (16-04) depends on all backend work being done first.

---

*Research complete. Ready for /gsd:plan-phase 16.*
