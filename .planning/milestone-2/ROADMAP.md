# Milestone 2: Tool-Level Governance & Production Hardening

## Vision

Achieve production-ready deployment with tool-level policy enforcement, enhanced observability, and multi-channel stability.

## Status

**Planned**

---

## Architectural Decision: Tool-Level Policy Enforcement

### Context

Milestone v1.0 implemented gateway-level policy enforcement — policy is evaluated before events reach Claude Code execution. However, tool-level enforcement (intercepting individual tool calls during Claude Code execution) was identified as an **architectural limitation**.

### The Problem

The current runner uses `execClaude()` which spawns Claude Code as a subprocess:

```
runner.execClaude()
  → spawns `claude-code` process
  → pipes stdin/stdout for messages
  → NO access to individual tool calls in real-time
```

Claude Code runs autonomously once spawned. There is no hook, event stream, or callback that allows the parent process to intercept each tool call (e.g., `bash`, `Write`, `Read`) to evaluate policy in real-time.

### What This Disables

- **Per-tool policy overrides**: Cannot say "allow `bash` but deny `Write` for user X in channel Y"
- **Runtime tool blacklists**: Cannot revoke a tool mid-session
- **Tool-level audit granularity**: Audit logs policy decision but not which tools were actually called

### Options Considered

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| **Option 1: Direct API Integration** | Replace subprocess with Claude Code SDK (if available) | Full control, real-time interception | SDK may not exist, significant rework |
| **Option 2: Proxy Mode** | Run Claude Code behind a local proxy that intercepts tool calls | Non-invasive, works with existing subprocess | Adds latency, proxy complexity |
| **Option 3: Event Instrumentation** | Use Claude Code hooks/callbacks if exposed | Clean integration | May not be exposed by Claude Code |
| **Option 4: Accept Limitation** | Document as known gap, continue with gateway-level enforcement | Ships sooner, gateway enforcement covers most cases | Reduced granularity |

### Decision

**Pursue Option 1: Direct API Integration** for Milestone 2.

If Claude Code SDK is not available or viable, fall back to Option 2 (Proxy Mode).

**Rationale:** True production-grade governance requires tool-level control. Gateway-level enforcement is a strong foundation but insufficient for enterprise requirements where tool access must be controlled per-user, per-session, or in real-time.

### Implementation Hint

Research Claude Code SDK availability and API capabilities before planning. If unavailable, evaluate proxy-based interception as fallback.

---

## Planned Requirements

### Tool-Level Governance
- [ ] Direct API integration or proxy-based tool interception
- [ ] Per-tool policy evaluation during execution
- [ ] Runtime tool revocation capability
- [ ] Tool-level audit trail (what tools were called, not just policy decisions)

### Production Hardening
- [ ] Performance benchmarking vs v1
- [ ] Load testing
- [ ] Error rate reduction
- [ ] Monitoring/alerting setup

### Enhanced Observability
- [ ] Grafana dashboards for governance metrics
- [ ] Real-time usage dashboard
- [ ] Audit log viewer/API

### Additional Channels (if SDK viable)
- [ ] Slack adapter (documented in Phase 7)
- [ ] Microsoft Teams adapter
- [ ] Email adapter

---

## Timeline

TBD — depends on Claude Code SDK research.

---

## Milestone Dependencies

```
Milestone 1 (v1.0) ──────────────────────────►
      │                                          │
      │    ┌─────────────────────────────────────┘
      ▼    ▼
Milestone 2 (Tool-Level Governance)
      │
      └──► Production deployment
```
