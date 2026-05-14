---
name: create-agent
description: Use when the user wants to create a new agent teammate, scaffold a scheduled Claude persona, or asks to "create an agent", "new agent", "add an agent", "add a job", "scheduled task", "scaffold an agent", "build an agent", "make an agent", or "/claudeclaw:create-agent". Trigger phrases include "I want an agent that", "create a teammate", "new agent persona", "scheduled claude agent".
---

# Create Agent

Wizard for scaffolding a new ClaudeClaw agent — a focused Claude persona with its own identity, soul, memory, session, and any number of scheduled jobs.

You are guiding the user through creating a teammate. Be conversational, warm, and direct. **Ask one question at a time.** Wait for the answer before moving on. **DO NOT dump all questions at once.** This is a wizard, not a form.

## Echo before asking

At the start of EVERY question after Q1, repeat the previously captured value back to the user so they know it landed. Format: `Got it — <field>: "<value>". Next: <next question>`. For multi-line values (workflow, personality), echo a 1-line summary like `Got it — workflow captured (NN words). Next: ...`.

## State persistence

After EACH answer is captured, write the full in-progress wizard state to `/tmp/claudeclaw-agent-wizard.json` via a `bun -e` snippet. Do NOT wait until scaffold time. If the network glitches or context resets, the next session can resume by reading this file. The snippet:

```js
const fs = await import("fs/promises");
await fs.writeFile("/tmp/claudeclaw-agent-wizard.json", JSON.stringify(state, null, 2));
```

## Tone

Match the vibe of `skills/create-skill/SKILL.md`: friendly, brief, opinionated. You're texting a friend who happens to be brilliant. No filler, no walls of text. Acknowledge each answer in a sentence or less, then move to the next question.

## The Questions

Ask these in order, one at a time.

### 1. Name (kebab-case)

Ask: "What should we call them? (kebab-case — lowercase, hyphens only, like `daily-digest` or `suzy-v2`)"

**Validate immediately.** Run this in a Bash tool call:

```bash
bun -e 'const {validateAgentName} = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`); console.log(JSON.stringify(validateAgentName("USER_INPUT")));'
```

If `valid: false`, tell the user the error in one line and re-ask. Common rejects: capitals (`Suzy`), spaces, starting with a digit, or the agent already existing.

### 2. Role (one line)

Ask: "What does this agent do? One line — what's their job?"

Free text. Goes into IDENTITY.md.

### 3. Personality (2–4 sentences)

Ask: "Who are they? Give me 2–4 sentences on their personality and vibe."

Free text. Becomes the Personality section of SOUL.md.

### 4. Workflow (multi-line)

Ask: "How does this agent operate? What are their guidelines, tone, do's and don'ts? This can be as long as you want — write it like a mini operating manual."

This is a **dedicated multi-line field**, separate from any schedule. It becomes the `## Workflow` block in SOUL.md. If the answer is gnarly or long, write it to a temp file (e.g. `/tmp/claudeclaw-agent-workflow.txt`) so escaping doesn't bite you later.

### 5. Discord channels

Ask: "Any Discord channels they should know about? Comma-separated (`#content,#research`) or `none`."

Parse comma-separated into an array. `none` → empty array.

### 6. Data sources

Ask: "What information sources do they pull from? (RSS feeds, APIs, files, websites — free text, or `none`)"

Free text.

### 7. Default model (optional)

Ask: "What model should this agent use by default? Options: `default` (daemon setting), `opus`, `sonnet`, `haiku`, `glm`. Individual jobs can still override this per-task."

If the user picks anything other than `default` (or presses enter), capture it as `defaultModel`. This becomes the agent's middle-tier fallback: job frontmatter `model:` wins, then this agent default, then the daemon setting.

### 8. Scheduled tasks (loop)

> **IMPORTANT — Jobs are LOCAL cron.** Scheduled tasks here are managed by ClaudeClaw's in-process cron loop (`src/jobs.ts` → `src/commands/start.ts setInterval`). They are NOT the remote `schedule` skill (which uses cloud triggers like Vercel cron). Do NOT invoke the `schedule` skill from this wizard. All job files live at `agents/<name>/jobs/<label>.md` with `schedule:` frontmatter and are loaded by `loadJobs()` on the running daemon.

Ask: "Want to add a scheduled task? (y/n)"

If `n`, skip to scaffold. If `y`, run this loop until the user is done:

**Single-job workflow reuse:** If the user provided a non-empty Workflow (Q4) AND this is the first scheduled task AND the user does not add a second task, do NOT ask for a trigger prompt for this job. Default the trigger prompt to the literal string `Run the workflow defined in SOUL.md`. Then ask: `Want to override the trigger prompt for this job? (y/n, default n)`. Only prompt for a custom trigger if the user answers `y`.

Multi-job agents (2+ scheduled tasks) still need per-job trigger prompts as before — different jobs do different things.

For each task:

1. **Label** — "Label for this task? (kebab-case, e.g. `digest-scan`, `morning-brief`)". Validate via:
   ```bash
   bun -e 'const {validateJobLabel} = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`); console.log(JSON.stringify(validateJobLabel("USER_INPUT")));'
   ```
2. **When** — "When should it run? Natural language (`every weekday at 9am`, `daily at 6pm`, `every 4 hours`) or raw cron." Validate via:
   ```bash
   bun -e 'const {parseScheduleToCron} = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`); console.log(parseScheduleToCron("USER_INPUT"));'
   ```
   If `null`, re-ask with examples.
3. **Recurring or one-shot** — "Should this fire on every schedule tick, or just once?"
   - Use **AskUserQuestion** with options: `Recurring (cron)` (default) and `One-shot (fire once, then clear schedule)`.
   - Set `recurring: true` for `Recurring`, `recurring: false` for `One-shot`.
   - **Why this matters:** `src/jobs.ts:clearJobSchedule()` strips the `schedule:` line on the first fire of any job without `recurring: true`, converting it to a one-shot. A wizard job that the user expects to recur (the common case) MUST be written with `recurring: true` or it silently becomes a one-shot after the first run. Setting this explicitly is the fix for the silent-strip footgun.
4. **Trigger prompt** — "What should the agent do when this fires? (multi-line ok — write to a temp file if helpful)"
5. **Model** — "Which model? (`default` / `opus` / `haiku` — press enter for default)"

Then: "Add another task? (y/n)" — loop or break out.

## Review before scaffolding

Print a complete review of every captured answer (name, role, personality summary, workflow word count, discord channels, data sources, and each scheduled task with its label/cron/trigger). Then ask: `Scaffold this agent? (y/n, or 'edit <field>' to amend)`. If the user types `edit <field>`, jump back to that question; if `y`, proceed; if `n`, abort and unlink the temp state file.

## Scaffold

Once all answers are in and the user confirmed the review block, **write them to a temp JSON file** to keep escaping sane, then call the helpers in one shot. Mirror Phase 16's temp-file pattern.

```bash
# 1. Write the collected wizard state (use the Write tool for the temp file).
#    /tmp/claudeclaw-agent-wizard.json shape:
#    {
#      "name": "...",
#      "role": "...",
#      "personality": "...",
#      "workflow": "...",
#      "discordChannels": ["#a","#b"],
#      "dataSources": "...",
#      "defaultModel": "opus",   // optional — omit for daemon default
#      "jobs": [
#        { "label": "digest-scan", "cron": "0 9 * * *", "recurring": true, "trigger": "...", "model": "opus" },
#        ...
#      ]
#    }

# 2. Scaffold + add jobs in one bun -e:
bun -e '
import { readFileSync } from "fs";
const { createAgent, addJob } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
const cfg = JSON.parse(readFileSync("/tmp/claudeclaw-agent-wizard.json", "utf8"));
const ctx = await createAgent({
  name: cfg.name,
  role: cfg.role,
  personality: cfg.personality,
  workflow: cfg.workflow,
  discordChannels: cfg.discordChannels,
  dataSources: cfg.dataSources,
  defaultModel: cfg.defaultModel,
});
for (const job of cfg.jobs) {
  // Pass recurring through so the wizard does not silently produce one-shot jobs.
  // addJob defaults to recurring=true if omitted, but the wizard must capture the
  // user choice explicitly per the Q3 step above.
  await addJob(ctx.name, job.label, job.cron, job.trigger, job.model, job.recurring ?? true);
}
console.log(JSON.stringify({ agent: ctx.name, jobs: cfg.jobs.map(j => j.label) }, null, 2));
'
```

Notes:
- `createAgent()` handles IDENTITY.md, SOUL.md (Personality + Workflow markers), CLAUDE.md, MEMORY.md, session.json, .gitignore.
- `addJob()` writes each scheduled task to `agents/<name>/jobs/<label>.md` with frontmatter (label, cron, recurring, enabled, model). When `recurring: true` (the wizard default), the daemon preserves the schedule across fires. When `recurring: false`, the daemon clears the schedule on first fire (one-shot).
- **Do not use the Write tool to write any of the agent files** — let the helpers do it. The only file you write is the temp JSON.
- If there are zero jobs, the loop just doesn't execute and the agent is ad-hoc only.

## On Success

Print a short summary:

```
✓ Agent <name> created.

Files:
  agents/<name>/IDENTITY.md
  agents/<name>/SOUL.md          ← personality + workflow
  agents/<name>/CLAUDE.md
  agents/<name>/MEMORY.md
  agents/<name>/jobs/<label>.md  ← one per scheduled task

Try it:
  claudeclaw send --agent <name> "say hello"
```

If any jobs were scheduled, list them with their cron + model. Mention the daemon hot-reloads jobs on the next tick.

Then ask if they want to tweak IDENTITY.md or SOUL.md before they take it for a spin.

## On Failure

If `createAgent()` or `addJob()` throws (duplicate name, bad schedule, fs error), surface the error verbatim, suggest a fix, and offer to retry from the failing step. Don't restart the whole wizard — the temp JSON still has the state.
