/**
 * Test fixtures for `src/adapters/discord/__tests__/discord.test.ts`.
 *
 * Pulled out so the test file stays under the per-file LOC cap
 * (SPRINT_3_PLAN.md). Contains:
 *   - FakeBus           — minimal `BusCore` implementation that captures
 *                          adapter→bus traffic and pushes synthetic events.
 *   - FakeDiscordGateway — emulates `MESSAGE_CREATE` / `INTERACTION_CREATE`
 *                          events without a real WebSocket.
 *   - FakeDiscordRestApi — captures `sendMessage` + interaction acks.
 *   - Test message + interaction factory helpers.
 */

import { randomUUID } from "node:crypto";
import type { BusCore, SendPromptRequest } from "../../../bus/core";
import type {
  Subscription,
  SubscriptionFilter,
  SubscriptionHandler,
} from "../../../bus/core-subscription";
import type { BusEvent } from "../../../bus/types";
import { DiscordAdapter } from "../index";
import type {
  DiscordGatewayLike,
  DiscordInboundInteraction,
  DiscordInboundMessage,
  DiscordRestApiLike,
  GatewayEvent,
} from "../types";

/* ────────────────────────────────────────────────────────────────────── */
/* FakeBus                                                                */
/* ────────────────────────────────────────────────────────────────────── */

interface FakeSubscription extends Subscription {
  filter: SubscriptionFilter;
  handler: SubscriptionHandler;
  closedFlag: boolean;
}

export class FakeBus implements BusCore {
  public readonly prompts: SendPromptRequest[] = [];
  public readonly permissionDecisions: Array<{
    agent_id: string;
    request_id: string;
    behavior: "allow" | "deny";
  }> = [];
  public readonly askAnswers: Array<{ agent_id: string; ask_id: string; answer: string }> = [];
  public readonly subscriptions = new Map<string, FakeSubscription>();

  async sendPrompt(req: SendPromptRequest): Promise<{ promise_id: string }> {
    this.prompts.push(req);
    return { promise_id: randomUUID() };
  }

  subscribe(filter: SubscriptionFilter, handler: SubscriptionHandler): Subscription {
    const id = randomUUID();
    const record: FakeSubscription = {
      id,
      filter,
      handler,
      closedFlag: false,
      close: () => {
        record.closedFlag = true;
        this.subscriptions.delete(id);
      },
      get overflowCount() {
        return 0;
      },
      get depth() {
        return 0;
      },
    };
    this.subscriptions.set(id, record);
    return record;
  }

  /** Push a synthetic event to matching subscriptions. */
  emit(event: BusEvent): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.closedFlag) continue;
      if (sub.filter.agent_id && sub.filter.agent_id !== event.agent_id) continue;
      if (sub.filter.topics && sub.filter.topics.length > 0) {
        if (!sub.filter.topics.includes(event.topic)) continue;
      }
      sub.handler(event);
    }
  }

  async invokeSlashCommand(): Promise<void> {}
  ingestReply(): void {}
  ingestSessionEvent(): void {}
  ingestPermissionDecision(req: {
    agent_id: string;
    request_id: string;
    behavior: "allow" | "deny";
  }): void {
    this.permissionDecisions.push(req);
  }
  ingestAskAnswer(req: { agent_id: string; ask_id: string; answer: string }): void {
    this.askAnswers.push(req);
  }
  state() {
    return {
      subscriberCount: this.subscriptions.size,
      connectedAgents: [],
      totalOverflows: 0,
    };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

/* ────────────────────────────────────────────────────────────────────── */
/* FakeDiscordGateway                                                     */
/* ────────────────────────────────────────────────────────────────────── */

export class FakeDiscordGateway implements DiscordGatewayLike {
  public started = false;
  public stopped = false;
  private handlers: Array<(e: GatewayEvent) => void> = [];

  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.handlers = [];
  }
  onEvent(handler: (e: GatewayEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** Push a synthetic gateway event. */
  push(event: GatewayEvent): void {
    for (const h of this.handlers) h(event);
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/* FakeDiscordRestApi                                                     */
/* ────────────────────────────────────────────────────────────────────── */

export interface SentMessage {
  channelId: string;
  text: string;
  components?: unknown[];
}

export interface SentInteractionAck {
  interactionId: string;
  body: { content: string; flags?: number };
}

export class FakeDiscordRestApi implements DiscordRestApiLike {
  public readonly sent: SentMessage[] = [];
  public readonly acks: SentInteractionAck[] = [];
  public readonly typings: string[] = [];

  async sendMessage(channelId: string, text: string, components?: unknown[]): Promise<void> {
    this.sent.push({ channelId, text, components });
  }

  async respondToInteraction(
    interactionId: string,
    _interactionToken: string,
    body: { content: string; flags?: number },
  ): Promise<void> {
    this.acks.push({ interactionId, body });
  }

  async sendTyping(channelId: string): Promise<void> {
    this.typings.push(channelId);
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/* Factory helpers                                                        */
/* ────────────────────────────────────────────────────────────────────── */

export const SILENT_LOGGER = {
  warn: () => {},
  info: () => {},
  error: () => {},
};

export function makeMessage(over: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
  return {
    id: over.id ?? "msg-1",
    channel_id: over.channel_id ?? "ch-1",
    guild_id: over.guild_id,
    author: over.author ?? { id: "user-1", username: "terry" },
    content: over.content ?? "hello",
    attachments: over.attachments ?? [],
  };
}

export function makeInteraction(
  over: Partial<DiscordInboundInteraction> = {},
): DiscordInboundInteraction {
  return {
    id: over.id ?? "int-1",
    type: over.type ?? 3,
    data: over.data,
    channel_id: over.channel_id ?? "ch-1",
    guild_id: over.guild_id,
    member: over.member,
    user: over.user ?? { id: "user-1", username: "terry" },
    token: over.token ?? "int-token",
  };
}

/**
 * Tiny await helper. Adapter handlers fire via `void this.foo()` —
 * waiting two microtasks reliably drains the promise chain in our
 * tests without coupling assertions to wall-clock timers.
 */
export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/* ────────────────────────────────────────────────────────────────────── */
/* Adapter harness                                                        */
/* ────────────────────────────────────────────────────────────────────── */

export interface AdapterHarness {
  bus: FakeBus;
  gateway: FakeDiscordGateway;
  rest: FakeDiscordRestApi;
}

/** Build a fresh harness — three independent fakes per test. */
export function makeHarness(): AdapterHarness {
  return {
    bus: new FakeBus(),
    gateway: new FakeDiscordGateway(),
    rest: new FakeDiscordRestApi(),
  };
}

/**
 * Build + start a `DiscordAdapter` wired to the given harness. Default
 * routing covers two channels, one thread, and a DM agent — sufficient
 * to exercise every test in the suite. Tests override fields via
 * `over` to focus on a single behaviour.
 */
export async function startAdapter(
  h: AdapterHarness,
  over: Partial<ConstructorParameters<typeof DiscordAdapter>[0]> = {},
): Promise<DiscordAdapter> {
  const a = new DiscordAdapter({
    bus: h.bus,
    token: "fake-token",
    allowedUserIds: ["user-1"],
    routing: {
      channels: { "ch-1": "triage", "ch-2": "ops" },
      threads: { "th-1": "ops" },
      dmAgentId: "global",
    },
    gateway: h.gateway,
    restApi: h.rest,
    logger: SILENT_LOGGER,
    // Disable rate-limit by default so per-test loops don't trip it.
    rateLimitCheck: () => true,
    ...over,
  });
  await a.start();
  return a;
}
