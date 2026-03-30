# Phase 10: Orchestrator Governance Bridge - Research

**Researched:** 2026-03-30
**Domain:** Interface adapter pattern / governance integration
**Confidence:** HIGH

## Summary

The orchestrator's executor (`src/orchestrator/executor.ts`) defines its own `GovernanceClient` interface that is incompatible with the actual `GovernanceClient` class in `src/governance/client.ts`. The executor expects `checkPolicy(channelId, action)` and `checkBudget(sessionId, action)` methods, but the real class provides `evaluateToolRequest(request)` which takes a `ToolRequestContext` with different parameters.

**Primary recommendation:** Create an adapter class that wraps the real GovernanceClient and implements the executor's expected interface, mapping between the different method signatures and return types.

## Problem Statement

### Interface Definitions

**Orchestrator's GovernanceClient** (`src/orchestrator/executor.ts:77-80`):
```typescript
export interface GovernanceClient {
  checkPolicy(channelId: string, action: string): Promise<GovernanceCheck>;
  checkBudget(sessionId: string, action: string): Promise<GovernanceCheck>;
}
```

**GovernanceCheck** (`executor.ts:27-31`):
```typescript
export interface GovernanceCheck {
  allowed: boolean;
  reason?: string;
  blockedBy?: string;
}
```

**Actual GovernanceClient class** (`src/governance/client.ts:17-124`):
```typescript
export class GovernanceClient {
  evaluateToolRequest(request: ToolRequestContext): PolicyDecision;
  isToolAllowed(request: ToolRequestContext): boolean;
  requiresApproval(request: ToolRequestContext): boolean;
  // ... other methods
}
```

**PolicyDecision** (`src/policy/engine.ts:47`):
```typescript
export interface PolicyDecision {
  requestId: string;
  action: "allow" | "deny" | "require_approval";
  reason: string;
  evaluatedAt: string;
  cacheable: boolean;
}
```

### Key Differences

| Aspect | Executor Interface | Actual GovernanceClient |
|--------|-------------------|------------------------|
| Method 1 | `checkPolicy(channelId, action)` | `evaluateToolRequest(request)` |
| Method 2 | `checkBudget(sessionId, action)` | `getBudgetState(scope)` |
| Return type | `GovernanceCheck { allowed, reason, blockedBy }` | `PolicyDecision { requestId, action, reason, ... }` |
| Action param | String action name | `ToolRequestContext` with `toolName`, `toolArgs` |
| Budget param | `sessionId` + `action` | scope object |

### Root Cause

The executor was designed with a task-level governance model where:
- `action` = workflow action reference (e.g., "sendNotification", "processPayment")
- Budget check = per-session budget enforcement

The actual GovernanceClient was designed with a tool-level governance model where:
- `toolName` = Claude tool name (e.g., "Bash", "WebSearch")
- Budget check = aggregate budget state

These are fundamentally different abstraction levels.

## Standard Stack

This is an internal interface adapter problem - no external libraries needed.

## Architecture Patterns

### Adapter Pattern Solution

Create a `GovernanceClientAdapter` in `src/orchestrator/` that:
1. Implements the executor's `GovernanceClient` interface
2. Wraps the real `GovernanceClient` instance
3. Translates `checkPolicy(channelId, action)` → `evaluateToolRequest(context)`
4. Translates `checkBudget(sessionId, action)` → `getBudgetState(scope)`

```typescript
// src/orchestrator/governance-adapter.ts
import { GovernanceClient as RealGovernanceClient, getGovernanceClient } from "../governance/client";
import { evaluate, type ToolRequestContext, type PolicyDecision } from "../policy/engine";
import { evaluateBudget, type BudgetState } from "../governance/budget-engine";

export interface GovernanceCheck {
  allowed: boolean;
  reason?: string;
  blockedBy?: string;
}

export interface GovernanceClient {
  checkPolicy(channelId: string, action: string): Promise<GovernanceCheck>;
  checkBudget(sessionId: string, action: string): Promise<GovernanceCheck>;
}

export class OrchestratorGovernanceAdapter implements GovernanceClient {
  private realClient: RealGovernanceClient;
  
  constructor(realClient: RealGovernanceClient = getGovernanceClient()) {
    this.realClient = realClient;
  }
  
  async checkPolicy(channelId: string, action: string): Promise<GovernanceCheck> {
    // Build a minimal ToolRequestContext for the action
    const request: ToolRequestContext = {
      eventId: crypto.randomUUID(),
      source: "orchestrator",
      channelId,
      toolName: action,  // Treat action as toolName for policy evaluation
      toolArgs: undefined,
      timestamp: new Date().toISOString(),
    };
    
    const decision = this.realClient.evaluateToolRequest(request);
    
    return {
      allowed: decision.action === "allow",
      reason: decision.reason,
      blockedBy: decision.action === "deny" ? "policy" : undefined,
    };
  }
  
  async checkBudget(sessionId: string, action: string): Promise<GovernanceCheck> {
    const evaluations = await evaluateBudget({ sessionId });
    
    // If any policy blocks, deny the action
    const blockingEvaluation = evaluations.find(e => e.state === "block");
    if (blockingEvaluation) {
      return {
        allowed: false,
        reason: `Budget exceeded: ${blockingEvaluation.policyName}`,
        blockedBy: "budget",
      };
    }
    
    return { allowed: true };
  }
}
```

### Integration Point

In `src/orchestrator/executor.ts`:
1. Remove the local `GovernanceClient` interface (lines 77-80)
2. Import `OrchestratorGovernanceAdapter` instead
3. Update `setGovernanceClient()` to accept the adapter

## Don't Hand-Roll

| Problem | Use Instead | Why |
|---------|-------------|-----|
| Custom interface translation | Adapter pattern | Decouples two existing interfaces cleanly |
| Inline type conversions | Explicit adapter class | Keeps transformation logic in one place |

## Common Pitfalls

### Pitfall 1: Forgetting async/sync mismatch
**What goes wrong:** `evaluateToolRequest` is sync but executor expects `Promise<GovernanceCheck>`
**Why it happens:** Executor interface declares `Promise<>` but real method is synchronous
**How to avoid:** Wrap sync calls in `Promise.resolve()`

### Pitfall 2: Action vs ToolName semantic mismatch
**What goes wrong:** Workflow action names ("sendNotification") don't map to policy tool rules ("Bash", "WebSearch")
**Why it happens:** Different abstraction levels - workflow actions vs Claude tools
**How to avoid:** The adapter should note this limitation; governance at workflow level requires separate policy rules

### Pitfall 3: Null governance client during initialization
**What goes wrong:** `getGovernanceClient()` called before `initGovernanceClient()`
**Why it happens:** Singleton pattern with lazy initialization
**How to avoid:** Ensure governance is initialized at app startup, or have adapter handle null gracefully

## Code Examples

### Executor checkGovernance usage (lines 94-122)
```typescript
async function checkGovernance(task: TaskDefinition, context: ExecutionContext): Promise<GovernanceCheck> {
  if (!config.enableGovernance || !governanceClient) {
    return { allowed: true };
  }
  
  // Check policy
  if (task.actionRef) {
    const policyCheck = await governanceClient.checkPolicy(
      context.channelId || "",
      task.actionRef
    );
    if (!policyCheck.allowed) {
      return policyCheck;
    }
  }
  
  // Check budget
  if (config.enableBudget && context.sessionId) {
    const budgetCheck = await governanceClient.checkBudget(
      context.sessionId,
      task.actionRef
    );
    if (!budgetCheck.allowed) {
      return budgetCheck;
    }
  }
  
  return { allowed: true };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Mock governance in tests | Real adapter wrapping real client | This phase | Enables task-level governance enforcement |

## Open Questions

1. **Action-to-tool-name mapping**
   - What's unclear: How do workflow action names map to policy tool rules?
   - Recommendation: Document that workflow actions need corresponding tool rules in policies, OR create a separate "workflow policy" evaluation path

2. **Budget enforcement granularity**
   - What's unclear: Should budget check use `action` parameter or ignore it?
   - Recommendation: Budget is session-scoped, so `action` parameter is informational only

3. **Null client fallback**
   - What's unclear: Should executor work without governance client at all?
   - Recommendation: Adapter should return `{ allowed: true }` when real client unavailable (current behavior)

## Validation Architecture

### Test Infrastructure
- Framework: Bun test (existing)
- Config: `bunfig.toml` if present
- Test location: `src/__tests__/orchestrator/executor.test.ts`

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command |
|--------|----------|-----------|-------------------|
| orchestrator-governance-interface | Adapter implements executor interface | unit | `bun test src/__tests__/orchestrator/executor.test.ts` |
| governance-client-orchestrator-mismatch | Adapter wraps real client | unit | Mock real client, verify adapter calls |
| orchestrator-governance-flow | checkGovernance works end-to-end | integration | `bun test src/__tests__/integration/` |

### Integration Points to Verify
1. `setGovernanceClient()` accepts adapter
2. `checkPolicy()` translates to `evaluateToolRequest()`
3. `checkBudget()` translates to `evaluateBudget()`
4. Blocked tasks are marked as failed with GovernanceBlocked error

## Sources

### Primary (HIGH confidence)
- `src/orchestrator/executor.ts:77-122` - executor governance interface and usage
- `src/governance/client.ts:17-124` - actual GovernanceClient class
- `src/governance/budget-engine.ts:443-534` - evaluateBudget function

### Secondary (MEDIUM confidence)
- `src/policy/engine.ts:47+` - PolicyDecision interface

## Metadata

**Confidence breakdown:**
- Standard stack: N/A - internal adapter pattern
- Architecture: HIGH - clear adapter pattern solution
- Pitfalls: HIGH - known issues documented with prevention strategies

**Research date:** 2026-03-30
**Valid until:** 90 days - stable pattern, no external dependencies
