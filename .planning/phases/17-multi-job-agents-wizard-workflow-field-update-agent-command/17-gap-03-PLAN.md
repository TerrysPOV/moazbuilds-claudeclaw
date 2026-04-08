---
phase: 17-multi-job-agents-wizard-workflow-field-update-agent-command
plan: gap-03
type: execute
wave: 2
depends_on: [gap-01]
files_modified:
  - src/agents.ts
  - src/__tests__/agents.test.ts
  - skills/update-agent/SKILL.md
autonomous: true
gap_closure: true
requirements: [UPDATE-03]
must_haves:
  truths:
    - "updateAgent accepts an optional mode field per patch key with values 'append' | 'replace' (default 'replace' for API back-compat)"
    - "Append mode for workflow concatenates the new content to the existing block (separated by a blank line) inside the claudeclaw:workflow markers — never wipes existing content"
    - "Append mode for personality concatenates inside the claudeclaw:personality markers"
    - "Append mode for dataSources concatenates inside the claudeclaw:datasources markers"
    - "update-agent SKILL.md wizard asks the user to choose Append / Replace / Show current for Options 1 (Workflow), 2 (Personality), and 7 (Data sources) — defaults to Append (non-destructive)"
    - "Show current option reads the current marker block content and prints it back to the user before they choose"
    - "MEMORY.md still untouched in append mode (UPDATE-02 invariant preserved)"
  artifacts:
    - path: src/agents.ts
      provides: "updateAgent with optional mode per patch key, applySoulPatch and applyClaudeMdPatch support append concatenation"
      exports: ["updateAgent", "AgentUpdatePatch"]
      contains: "append"
    - path: src/__tests__/agents.test.ts
      provides: "Tests covering append for workflow/personality/dataSources, default-replace back-compat, MEMORY.md mtime invariant under append"
    - path: skills/update-agent/SKILL.md
      provides: "Wizard mode-selection prompt for Options 1, 2, 7 with default Append"
      contains: "How should this be applied"
  key_links:
    - from: "AgentUpdatePatch interface"
      to: "applySoulPatch / applyClaudeMdPatch"
      via: "{ value: string, mode?: 'append'|'replace' } shape per field"
      pattern: "mode\\?:"
    - from: "applySoulPatch append branch"
      to: "claudeclaw:workflow markers"
      via: "read existing content between markers, concatenate new content with blank-line separator, write back"
      pattern: "claudeclaw:workflow:start"
    - from: "skills/update-agent/SKILL.md mode prompt"
      to: "bun -e updateAgent call"
      via: "passes mode field in patch object"
      pattern: "mode.*append"
---

<objective>
Add append mode to `updateAgent` for Workflow, Personality, and Data sources patches. Currently these fields are replace-only — every edit silently wipes existing content unless the user re-pastes it in full. This is GAP-17-07: a footgun that caused real data-loss risk during Reg UAT when the user wanted to add 3 sentences to a 300-word workflow.

Purpose: Make iterative refinement of agents practical. Default to non-destructive (append). Keep replace available for full rewrites. Add a "show current" helper so users can see what's there before deciding.

Output: Extended `AgentUpdatePatch` interface with optional `mode` per field, append concatenation in `applySoulPatch`/`applyClaudeMdPatch`, wizard mode-selection prompt in `skills/update-agent/SKILL.md` for Options 1, 2, 7. MEMORY.md invariant preserved (verified by reusing the existing source-grep audit test from plan 17-03).
</objective>

<execution_context>
@/Users/terrenceyodaiken/.claude/get-shit-done/workflows/execute-plan.md
@/Users/terrenceyodaiken/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/phases/17-multi-job-agents-wizard-workflow-field-update-agent-command/17-GAPS.md
@.planning/phases/17-multi-job-agents-wizard-workflow-field-update-agent-command/17-03-SUMMARY.md
@src/agents.ts
@src/__tests__/agents.test.ts
@skills/update-agent/SKILL.md

Plan 17-03 built `updateAgent(name, patch)` with `applySoulPatch` and `applyClaudeMdPatch` as pure string transforms. The current `AgentUpdatePatch` shape is `{ workflow?: string, personality?: string, discordChannels?: string[], dataSources?: string }` — flat strings. To add mode without breaking back-compat, the interface should accept either a bare string (treated as replace) OR an object `{ value, mode }`.

Section markers already exist from plan 17-03: `claudeclaw:workflow:start/end`, `claudeclaw:personality:start/end`, `claudeclaw:datasources:start/end`. The append branch reads content between markers, concatenates with `\n\n` separator, and writes back.

UPDATE-02 invariant (MEMORY.md untouched) is enforced by an existing source-grep unit test that parses `updateAgent`'s function body. That test must continue to pass — the new append code paths must not introduce any MEMORY/session references.

This plan depends on gap-01 because both touch `skills/update-agent/SKILL.md`. Gap-01 only adds the local-cron callout above the job menu options; gap-03 adds mode-selection prompts to Options 1, 2, 7. They edit different sections but to keep merge clean, gap-03 runs after gap-01.

Discord channels (Option 6) is intentionally NOT in scope for append mode — it's an array, not free text, and the natural operation is replace-the-list. If users need to add a single channel, they'll list all of them in one update.
</context>

<interfaces>
Current shape (from plan 17-03):
```typescript
export interface AgentUpdatePatch {
  workflow?: string;
  personality?: string;
  discordChannels?: string[];
  dataSources?: string;
}
export async function updateAgent(name: string, patch: AgentUpdatePatch): Promise<void>;
```

Target shape (back-compat preserving):
```typescript
export type PatchField<T = string> = T | { value: T; mode: "append" | "replace" };

export interface AgentUpdatePatch {
  workflow?: PatchField<string>;
  personality?: PatchField<string>;
  discordChannels?: string[];        // unchanged — replace only
  dataSources?: PatchField<string>;
}
```

A bare string is treated as `{ value, mode: "replace" }` for back-compat. All existing call sites and tests continue to work unchanged.
</interfaces>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add append mode to updateAgent + tests</name>
  <files>src/agents.ts, src/__tests__/agents.test.ts</files>
  <behavior>
    - Test: updateAgent({workflow: "extra"}) on agent with existing workflow REPLACES (back-compat — bare string still means replace)
    - Test: updateAgent({workflow: {value: "extra paragraph", mode: "append"}}) concatenates inside workflow markers, separated by blank line
    - Test: updateAgent({workflow: {value: "extra", mode: "append"}}) on agent with NO existing workflow section creates the section with just the new content (no leading blank line)
    - Test: updateAgent({workflow: {value: "rewrite", mode: "replace"}}) explicit replace works
    - Test: same three cases for personality
    - Test: same three cases for dataSources
    - Test: append mode preserves MEMORY.md mtime (UPDATE-02 invariant under new code path)
    - Test: existing source-grep audit test still passes (no MEMORY/session refs in updateAgent body)
    - Test: discordChannels still accepts a bare string[] (unchanged shape)
  </behavior>
  <action>
TDD: write the failing tests first, commit RED, then implement.

Implementation steps in `src/agents.ts`:

1. Add `PatchField<T>` type alias.
2. Update `AgentUpdatePatch` interface — workflow/personality/dataSources become `PatchField<string>` (discordChannels stays `string[]`).
3. Add a `normalizePatchField` helper:
   ```typescript
   function normalizePatchField(field: PatchField<string> | undefined): { value: string; mode: "append" | "replace" } | undefined {
     if (field === undefined) return undefined;
     if (typeof field === "string") return { value: field, mode: "replace" };
     return field;
   }
   ```
4. In `applySoulPatch` and `applyClaudeMdPatch`, branch on mode:
   - `replace` → existing behaviour (replaceBetweenMarkers / insertSectionAfterPersonality)
   - `append` → read current content between markers (use existing marker constants), concatenate `current + "\n\n" + value`, write back. If no existing section, fall through to the insert path with just the new value (no leading blank line).
5. Add a small helper `readBetweenMarkers(content, startMarker, endMarker): string | null` that returns the inner block or null if markers absent.
6. The MEMORY.md invariant test (source-grep) should automatically still pass because none of the new code references memory/session paths — but verify by running it.

Re-run the full agents.test.ts suite to confirm no regressions.
  </action>
  <verify>
    <automated>bun test src/__tests__/agents.test.ts</automated>
  </verify>
  <done>All new tests pass + existing 85 tests still pass + source-grep audit still passes. Append mode works for workflow/personality/dataSources. Bare-string back-compat preserved.</done>
</task>

<task type="auto">
  <name>Task 2: Add mode-selection prompts to update-agent SKILL.md for Options 1, 2, 7</name>
  <files>skills/update-agent/SKILL.md</files>
  <action>
Edit `skills/update-agent/SKILL.md` to update the wizard logic for Options 1 (Workflow), 2 (Personality), and 7 (Data sources).

For each of these three options, before prompting for the new content, ask:

```
How should this be applied?
  a. Append        — add to the existing <section> (keeps everything already there) [DEFAULT]
  b. Replace       — wipe and rewrite the entire block
  c. Show current  — print the current content first, then ask again
```

If the user picks `a` (or just hits enter): collect the new content, then call:
```js
await updateAgent(name, { workflow: { value: newContent, mode: "append" } });
```

If `b`: same call but with `mode: "replace"`.

If `c`: read the current content from the agent's SOUL.md or CLAUDE.md (parse between the matching markers), print it back to the user, then re-prompt for the mode choice.

Update the bun -e helper snippets to use the new patch shape `{ workflow: { value, mode } }` instead of the bare string. Preserve the CLAUDECLAW_ROOT dynamic-import pattern from GAP-17-01.

Do NOT touch the local-cron callout section that gap-01 added — it's above the job menu options, this edit is in the field-edit options below it.
  </action>
  <verify>
    <automated>grep -q "How should this be applied" skills/update-agent/SKILL.md && grep -q "mode.*append" skills/update-agent/SKILL.md && grep -q "Show current" skills/update-agent/SKILL.md && grep -q "IMPORTANT — Jobs are LOCAL cron" skills/update-agent/SKILL.md</automated>
  </verify>
  <done>Mode-selection prompt present for Options 1, 2, 7. Bun -e snippets pass the new patch shape. Gap-01's local-cron callout still present (no regression).</done>
</task>

</tasks>

<verification>
- All agents.test.ts tests pass (85 prior + new append tests)
- Source-grep audit for MEMORY/session refs in updateAgent body still passes
- Full suite shows no new regressions vs STATE.md baseline
- update-agent SKILL.md has both the gap-01 local-cron callout AND the new gap-03 mode-selection prompts
</verification>

<success_criteria>
- GAP-17-07 verification gate item in 17-GAPS.md can be ticked
- Append is the default for workflow/personality/dataSources edits
- Replace remains available
- Show current works
- Bare-string API still works (no breaking change)
- MEMORY.md untouched under append paths
</success_criteria>

<output>
After completion, create `.planning/phases/17-multi-job-agents-wizard-workflow-field-update-agent-command/17-gap-03-SUMMARY.md`.
</output>
