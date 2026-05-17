/**
 * Bus core — subscription + ringbuffer helpers.
 *
 * Per spec §5.4: backpressure is per-subscriber ringbuffer, drop-oldest with
 * a metric increment when the buffer overflows.
 */

import type { BusEvent, BusEventTopic, BusOrigin } from "./types";

export interface SubscriptionFilter {
  agent_id?: string;
  topics?: BusEventTopic[];
  origin?: BusOrigin;
}

export type SubscriptionHandler = (e: BusEvent) => void;

export interface Subscription {
  /** Unique id for this subscription (random). */
  id: string;
  /** Unsubscribe and drain. */
  close(): void;
  /** Count of events dropped due to ringbuffer overflow (drop-oldest semantics). */
  readonly overflowCount: number;
  /** Current depth of pending events in ringbuffer. */
  readonly depth: number;
}

/**
 * Internal subscription record held by the bus core.
 */
export interface SubscriberRecord {
  id: string;
  filter: SubscriptionFilter;
  handler: SubscriptionHandler;
  ringbuffer: BusEvent[];
  /** Drop-oldest counter (per spec §5.4). */
  overflowCount: number;
  /** Per-subscriber ring buffer cap. */
  capacity: number;
  /** Whether the subscriber has been closed. */
  closed: boolean;
}

/**
 * Default ringbuffer capacity per subscriber. The spec says "size N"; we pick
 * 1000 — matches what an adapter could reasonably drain in a few hundred ms
 * before falling behind.
 */
export const DEFAULT_RINGBUFFER_CAPACITY = 1000;

/**
 * Apply the subscription filter to a single event.
 *
 * - `agent_id`: exact match required.
 * - `topics`: event topic must be in the list (if provided).
 * - `origin`: matched against `payload.origin` if it exists; otherwise the
 *   filter is treated as non-matching for events that don't carry an origin
 *   (only `prompt` events do today; later sprints may add more).
 */
export function matchesFilter(event: BusEvent, filter: SubscriptionFilter): boolean {
  if (filter.agent_id !== undefined && event.agent_id !== filter.agent_id) {
    return false;
  }
  if (filter.topics !== undefined && filter.topics.length > 0) {
    if (!filter.topics.includes(event.topic)) return false;
  }
  if (filter.origin !== undefined) {
    const payload = event.payload as { origin?: BusOrigin } | undefined;
    if (!payload || payload.origin !== filter.origin) return false;
  }
  return true;
}

/**
 * Push an event into the subscriber's ringbuffer with drop-oldest semantics.
 * Returns true if delivered immediately, false if buffered.
 *
 * The caller is responsible for draining the buffer (we keep dispatch
 * single-threaded so the simplest correct implementation is: drain after
 * every push).
 */
export function enqueueForSubscriber(sub: SubscriberRecord, event: BusEvent): void {
  if (sub.ringbuffer.length >= sub.capacity) {
    // Drop oldest, increment metric (spec §5.4).
    sub.ringbuffer.shift();
    sub.overflowCount += 1;
  }
  sub.ringbuffer.push(event);
}

/**
 * Drain the ringbuffer synchronously into the handler. Handler errors are
 * swallowed (logged by caller) — the bus must not block dispatch because of
 * a misbehaving subscriber.
 */
export function drainSubscriber(sub: SubscriberRecord, onError: (err: unknown) => void): void {
  while (sub.ringbuffer.length > 0 && !sub.closed) {
    const evt = sub.ringbuffer.shift();
    if (evt === undefined) break;
    try {
      sub.handler(evt);
    } catch (err) {
      onError(err);
    }
  }
}
