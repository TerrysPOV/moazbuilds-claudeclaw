/**
 * Web UI WebSocket adapter — request/response wire shapes.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.4.
 *
 * These are the JSON shapes spoken over the adapter's HTTP and WebSocket
 * surfaces. They are intentionally lighter than `BusEvent` itself — the
 * adapter forwards every fan-out event verbatim, so consumers should
 * import `BusEvent` from `src/bus/types.ts` for downstream typing.
 */

import type { BusEventTopic } from "../../bus/types";

/**
 * HTTP `POST /prompt` body. Mirrors `SendPromptRequest` minus the
 * fields the adapter fills in itself (`origin`, `origin_id`, `user_id`).
 */
export interface PromptRequestBody {
  agent_id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

/** Successful `POST /prompt` response. */
export interface PromptResponseBody {
  ok: true;
  promise_id: string;
}

/** Failure response shape (used by every error path). */
export interface ErrorResponseBody {
  ok: false;
  error: string;
}

/**
 * WebSocket client → adapter envelope. Sprint 2 ships only `subscribe`;
 * adding `unsubscribe` / `ping` later is a non-breaking expansion of the
 * discriminated union.
 */
export type WsClientMessage = WsSubscribeMessage;

export interface WsSubscribeMessage {
  type: "subscribe";
  agent_id: string;
  /**
   * Optional topic allow-list. If omitted, every topic for the agent is
   * forwarded — matching the spec §5.5.4 "topics: '*'" semantics.
   */
  topics?: BusEventTopic[];
}

/**
 * WebSocket adapter → client envelope. The Bus event itself is wrapped in
 * a thin envelope so we can carry control messages (`ready`, `error`)
 * over the same channel without colliding with `topic` strings.
 */
export type WsServerMessage =
  | { type: "ready"; subscription_id: string }
  | { type: "event"; event: import("../../bus/types").BusEvent }
  | { type: "error"; error: string };
