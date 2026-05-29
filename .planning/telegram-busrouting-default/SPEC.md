# SPEC — Telegram bus adapter mounts on token alone (#197)

**Issue:** TerrysPOV/ClaudeClaw-Plus#197 — cause #2 of the 3-cause fresh-install
breakage (#193). #195 fixed cause #3 (bypass-permissions dialog); #196 fixed
cause #1 (no default agent declared). This is the last cause.

## 1. Problem statement

The bus Telegram adapter refuses to mount unless **both** `telegram.token` and
`telegram.busRouting` are present. A fresh install sets the token (via the
wizard / env) but never writes `busRouting`, so `mountTelegram` returns `null`,
the startup banner reads `no adapters`, and the bot is silent despite a valid
token. (Field trace: moazbuilds/claudeclaw#216, @GordonWu.)

## 2. Current behaviour (as-is)

- `src/bus/adapter-wiring.ts:168` — `mountTelegram`: `if (!cfg.token || !cfg.busRouting) return null;`.
- `src/bus/adapter-wiring.ts:111` — `configuredBusAdapterNames`: telegram counted
  only when `token && busRouting` (so the pre-spawn banner also reports it as
  absent).
- `TelegramBusRouting = { chats: Record<chatId,agentId>; defaultAgentId? }`
  (`src/config.ts:258-261`). `parseTelegramBusRouting` returns `null` unless
  `chats` or `defaultAgentId` is present (`config.ts:1167-1180`), so a fresh
  install's absent block parses to `undefined`.
- `TelegramAdapter.resolveAgent(chatId)` returns `routingChats[chatId] ?? defaultAgentId`
  (`src/adapters/telegram/index.ts:750-753`) — so empty `chats` + a
  `defaultAgentId` routes **every** chat to the default agent.
- Allow-list: empty `allowedUserIds` = **allow all** (`index.ts:287-296`), so a
  token-only install accepts inbound from any user.
- `wireBusAdapters` is called with only `{ bus, settings }`
  (`src/commands/start.ts:893`); it has no notion of the default agent id. The
  scheduler wiring right after uses `busRuntimeHandle.spawnedAgentIds[0]`
  (`start.ts:906`).

Net: token set, `busRouting` absent → adapter never mounts → silent bot.

## 3. Target behaviour (to-be)

- When `telegram.token` is present and `telegram.busRouting` is **absent**, the
  adapter mounts with a derived default routing `{ chats: {}, defaultAgentId }`
  where `defaultAgentId` is the bus's default agent (first spawned agent — now
  always present after #196). All inbound chats route to that agent; replies go
  back to the originating chat.
- When `telegram.busRouting` is **present**, behaviour is unchanged (explicit
  config wins).
- When `telegram.token` is present but there is **no** default agent to route to
  (e.g. operator cleared `settings.agents` to `[]`), the adapter still skips —
  there is genuinely nothing to route to. A one-line info log explains the
  derive when it happens.
- The pre-spawn startup banner (`configuredBusAdapterNames`) reflects the same
  predicate so it doesn't under-report Telegram.

## 4. Architecture decisions (frozen)

- **Graceful-degrade in the adapter, not a wizard write.** The robust fix lives
  in `mountTelegram`: it works regardless of how the token was supplied (wizard,
  env, hand-edited settings). Writing a default `busRouting` block at wizard
  time would only cover the wizard path and risks touching the token-write flow.
  (Rejected: wizard-writes-busRouting as the primary fix.)
- **Telegram only.** Cause #2 is Telegram. Discord and Slack are channel-routed
  (`channels: Record<channelId,agentId>` is required; there is no single
  "default chat"), so a default-agent degrade is a separate design. Their
  `token && busRouting` guards are left unchanged. (Out of scope.)
- **Thread the default agent id through `wireBusAdapters`.** Add
  `defaultAgentId?: string` to `WireBusAdaptersOptions`; `start.ts` passes
  `busRuntimeHandle.spawnedAgentIds[0]` (the same id the scheduler targets). The
  banner passes `settings.agents[0]?.id` (declared default, pre-spawn).
- **Derive only when there is an agent.** No default agent ⇒ no derived routing
  ⇒ skip (don't mount an adapter whose messages would land on no consumer).
- **Pairs with #196.** #196 guarantees a `default` agent exists on fresh install;
  this routes Telegram to it. Both are required for the end-to-end fresh-install
  path.

## 5. Key file references

- `src/bus/adapter-wiring.ts`:
  - `WireBusAdaptersOptions` (~52-59) — add `defaultAgentId?`.
  - `wireBusAdapters` (~66-96) — pass `defaultAgentId` to `mountTelegram`.
  - `configuredBusAdapterNames` (~106-115) — telegram predicate `token && (busRouting || defaultAgentId)`.
  - `mountTelegram` (~163-184) — derive `{ chats: {}, defaultAgentId }` when token set + busRouting absent + defaultAgentId present; log it.
- `src/commands/start.ts`:
  - `configuredBusAdapterNames(settings)` call (~570) → pass `settings.agents[0]?.id`.
  - `wireBusAdapters({ bus, settings })` call (~893) → add `defaultAgentId: busRuntimeHandle.spawnedAgentIds[0]`.
- `src/adapters/telegram/index.ts:750-753` (resolveAgent), `:287-296` (allow-list) — confirm derived routing reaches the default agent. No change.
- Tests: `src/bus/__tests__/adapter-wiring.test.ts` (the gating suite).

## 6. Out of scope (deferred)

- Discord / Slack token-only degrade (channel-routed; separate design).
- Wizard writing an explicit `telegram.busRouting` block.
- Outbound cron/heartbeat → Telegram chat selection with empty `chats`
  (`pickOutboundChat` needs a chat map; inbound-reply works without it). Same
  limitation as any chat-less routing today; not part of this acceptance.
- Per-user rate limiting (pre-existing TODO in the adapter).
