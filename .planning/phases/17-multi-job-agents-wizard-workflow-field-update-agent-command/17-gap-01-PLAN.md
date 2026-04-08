---
phase: 17-multi-job-agents-wizard-workflow-field-update-agent-command
plan: gap-01
type: execute
wave: 1
depends_on: []
files_modified:
  - skills/create-agent/SKILL.md
  - skills/update-agent/SKILL.md
autonomous: true
gap_closure: true
requirements: [WIZARD-01, WIZARD-02]
must_haves:
  truths:
    - "When user provides a Workflow and the agent has exactly one job, wizard does NOT ask for the trigger prompt again — it defaults to running the workflow"
    - "Every wizard question echoes back the previously captured value so the user knows the prior answer landed"
    - "Wizard persists state to /tmp/claudeclaw-agent-wizard.json after every answer (not just at scaffold time) so a network glitch doesn't lose progress"
    - "Before scaffolding, wizard prints a complete review block of all collected answers for explicit confirmation"
    - "Scheduled Tasks section in both create-agent and update-agent SKILL.md prominently states jobs are LOCAL cron managed by jobs.ts/start.ts, NOT the remote schedule skill"
  artifacts:
    - path: skills/create-agent/SKILL.md
      provides: "Wizard with echo-on-each-question, per-step state persistence, single-job workflow reuse, local-cron callout, final review block"
      contains: "IMPORTANT — Jobs are LOCAL cron"
    - path: skills/update-agent/SKILL.md
      provides: "Local-cron callout in scheduled tasks section"
      contains: "IMPORTANT — Jobs are LOCAL cron"
  key_links:
    - from: "create-agent wizard scheduled-tasks loop"
      to: "single-job workflow-reuse branch"
      via: "if jobs.length === 1 && workflow.trim().length > 0: default trigger to 'Run the workflow defined in SOUL.md'"
      pattern: "Run the workflow defined in SOUL.md"
    - from: "every wizard question"
      to: "/tmp/claudeclaw-agent-wizard.json"
      via: "write after each answer captured"
      pattern: "claudeclaw-agent-wizard.json"
---

<objective>
Close three UX gaps in the create-agent wizard discovered during 2026-04-07 Reg UAT on the Hetzner production server: workflow/trigger prompt redundancy (GAP-17-02), dropped acknowledgments with no resync path (GAP-17-03), and confusion between local cron and the remote schedule skill (GAP-17-04).

Purpose: The wizard scaffolds correctly but the UX trips users into wasted typing, lost state, and reaching for the wrong scheduling tool. These three together block confident sign-off on Phase 17.

Output: Updated `skills/create-agent/SKILL.md` and `skills/update-agent/SKILL.md` with echo-on-question, per-step state persistence, single-job workflow reuse, final review block, and a prominent local-cron callout in both scheduled-tasks sections.
</objective>

<execution_context>
@/Users/terrenceyodaiken/.claude/get-shit-done/workflows/execute-plan.md
@/Users/terrenceyodaiken/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/phases/17-multi-job-agents-wizard-workflow-field-update-agent-command/17-GAPS.md
@.planning/phases/17-multi-job-agents-wizard-workflow-field-update-agent-command/17-05-SUMMARY.md
@skills/create-agent/SKILL.md
@skills/update-agent/SKILL.md

These edits are documentation/prompt edits to skill files. No TypeScript, no tests to write — the verification is reading the file and confirming the new sections exist with the required wording. The wizards themselves are validated by re-running them end-to-end against a real claudeclaw instance, but that's a separate live UAT step (not required for this plan to ship).
</context>

<tasks>

<task type="auto">
  <name>Task 1: Patch create-agent SKILL.md — echo, persistence, workflow reuse, local-cron callout, review block</name>
  <files>skills/create-agent/SKILL.md</files>
  <action>
Edit `skills/create-agent/SKILL.md` to add five fixes. Read the current file first to understand its structure (Phase 17 plan 5 wrote it).

**Fix 1 — Per-question echo (GAP-17-03):**
At the top of the wizard flow section, add a directive:

> **Echo before asking.** At the start of EVERY question after Q1, repeat the previously captured value back to the user so they know it landed. Format: `Got it — <field>: "<value>". Next: <next question>`. For multi-line values (workflow, personality), echo a 1-line summary like `Got it — workflow captured (NN words). Next: ...`.

**Fix 2 — Per-step state persistence (GAP-17-03):**
Add a section "State persistence" near the wizard intro:

> After EACH answer is captured, write the full in-progress wizard state to `/tmp/claudeclaw-agent-wizard.json` via a `bun -e` snippet. Do NOT wait until scaffold time. If the network glitches or context resets, the next session can resume by reading this file. The snippet:
> ```js
> const fs = await import("fs/promises");
> await fs.writeFile("/tmp/claudeclaw-agent-wizard.json", JSON.stringify(state, null, 2));
> ```

**Fix 3 — Single-job workflow reuse (GAP-17-02):**
In the Scheduled Tasks loop section, add a branch:

> **If the user provided a non-empty Workflow (Q4) AND this is the first scheduled task AND the user does not add a second task, do NOT ask for a trigger prompt for this job.** Default the trigger prompt to the literal string `Run the workflow defined in SOUL.md`. Then ask: `Want to override the trigger prompt for this job? (y/n, default n)`. Only prompt for a custom trigger if the user answers `y`.
>
> Multi-job agents (2+ scheduled tasks) still need per-job trigger prompts as before — different jobs do different things.

**Fix 4 — Local cron callout (GAP-17-04):**
At the very top of the Scheduled Tasks section (before the loop instructions), add a callout box:

> **IMPORTANT — Jobs are LOCAL cron.** Scheduled tasks here are managed by ClaudeClaw's in-process cron loop (`src/jobs.ts` → `src/commands/start.ts setInterval`). They are NOT the remote `schedule` skill (which uses cloud triggers like Vercel cron). Do NOT invoke the `schedule` skill from this wizard. All job files live at `agents/<name>/jobs/<label>.md` with `schedule:` frontmatter and are loaded by `loadJobs()` on the running daemon.

**Fix 5 — Final review block (GAP-17-03):**
After the last question and BEFORE the scaffold step, add:

> **Review before scaffolding.** Print a complete review of every captured answer (name, role, personality summary, workflow word count, discord channels, data sources, and each scheduled task with its label/cron/trigger). Then ask: `Scaffold this agent? (y/n, or 'edit <field>' to amend)`. If the user types `edit <field>`, jump back to that question; if `y`, proceed; if `n`, abort and unlink the temp state file.

Preserve all existing wording around the helper bun -e calls and the CLAUDECLAW_ROOT pattern from GAP-17-01. Do NOT touch the actual createAgent/addJob helper invocation logic at the bottom of the file.
  </action>
  <verify>
    <automated>grep -q "IMPORTANT — Jobs are LOCAL cron" skills/create-agent/SKILL.md && grep -q "Run the workflow defined in SOUL.md" skills/create-agent/SKILL.md && grep -q "claudeclaw-agent-wizard.json" skills/create-agent/SKILL.md && grep -q "Echo before asking" skills/create-agent/SKILL.md && grep -q "Review before scaffolding" skills/create-agent/SKILL.md</automated>
  </verify>
  <done>All five new sections present in the file with the required wording. Existing wizard structure and helper-call pattern preserved (no regression in GAP-17-01 fix).</done>
</task>

<task type="auto">
  <name>Task 2: Patch update-agent SKILL.md — local-cron callout in scheduled tasks section</name>
  <files>skills/update-agent/SKILL.md</files>
  <action>
Edit `skills/update-agent/SKILL.md` to add the same local-cron callout that Task 1 added to create-agent.

Locate the "Add job" / "Edit job" / "Remove job" menu options in the SKILL.md (Phase 17 plan 5 wrote them). Above the first job-related menu option, insert the callout:

> **IMPORTANT — Jobs are LOCAL cron.** The Add/Edit/Remove job options below operate on `agents/<name>/jobs/<label>.md` files which are scanned by `loadJobs()` and fired by ClaudeClaw's in-process cron loop. They are NOT the remote `schedule` skill. Do NOT invoke the `schedule` skill from this wizard.

No other edits to update-agent are needed in this plan — append-mode (GAP-17-07) is handled by gap-03.
  </action>
  <verify>
    <automated>grep -q "IMPORTANT — Jobs are LOCAL cron" skills/update-agent/SKILL.md</automated>
  </verify>
  <done>Callout present above the job-related menu options. No other changes made to update-agent SKILL.md.</done>
</task>

</tasks>

<verification>
- Both SKILL.md files contain the local-cron callout
- create-agent SKILL.md contains all five new sections (echo, persistence, single-job reuse, callout, review block)
- No regression in the GAP-17-01 CLAUDECLAW_ROOT dynamic-import pattern (grep for `process.env.CLAUDECLAW_ROOT` should still find matches in create-agent SKILL.md)
</verification>

<success_criteria>
- GAP-17-02, GAP-17-03, GAP-17-04 verification gate items in 17-GAPS.md can be ticked after a live wizard re-run on the Hetzner server
- All five must_haves truths observable by re-running the wizard
- Files committed to git
</success_criteria>

<output>
After completion, create `.planning/phases/17-multi-job-agents-wizard-workflow-field-update-agent-command/17-gap-01-SUMMARY.md` documenting which gap each section addresses and the verification status.
</output>
