---
phase: 2-session-gateway
plan: 02
subsystem: gateway
tags: [event-normalization, telegram, discord, cron, webhook, typescript]

# Dependency graph
requires:
  - phase: 1-event-bus
    provides: event-log, event-processor, retry-queue, dead-letter-queue, replay
provides:
  - Normalized event schema (Channel, Attachment, NormalizedEvent types)
  - Type guards (isNormalizedEvent, isValidChannel)
  - Platform normalizers (Telegram, Discord, Cron, Webhook)
affects: [2-session-gateway, 3-policy-engine]

# Tech tracking
tech-stack:
  added: []
  patterns: [normalized-event-schema, type-guards, adapter-decoupling]

key-files:
  created:
    - src/gateway/normalizer.ts
    - src/__tests__/gateway/normalizer.test.ts
  modified: []

key-decisions:
  - "Local UUID assigned by event log, not normalizer (seq belongs to event log)"
  - "Telegram channelId format: telegram:<chat.id>"
  - "Discord channelId format preserves guild context: discord:guild:<guild_id>:<channel_id>"
  - "Discord DM format: discord:dm:<channel_id>"
  - "System actor userId for Cron/Webhook: 'system' (stable synthetic identifier)"
  - "Sensitive webhook headers (authorization, cookie, x-api-key, x-auth) stripped from metadata"

patterns-established:
  - "NormalizedEvent schema with sourceEventId for upstream provenance"
  - "Attachment classification: image, voice, document with metadata preservation"
  - "Type guards validate schema conformance without runtime overhead"

requirements-completed: [event-normalization, adapter-decoupling]

# Metrics
duration: 4min
completed: 2026-03-27T12:49:31Z
---

# Phase 2 Plan 2: Normalized Event Schema Summary

**Normalized event schema with type guards for Telegram, Discord, Cron, and Webhook — decouples channel adapters from gateway processing**

## Performance

- **Duration:** 4 min (12:45 → 12:49)
- **Started:** 2026-03-27T12:45:19Z
- **Completed:** 2026-03-27T12:49:31Z
- **Tasks:** 5 (all implemented)
- **Files created:** 2

## Accomplishments
- Created unified NormalizedEvent schema with Channel, Attachment types
- Implemented type guards (isNormalizedEvent, isValidChannel) for runtime validation
- Built Telegram normalizer handling text, captions, photos, voice, documents, replies, threads
- Built Discord normalizer with guild/DM context, image/voice/document classification, slash command extraction
- Built Cron/Webhook normalizers with payload preservation and sensitive header stripping
- Comprehensive test suite: 44 tests, 109 assertions, covering happy paths and edge cases

## Task Commits

Each task was committed atomically:

1. **Task 1-5: Normalized Event Schema Implementation** - `b2dac26` (feat)

**Plan metadata:** `b2dac26` (feat: complete plan)

## Files Created/Modified

- `src/gateway/normalizer.ts` - Core normalizer module with types, guards, and platform normalizers
- `src/__tests__/gateway/normalizer.test.ts` - 44 tests covering all normalizers and edge cases

## Decisions Made

- **seq field excluded from NormalizedEvent** — Sequence numbers are assigned by the event log, not the normalizer. This ensures normalization is stateless and adapters remain decoupled from event log concerns.
- **Telegram channelId uses `telegram:<chat.id>` format** — Simple, stable identifier that maps directly to Telegram's chat structure.
- **Discord channelId preserves guild context** — Format `discord:guild:<guild_id>:<channel_id>` maintains isolation semantics and enables guild-scoped routing.
- **System actor userId = "system"** — Stable synthetic identifier for Cron/Webhook events ensures consistent actor representation without real user IDs.
- **Sensitive headers stripped from Webhook metadata** — Authorization, cookie, x-api-key, x-auth headers are excluded to prevent accidental secrets logging.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - all verification criteria met on first run.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- NormalizedEvent schema ready for Session Map Store (2-01) and session gateway integration
- Type guards available for runtime validation at gateway entry points
- Adapters can now normalize events independently, then submit to event log
