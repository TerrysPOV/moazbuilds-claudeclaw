---
phase: 17-multi-job-agents-wizard-workflow-field-update-agent-command
plan: gap-02
type: execute
wave: 1
depends_on: []
files_modified:
  - src/commands/fire.ts
  - src/index.ts
  - src/__tests__/fire.test.ts
  - src/adapters/discord.ts
  - src/adapters/telegram.ts
  - src/web/server.ts
autonomous: true
gap_closure: true
requirements: [FIRE-01]
must_haves:
  truths:
    - "Running `claudeclaw fire <agent>:<label>` (or `claudeclaw fire <agent> <label>`) loads the matching agent job and runs it once via the same code path as the cron loop"
    - "If the agent or label doesn't exist, fire exits non-zero with a clear error naming the missing piece"
    - "Job output streams to stdout in real time"
    - "Discord slash command `/fire <agent>:<label>` triggers the same fire path and posts completion to the originating channel"
    - "Telegram slash command `/fire <agent>:<label>` triggers the same fire path"
    - "Web UI exposes a 'Fire now' button on each agent job entry that POSTs to /api/jobs/fire and returns the job result"
  artifacts:
    - path: src/commands/fire.ts
      provides: "fireJob(agent, label) helper that loads job from agents/<agent>/jobs/<label>.md and invokes runner.run() once"
      exports: ["fireJob", "runFireCommand"]
      min_lines: 40
    - path: src/__tests__/fire.test.ts
      provides: "Unit tests covering: success path, missing agent, missing label, disabled job (still fireable manually), output streaming"
      min_lines: 60
    - path: src/index.ts
      provides: "CLI subcommand wiring for `fire` arg"
      contains: "fire"
  key_links:
    - from: "src/commands/fire.ts"
      to: "src/runner.ts run()"
      via: "direct call with agent name + job prompt"
      pattern: "run\\("
    - from: "src/commands/fire.ts"
      to: "src/jobs.ts loadJobs()"
      via: "filter to matching agent+label"
      pattern: "loadJobs"
    - from: "src/index.ts"
      to: "src/commands/fire.ts"
      via: "subcommand dispatch"
      pattern: "from.*commands/fire"
    - from: "src/adapters/discord.ts /fire handler"
      to: "src/commands/fire.ts fireJob"
      via: "import and call on slash command match"
      pattern: "fireJob"
    - from: "src/adapters/telegram.ts /fire handler"
      to: "src/commands/fire.ts fireJob"
      via: "import and call on slash command match"
      pattern: "fireJob"
    - from: "src/web/server.ts POST /api/jobs/fire"
      to: "src/commands/fire.ts fireJob"
      via: "endpoint handler"
      pattern: "fireJob"
---

<objective>
Add a manual `claudeclaw fire <agent>:<label>` command that fires a single agent job immediately, using the same code path as the cron loop. Surface it via CLI, Discord slash, Telegram slash, and a Web UI button. Closes GAP-17-05 — currently the only way to test a new job is wait for cron or shell out to a manual `bun -e` invocation.

Purpose: Every new agent currently requires a 1-minute-to-24-hour wait before you can verify it works. There's no way to re-run a failed job, smoke-test a job during development, or fire a job on demand. This is operationally painful and was flagged immediately during Reg UAT.

Output: New `src/commands/fire.ts` module with `fireJob()` and `runFireCommand()`, CLI wiring in `src/index.ts`, slash command handlers in Discord/Telegram adapters, web UI endpoint + button.
</objective>

<execution_context>
@/Users/terrenceyodaiken/.claude/get-shit-done/workflows/execute-plan.md
@/Users/terrenceyodaiken/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/phases/17-multi-job-agents-wizard-workflow-field-update-agent-command/17-GAPS.md
@.planning/phases/17-multi-job-agents-wizard-workflow-field-update-agent-command/17-04-SUMMARY.md
@src/jobs.ts
@src/runner.ts
@src/index.ts
@src/commands/start.ts
@src/adapters/discord.ts
@src/adapters/telegram.ts
@src/web/server.ts

The cron loop in `src/commands/start.ts` (line ~720 setInterval) fires jobs by iterating `loadJobs()` results and calling `run(job.name, job.prompt, job.agent)`. The fire command must replicate this exact pattern to keep storage/exec format consistent (per GAP-17-08 lesson — parallel formats cause silent breakage).

`loadJobs()` (Phase 17 plan 4) already scans `agents/*/jobs/*.md` and returns Job records with `name`, `agent`, `label`, `prompt`, `enabled`. Reuse it — do NOT write a parallel parser.

For Discord/Telegram slash command registration, find the existing slash command dispatch table (likely a switch on command name) and add `fire` alongside the existing `/reset`, `/status`, etc. handlers.

For the Web UI, find the existing job-listing endpoint (likely `/api/jobs` or similar) — add a "Fire now" button to the rendered job rows and a new POST `/api/jobs/fire` endpoint that calls `fireJob`. Respect existing CSRF token validation pattern from Phase 14 (`SEC-04`).
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Create fire.ts module with TDD coverage</name>
  <files>src/commands/fire.ts, src/__tests__/fire.test.ts</files>
  <behavior>
    - Test: fireJob("reg", "daily-research") on a real agent dir loads the matching job and calls run() with the job's prompt + agent name
    - Test: fireJob throws clear error if agents/<agent>/ does not exist ("agent 'foo' not found")
    - Test: fireJob throws clear error if agents/<agent>/jobs/<label>.md does not exist ("job 'foo:bar' not found")
    - Test: fireJob can fire a disabled job (enabled: false) — manual fire bypasses the enabled filter
    - Test: fireJob accepts both `agent:label` and `agent label` invocation forms (parsed by runFireCommand)
    - Test: runFireCommand returns exit code 0 on success, 1 on agent missing, 1 on label missing, 2 on usage error
  </behavior>
  <action>
Write failing tests in `src/__tests__/fire.test.ts` first. Use the existing test fixtures pattern from `src/__tests__/jobs.test.ts` (tmp dirs, agent scaffolding via `createAgent` + `addJob`).

Then implement `src/commands/fire.ts`:

```typescript
import { loadJobs, type Job } from "../jobs.ts";
import { run } from "../runner.ts";
import path from "path";
import fs from "fs/promises";

export async function fireJob(agent: string, label: string): Promise<{ exitCode: number; output?: string }> {
  // 1. Validate agent dir exists
  // 2. Load all jobs (loadJobs already filters disabled — for fire we need to bypass)
  // 3. Find job matching agent + label (read agents/<agent>/jobs/<label>.md directly to bypass enabled filter)
  // 4. Parse frontmatter + body using same parser as jobs.ts (import or duplicate minimally)
  // 5. Call run(jobName, prompt, agent) — same signature as cron loop
  // 6. Return exit code
}

export async function runFireCommand(args: string[]): Promise<number> {
  // Parse `agent:label` or `agent label`, dispatch to fireJob, return exit code
}
```

Key constraint: `loadJobs()` filters disabled jobs at load time. For manual fire we MUST bypass this — read the job file directly. Either (a) export an unfiltered `loadJobsRaw()` from jobs.ts and reuse, or (b) read the file directly in fire.ts using the same frontmatter parser. Prefer (a) to avoid duplication — add `loadAgentJobsUnfiltered(agentName)` to jobs.ts as a small helper.

Wire output streaming via the runner's existing stdout pipe (the cron loop already does this — copy that pattern from start.ts).

Return JSON-friendly result for the adapter/web callers, plus a CLI-friendly text path for runFireCommand.
  </action>
  <verify>
    <automated>bun test src/__tests__/fire.test.ts</automated>
  </verify>
  <done>All fire.test.ts tests pass. fireJob() reuses loadJobs/run code paths (no parallel parser). Disabled-job override works.</done>
</task>

<task type="auto">
  <name>Task 2: Wire fire subcommand into CLI entry point</name>
  <files>src/index.ts</files>
  <action>
Read `src/index.ts` to find the existing subcommand dispatch (start, send, reset, etc.). Add a `fire` case that calls `runFireCommand(process.argv.slice(3))` and exits with the returned code.

Update the help text to document:
```
claudeclaw fire <agent>:<label>     Fire an agent job once, immediately
claudeclaw fire <agent> <label>     Same, alternate form
```

If the user runs `claudeclaw fire` with no args or malformed args, print usage and exit 2.
  </action>
  <verify>
    <automated>bun src/index.ts fire 2>&1 | grep -q "fire" && bun src/index.ts --help 2>&1 | grep -q "fire"</automated>
  </verify>
  <done>`claudeclaw fire` is a documented subcommand. Help text mentions it. Malformed invocation exits 2 with usage.</done>
</task>

<task type="auto">
  <name>Task 3: Wire fire into Discord, Telegram, and Web UI surfaces</name>
  <files>src/adapters/discord.ts, src/adapters/telegram.ts, src/web/server.ts</files>
  <action>
**Discord (`src/adapters/discord.ts`):**
Find the slash command handler dispatch (look for `/reset`, `/status` handling). Add a `/fire <agent>:<label>` case:
- Parse the argument
- Call `fireJob(agent, label)` from `src/commands/fire.ts`
- Reply in the originating channel with start message ("Firing reg:daily-research...")
- After completion, reply with the result summary (success/failure + first 1500 chars of output)
- On error (agent/job missing) reply with the error message

**Telegram (`src/adapters/telegram.ts`):**
Same pattern as Discord. Find the existing `/reset` or `/status` slash handler. Add `/fire` parsing and dispatch to `fireJob`.

**Web UI (`src/web/server.ts`):**
1. Find the existing jobs listing endpoint (likely `/api/jobs` GET). For each agent job in the response, ensure the JSON includes `agent` and `label` fields so the client can construct a fire request.
2. Add a new endpoint: `POST /api/jobs/fire` accepting `{ agent: string, label: string }` in the body. Validate CSRF token using the same pattern as `/api/jobs/quick` and other Phase 14 endpoints. Call `fireJob` and return `{ success, output, error }`.
3. In the existing job-list template (look for the HTML rendering or client-side JS that builds the job table), add a "Fire now" button per row that POSTs to `/api/jobs/fire` with the agent + label of that row. Show a toast / inline result block on completion.

Respect the existing patterns — do not introduce new HTTP frameworks, do not bypass CSRF, do not break existing endpoints. The Web UI button is the lowest-priority piece; if the existing UI is server-rendered HTML and adding a button is invasive, a minimal `<form method="POST" action="/api/jobs/fire">` per row is acceptable.
  </action>
  <verify>
    <automated>grep -q "fireJob" src/adapters/discord.ts && grep -q "fireJob" src/adapters/telegram.ts && grep -q "/api/jobs/fire" src/web/server.ts && grep -q "fireJob" src/web/server.ts</automated>
  </verify>
  <done>All three surfaces import and call fireJob. CSRF token validated on the web endpoint. Discord/Telegram replies wired to originating channel.</done>
</task>

</tasks>

<verification>
- `bun test src/__tests__/fire.test.ts` passes (all behaviors)
- Full test suite shows no new regressions (baseline 13 pre-existing failures from STATE.md should stay constant)
- `claudeclaw fire reg:daily-content-research` on the Hetzner server fires the live Reg job (manual UAT check, separate from this plan's automated verification)
</verification>

<success_criteria>
- GAP-17-05 verification gate item in 17-GAPS.md can be ticked
- Manual fire works from CLI, Discord, Telegram, and Web UI
- No parallel job parser created (reuses jobs.ts loaders)
- Disabled jobs can still be fired manually
</success_criteria>

<output>
After completion, create `.planning/phases/17-multi-job-agents-wizard-workflow-field-update-agent-command/17-gap-02-SUMMARY.md`.
</output>
