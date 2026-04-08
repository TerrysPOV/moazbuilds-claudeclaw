---
phase: 17-multi-job-agents-wizard-workflow-field-update-agent-command
plan: gap-01
subsystem: skills/create-agent, skills/update-agent
tags: [wizard, ux, gap-closure, cron, docs]
requires: [17-05]
provides: [wizard-echo, wizard-persistence, single-job-reuse, local-cron-callout, review-block]
affects: [skills/create-agent/SKILL.md, skills/update-agent/SKILL.md]
tech-stack:
  added: []
  patterns: [per-step-state-persistence, echo-on-question, review-before-commit]
key-files:
  created: []
  modified:
    - skills/create-agent/SKILL.md
    - skills/update-agent/SKILL.md
decisions:
  - "Default single-job trigger to 'Run the workflow defined in SOUL.md' when Q4 workflow is non-empty"
  - "Persist wizard state per-answer to /tmp/claudeclaw-agent-wizard.json instead of only at scaffold time"
metrics:
  duration: ~5min
  completed: 2026-04-08
requirements: [WIZARD-01, WIZARD-02]
---

# Phase 17 Plan gap-01: Wizard UX Gap Closure Summary

Closes GAP-17-02 (workflow/trigger redundancy), GAP-17-03 (dropped acknowledgments, no resync), and GAP-17-04 (local vs remote scheduling confusion) from 2026-04-07 Reg UAT.

## What Changed

**skills/create-agent/SKILL.md** — five fixes:
1. **Echo before asking** section added after wizard intro (GAP-17-03)
2. **State persistence** section with per-answer JSON writes (GAP-17-03)
3. **Local-cron callout** at top of Scheduled tasks section (GAP-17-04)
4. **Single-job workflow reuse** branch — defaults trigger to `Run the workflow defined in SOUL.md` (GAP-17-02)
5. **Review before scaffolding** block with edit/abort/proceed options (GAP-17-03)

**skills/update-agent/SKILL.md** — one fix:
1. **Local-cron callout** above Option 1 in the menu loop (GAP-17-04)

## Commits

- `ed7ceac` feat(17-gap-01): add echo, persistence, review block, local-cron callout to create-agent wizard
- `1cb927b` feat(17-gap-01): add local-cron callout to update-agent wizard

## Verification

All automated greps pass:
- `IMPORTANT — Jobs are LOCAL cron` present in both SKILL.md files
- `Run the workflow defined in SOUL.md` present in create-agent
- `claudeclaw-agent-wizard.json`, `Echo before asking`, `Review before scaffolding` all present in create-agent
- `process.env.CLAUDECLAW_ROOT` still present (no regression on GAP-17-01)

Live UAT re-run on Hetzner is a separate step tracked in 17-GAPS.md.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED
- skills/create-agent/SKILL.md: FOUND
- skills/update-agent/SKILL.md: FOUND
- Commit ed7ceac: FOUND
- Commit 1cb927b: FOUND
