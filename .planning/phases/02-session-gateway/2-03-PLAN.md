---
phase: 2-session-gateway
plan: 03
version: revised
wave: 2
type: execute
depends_on:
  - 2-01
  - 2-02
files_modified:
  - src/gateway/resume.ts
  - src/__tests__/gateway/resume.test.ts
autonomous: true
requirements:
  - per-thread-resume
must_haves:
  truths:
    - "Existing mappings are resumed by channel+thread lookup"
    - "Real Claude session IDs come from Claude/runner, not from random UUID generation"
    - "Resume args include --resume only when a real Claude session ID exists"
    - "lastSeq and turnCount are updated after successful processing"
  artifacts:
    - path: "src/gateway/resume.ts"
      provides: "Session resume logic with mapping and Claude session integration"
      exports: ["getResumeArgs", "getOrCreateSessionMapping", "updateSessionAfterProcessing", "recordClaudeSessionId"]
    - path: "src/__tests__/gateway/resume.test.ts"
      provides: "Unit tests for resume logic"
---

# Objective

Create the resume logic module that bridges normalized inbound events, session mappings, and real Claude CLI session resumption.

Purpose: enable deterministic session resumption per conversation thread using the **actual** Claude session ID once one has been created.

# Critical correction

The earlier version of this plan generated a random UUID and treated it like a Claude session ID. That is wrong.

- local mapping identity may be generated locally
- Claude session identity must come from runner / Claude output
- `--resume` must only be emitted when a real `claudeSessionId` exists

# Success criteria

- existing mappings are looked up by `channelId + threadId`
- new mappings are created when none exist
- `getResumeArgs()` returns `[]` for mappings without a real `claudeSessionId`
- `getResumeArgs()` returns `["--resume", claudeSessionId]` only when one exists
- after successful first-run processing, real Claude session ID can be recorded
- `lastSeq`, `turnCount`, and activity timestamps update after successful processing
- tests cover new/existing/resumed flows

# Tasks

## Task 1 — Create `resume.ts` with core lookup and resume argument logic

**File:** `src/gateway/resume.ts`

### Done when
- imports session-map helpers rather than duplicating storage logic
- exports:
  - `getOrCreateSessionMapping(channelId, threadId = "default")`
  - `getResumeArgs(channelId, threadId = "default")`
  - `getResumeArgsForEvent(event)`
- `getResumeArgs()` returns:

```ts
export interface ResumeArgs {
  mappingId: string;
  claudeSessionId: string | null;
  args: string[];
  isNewMapping: boolean;
  canResume: boolean;
}
```

### Behavioral rules
- if no mapping exists: create one with `claudeSessionId = null`
- if mapping exists but `claudeSessionId` is null: return empty `args`
- if mapping has a real `claudeSessionId`: return `--resume` args

### Tests
- existing mapping with `claudeSessionId` resumes correctly
- new mapping returns empty args
- existing mapping without `claudeSessionId` still returns empty args

## Task 2 — Add post-processing metadata updates

### Done when
- exports:
  - `recordClaudeSessionId(channelId, threadId, claudeSessionId)`
  - `updateSessionAfterProcessing(channelId, threadId, seq, options?)`
  - `getSessionStats(channelId, threadId)`
- `recordClaudeSessionId()` stores the real session ID after first successful runner execution
- `updateSessionAfterProcessing()` updates:
  - `lastSeq`
  - `turnCount`
  - `lastActiveAt`
  - `updatedAt`
- optionally supports first-success path where both `seq` and `claudeSessionId` are available together

### Important note
If the current runner does not expose Claude session ID consistently, add a narrow abstraction layer here and document the limitation rather than faking completion.

### Tests
- first successful run records a real Claude session ID
- later runs resume using that ID
- metadata fields update correctly

## Task 3 — Add lifecycle helpers

### Done when
- exports:
  - `resetSession(channelId, threadId)`
  - `isSessionStale(channelId, threadId, thresholdMs?)`
  - `shouldWarnCompact(channelId, threadId)`
- stale detection uses `lastActiveAt`, not only `createdAt`
- reset semantics are explicit and do not silently destroy unrelated state

### Tests
- reset removes the targeted mapping
- stale detection behaves correctly
- compact warning threshold behaves correctly

## Task 4 — Comprehensive tests

**File:** `src/__tests__/gateway/resume.test.ts`

### Must cover
- new mapping vs existing mapping
- mapping with null `claudeSessionId`
- mapping with real `claudeSessionId`
- first-run record of real Claude session ID
- update after processing
- reset/stale/compact helpers
- full flow: create mapping -> first success -> record Claude session ID -> later resume

# Integration notes

- `resume.ts` should integrate with `runner.ts` only through actual returned session data or a documented extraction point
- do not hard-code assumptions about runner output formats beyond what the repo currently supports

# Verification

1. `bun test src/__tests__/gateway/resume.test.ts`
2. verify a new mapping does **not** emit `--resume`
3. verify a mapping with a real Claude session ID does emit `--resume`
4. verify first successful run can store the real session ID for future resumes

# Output

After completion, create:
- `.planning/phases/2-session-gateway/2-03-SUMMARY.md`
