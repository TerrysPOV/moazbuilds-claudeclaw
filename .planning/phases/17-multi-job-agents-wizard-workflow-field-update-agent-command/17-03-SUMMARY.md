---
phase: 17-multi-job-agents-wizard-workflow-field-update-agent-command
plan: 03
subsystem: agents
tags: [agents, soul, claude-md, update-agent, memory-invariant]
requires: [17-01, 17-02]
provides: [updateAgent, applySoulPatch, applyClaudeMdPatch, AgentUpdatePatch, workflow-section]
affects: [src/agents.ts]
tech_added: []
patterns: [whole-file-string-transform, section-markers, legacy-fallback-regex]
files_created: []
files_modified:
  - src/agents.ts
  - src/__tests__/agents.test.ts
decisions:
  - "Whole-file read → string transform → write (no offset edits)"
  - "Section markers mirror existing claudeclaw:managed:start/end convention"
  - "Legacy SOUL/CLAUDE.md (no markers) handled via regex fallback so Phase 16 agents upgrade transparently"
  - "updateAgent body audited via unit test for zero MEMORY/session references — UPDATE-02 enforced at source level"
metrics:
  duration: ~15min
  completed: 2026-04-07
requirements_completed: [UPDATE-01, UPDATE-02]
---

# Phase 17 Plan 3: updateAgent + Workflow Section + MEMORY Invariant Summary

Selective-field `updateAgent(name, patch)` helper for SOUL.md / CLAUDE.md, plus optional `## Workflow` section in SOUL.md emitted by both `createAgent` and `updateAgent`. MEMORY.md invariant proven by mtime tests **and** a source-grep audit unit test.

## What Shipped

**`src/agents.ts`**
- `AgentUpdatePatch` interface — `{ workflow?, personality?, discordChannels?, dataSources? }`
- `applySoulPatch(soul, patch)` — pure string transform; marker-aware with legacy regex fallback
- `applyClaudeMdPatch(claudeMd, patch)` — same shape for discord channels + data sources
- `updateAgent(name, patch)` — async helper; reads SOUL/CLAUDE.md, applies patches, writes only if changed
- `AgentCreateOpts.workflow?: string` — optional, threaded through `renderSoul`
- 8 section marker constants (workflow, personality, discord, datasources × start/end)
- `renderSoul` now wraps Personality in markers and emits `## Workflow` block when workflow provided
- `renderClaudeMd` now wraps Discord Channels and Data Sources in markers
- Helper primitives: `replaceBetweenMarkers`, `replaceLegacySection`, `insertSectionAfterPersonality`

**`src/__tests__/agents.test.ts`**
- `Phase 17: SOUL/CLAUDE.md patching` — 11 tests covering marked/legacy paths, idempotency, isolated field updates
- `Phase 17: updateAgent + MEMORY invariant` — 9 tests:
  - createAgent emits Workflow section
  - mtime checks for {workflow}, {personality}, {discordChannels}, {dataSources}
  - updateAgent on legacy SOUL.md adds workflow section
  - updateAgent throws on missing agent
  - **Source-grep audit**: parses updateAgent function body and asserts zero references to memoryPath / MEMORY.md / ensureMemoryFile / getMemoryPath / sessionPath / session.json

## Verification

- `bun test src/__tests__/agents.test.ts` → **85/85 pass** (65 prior + 20 new), 209 expect calls
- Full suite: **665/678 pass**, 13 pre-existing failures unchanged (baseline matches STATE.md)
- `grep "claudeclaw:workflow:start" src/agents.ts` → defined and used by `renderSoul`
- updateAgent body grep → CLEAN (no MEMORY/session refs)

## Deviations from Plan

None — plan executed exactly as written. The plan's `renderSoul` example sketched a different signature shape (`{name, personality, workflow}` plus a leading `# <name>'s Soul` heading) but the existing Phase 16 code used `renderSoul(personality)` and no top heading; preserved current shape and threaded `workflow?` as a second positional arg to keep the diff minimal and not break existing renderings.

## Commits

- `3f9a018` test(17-03): add failing tests for SOUL/CLAUDE.md patching and updateAgent
- `971204c` feat(17-03): add updateAgent + applySoulPatch/applyClaudeMdPatch with MEMORY.md invariant

## Self-Check: PASSED

- `src/agents.ts` modified ✓
- `src/__tests__/agents.test.ts` modified ✓
- Both commits present in `git log` ✓
- Test suite green ✓
- UPDATE-02 invariant verified by passing source-grep unit test ✓
