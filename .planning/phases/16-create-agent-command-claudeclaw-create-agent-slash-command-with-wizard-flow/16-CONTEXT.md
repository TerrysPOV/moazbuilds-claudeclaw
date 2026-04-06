# Phase 16: Create Agent Command - Context

**Gathered:** 2026-04-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement `/claudeclaw:create-agent` slash command — a guided wizard that scaffolds persistent agent teammates (e.g. "Suzy") with their own identity, memory, optional cron schedule, and Claude session. Agents are first-class teammates, not throwaway sub-agents: each has its own session, context files, and can be invoked ad-hoc or via scheduled jobs.

Out of scope:
- Migrating existing standalone scripts (Suzy currently lives as `~/project/suzy-digest*.ts` shell scripts on the Hetzner server — not an agent in the architectural sense, treated as motivating example only).
- Building actual content-sourcing agents — this phase delivers the *creation tool* only.
- Discord/Telegram routing logic for agents — adapters already exist; agent-specific channel posting can land later.

</domain>

<decisions>
## Implementation Decisions

### Wizard flow & questions
- **6 wizard steps as per issue #78**: name, role, personality, schedule, discord channels, data sources
- **Schedule UX**: natural-language parsing — accept inputs like "every weekday at 9am", "daily at 5pm", "every hour" and parse into cron expression. Needs a small NL→cron parser.
- **Personality**: free-text description, injected directly into agent's SOUL.md
- **Validation**: validate critical fields before scaffolding
  - Name: unique (not already in `agents/`), valid kebab-case
  - Cron: must parse successfully (use existing `cron.ts` `cronMatches` for sanity check)
  - Schedule preset/NL string: must resolve to a valid cron expression
- Wizard runs conversationally — Claude reads SKILL.md and asks each question in turn, similar to existing `skills/create-skill/SKILL.md` pattern

### Scaffolded output
- **Agent path**: `agents/<name>/` in project root (matches existing `memory.ts` `AGENTS_MEMORY_DIR` convention — avoids `.claude/` write restrictions)
- **Files generated**:
  ```
  agents/<name>/
    IDENTITY.md    — generated from name + role (template from prompts/IDENTITY.md)
    SOUL.md        — generated from personality (template from prompts/SOUL.md)
    CLAUDE.md      — agent-specific role/instructions only (NOT a full copy)
    MEMORY.md      — empty template (matches existing memory.ts MEMORY_TEMPLATE)
    session.json   — created on first invocation, not at scaffold time
  ```
- **CLAUDE.md is a layer**, not a full standalone file — loaded via `--append-system-prompt` alongside project CLAUDE.md. Base behaviour shared, agent role layered on top. Avoids duplication and drift.
- **Job file**: only created if user provides a schedule. No schedule = no job file = agent is invokable manually but doesn't auto-run.
- **Job file location**: `.claude/claudeclaw/jobs/<name>.md` with `agent: <name>` frontmatter field
- **No Suzy migration**: Suzy is a standalone shell-script setup, not an architectural agent. This phase ships the creation tool — migrating Suzy is a separate optional follow-up.

### Agent session lifecycle
- **Reuse `runner.ts`** with optional `agentName` parameter
  - When `agentName` is set: load `agents/<name>/session.json` instead of root `.claude/claudeclaw/session.json`
  - Load `agents/<name>/IDENTITY.md`, `SOUL.md`, `CLAUDE.md`, `MEMORY.md` and inject via `--append-system-prompt`
  - Session created on first invocation via `claude -p` (no `--resume`), stored in `agents/<name>/session.json`
  - Subsequent invocations use `--resume <agentSessionId>` for persistent conversation
- **Sessions module**: extend `sessions.ts` to support agent-scoped session paths (`getSession(agentName?)`, `createSession(sessionId, agentName?)`)
- **Memory**: already supported — `memory.ts` `getMemoryPath(agentName)` already returns `agents/<name>/MEMORY.md`
- **Job → agent linking**: extend `Job` interface in `jobs.ts` with optional `agent?: string` field. When set, runner loads agent's session/context. Jobs without `agent` field continue to use main session (backwards compatible).
- **Ad-hoc invocation**: add `claudeclaw send --agent <name> '<message>'` CLI flag (extend existing `src/commands/send.ts`). Lets user query an agent anytime, not just on schedule.

### Skill implementation
- **Skill location**: `skills/create-agent/SKILL.md` — same pattern as `skills/create-skill/`. Project-level, ships with claudeclaw, auto-discovered by `skills.ts` loader.
- **Runtime module**: new `src/agents.ts`
  - `createAgent(opts)` — scaffolds files, validates inputs
  - `loadAgent(name)` — returns agent context for runner
  - `listAgents()` — enumerate `agents/` directory
  - `validateAgentName(name)` — kebab-case + uniqueness check
  - `parseScheduleToCron(input)` — NL→cron parser
- **Skill markdown** is the wizard prompt + flow instructions; calls into `src/agents.ts` primitives via Bash/Write tools that Claude executes
- **Testing**:
  - **Unit tests** for `src/agents.ts` (validation, scaffolding, NL cron parsing) using existing Bun test setup in `src/__tests__/`
  - **Integration test**: programmatically create an agent and verify the full file structure
  - **Manual wizard validation**: end-to-end test of the wizard flow before phase is marked complete (test plan in PR)

### Claude's Discretion
- Exact NL→cron parser implementation (regex vs library — keep dependencies minimal, prefer hand-rolled if feasible)
- Default personality template wording when user gives sparse input
- Cron preset list (which canonical schedules to recognise: "daily", "hourly", "weekdays", "weekly", etc.)
- Error message phrasing for validation failures
- Whether `agents/<name>/` itself contains a `.gitignore` (likely yes, ignoring `session.json` and `MEMORY.md`)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/skills.ts` — skill loader, will auto-discover `skills/create-agent/SKILL.md` with no changes
- `skills/create-skill/SKILL.md` — reference pattern for wizard-style skills (conversational Q&A → file generation)
- `src/memory.ts` — already has `getMemoryPath(agentName)`, `ensureMemoryFile(agentName)`, `loadMemory(agentName)`. AGENTS_MEMORY_DIR is `agents/` in project root. Memory infrastructure is done.
- `src/sessions.ts` — session persistence pattern (load/save JSON, lazy init). Needs extension for per-agent sessions but the pattern is solid.
- `src/runner.ts` — already loads MEMORY via `--append-system-prompt`, runs `claude -p`, manages turn counts. Needs an `agentName` parameter to swap session/context source.
- `src/jobs.ts` — frontmatter parser, `Job` interface. Needs new optional `agent` field.
- `src/cron.ts` — `cronMatches`, `nextCronMatch`. Use for validating parsed cron expressions.
- `prompts/IDENTITY.md`, `prompts/SOUL.md` — templates to base agent IDENTITY/SOUL on.

### Established Patterns
- **Wizards as skills**: `skills/create-skill/SKILL.md` shows the pattern — conversational, asks questions, generates files. Mirror this for create-agent.
- **Frontmatter `.md` files for config**: jobs, skills, prompts all use YAML frontmatter + markdown body. Agent files follow the same convention.
- **Bun test runner** (`src/__tests__/`): use `bun:test` for new agent tests.
- **Memory lives in project root** (not `.claude/`) due to Claude Code Write tool restrictions on `.claude/` paths — already documented in `memory.ts:14-16`. Agents follow the same constraint.

### Integration Points
- `src/skills.ts` collectSkillsFromDir → discovers new skill automatically
- `src/runner.ts` → needs `agentName` parameter threaded through
- `src/sessions.ts` → needs agent-scoped session paths
- `src/jobs.ts` → `Job` interface gets optional `agent` field; cron loop in `index.ts` reads `agent` and routes to agent-aware runner
- `src/commands/send.ts` → add `--agent` CLI flag for ad-hoc invocation
- `prompts/` → IDENTITY.md and SOUL.md serve as templates the wizard renders into agent dirs

</code_context>

<specifics>
## Specific Ideas

- **Suzy is the spiritual prototype** — the wizard should make creating Suzy-like agents trivial. Daily content sourcer, posts to Discord, has a personality, runs on cron. If we can scaffold "Suzy v2" via the wizard in under 2 minutes, we've nailed it.
- **Issue #78 in moazbuilds/claudeclaw** is the source spec — anything in this CONTEXT.md takes precedence where they conflict, but the issue's UX vision is the north star.
- **Dependency on PR #77 (memory system)**: agent memory infrastructure already merged. PR #72 (governance) handles model routing/budget for agent invocations.
- **Wizard tone**: should match the create-skill wizard's conversational vibe — friendly, asks one thing at a time, doesn't dump a wall of questions.
- **PR scope**: the upstream PR will include `src/agents.ts`, `src/sessions.ts` changes, `src/runner.ts` changes, `src/jobs.ts` changes, `src/commands/send.ts` changes, `skills/create-agent/SKILL.md`, and `src/__tests__/agents.test.ts`. **NOT** included: `.planning/` directory (GSD planning artifacts stay local).

</specifics>

<deferred>
## Deferred Ideas

- **Suzy migration** — converting the existing Hetzner shell-script setup into a proper agent. Optional follow-up after this phase ships.
- **Agent-specific Discord/Telegram routing** — having an agent post to a specific channel automatically based on its IDENTITY. Adapters already exist; can be wired in a later phase.
- **Agent listing UI in web dashboard** — `claudeclaw web` could show registered agents. Out of scope.
- **Agent templates / agent marketplace** — pre-built agent recipes users can install. Future phase.
- **`/claudeclaw:edit-agent` and `/claudeclaw:delete-agent`** — lifecycle commands beyond creation. Future phase.
- **Multi-agent conversations** — agents talking to each other. Far future.

</deferred>

---

*Phase: 16-create-agent-command-claudeclaw-create-agent-slash-command-with-wizard-flow*
*Context gathered: 2026-04-06*
