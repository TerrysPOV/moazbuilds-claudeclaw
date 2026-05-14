---
name: update-agent
description: Use when the user wants to modify an existing agent — change personality, workflow, add or edit a scheduled job, update Discord channels, swap a job's model, or delete the agent. Trigger phrases include "update an agent", "edit agent", "modify agent", "change agent", "/claudeclaw:update-agent", "add a job to <agent>", "remove job from <agent>", "delete agent <name>".
---

# Update Agent

This skill walks the user through updating an existing agent without losing its accumulated MEMORY.md state.

## Invariants (READ THIS FIRST)

> **NEVER read or write `agents/<name>/MEMORY.md`.** It's the agent's accumulated state — preserving it across edits is the entire point of this skill.
>
> **NEVER touch `agents/<name>/session.json`.** Same reason.
>
> The **only** exception is the "Delete agent" menu option, which removes the entire `agents/<name>/` directory by design.
>
> All edits go through helpers in `src/agents.ts` — they're full-file rewrites with marker-aware patching. Do not hand-edit SOUL.md or CLAUDE.md with the Edit tool.

## Tone

Friendly, brief, opinionated. Same vibe as `create-agent`. Acknowledge each answer in a sentence or less and move on.

## Flow

### Step 1 — List agents

If `$ARGUMENTS` already names an agent, skip to Step 3. Otherwise:

```bash
bun -e 'const { listAgents } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`); console.log((await listAgents()).join("\n"));'
```

Show the list and ask "Which one?".

### Step 2 — Pick agent

Capture the chosen name. Validate it exists in the list above.

### Step 3 — Show current state

```bash
bun -e '
const { loadAgent, listAgentJobs } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
const ctx = await loadAgent("AGENT_NAME");
const jobs = await listAgentJobs("AGENT_NAME");
console.log("SOUL.md (head):");
console.log((await Bun.file(ctx.soulPath).text()).split("\n").slice(0,30).join("\n"));
console.log("\nJobs:");
for (const j of jobs) console.log(`  - ${j.label} (${j.cron}) ${j.enabled ? "" : "[disabled]"} ${j.model ? "model="+j.model : ""}`);
'
```

### Step 4 — Menu loop

Present this menu and **loop until the user picks Done**. One selection at a time.

```
1. Workflow         — rewrite the agent's operating manual
2. Personality      — rewrite the personality block
3. Add job          — add a new scheduled task
4. Edit job         — change cron / trigger / enabled / model on an existing job
5. Remove job       — delete a scheduled task
6. Discord channels — re-set the channel list
7. Data sources     — rewrite the data sources block
8. Default model    — set or clear the agent's defaultModel (opus/sonnet/haiku/glm — middle fallback tier)
9. Delete agent     — nuke the entire agent directory (requires re-typing the name)
10. Done            — exit
```

For each option, ask the relevant follow-up question(s), then run the matching `bun -e` invocation. Use temp JSON files for any multi-line content (workflow, personality, trigger prompts) to keep escaping sane.

> **IMPORTANT — Jobs are LOCAL cron.** The Add/Edit/Remove job options below operate on `agents/<name>/jobs/<label>.md` files which are scanned by `loadJobs()` and fired by ClaudeClaw's in-process cron loop. They are NOT the remote `schedule` skill. Do NOT invoke the `schedule` skill from this wizard.

#### Mode selection (Options 1, 2, 7)

Before collecting new content for Workflow / Personality / Data sources, ask:

```
How should this be applied?
  a. Append        — add to the existing <section> (keeps everything already there) [DEFAULT]
  b. Replace       — wipe and rewrite the entire block
  c. Show current  — print the current content first, then ask again
```

If the user picks `a` or just hits enter → use `mode: "append"` (default — non-destructive).
If `b` → use `mode: "replace"`.
If `c` → read the current marker block from SOUL.md (Workflow/Personality) or CLAUDE.md (Data sources), print it back to the user, then re-prompt for the mode choice.

To read current content for Show current:

```bash
bun -e '
const { loadAgent } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
const ctx = await loadAgent("AGENT_NAME");
const path = "SOUL_OR_CLAUDE_PATH"; // ctx.soulPath or ctx.claudeMdPath
const text = await Bun.file(path).text();
const start = "<!-- claudeclaw:workflow:start -->"; // or :personality: / :datasources:
const end   = "<!-- claudeclaw:workflow:end -->";
const i = text.indexOf(start), j = text.indexOf(end);
console.log(i === -1 ? "(no existing block)" : text.slice(i + start.length, j).trim());
'
```

#### Option 1 — Workflow

Run the **mode selection** above, then re-prompt: "What's the new workflow? (multi-line)".
Write to `/tmp/claudeclaw-update.json` as `{"value": "...", "mode": "append"|"replace"}` then:

```bash
bun -e '
import { readFileSync } from "fs";
const { updateAgent } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
const { value, mode } = JSON.parse(readFileSync("/tmp/claudeclaw-update.json", "utf8"));
await updateAgent("AGENT_NAME", { workflow: { value, mode } });
console.log("workflow updated (" + mode + ")");
'
```

#### Option 2 — Personality

Run the **mode selection** above, then re-prompt for the new personality content:

```bash
bun -e '
import { readFileSync } from "fs";
const { updateAgent } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
const { value, mode } = JSON.parse(readFileSync("/tmp/claudeclaw-update.json", "utf8"));
await updateAgent("AGENT_NAME", { personality: { value, mode } });
console.log("personality updated (" + mode + ")");
'
```

#### Option 3 — Add job

Collect: label (validate via `validateJobLabel`), cron (validate via `parseScheduleToCron`), **recurring vs one-shot** (use AskUserQuestion — default `Recurring (cron)`; pick `One-shot` only when the user is clear they want a single fire), trigger prompt, model (`default`/`opus`/`haiku` — empty for default).

The recurring step is non-optional: jobs without `recurring: true` are silently converted to one-shots by `src/jobs.ts:clearJobSchedule()` on first fire. Default to `recurring: true` if the user expresses any uncertainty.

```bash
bun -e '
import { readFileSync } from "fs";
const { addJob } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
const j = JSON.parse(readFileSync("/tmp/claudeclaw-update.json", "utf8"));
// Pass recurring explicitly (default true) so the wizard never produces silent one-shots.
await addJob("AGENT_NAME", j.label, j.cron, j.trigger, j.model, j.recurring ?? true);
console.log("added " + j.label);
'
```

#### Option 4 — Edit job

List jobs first (via `listAgentJobs`), let the user pick a label, then ask which fields to change. Build a patch object with only the changed fields:

```bash
bun -e '
import { readFileSync } from "fs";
const { updateJob } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
const { label, patch } = JSON.parse(readFileSync("/tmp/claudeclaw-update.json", "utf8"));
await updateJob("AGENT_NAME", label, patch);
console.log("updated " + label);
'
```

`patch` may contain any subset of `{ cron, trigger, enabled, recurring, model }`. Flipping `recurring` from `false` to `true` re-arms a previously-cleared schedule; the daemon picks it up on the next hot-reload tick.

#### Option 5 — Remove job

List jobs, let the user pick one, **confirm** ("Remove `<label>`? y/n"), then:

```bash
bun -e '
const { removeJob } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
await removeJob("AGENT_NAME", "LABEL");
console.log("removed");
'
```

#### Option 6 — Discord channels

Re-prompt for the comma-separated list. Parse to array.

```bash
bun -e '
import { readFileSync } from "fs";
const { updateAgent } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
const { discordChannels } = JSON.parse(readFileSync("/tmp/claudeclaw-update.json", "utf8"));
await updateAgent("AGENT_NAME", { discordChannels });
console.log("channels updated");
'
```

#### Option 7 — Data sources

Run the **mode selection** above (default Append). Then collect the new data-sources content.

```bash
bun -e '
import { readFileSync } from "fs";
const { updateAgent } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
const { value, mode } = JSON.parse(readFileSync("/tmp/claudeclaw-update.json", "utf8"));
await updateAgent("AGENT_NAME", { dataSources: { value, mode } });
console.log("data sources updated (" + mode + ")");
'
```

#### Option 8 — Default model

Ask: "New default model? (`opus` / `sonnet` / `haiku` / `glm`, or empty to clear)". This is the agent's middle fallback tier — job frontmatter `model:` still wins per-task. Append mode is NOT supported (single-value field).

```bash
bun -e '
const { updateAgent } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
await updateAgent("AGENT_NAME", { defaultModel: "opus" });  // or "" to clear
console.log("default model updated");
'
```

#### Option 9 — Delete agent

This is destructive. Require the user to **re-type the agent name verbatim** as a confirmation guard. If the typed name does not match, abort and return to the menu.

```bash
bun -e '
const { deleteAgent } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
await deleteAgent("AGENT_NAME");
console.log("deleted");
'
```

This call IS allowed to remove `MEMORY.md` and `session.json` because the entire agent directory is going away.

#### Option 10 — Done

Exit the loop and print a one-line summary of what changed.

## Examples

### Example A — Update Reg's workflow

```
You: /claudeclaw:update-agent reg
Claude: pulling reg's current state...
        [shows SOUL.md head + jobs list]
        what do you want to change?
        1. Workflow  2. Personality  3. Add job  4. Edit job
        5. Remove job  6. Discord  7. Data sources  8. Delete  9. Done
You: 1
Claude: paste the new workflow (multi-line ok)
You: [pastes 30 lines of new operating manual]
Claude: [writes /tmp/claudeclaw-update.json, runs updateAgent]
        ✓ workflow updated. MEMORY.md untouched.
        anything else?
You: 9
Claude: done. reg's workflow has been replaced. one change total.
```

### Example B — Add a new job to Suzy

```
You: /claudeclaw:update-agent suzy
Claude: [lists current state]
        ...
You: 3
Claude: label?
You: weekly-review
Claude: when?
You: every monday at 8am
Claude: [validates → 0 8 * * 1]
        trigger prompt?
You: scan the week's clippings and write a synthesis to MEMORY.md
Claude: model? (default/opus/haiku)
You: opus
Claude: [runs addJob]
        ✓ added weekly-review (0 8 * * 1, model=opus)
        anything else?
You: 9
```
