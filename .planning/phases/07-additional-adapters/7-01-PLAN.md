---
phase: 7
plan: 01
name: Additional Adapters
objective: Create a durable adapter architecture package, capability contracts, and implementation-ready scaffolds for future Slack, Teams, Email, and GitHub channel integrations without shipping fake working adapters
description: Adapter architecture package and implementation scaffolding for future channel support
tags: [adapters, architecture, slack, teams, email, github, scaffolding]
wave: 1
estimated_duration: 2h
autonomous: true
gap_closure: false

dependencies:
  - phase: 2
    plan: 04
    reason: Session Gateway provides adapter integration patterns

must_haves:
  - shared adapter architecture documented in src/adapters/README.md
  - adapter contract updated for gateway/session/normalization model
  - per-adapter scaffold directories exist for Slack, Teams, Email, and GitHub
  - each adapter README includes environment, auth, threading, inbound/outbound semantics
  - capability matrix comparing all adapters (Telegram, Discord, Slack, Teams, Email, GitHub)
  - configuration examples align with current settings model
  - no fake implementations or misleading stubs introduced
  - documentation honest about what is scaffolding vs working code
---

# Phase 7: Additional Adapters

## Goal
Create a clean adapter architecture package and implementation-ready scaffolds for future Slack, Teams, Email, and GitHub support.

This phase is **not** about pretending those adapters already work. It is about ensuring the system is ready for real implementations later by defining:
- adapter contracts
- capability boundaries
- normalized inbound/outbound semantics
- configuration/documentation expectations
- per-platform scaffolding and investigation notes

The output should make future adapter implementation straightforward and reduce architectural churn later.

## Why This Matters

### Current state
- Telegram and Discord are the only supported channels.
- Additional platforms are mentioned conceptually but not formalized architecturally.
- Without a stronger adapter package, future integrations will likely reinvent normalization, delivery, auth, threading, and lifecycle concerns inconsistently.

### Target state
- There is a documented adapter architecture shared across all channels.
- Future adapters plug into the Phase 2 gateway/session model cleanly.
- Platform-specific differences are captured as capabilities and constraints, not hidden in ad hoc adapter code.
- Each future adapter has a directory, scaffold docs, config contract, and implementation notes.
- No fake adapters or misleading placeholder implementations are shipped.

## Non-goals for Phase 7
Do **not** implement:
- working Slack/Teams/Email/GitHub integrations
- fake webhook handlers that appear real
- mock delivery code that implies production readiness
- provider-specific auth flows beyond documented scaffolding/config contracts
- broad channel UX work in the dashboard

This phase is specifically about **architecture, scaffolding, and documentation**.

## Success Criteria
- shared adapter architecture is documented in `src/adapters/README.md`
- adapter contract is updated to reflect the actual gateway/session/normalization model
- per-adapter scaffold directories exist for Slack, Teams, Email, and GitHub
- each adapter README includes environment, auth, threading, inbound event handling, outbound reply semantics, capabilities, constraints, and testing notes
- a capability matrix exists comparing current and future adapters
- configuration examples align with current system settings model
- no fake implementations or misleading stubs are introduced
- future adapter work can begin without redefining the control-plane boundaries

## Prerequisites
- Phase 2 (Session Gateway) complete
- all previous tests passing
- normalization and gateway contracts stable enough to document accurately

## Core design constraints
- adapters are transport/platform boundary components
- gateway/session mapping remains the control-plane coordinator
- normalization should produce the common inbound event shape used by the gateway
- outbound sending must respect thread/session routing semantics
- adapters must declare capabilities explicitly instead of assuming all platforms behave the same
- documentation/scaffolding must not pretend unsupported features already exist

## Architectural scope for this phase
This phase should produce:

1. **Shared adapter architecture overview**
2. **Common adapter contract / interface definitions**
3. **Capability matrix**
4. **Per-platform scaffolds and docs**
5. **Configuration examples**
6. **Implementation notes and investigation gaps**

It should **not** produce runnable channel integrations.

## Adapter architecture

### Recommended contract
The original contract in the uploaded Phase 7 plan is a useful start, but it is too thin for real adapter work. It should be revised to reflect:
- inbound admission to gateway
- outbound reply/send operations
- capability discovery
- startup/shutdown lifecycle
- health/reporting hooks
- optional thread/reply semantics

Recommended contract:

```ts
interface ChannelAdapter {
  name: string;

  // Initialize credentials/config/resources
  initialize(): Promise<void>;

  // Start receiving inbound events (webhook registration, polling loop, socket mode, etc.)
  start(): Promise<void>;

  // Stop receiving inbound events cleanly
  stop(): Promise<void>;

  // Return adapter capabilities so gateway/outbound logic can reason about platform differences
  getCapabilities(): AdapterCapabilities;

  // Convert platform-specific inbound event into normalized inbound event shape
  normalizeInboundEvent(platformEvent: unknown): NormalizedEvent;

  // Send or reply to a thread/conversation on the platform
  sendMessage(target: OutboundMessageTarget, content: OutboundMessageContent): Promise<AdapterSendResult>;

  // Optional: edit/update/delete if the platform supports it
  editMessage?(target: OutboundMessageTarget, content: OutboundMessageContent): Promise<AdapterSendResult>;
}
```

### Capability model
```ts
interface AdapterCapabilities {
  supportsThreads: boolean;
  supportsDirectMessages: boolean;
  supportsChannelMessages: boolean;
  supportsMessageEdit?: boolean;
  supportsAttachments?: boolean;
  supportsReactions?: boolean;
  supportsRichCards?: boolean;
  supportsWebhooks?: boolean;
  supportsPolling?: boolean;
  requiresPublicWebhook?: boolean;
}
```

### Outbound target model
```ts
interface OutboundMessageTarget {
  source: string;
  channelId?: string;
  threadId?: string;
  userId?: string;
  replyToMessageId?: string;
}
```

### Why this matters
Different platforms are not interchangeable:
- Slack threads behave differently from Teams threads.
- Email threading is header-based, not chat-thread-based.
- GitHub is comment/review/event-centric, not chat-centric.
- Some platforms need public webhooks; others can use socket/polling models.

The adapter contract must reflect these realities.

## Tasks

### G.1 — Shared Adapter Architecture Overview
- **File:** `src/adapters/README.md`
- **Status:** TODO
- **Prerequisites:** Phase 2 gateway/normalizer stable

#### Goal
Document the adapter architecture and control-plane boundaries for current and future channel integrations.

#### Done When
- [ ] `src/adapters/README.md` created or updated
- [ ] documents adapter responsibilities vs gateway responsibilities
- [ ] documents inbound flow:
  - platform event
  - adapter normalization
  - gateway admission/session mapping
  - event bus
- [ ] documents outbound flow:
  - gateway routing
  - adapter target resolution
  - platform send/reply
- [ ] documents lifecycle responsibilities:
  - initialize
  - start
  - stop
  - health/capabilities
- [ ] includes explicit “what adapters must not do” section (e.g. invent session IDs, bypass gateway/policy)
- [ ] includes capability matrix section or links to it

#### Important Notes
- adapters should not become mini-gateways
- adapters should not own durable session mapping
- docs should align with actual Phase 2 architecture, not an imagined one

---

### G.2 — Common Adapter Contract & Capability Matrix
- **File:** `src/adapters/contracts.md`
- **Status:** TODO
- **Prerequisites:** G.1

#### Goal
Define a stable adapter contract and capability matrix for current/future implementations.

#### Done When
- [ ] common adapter contract documented
- [ ] normalized inbound/outbound semantics documented
- [ ] capability matrix created covering at least:
  - Telegram
  - Discord
  - Slack
  - Teams
  - Email
  - GitHub
- [ ] capability matrix includes:
  - threading model
  - inbound mode (webhook/socket/polling)
  - outbound reply mode
  - attachments support
  - auth model
  - webhook/public endpoint requirement
  - major rate-limit concerns
- [ ] investigation gaps called out per platform

#### Important Notes
- this can be documentation-only if code contracts are not ready to freeze yet
- do not publish TypeScript interfaces in code unless they match the repo’s current architecture closely enough to be stable

---

### G.3 — Slack Adapter Scaffold
- **File:** `src/adapters/slack/README.md`
- **Status:** TODO
- **Prerequisites:** G.1, G.2

#### Goal
Provide an implementation-ready scaffold for a future Slack adapter.

#### Done When
- [ ] directory created: `src/adapters/slack/`
- [ ] README documents:
  - required environment variables
  - app setup steps
  - auth model
  - inbound mode options (Events API vs Socket Mode)
  - threading model via `thread_ts`
  - channel vs DM behavior
  - outbound reply semantics
  - required bot scopes/permissions
  - signature validation requirements
  - testing approach
  - rate-limit considerations
  - open investigation questions
- [ ] explicitly states that no working implementation is included

#### Important Notes
- document whether Socket Mode vs Events API is preferred and why
- be explicit about public webhook requirements if not using Socket Mode

---

### G.4 — Teams Adapter Scaffold
- **File:** `src/adapters/teams/README.md`
- **Status:** TODO
- **Prerequisites:** G.1, G.2

#### Goal
Provide an implementation-ready scaffold for a future Teams adapter.

#### Done When
- [ ] directory created: `src/adapters/teams/`
- [ ] README documents:
  - required environment variables
  - Azure/Bot Framework registration steps
  - auth model
  - inbound endpoint requirements
  - Teams conversation/threading semantics
  - outbound messaging semantics
  - Adaptive Card / rich formatting considerations
  - local testing approach
  - deployment/testing constraints
  - rate-limit / tenant considerations
  - open investigation questions
- [ ] explicitly states that no working implementation is included

#### Important Notes
- Teams semantics are not identical to Slack; document platform-specific constraints instead of forcing symmetry

---

### G.5 — Email Adapter Scaffold
- **File:** `src/adapters/email/README.md`
- **Status:** TODO
- **Prerequisites:** G.1, G.2

#### Goal
Provide an implementation-ready scaffold for a future Email adapter.

#### Done When
- [ ] directory created: `src/adapters/email/`
- [ ] README documents:
  - IMAP/SMTP environment variables
  - optional API-based alternatives (Gmail API, third-party APIs)
  - inbound polling vs push tradeoffs
  - threading model using `Message-ID`, `In-Reply-To`, `References`
  - attachment handling considerations
  - spoofing/security concerns
  - rate limiting / loop prevention considerations
  - outbound reply semantics
  - testing approach
  - open investigation questions
- [ ] explicitly states that no working implementation is included

#### Important Notes
- email is not chat; the docs should reflect that clearly
- loop prevention and spoofing controls deserve explicit treatment

---

### G.6 — GitHub Adapter Scaffold
- **File:** `src/adapters/github/README.md`
- **Status:** TODO
- **Prerequisites:** G.1, G.2

#### Goal
Provide an implementation-ready scaffold for a future GitHub adapter.

#### Done When
- [ ] directory created: `src/adapters/github/`
- [ ] README documents:
  - required environment variables
  - GitHub App setup
  - webhook validation/signature requirements
  - relevant event types (issues, issue_comment, pull_request, pull_request_review, etc.)
  - auth model
  - comment/reply semantics
  - command invocation conventions (e.g. mention/comment-driven commands)
  - check-run/status update possibilities
  - rate-limit considerations
  - testing approach
  - open investigation questions
- [ ] explicitly states that no working implementation is included

#### Important Notes
- GitHub is event/review centric, not a real-time chat adapter; document differences explicitly

---

### G.7 — Configuration & Implementation Notes
- **File:** `src/adapters/configuration.md`
- **Status:** TODO
- **Prerequisites:** G.1–G.6

#### Goal
Document configuration patterns and future implementation guidance across adapters.

#### Done When
- [ ] configuration examples align with current settings/config model
- [ ] env var examples included for each adapter
- [ ] secrets handling expectations documented
- [ ] public webhook vs socket/polling tradeoffs documented
- [ ] “implementation readiness checklist” provided for future adapter phases
- [ ] known unknowns and investigation tasks captured explicitly

#### Important Notes
- config examples should not drift from current repo conventions
- do not add fake enabled-by-default config

## Integration Points

### With Phase 2
- adapters normalize inbound events before gateway admission
- gateway routes outbound messages to the appropriate adapter
- adapters must respect local session mapping and thread context produced by the gateway

### With Phase 3
- future adapter actions should not bypass policy-governed execution paths
- adapter docs should note where inbound commands/messages enter policy evaluation

### With Phase 4
- future adapter implementations may need provider/rate/budget-aware behavior, especially for high-volume channels
- docs should note platform rate limits and operational concerns

### With Phase 5
- future adapter implementations may need to reflect orchestration state in replies/notifications
- handoff/resume/operator flows may eventually surface over these adapters

### With Phase 6
- future escalation notifications may be delivered through some adapters
- docs should note whether the platform is a realistic delivery target for escalation alerts

## Capability Matrix (minimum required dimensions)
Create a comparison matrix that includes at least:

| Adapter | Inbound Mode | Threading Model | Outbound Reply Model | Attachments | Public Webhook Needed | DM Support | Channel Support | Notes |
|---------|--------------|-----------------|----------------------|-------------|-----------------------|------------|-----------------|-------|

Populate for:
- Telegram
- Discord
- Slack
- Teams
- Email
- GitHub

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Shipping fake integrations | Documentation/scaffolding only; no runnable fake adapters |
| Adapter contract mismatch later | Keep contract aligned to current gateway architecture and mark unstable areas clearly |
| Missing platform-specific constraints | Include investigation gaps and capability matrix |
| Config drift from repo reality | Align docs with existing config/settings model |
| Over-generalizing platforms | Document platform differences explicitly instead of forcing symmetry |

## Dependencies
- Phase 2 gateway/session architecture
- existing Telegram/Discord adapter behavior as reference inputs
- current config/settings model
- no external credentials required for this documentation/scaffold phase

## Expected Output
- `src/adapters/README.md`
- `src/adapters/contracts.md`
- `src/adapters/configuration.md`
- `src/adapters/slack/README.md`
- `src/adapters/teams/README.md`
- `src/adapters/email/README.md`
- `src/adapters/github/README.md`

## No Code Tests Required
This phase is documentation/scaffolding only.

However:
- verify paths and docs are internally consistent
- verify contract and config examples match current gateway/config architecture
- verify no README implies a working adapter exists when it does not

## Final Checkpoint
After this phase completes:
1. review all adapter docs for completeness and honesty
2. verify adapter contract aligns with current gateway/session architecture
3. verify capability matrix is complete
4. verify config examples match current settings model
5. project complete — ready for release prep or future per-adapter implementation phases

## Post-v2 Future Work
Actual adapter implementation can then be tackled as separate, focused phases:
- Slack adapter
- GitHub adapter
- Email adapter
- Teams adapter

Each should get its own implementation plan, credentials/testing setup, and production-hardening phase.
