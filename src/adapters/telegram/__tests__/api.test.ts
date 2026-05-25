/**
 * Tests for the per-chat flood cooldown in `createTelegramApi`.
 *
 * Background (#141 incident 2026-05-21): the progress spinner edited a message
 * ~1/s for the duration of a turn; Telegram escalated to a flood-ban with
 * `retry_after` ~1730s, and every further send 429'd, blocking all replies.
 * The cooldown records the `retry_after` deadline per chat and short-circuits
 * subsequent sends WITHOUT hitting the API until it clears.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createTelegramApi } from "../api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub429(retryAfter: number, counter: { n: number }): void {
  globalThis.fetch = (async () => {
    counter.n += 1;
    return new Response(
      JSON.stringify({
        ok: false,
        error_code: 429,
        description: `Too Many Requests: retry after ${retryAfter}`,
        parameters: { retry_after: retryAfter },
      }),
      { status: 429, statusText: "Too Many Requests" },
    );
  }) as typeof fetch;
}

describe("createTelegramApi — per-chat flood cooldown", () => {
  it("short-circuits a flooded chat without re-hitting the API", async () => {
    const counter = { n: 0 };
    stub429(100, counter);
    const api = createTelegramApi("test-token");

    // First send reaches Telegram and gets the 429 (records the cooldown).
    await expect(api.sendMessage({ chat_id: 42, text: "hi" })).rejects.toThrow(/429/);
    expect(counter.n).toBe(1);

    // Second send to the SAME chat is rejected locally — no new fetch.
    await expect(api.sendMessage({ chat_id: 42, text: "again" })).rejects.toThrow(/flood cooldown/);
    expect(counter.n).toBe(1);
  });

  it("does not block a different chat", async () => {
    const counter = { n: 0 };
    stub429(100, counter);
    const api = createTelegramApi("test-token");

    await expect(api.sendMessage({ chat_id: 42, text: "hi" })).rejects.toThrow(/429/);
    expect(counter.n).toBe(1);

    // A different chat is unaffected — it still reaches the API.
    await expect(api.sendMessage({ chat_id: 99, text: "hi" })).rejects.toThrow(/429/);
    expect(counter.n).toBe(2);
  });

  it("surfaces retry_after in the thrown error for observability", async () => {
    const counter = { n: 0 };
    stub429(1730, counter);
    const api = createTelegramApi("test-token");
    await expect(api.editMessageText({ chat_id: 7, message_id: 1, text: "x" })).rejects.toThrow(
      /retry_after 1730s/,
    );
  });
});

describe("createTelegramApi — per-chat send serialization (#154)", () => {
  function stubConcurrencyTracker(): { maxConcurrent: number } {
    const state = { inFlight: 0, maxConcurrent: 0 };
    globalThis.fetch = (async () => {
      state.inFlight += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.inFlight);
      await new Promise((r) => setTimeout(r, 25));
      state.inFlight -= 1;
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }) as typeof fetch;
    return state;
  }

  it("never has two in-flight sends to the same chat at once", async () => {
    const tracker = stubConcurrencyTracker();
    const api = createTelegramApi("test-token");
    await Promise.all([
      api.sendMessage({ chat_id: 1, text: "a" }),
      api.sendMessage({ chat_id: 1, text: "b" }),
      api.sendMessage({ chat_id: 1, text: "c" }),
    ]);
    expect(tracker.maxConcurrent).toBe(1);
  });

  it("lets different chats send concurrently", async () => {
    const tracker = stubConcurrencyTracker();
    const api = createTelegramApi("test-token");
    await Promise.all([
      api.sendMessage({ chat_id: 1, text: "a" }),
      api.sendMessage({ chat_id: 2, text: "b" }),
    ]);
    expect(tracker.maxConcurrent).toBe(2);
  });
});

/**
 * Hung long-poll recovery. A half-open connection (gateway 502/504 / network
 * blip) leaves `fetch` neither resolving nor rejecting; without a client-side
 * deadline `getUpdates` hangs forever and the poll loop freezes silently — the
 * bot goes deaf with no error logged. `getUpdates` layers a client hard-timeout
 * (`timeoutSeconds + buffer`) so a stuck request aborts and surfaces as a
 * retryable error the loop can recover from.
 */
describe("createTelegramApi — getUpdates client timeout", () => {
  /** Fetch that honors the abort signal like the real one but never resolves on its own. */
  function stubHangingFetch(): { calls: number } {
    const state = { calls: 0 };
    globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => {
      state.calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // mimic a request that never settles
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    return state;
  }

  it("aborts a hung getUpdates within the client timeout instead of hanging forever", async () => {
    const tracker = stubHangingFetch();
    // timeoutSeconds=0 → client deadline is just the 80ms buffer.
    const api = createTelegramApi("test-token", { getUpdatesTimeoutBufferMs: 80 });
    const neverAbort = new AbortController();

    const start = Date.now();
    let caught: unknown;
    await api.getUpdates(0, 0, neverAbort.signal).catch((e) => {
      caught = e;
    });
    const elapsed = Date.now() - start;

    expect(tracker.calls).toBe(1);
    // The call rejected (did not hang) well inside a generous bound.
    expect(elapsed).toBeLessThan(2000);
    // A timeout abort surfaces as TimeoutError — distinct from stop()'s
    // AbortError, so the poll loop logs + retries rather than treating it as
    // a clean stop.
    expect((caught as { name?: string })?.name).toBe("TimeoutError");
  });

  it("propagates the caller's stop() abort as AbortError (clean-stop path preserved)", async () => {
    const tracker = stubHangingFetch();
    // Large buffer so the timeout never fires first — the caller's abort wins.
    const api = createTelegramApi("test-token", { getUpdatesTimeoutBufferMs: 60_000 });
    const stop = new AbortController();

    const p = api.getUpdates(0, 30, stop.signal).catch((e) => e);
    stop.abort(); // mimic adapter stop()
    const err = (await p) as { name?: string };

    expect(tracker.calls).toBe(1);
    expect(err?.name).toBe("AbortError");
  });
});
