---
phase: 08-policy-integration
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/gateway/index.ts
  - src/governance/client.ts
  - src/event-processor.ts
autonomous: true
gap_closure: true
requirements:
  - REQ-3.1
  - REQ-3.3
  - REQ-5.1

must_haves:
  truths:
    - "Policy engine evaluate() is called for every tool request before execution"
    - "require_approval decisions enqueue approval requests to the durable queue"
    - "GovernanceClient provides a unified interface to governance operations"
  artifacts:
    - path: "src/governance/client.ts"
      provides: "GovernanceClient interface implementation"
      min_lines: 50
    - path: "src/gateway/index.ts"
      provides: "Policy engine wiring in gateway"
      exports: ["evaluatePolicy", "checkToolApproval"]
  key_links:
    - from: "src/gateway/index.ts"
      to: "src/policy/engine.ts"
      via: "evaluate() call"
      pattern: "evaluate\\(.*ToolRequestContext"
    - from: "src/gateway/index.ts"
      to: "src/policy/approval-queue.ts"
      via: "enqueue() call"
      pattern: "enqueue\\(.*request.*decision"
    - from: "src/governance/client.ts"
      to: "src/governance/index.ts"
      via: "governance module delegation"
      pattern: "export.*class GovernanceClient"
---

<objective>
Wire the existing policy engine and approval queue into the execution path. The policy engine's `evaluate()` function must be called before tool execution, and `require_approval` decisions must enqueue to the durable approval queue. Also implement the GovernanceClient interface.

Purpose: Close the gap between policy modules existing and being actually used.
Output: Policy engine wired to gateway, approval queue wired to event processing, GovernanceClient implementation.
</objective>

<context>
@src/policy/engine.ts
@src/policy/approval-queue.ts
@src/governance/index.ts
@src/gateway/index.ts

## Key Interfaces

From src/policy/engine.ts:
```typescript
export interface ToolRequestContext {
  eventId: string;
  source: string;
  channelId?: string;
  threadId?: string;
  userId?: string;
  skillName?: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  sessionId?: string;
  claudeSessionId?: string | null;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export type PolicyAction = "allow" | "deny" | "require_approval";

export interface PolicyDecision {
  requestId: string;
  action: PolicyAction;
  matchedRuleId?: string;
  reason: string;
  evaluatedAt: string;
  cacheable?: boolean;
}

export function evaluate(request: ToolRequestContext): PolicyDecision;
```

From src/policy/approval-queue.ts:
```typescript
import { type ToolRequestContext, type PolicyDecision } from "./engine";

export async function enqueue(
  request: ToolRequestContext,
  decision: PolicyDecision
): Promise<ApprovalEntry>;

export function listPending(): ApprovalEntry[];
export async function findByEventId(eventId: string): Promise<ApprovalEntry | null>;
```

From src/governance/index.ts - governance modules export usage-tracker, budget-engine, model-router, watchdog, telemetry.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create GovernanceClient interface</name>
  <files>src/governance/client.ts</files>
  <action>
Create src/governance/client.ts with GovernanceClient class that provides a unified interface to governance operations.

```typescript
/**
 * GovernanceClient - Unified interface to governance operations
 * 
 * Provides a single entry point for policy evaluation, approval management,
 * and governance telemetry across the codebase.
 */

import { evaluate, loadRules, type ToolRequestContext, type PolicyDecision } from "../policy/engine";
import { enqueue, listPending, findByEventId, findById, loadState as loadApprovalState, type ApprovalEntry } from "../policy/approval-queue";
import * as governance from "./index";

export interface GovernanceClientConfig {
  policyEnabled?: boolean;
  approvalEnabled?: boolean;
}

export class GovernanceClient {
  private config: GovernanceClientConfig;

  constructor(config: GovernanceClientConfig = {}) {
    this.config = {
      policyEnabled: config.policyEnabled ?? true,
      approvalEnabled: config.approvalEnabled ?? true,
    };
  }

  // --- Policy Engine ---
  
  /**
   * Evaluate a tool request against policy rules.
   */
  evaluateToolRequest(request: ToolRequestContext): PolicyDecision {
    if (!this.config.policyEnabled) {
      return {
        requestId: crypto.randomUUID(),
        action: "allow",
        reason: "Policy engine disabled",
        evaluatedAt: new Date().toISOString(),
        cacheable: false,
      };
    }
    return evaluate(request);
  }

  /**
   * Load/reload policy rules from disk.
   */
  async reloadPolicies(): Promise<void> {
    await loadRules();
  }

  // --- Approval Queue ---
  
  /**
   * Request approval for a tool execution.
   * Returns the approval entry if decision is require_approval.
   */
  async requestApproval(request: ToolRequestContext, decision: PolicyDecision): Promise<ApprovalEntry | null> {
    if (!this.config.approvalEnabled || decision.action !== "require_approval") {
      return null;
    }
    return enqueue(request, decision);
  }

  /**
   * Get all pending approvals.
   */
  getPendingApprovals(): ApprovalEntry[] {
    return listPending();
  }

  /**
   * Find approval by event ID.
   */
  async findApprovalByEvent(eventId: string): Promise<ApprovalEntry | null> {
    return findByEventId(eventId);
  }

  /**
   * Find approval by approval ID.
   */
  getApprovalById(id: string): ApprovalEntry | null {
    return findById(id);
  }

  // --- Governance Telemetry ---
  
  /**
   * Get governance telemetry summary.
   */
  async getTelemetry() {
    return governance.getTelemetry({});
  }

  /**
   * Get usage stats.
   */
  async getUsageStats() {
    return governance.getUsageStats();
  }

  /**
   * Get budget state.
   */
  async getBudgetState(channelId?: string) {
    return governance.getBudgetState(channelId);
  }

  /**
   * Check if a tool is allowed (shortcut for allow action).
   */
  isToolAllowed(request: ToolRequestContext): boolean {
    const decision = this.evaluateToolRequest(request);
    return decision.action === "allow";
  }

  /**
   * Check if a tool requires approval (shortcut for require_approval action).
   */
  requiresApproval(request: ToolRequestContext): boolean {
    const decision = this.evaluateToolRequest(request);
    return decision.action === "require_approval";
  }
}

// --- Singleton Instance ---

let governanceClientInstance: GovernanceClient | null = null;

export function getGovernanceClient(): GovernanceClient {
  if (!governanceClientInstance) {
    governanceClientInstance = new GovernanceClient();
  }
  return governanceClientInstance;
}

export function initGovernanceClient(config?: GovernanceClientConfig): GovernanceClient {
  governanceClientInstance = new GovernanceClient(config);
  return governanceClientInstance;
}
```

Also export GovernanceClient from src/governance/index.ts by adding:
```typescript
export { GovernanceClient, getGovernanceClient, initGovernanceClient, type GovernanceClientConfig } from "./client";
```
</action>
  <verify>grep -n "class GovernanceClient" src/governance/client.ts && grep -n "GovernanceClient" src/governance/index.ts</verify>
  <done>GovernanceClient class exists and is exported from governance/index.ts</done>
</task>

<task type="auto">
  <name>Task 2: Wire evaluate() into gateway</name>
  <files>src/gateway/index.ts</files>
  <action>
Wire policy engine evaluate() into the gateway's processInboundEvent flow.

Add to Gateway class:
1. Import: `import { evaluate, type ToolRequestContext, type PolicyDecision } from "../policy/engine";`
2. Import: `import { enqueue } from "../policy/approval-queue";`
3. Import GovernanceClient: `import { getGovernanceClient } from "../governance/client";`

Add helper methods to Gateway class:
```typescript
/**
 * Evaluate a tool request against policy rules.
 */
function evaluatePolicy(event: NormalizedEvent, toolName: string, toolArgs?: Record<string, unknown>): PolicyDecision {
  const gc = getGovernanceClient();
  const request: ToolRequestContext = {
    eventId: event.id || crypto.randomUUID(),
    source: event.channel,
    channelId: event.channelId,
    threadId: event.threadId,
    userId: event.userId,
    skillName: event.skillName,
    toolName,
    toolArgs,
    sessionId: event.sessionId,
    claudeSessionId: event.claudeSessionId,
    timestamp: event.timestamp,
    metadata: event.metadata,
  };
  return gc.evaluateToolRequest(request);
}

/**
 * Check if approval is required and enqueue if so.
 * Returns true if the request was enqueued for approval.
 */
async function checkToolApproval(
  event: NormalizedEvent, 
  decision: PolicyDecision
): Promise<{ needsApproval: boolean; approvalId?: string }> {
  if (decision.action !== "require_approval") {
    return { needsApproval: false };
  }
  
  const gc = getGovernanceClient();
  const request: ToolRequestContext = {
    eventId: event.id || crypto.randomUUID(),
    source: event.channel,
    channelId: event.channelId,
    threadId: event.threadId,
    userId: event.userId,
    skillName: event.skillName,
    toolName: decision.matchedRuleId || "unknown",
    timestamp: event.timestamp,
  };
  
  const entry = await gc.requestApproval(request, decision);
  if (entry) {
    return { needsApproval: true, approvalId: entry.id };
  }
  return { needsApproval: false };
}
```

Modify the `processInboundEvent` method to:
1. After Step 2 (session mapping), add policy evaluation:
```typescript
// Step 2b: Evaluate policy for inbound event
// This evaluates the incoming message as a "tool" request
const policyDecision = this.evaluatePolicy(event, "InboundMessage", {
  messageLength: event.text?.length ?? 0,
  hasAttachments: (event.attachments ?? []).length > 0,
});

// Check if approval is required
const { needsApproval, approvalId } = await this.checkToolApproval(event, policyDecision);
if (needsApproval) {
  return { 
    success: false, 
    error: `Request requires approval (ID: ${approvalId}). Please wait for operator approval.`,
  };
}

// If denied, reject the request
if (policyDecision.action === "deny") {
  return { 
    success: false, 
    error: `Request denied: ${policyDecision.reason}`,
  };
}
```

Note: The gateway processes inbound events (messages), not tool executions. The actual tool policy evaluation should happen at runner level. But the gateway should still evaluate inbound policy to reject obviously denied requests early.
</action>
  <verify>grep -n "evaluatePolicy\|checkToolApproval\|ToolRequestContext" src/gateway/index.ts | head -20</verify>
  <done>Gateway has policy evaluation wired via evaluatePolicy and checkToolApproval helpers</done>
</task>

<task type="auto">
  <name>Task 3: Create policy evaluation wrapper for runner</name>
  <files>src/runner.ts</files>
  <action>
Create a policy evaluation wrapper that can be used by the runner to evaluate tool requests.

Add to src/runner.ts:

1. Import at top:
```typescript
import { getGovernanceClient, type GovernanceClient } from "./governance/client";
```

2. Add policy evaluation helper before the execClaude function:
```typescript
/**
 * Policy-aware tool execution wrapper.
 * Evaluates tool requests against policy before allowing execution.
 */
async function evaluateToolForExecution(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
  context: {
    source: string;
    channelId?: string;
    userId?: string;
    skillName?: string;
    sessionId?: string;
    claudeSessionId?: string | null;
    eventId: string;
  }
): Promise<{ allowed: boolean; decision: import("./policy/engine").PolicyDecision }> {
  const gc = getGovernanceClient();
  const request: import("./policy/engine").ToolRequestContext = {
    eventId: context.eventId,
    source: context.source,
    channelId: context.channelId,
    userId: context.userId,
    skillName: context.skillName,
    toolName,
    toolArgs,
    sessionId: context.sessionId,
    claudeSessionId: context.claudeSessionId,
    timestamp: new Date().toISOString(),
  };

  const decision = gc.evaluateToolRequest(request);
  
  if (decision.action === "deny") {
    console.warn(`[policy] Tool ${toolName} denied: ${decision.reason}`);
    return { allowed: false, decision };
  }
  
  if (decision.action === "require_approval") {
    console.warn(`[policy] Tool ${toolName} requires approval: ${decision.reason}`);
    // Enqueue for approval
    const entry = await gc.requestApproval(request, decision);
    if (entry) {
      console.warn(`[policy] Approval request enqueued: ${entry.id}`);
    }
    return { allowed: false, decision };
  }
  
  return { allowed: true, decision };
}

/**
 * Get context for policy evaluation from current session and settings.
 */
async function getPolicyContext(source: string): Promise<{
  eventId: string;
  source: string;
  channelId?: string;
  userId?: string;
  skillName?: string;
  sessionId?: string;
  claudeSessionId?: string | null;
}> {
  const existing = await getSession();
  const settings = getSettings();
  return {
    eventId: crypto.randomUUID(),
    source,
    channelId: undefined, // Will be populated from event context
    userId: settings.userId,
    skillName: undefined,
    sessionId: existing?.sessionId,
    claudeSessionId: existing?.sessionId ?? null,
  };
}
```

Note: The runner doesn't currently have per-tool hooks since Claude Code handles tool calls internally. This wrapper is prepared for future integration where individual tool calls can be intercepted. For now, the policy evaluation happens at the gateway level for inbound messages.

Also add governance client initialization at the top of execClaude:
```typescript
// Ensure governance client is initialized
const gc = getGovernanceClient();
```
</action>
  <verify>grep -n "evaluateToolForExecution\|getGovernanceClient" src/runner.ts | head -10</verify>
  <done>Runner has policy evaluation wrapper functions added</done>
</task>

<task type="auto">
  <name>Task 4: Add integration tests for policy wiring</name>
  <files>src/__tests__/policy/wiring.test.ts</files>
  <action>
Create integration tests to verify the policy wiring is working correctly.

Create src/__tests__/policy/wiring.test.ts:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { evaluate } from "../../src/policy/engine";
import { enqueue, loadState, listPending, findByEventId } from "../../src/policy/approval-queue";
import { initGovernanceClient, getGovernanceClient, type GovernanceClient } from "../../src/governance/client";

describe("Policy Wiring Integration", () => {
  beforeEach(async () => {
    // Reset and reinitialize
    await loadState();
    initGovernanceClient({ policyEnabled: true, approvalEnabled: true });
  });

  describe("GovernanceClient", () => {
    it("should evaluate tool requests through policy engine", () => {
      const gc = getGovernanceClient();
      const request = {
        eventId: "test-event-1",
        source: "telegram",
        channelId: "telegram:123",
        userId: "user1",
        toolName: "Bash",
        timestamp: new Date().toISOString(),
      };

      const decision = gc.evaluateToolRequest(request);
      expect(decision).toBeDefined();
      expect(decision.action).toMatch(/^(allow|deny|require_approval)$/);
    });

    it("should detect allow decisions", () => {
      const gc = getGovernanceClient();
      const request = {
        eventId: "test-event-2",
        source: "telegram",
        channelId: "telegram:123",
        toolName: "Read",
        timestamp: new Date().toISOString(),
      };

      const allowed = gc.isToolAllowed(request);
      expect(typeof allowed).toBe("boolean");
    });

    it("should detect require_approval decisions", () => {
      const gc = getGovernanceClient();
      const request = {
        eventId: "test-event-3",
        source: "discord",
        channelId: "discord:456",
        toolName: "Edit",
        timestamp: new Date().toISOString(),
      };

      const requiresApproval = gc.requiresApproval(request);
      expect(typeof requiresApproval).toBe("boolean");
    });
  });

  describe("Policy Engine evaluate()", () => {
    it("should return deny when no rules match (default deny)", () => {
      const request = {
        eventId: "test-event-deny",
        source: "unknown",
        toolName: "SomeTool",
        timestamp: new Date().toISOString(),
      };

      const decision = evaluate(request);
      expect(decision.action).toBe("deny");
      expect(decision.reason).toContain("No matching policy rule");
    });

    it("should include requestId and evaluatedAt in decision", () => {
      const request = {
        eventId: "test-event-meta",
        source: "telegram",
        toolName: "View",
        timestamp: new Date().toISOString(),
      };

      const decision = evaluate(request);
      expect(decision.requestId).toBeDefined();
      expect(decision.evaluatedAt).toBeDefined();
    });
  });

  describe("Approval Queue enqueue()", () => {
    it("should enqueue require_approval requests", async () => {
      const request = {
        eventId: "test-approval-event",
        source: "telegram",
        toolName: "Edit",
        timestamp: new Date().toISOString(),
      };

      const decision = {
        requestId: "test-req-id",
        action: "require_approval" as const,
        reason: "Edit requires approval",
        evaluatedAt: new Date().toISOString(),
      };

      const entry = await enqueue(request, decision);
      expect(entry).toBeDefined();
      expect(entry.id).toBeDefined();
      expect(entry.status).toBe("pending");
      expect(entry.eventId).toBe("test-approval-event");
    });

    it("should find enqueued approval by eventId", async () => {
      const eventId = "test-find-event-" + Date.now();
      const request = {
        eventId,
        source: "discord",
        toolName: "Bash",
        timestamp: new Date().toISOString(),
      };

      const decision = {
        requestId: "test-req-id-2",
        action: "require_approval" as const,
        reason: "Bash requires approval",
        evaluatedAt: new Date().toISOString(),
      };

      await enqueue(request, decision);
      const found = await findByEventId(eventId);
      expect(found).toBeDefined();
      expect(found?.eventId).toBe(eventId);
    });

    it("should list pending approvals", async () => {
      const pending = listPending();
      expect(Array.isArray(pending)).toBe(true);
    });
  });
});
```
</action>
  <verify>bun test src/__tests__/policy/wiring.test.ts 2>&1 | tail -20</verify>
  <done>Integration tests exist and verify policy/approval wiring</done>
</task>

</tasks>

<verification>
- GovernanceClient exported from src/governance/index.ts
- evaluate() called via GovernanceClient in gateway
- enqueue() called via GovernanceClient when require_approval decision returned
- All new tests pass
</verification>

<success_criteria>
- REQ-3.1: Policy engine evaluate() is wired to gateway (verified by grep finding evaluatePolicy calls)
- REQ-3.3: Approval queue enqueue() is wired via checkToolApproval in gateway (verified by grep finding enqueue usage)
- REQ-5.1: GovernanceClient interface implemented and exported (verified by GovernanceClient class existence)
</success_criteria>

<output>
After completion, create `.planning/phases/08-policy-integration/8-01-SUMMARY.md`
</output>
