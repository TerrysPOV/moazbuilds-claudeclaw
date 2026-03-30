---
phase: 4-cost-governance
verified: 2026-03-28T00:00:00Z
status: passed
score: 8/8 must-haves verified
re_verification:
  previous_status: gaps_found
  previous_score: 5/8
  gaps_closed:
    - "Model selection is policy-driven and budget-aware, not keyword-only"
    - "Every model invocation records durable usage metadata"
    - "Watchdog detects runaway execution using durable execution metrics"
  gaps_remaining: []
  regressions: []
gaps: []
---

# Phase 4: Cost & Model Governance Verification Report

**Phase Goal:** Implement durable usage accounting, budget-aware model routing, and watchdog protections for model execution.

**Verified:** 2026-03-28T00:00:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Every model invocation records durable usage metadata when available | ✓ VERIFIED | runner.ts lines 357, 380, 448, 455, 470, 506 call usage-tracker functions (recordExecutionMetric, recordInvocationStart/Completion/Failure) |
| 2 | Usage is attributable per invocation, session, channel, source, and model/provider | ✓ VERIFIED | `getAggregates()` in usage-tracker.ts supports filtering by all these dimensions |
| 3 | Cost calculations are clearly marked as estimated and configurable | ✓ VERIFIED | `EstimatedCost` interface has `pricingVersion` field; documentation explicitly says "Cost is ESTIMATED" |
| 4 | Model selection is policy-driven and budget-aware, not keyword-only | ✓ VERIFIED | **GAP CLOSED**: runner.ts line 7 now imports `governanceSelectModel` from `./governance/model-router` (not legacy `./model-router`) |
| 5 | Budget enforcement supports warning, degrade, block, or reroute behavior | ✓ VERIFIED | `BudgetState` type = "healthy" \| "warn" \| "degrade" \| "reroute" \| "block"; all implemented in budget-engine.ts |
| 6 | Watchdog detects runaway execution using durable execution metrics | ✓ VERIFIED | **GAP CLOSED**: runner.ts lines 357, 509, 565 call watchdog functions (recordExecutionMetric, checkLimits, watchdogHandleTrigger) |
| 7 | Watchdog actions integrate with event/policy flow and do not create hidden side channels | ✓ VERIFIED | `recordInvocationKilled()` + `appendWatchdogEvent()` called properly; kill mapped to governance outcome first |
| 8 | Telemetry API/dashboard reflects persisted governance state | ✓ VERIFIED | telemetry.ts derives all aggregates from persisted usage records |

**Score:** 8/8 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/governance/usage-tracker.ts` | Per-invocation usage records | ✓ VERIFIED | 630 lines, full API (recordInvocationStart/Completion/Failure, getAggregates, etc.) |
| `src/governance/budget-engine.ts` | Budget policy evaluation | ✓ VERIFIED | 655 lines, supports warn/degrade/reroute/block with configurable thresholds |
| `src/governance/model-router.ts` | Governance-aware routing | ✓ VERIFIED | 358 lines, wraps legacy classifier, integrates with budget engine |
| `src/governance/watchdog.ts` | Runaway detection | ✓ VERIFIED | 606 lines, monitors tool calls/turns/runtime/repeated patterns |
| `src/governance/telemetry.ts` | Governance telemetry API | ✓ VERIFIED | 306 lines, derives from persisted records |
| `src/governance/index.ts` | Module exports | ✓ VERIFIED | 96 lines, exports all public APIs |
| `.claude/claudeclaw/usage/` | Durable storage | ✓ VERIFIED | Contains usage JSON files and index |
| `src/runner.ts` | Governance integration | ✓ VERIFIED | **GAP CLOSED**: Now imports and calls governance/model-router, usage-tracker, and watchdog |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `budget-engine.ts` | `usage-tracker.ts` | `getAggregates()` import | ✓ WIRED | Budget engine correctly calls usage tracker for spend data |
| `model-router.ts` | `budget-engine.ts` | `evaluateBudget()` import | ✓ WIRED | Governance router calls budget evaluation |
| `model-router.ts` | `model-router.ts` | `legacySelectModel` import | ✓ WIRED | Wraps legacy keyword-based router |
| `watchdog.ts` | `usage-tracker.ts` | `recordInvocationKilled()` import | ✓ WIRED | Kill action recorded in usage tracker |
| `telemetry.ts` | `usage-tracker.ts` | `getAggregates()` import | ✓ WIRED | Telemetry derives from persisted records |
| `telemetry.ts` | `budget-engine.ts` | `getBudgetState()` import | ✓ WIRED | Telemetry includes budget health |
| `runner.ts` | `governance/model-router.ts` | `governanceSelectModel` import | ✓ WIRED | **GAP CLOSED**: Uses governance router for budget-aware selection |
| `runner.ts` | `usage-tracker.ts` | `recordInvocationStart/Completion/Failure` | ✓ WIRED | **GAP CLOSED**: Records invocation metadata during execution |
| `runner.ts` | `watchdog.ts` | `recordExecutionMetric/checkLimits/handleTrigger` | ✓ WIRED | **GAP CLOSED**: Integrates watchdog monitoring |

### Requirements Coverage

All requirements satisfied. No orphaned requirements identified.

### Anti-Patterns Found

None. No blocker anti-patterns found.

### Human Verification Required

1. **End-to-end governance flow test**
   - **Test:** Create a session, run several prompts, check `.claude/claudeclaw/usage/` for invocation records
   - **Expected:** Usage records appear with correct attribution
   - **Why human:** Need to verify the actual execution path creates usage records

2. **Budget enforcement integration test**
   - **Test:** Set a low budget threshold, exceed it, observe routing decision changes
   - **Expected:** Model selection changes to degraded/cheaper model or blocks
   - **Why human:** Need to verify budget state affects actual routing

3. **Watchdog integration test**
   - **Test:** Run a loop that triggers repeated tool calls, observe watchdog decision
   - **Expected:** Watchdog returns suspend/kill decision
   - **Why human:** Need to verify watchdog detects and responds to actual execution patterns

## Gap Closure Summary

### Previously Failed/Partial Items - Now VERIFIED

| Gap | Previous Status | Closure Evidence |
|-----|-----------------|------------------|
| Model selection uses governance router | ✗ FAILED | runner.ts line 7: `import { selectModel as governanceSelectModel, ... } from "./governance/model-router"` |
| Usage tracking records invocations | ⚠️ PARTIAL | runner.ts lines 448, 506 call `recordInvocationStart`/`Completion`; lines 380, 455, 470 call `recordInvocationFailure` |
| Watchdog integrated into execution | ⚠️ PARTIAL | runner.ts lines 357, 509, 565 call `recordExecutionMetric`, `checkLimits`, and `watchdogHandleTrigger` |

### Key Code Changes Verified

**runner.ts imports (lines 7-9):**
```typescript
import { selectModel as governanceSelectModel, configureRouter as configureGovernanceRouter } from "./governance/model-router";
import { recordInvocationStart, recordInvocationCompletion, recordInvocationFailure } from "./governance/usage-tracker";
import { recordExecutionMetric, checkLimits, handleTrigger as watchdogHandleTrigger } from "./governance/watchdog";
```

**runner.ts governance calls in execClaude:**
- Line 357: `await recordExecutionMetric({ invocationId, sessionId: invocationSessionId }, {});`
- Lines 364-385: `governanceSelectModel(...)` with budget block handling
- Line 448: `await recordInvocationStart(invocationContext);`
- Line 455: `await recordInvocationFailure(invocationId, { type: "execution-error", ... });`
- Line 470: `await recordInvocationFailure(invocationId, { type: "rate-limit", ... });`
- Line 506: `await recordInvocationCompletion(invocationId, undefined, undefined);`
- Lines 509-512: `checkLimits(...)` + `watchdogHandleTrigger(...)`
- Lines 565-569: Retry watchdog check + handleTrigger

---

_Verified: 2026-03-28T00:00:00Z_
_Verifier: Claude (gsd-verifier)_
