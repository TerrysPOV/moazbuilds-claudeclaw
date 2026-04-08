---
phase: 17-multi-job-agents-wizard-workflow-field-update-agent-command
plan: gap-03
subsystem: agents
tags: [updateAgent, append-mode, gap-closure, UPDATE-03, GAP-17-07]
requires: [gap-01]
provides: [updateAgent-append-mode, PatchField-type, mode-selection-wizard]
affects: [src/agents.ts, src/__tests__/agents.test.ts, skills/update-agent/SKILL.md]
tech-stack:
  added: []
  patterns: [PatchField<T> discriminated union, normalizePatchField helper, readBetweenMarkers helper, marker-aware concatenation]
key-files:
  created: []
  modified:
    - src/agents.ts
    - src/__tests__/agents.test.ts
    - skills/update-agent/SKILL.md
decisions:
  - "Bare string in patch = replace (back-compat); object {value, mode} = explicit"
  - "Append default in wizard — non-destructive is the safe default for iterative refinement"
  - "Append separator: blank line (\\n\\n) inside markers"
  - "dataSources append on file with no marker block creates a new section at end"
  - "Discord channels intentionally NOT in scope — array, not free text, replace-the-list semantics"
metrics:
  duration: ~10min
  completed: 2026-04-08
  tasks: 2
  files: 3
  tests-added: 14
  tests-passing: 98/98 (agents.test.ts), 697/710 full suite (13 pre-existing failures unchanged)
requirements: [UPDATE-03]
---

# Phase 17 Plan gap-03: updateAgent Append Mode Summary

Adds non-destructive append mode to `updateAgent` for Workflow, Personality, and Data sources patches — closes GAP-17-07 (replace-only footgun that risked silent data loss during iterative agent refinement).

## What changed

**`src/agents.ts`:**
- New `PatchField<T> = T | { value: T; mode: "append" | "replace" }` type
- `AgentUpdatePatch.workflow / personality / dataSources` widened to `PatchField<string>`
- New `normalizePatchField` helper — bare string → `{value, mode: "replace"}` (back-compat)
- New `readBetweenMarkers` helper — reads inner block content for append concatenation
- `applySoulPatch` and `applyClaudeMdPatch` branch on mode: append concatenates with `\n\n` separator inside markers
- dataSources append on a file with no existing block creates a new marked section at end

**`src/__tests__/agents.test.ts`:** 14 new tests covering:
- Bare-string back-compat (workflow / personality / dataSources / discordChannels)
- Append for workflow / personality / dataSources (existing block + no-block cases)
- Explicit replace mode for all three fields
- MEMORY.md mtime invariant under all three append paths

**`skills/update-agent/SKILL.md`:** Mode-selection prompt added before collecting content for Options 1 (Workflow), 2 (Personality), 7 (Data sources). Default is Append. Show-current option prints the existing marker block back to the user. Bun -e snippets updated to pass `{ value, mode }` patch shape. Gap-01's local-cron callout preserved.

## Verification

- `bun test src/__tests__/agents.test.ts`: **98/98 passing** (84 prior + 14 new)
- Full suite: 697/710 (13 pre-existing failures unchanged from STATE.md baseline)
- Source-grep audit (UPDATE-02 invariant): still passes — no MEMORY/session refs in updateAgent body
- SKILL.md grep checks all pass: "How should this be applied", "mode.*append", "Show current", "IMPORTANT — Jobs are LOCAL cron"

## Deviations from Plan

None — plan executed exactly as written. Two minor in-task fixups:
1. Test "explicit replace mode for workflow" originally used the substring `"old"` which collided with the word `bold` in the SOUL.md core-truths boilerplate (false positive). Renamed to `ancient-wf-content` / `rewrite-content` for unique substrings.
2. The dataSources append branch needed an "insert new section at end" fallthrough when neither markers nor a legacy `## Data Sources` heading exist. Added inline.

Both are Rule 1 inline fixes (test correctness, missing edge-case handling).

## Commits

- `3aa3cd7` test(17-gap-03): add failing tests for updateAgent append mode (RED)
- `62eed25` feat(17-gap-03): add append mode to updateAgent for workflow/personality/dataSources (GREEN)
- `5bf0bc1` feat(17-gap-03): add Append/Replace/Show-current mode prompt to update-agent wizard

## Self-Check: PASSED

- src/agents.ts — FOUND
- src/__tests__/agents.test.ts — FOUND
- skills/update-agent/SKILL.md — FOUND
- commit 3aa3cd7 — FOUND
- commit 62eed25 — FOUND
- commit 5bf0bc1 — FOUND
