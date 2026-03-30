---
phase: 2-session-gateway
plan: 02
version: revised
wave: 1
type: execute
depends_on: []
files_modified:
  - src/gateway/normalizer.ts
  - src/__tests__/gateway/normalizer.test.ts
autonomous: true
requirements:
  - event-normalization
  - adapter-decoupling
must_haves:
  truths:
    - "All inbound platform events normalize to the same core schema"
    - "Normalization does not assign durable sequence numbers"
    - "Normalized events preserve provenance needed for dedupe and replay"
    - "Adapters only need to normalize and submit events"
  artifacts:
    - path: "src/gateway/normalizer.ts"
      provides: "Normalized event schema and normalizer functions"
      exports: ["normalizeTelegramMessage", "normalizeDiscordMessage", "normalizeCronEvent", "normalizeWebhookEvent", "isNormalizedEvent", "isValidChannel"]
    - path: "src/__tests__/gateway/normalizer.test.ts"
      provides: "Unit tests for normalization"
---

# Objective

Create the normalized inbound event schema and normalizer functions that transform platform-specific events into a unified format.

Purpose: decouple channel adapters from gateway and processing logic so new platforms only need normalization, not core code changes.

# Important corrections

1. `seq` must **not** be assigned in the normalizer. Sequence numbers belong to the event log.
2. Normalized events should preserve source provenance needed for dedupe/resume.
3. Outbound denormalization is optional in this wave unless the repo already needs it; do not force outbound abstractions prematurely.

# Success criteria

- all supported inbound platforms normalize into one schema
- schema contains source provenance and stable source identifiers where available
- Telegram, Discord, Cron, and Webhook normalization are implemented
- normalization handles attachments consistently
- type guards validate the schema
- tests cover happy paths and edge cases

# Core schema

```ts
export type Channel = "telegram" | "discord" | "cron" | "webhook";

export interface Attachment {
  type: "image" | "voice" | "document";
  url?: string;
  localPath?: string;
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
}

export interface NormalizedEvent {
  id: string;                 // local event UUID
  channel: Channel;
  sourceEventId?: string;     // upstream message/event ID if available
  channelId: string;
  threadId: string;
  userId: string;
  text: string;
  attachments: Attachment[];
  timestamp: number;          // source timestamp if available, else now
  metadata: {
    replyTo?: string;
    command?: string;
    entities?: unknown[];
    rawType?: string | number;
    [key: string]: unknown;
  };
}
```

## Notes

- `id` is local.
- `sourceEventId` is critical when upstream platforms provide a stable message/event ID.
- No `seq` field here.
- `threadId` should always be normalized to a string, using `"default"` when absent.

# Tasks

## Task 1 — Define normalized schema and type guards

**File:** `src/gateway/normalizer.ts`

### Done when
- exports `Channel`, `Attachment`, and `NormalizedEvent`
- exports:
  - `isNormalizedEvent(obj)`
  - `isValidChannel(str)`
- minimal platform source interfaces are defined or imported safely
- schema is documented at module level

### Tests
- valid normalized event passes guard
- invalid structures fail guard
- invalid channel values fail validation

## Task 2 — Implement Telegram normalization

### Done when
- `normalizeTelegramMessage(message)` returns a `NormalizedEvent`
- field mapping includes:
  - `sourceEventId = message.message_id`
  - `channelId = telegram:<chat.id>`
  - `threadId = message_thread_id || "default"`
  - `userId = from.id || "unknown"`
  - `text = text ?? caption ?? ""`
- photo/voice/document attachments normalize correctly
- entities/reply metadata preserved
- source timestamp used if available; otherwise `Date.now()`

### Important note
Do not treat Telegram file availability as solved at normalization time. Preserve metadata only; file fetching/downloading belongs elsewhere.

### Tests
- text message
- caption-only message
- photo
- voice/audio
- document
- reply metadata
- thread/topic message

## Task 3 — Implement Discord normalization

### Done when
- `normalizeDiscordMessage(message)` returns a `NormalizedEvent`
- includes:
  - `sourceEventId = message.id`
  - channel/thread mapping that preserves enough context for isolation
  - `userId = author.id || "unknown"`
  - trimmed content text
- image/voice/document attachment classification is reasonable and documented
- reply/reference metadata preserved where available

### Important correction
Do not bury thread identity irreversibly inside `channelId` if the source exposes a separate thread concept. Preserve thread semantics explicitly where possible.

### Tests
- basic guild message
- DM message
- image attachment
- voice attachment
- reply/reference message
- thread-aware message handling

## Task 4 — Implement Cron and Webhook normalization

### Done when
- `normalizeCronEvent(event)` and `normalizeWebhookEvent(event)` are implemented
- payload/header/context data preserved in metadata
- synthetic system actors use a stable convention such as `userId = "system"`

### Tests
- cron with and without payload
- webhook with headers/body/path

## Task 5 — Comprehensive unit tests

**File:** `src/__tests__/gateway/normalizer.test.ts`

### Must cover
- type guards
- Telegram mapping
- Discord mapping
- Cron/Webhook mapping
- empty content
- missing optional fields
- unicode text
- large metadata payloads

# Verification

1. `bun test src/__tests__/gateway/normalizer.test.ts`
2. manually inspect normalized output samples for all platforms
3. verify no normalized object includes a gateway/event-log sequence number

# Output

After completion, create:
- `.planning/phases/2-session-gateway/2-02-SUMMARY.md`
