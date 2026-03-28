---
phase: 4-cost-governance
plan: 2
subsystem: governance
tags: [governance, usage-tracking, watchdog, model-routing, cost-accounting]

# Dependency graph
requires:
  - phase: 4
    provides: Governance modules (usage-tracker, model-router, watchdog)

provides:
  - runner.ts integrated with governance modules for cost-aware execution

affects: [orchestration]

# Tech tracking
tech-stack:
  added: []
  patterns: [governance-aware execution, invocation tracking, watchdog monitoring]

key-files:
  created: []
  modified:
    - src/runner.ts

key-decisions:
  - "Governance router initialized lazily on first agentic invocation"
  - "Invocation ID (crypto.randomUUID) enables correlation across usage-tracker and watchdog"

patterns-established:
  - "Integration pattern: import governance modules, initialize router, track invocations"

requirements-completed: []

# Metrics
duration: 5 min
completed: 2026-03-28T09:22:26Z
---

# Phase 4 Plan 2: Gap Closure - Wire Runner to Governance Summary

**Wired runner.ts to governance modules - usage-tracker records invocations, watchdog monitors execution, governance-aware model routing enabled**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-28T09:17:00Z
- **Completed:** 2026-03-28T09:22:26Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Imported governance/model-router for budget-aware model selection
- Imported usage-tracker for invocation recording (start/completion/failure)
- Imported watchdog for execution monitoring
- Added ensureGovernanceRouter initialization with agentic modes
- Wrapped Claude execution with invocation tracking and failure recording
- Added watchdog limit checks after execution and compact retry

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire runner.ts to governance modules** - `9adfe18` (feat)

**Plan metadata:** `9adfe18` (docs: complete plan)

## Files Created/Modified
- `src/runner.ts` - Integrated governance modules for cost-aware execution

## Decisions Made
- Used `governanceSelectModel` alias to distinguish from legacy `selectModel`
- `watchdogHandleTrigger` alias to avoid naming conflict with `handleTrigger` in other modules
- Governance router initialized lazily on first agentic invocation to avoid eager initialization issues

## Deviations from Plan

None - plan executed exactly as written.

### Auto-fixed Issues

None - no auto-fixes were needed.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 5 (Orchestration) can proceed
- runner.ts now integrates with all governance modules
- Cost-aware execution and invocation tracking enabled

---
*Phase: 4-cost-governance*
*Completed: 2026-03-28*
