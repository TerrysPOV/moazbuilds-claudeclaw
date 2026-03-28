---
phase: 4-cost-governance
plan: 2
type: execute
wave: 1
depends_on: []
files_modified:
  - src/runner.ts
autonomous: true
gap_closure: true
must_haves:
  truths:
    - "runner.ts imports selectModel from ./governance/model-router for budget-aware routing"
    - "runner.ts calls usage-tracker.recordInvocationStart before each Claude invocation"
    - "runner.ts calls usage-tracker.recordInvocationCompletion after successful completion"
    - "runner.ts calls usage-tracker.recordInvocationFailure after invocation failure"
    - "runner.ts calls watchdog.recordExecutionMetric to track execution metrics"
    - "runner.ts calls watchdog.checkLimits to evaluate watchdog limits"
    - "runner.ts calls watchdog.handleTrigger when watchdog returns suspend or kill decision"
  artifacts: []
  key_links:
    - from: src/runner.ts
      to: src/governance/model-router.ts
      via: selectModel import
      pattern: import.*selectModel.*governance/model-router
    - from: src/runner.ts
      to: src/governance/usage-tracker.ts
      via: recordInvocationStart/Completion/Failure calls
      pattern: recordInvocation(Start|Completion|Failure)
    - from: src/runner.ts
      to: src/governance/watchdog.ts
      via: recordExecutionMetric/checkLimits/handleTrigger calls
      pattern: (recordExecutionMetric|checkLimits|handleTrigger)
---

<objective>
Wire runner.ts to governance modules to close verification gaps. This plan addresses all three gaps in a single task by modifying runner.ts to use the governance-aware model router, record invocations via usage-tracker, and monitor execution via watchdog.
</objective>

<context>
## Gap Summary (from 04-VERIFICATION.md)

| Truth | Status | Gap |
|-------|--------|-----|
| "Model selection is policy-driven and budget-aware" | FAILED | runner.ts imports selectModel from ./model-router (old), NOT ./governance/model-router |
| "Every model invocation records durable usage metadata" | PARTIAL | usage-tracker exists but is NOT called from runner.ts |
| "Watchdog detects runaway execution" | PARTIAL | watchdog exists but is NOT integrated into runner.ts |

## Key Interfaces

### Governance Model Router (src/governance/model-router.ts)
```typescript
export interface ModelRoutingDecision {
  requestId: string;
  selectedProvider: string;
  selectedModel: string;
  reason: string;
  matchedPolicyId?: string;
  budgetState?: BudgetState;
  fallbackChain?: Array<{ provider: string; model: string }>;
  decidedAt: string;
}

export interface ModelRequestContext {
  prompt?: string;
  taskType?: string;
  capability?: string;
  preferredProvider?: string;
  preferredModel?: string;
  explicitOverride?: { provider?: string; model?: string; allowed: boolean };
  sessionId?: string;
  channelId?: string;
  source?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export function selectModel(requestContext: ModelRequestContext): Promise<ModelRoutingDecision>;
export function configureRouter(config: Partial<RouterConfig>): void;
```

### Usage Tracker (src/governance/usage-tracker.ts)
```typescript
export interface InvocationContext {
  eventId?: string;
  sessionId?: string;
  claudeSessionId?: string | null;
  source?: string;
  channelId?: string;
  threadId?: string;
  provider: string;
  model: string;
  metadata?: Record<string, unknown>;
}

export async function recordInvocationStart(context: InvocationContext): Promise<InvocationUsageRecord>;
export async function recordInvocationCompletion(invocationId: string, usage?: UsageMetrics, estimatedCost?: EstimatedCost): Promise<InvocationUsageRecord | null>;
export async function recordInvocationFailure(invocationId: string, error: { type?: string; message: string }): Promise<InvocationUsageRecord | null>;
```

### Watchdog (src/governance/watchdog.ts)
```typescript
export interface ExecutionMetrics { ... }
export type WatchdogState = "healthy" | "warn" | "suspend" | "kill";

export async function recordExecutionMetric(context: { invocationId: string; sessionId?: string }, metrics: { toolCallCount?: number; turnCount?: number }): Promise<void>;
export async function checkLimits(context: { invocationId: string; sessionId?: string }): Promise<WatchdogDecision>;
export async function handleTrigger(context: { invocationId: string; sessionId?: string }, decision: WatchdogDecision): Promise<{ action: string; success: boolean }>;

export interface WatchdogDecision {
  invocationId: string;
  state: WatchdogState;
  reason: string;
  triggeredLimits: string[];
  recommendedAction: string;
  evaluatedAt: string;
}
```

### Legacy Model Router (src/model-router.ts) - Still used by legacy path
```typescript
// Legacy signature still used in some paths
export function selectModel(prompt: string, modes: AgenticMode[], defaultMode: string): { model: string; taskType: string; reasoning: string };
```
</context>

<tasks>

<task type="auto">
  <name>Wire runner.ts to governance modules</name>
  <files>src/runner.ts</files>
  <action>
## Changes to make in src/runner.ts:

### 1. Update imports (replace line 7)
**Before:**
```typescript
import { selectModel } from "./model-router";
```
**After:**
```typescript
import { selectModel as governanceSelectModel, configureRouter as configureGovernanceRouter } from "./governance/model-router";
import { recordInvocationStart, recordInvocationCompletion, recordInvocationFailure } from "./governance/usage-tracker";
import { recordExecutionMetric, checkLimits, handleTrigger as watchdogHandleTrigger } from "./governance/watchdog";
```

### 2. Initialize governance router at module level
Add after the LOGS_DIR constant (around line 9):
```typescript
// Initialize governance router with agentic modes from settings
let governanceInitialized = false;
function ensureGovernanceRouter(modes?: AgenticMode[], defaultMode?: string): void {
  if (!governanceInitialized && modes && defaultMode) {
    configureGovernanceRouter({ modes, defaultMode, defaultProvider: "anthropic", defaultModel: "claude-3-5-sonnet" });
    governanceInitialized = true;
  }
}
```

### 3. Add invocation tracking state to execClaude
In the execClaude function, add near the top after getting settings:
```typescript
// Generate invocation ID for tracking
const invocationId = crypto.randomUUID();
const sessionId = existing?.sessionId;

// Initialize watchdog metrics
await recordExecutionMetric({ invocationId, sessionId });
```

### 4. Replace model selection with governance router
In execClaude around lines 346-356, replace:
```typescript
if (agentic.enabled) {
  const routing = selectModel(prompt, agentic.modes, agentic.defaultMode);
  primaryConfig = { model: routing.model, api };
  taskType = routing.taskType;
  routingReasoning = routing.reasoning;
```
**After (using governance router):**
```typescript
if (agentic.enabled) {
  ensureGovernanceRouter(agentic.modes, agentic.defaultMode);
  const routing = await governanceSelectModel({
    prompt,
    taskType: agentic.defaultMode,
    sessionId: existing?.sessionId,
    channelId: undefined, // Would come from event context if available
    source: name,
  });
  primaryConfig = { model: routing.selectedModel, api: routing.selectedProvider === "openai" ? "" : api };
  taskType = routing.reason;
  routingReasoning = routing.reason;
  // Handle budget block
  if (routing.budgetState === "block") {
    console.warn(`[${new Date().toLocaleTimeString()}] Execution blocked: budget limit exceeded`);
    // Record failure and return
    await recordInvocationFailure(invocationId, { type: "budget-blocked", message: `Budget state: ${routing.budgetState}` });
    return { stdout: "", stderr: "Execution blocked: budget limit exceeded", exitCode: 0 };
  }
```

### 5. Record invocation start before Claude call
Before the first `exec = await runClaudeOnce(...)` call (around line 406), add:
```typescript
// Record invocation start
const invocationContext = {
  sessionId: existing?.sessionId,
  claudeSessionId: existing?.sessionId ?? null,
  source: name,
  channelId: undefined,
  provider: primaryConfig.api || "anthropic",
  model: primaryConfig.model,
  metadata: { taskType, routingReasoning },
};
await recordInvocationStart(invocationContext);
```

### 6. Wrap Claude execution with usage tracking
Replace the Claude execution section (around lines 406-416) with try/catch:
```typescript
let exec: { rawStdout: string; stderr: string; exitCode: number };
try {
  exec = await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv, timeoutMs);
} catch (err) {
  // Record failure
  await recordInvocationFailure(invocationId, { type: "execution-error", message: err instanceof Error ? err.message : String(err) });
  throw err;
}

const primaryRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
```

### 7. After successful output parsing, record completion
After the stdout/stderr processing (around line 447-448), add completion recording:
```typescript
// Record successful completion
await recordInvocationCompletion(invocationId, undefined, undefined);
```

### 8. Record failure on rate limit fallback failure
If the fallback also hits rate limit (around lines 410-416), add failure recording:
```typescript
if (primaryRateLimit && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig)) {
  console.warn(`[${new Date().toLocaleTimeString()}] Claude limit reached; retrying with fallback...`);
  exec = await runClaudeOnce(args, fallbackConfig.model, fallbackConfig.api, baseEnv, timeoutMs);
  usedFallback = true;
  // If fallback also fails, record failure
  if (extractRateLimitMessage(exec.rawStdout, exec.stderr)) {
    await recordInvocationFailure(invocationId, { type: "rate-limit", message: "Both primary and fallback hit rate limit" });
  }
}
```

### 9. Check watchdog limits after completion
After the result is finalized (around line 513, before `return result`), add:
```typescript
// Check watchdog limits
const watchdogDecision = await checkLimits({ invocationId, sessionId });
if (watchdogDecision.state === "suspend" || watchdogDecision.state === "kill") {
  console.warn(`[${new Date().toLocaleTimeString()}] Watchdog ${watchdogDecision.state}: ${watchdogDecision.reason}`);
  await watchdogHandleTrigger({ invocationId, sessionId }, watchdogDecision);
}
```

### 10. Also add watchdog check after compact retry
In the compact retry section (around line 495-499), add watchdog check after successful retry:
```typescript
if (retryExec.exitCode === 0) {
  const count = await incrementTurn();
  console.log(`[${new Date().toLocaleTimeString()}] Turn count: ${count} (after compact + retry)`);
  // Check watchdog after successful retry
  const retryWatchdogDecision = await checkLimits({ invocationId, sessionId });
  if (retryWatchdogDecision.state === "suspend" || retryWatchdogDecision.state === "kill") {
    console.warn(`[${new Date().toLocaleTimeString()}] Watchdog ${retryWatchdogDecision.state} after retry: ${retryWatchdogDecision.reason}`);
    await watchdogHandleTrigger({ invocationId, sessionId }, retryWatchdogDecision);
  }
}
```

## Important Notes
- The governance router's `selectModel` is async (returns Promise), so the `await` is required
- The old `selectModel` from `./model-router` can remain imported ONLY if it's used elsewhere - but in execClaude, we now use governanceSelectModel
- The `crypto` module should be available in Bun's built-ins for `randomUUID()`
- Watchdog kill/suspend handling is advisory in this integration - actual subprocess termination would require additional work in future phases
</action>
  <verify>grep -n "governance/model-router\|recordInvocation(Start\|Completion\|Failure)\|recordExecutionMetric\|checkLimits\|watchdogHandleTrigger" src/runner.ts | wc -l</verify>
  <done>runner.ts imports governance/model-router selectModel, calls usage-tracker at invocation start/completion/failure, and calls watchdog recordExecutionMetric/checkLimits/handleTrigger during execution</done>
</task>

</tasks>

<verification>
After execution, verify these grep patterns return matches:
- `grep -n "from \"./governance/model-router\"" src/runner.ts` - should find governance model router import
- `grep -n "recordInvocationStart\|recordInvocationCompletion\|recordInvocationFailure" src/runner.ts` - should find usage tracker calls
- `grep -n "recordExecutionMetric\|checkLimits\|watchdogHandleTrigger" src/runner.ts` - should find watchdog calls
</verification>

<success_criteria>
When this plan executes:
1. runner.ts imports selectModel from ./governance/model-router (not the legacy ./model-router)
2. Every execClaude invocation calls recordInvocationStart before the Claude process runs
3. Successful completions call recordInvocationCompletion
4. Failures call recordInvocationFailure
5. recordExecutionMetric is called to initialize watchdog tracking
6. checkLimits is called after each execution to evaluate watchdog state
7. watchdogHandleTrigger is called when watchdog returns suspend or kill
</success_criteria>

<output>
After completion, create `.planning/phases/04-cost-governance/4-02-SUMMARY.md`
</output>
