/**
 * Unit tests for the multiplexer response cache. Issue #69.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { ResponseCache, __setResponseCacheForTest, getResponseCache } from "../cache";

function freshCache(): ResponseCache {
  const c = new ResponseCache();
  __setResponseCacheForTest(c);
  return c;
}

describe("ResponseCache — disabled by default", () => {
  it("isCacheable() returns false on construction", () => {
    const c = freshCache();
    expect(c.isCacheable("retrieval", "get")).toBe(false);
  });

  it("get/set are no-ops when disabled", () => {
    const c = freshCache();
    c.set("retrieval", "get", { id: 1 }, "value");
    expect(c.get("retrieval", "get", { id: 1 })).toBeUndefined();
    const stats = c.stats();
    expect(stats.enabled).toBe(false);
    expect(stats.entries).toBe(0);
  });
});

describe("ResponseCache — enabled", () => {
  let c: ResponseCache;
  beforeEach(() => {
    c = freshCache();
    c.configure({
      enabled: true,
      ttlMs: 5_000,
      maxEntries: 100,
      cacheable: { retrieval: new Set(["get", "list"]) },
    });
  });

  it("isCacheable() reflects the allowlist", () => {
    expect(c.isCacheable("retrieval", "get")).toBe(true);
    expect(c.isCacheable("retrieval", "list")).toBe(true);
    expect(c.isCacheable("retrieval", "create")).toBe(false);
    expect(c.isCacheable("other", "get")).toBe(false);
  });

  it("set + get round-trip for a cacheable (server, tool, args)", () => {
    c.set("retrieval", "get", { id: 1 }, { name: "alice" });
    expect(c.get("retrieval", "get", { id: 1 })).toEqual({ name: "alice" });
    const s = c.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(0);
    expect(s.entries).toBe(1);
  });

  it("different args produce different cache slots", () => {
    c.set("retrieval", "get", { id: 1 }, "alice");
    c.set("retrieval", "get", { id: 2 }, "bob");
    expect(c.get("retrieval", "get", { id: 1 })).toBe("alice");
    expect(c.get("retrieval", "get", { id: 2 })).toBe("bob");
    expect(c.stats().entries).toBe(2);
  });

  it("treats semantically-equal args as equal regardless of key order", () => {
    c.set("retrieval", "get", { a: 1, b: 2 }, "stored");
    expect(c.get("retrieval", "get", { b: 2, a: 1 })).toBe("stored");
  });

  it("treats different arg values as cache misses", () => {
    c.set("retrieval", "get", { id: 1 }, "x");
    expect(c.get("retrieval", "get", { id: 2 })).toBeUndefined();
    expect(c.stats().misses).toBe(1);
  });

  it("set() is a no-op for non-allowlisted tools (defensive)", () => {
    c.set("retrieval", "create", { name: "alice" }, "stored");
    expect(c.stats().entries).toBe(0);
  });

  it("get() on non-cacheable tool increments `skipped`", () => {
    c.get("retrieval", "create", {});
    expect(c.stats().skipped).toBe(1);
    expect(c.stats().misses).toBe(0);
  });

  it("expires entries past ttlMs", async () => {
    c.configure({
      enabled: true,
      ttlMs: 10,
      maxEntries: 100,
      cacheable: { retrieval: new Set(["get"]) },
    });
    c.set("retrieval", "get", { id: 1 }, "v");
    await new Promise((r) => setTimeout(r, 20));
    expect(c.get("retrieval", "get", { id: 1 })).toBeUndefined();
    expect(c.stats().misses).toBe(1);
  });

  it("LRU evicts oldest entry when maxEntries hit", () => {
    c.configure({
      enabled: true,
      ttlMs: 60_000,
      maxEntries: 3,
      cacheable: { retrieval: new Set(["get"]) },
    });
    c.set("retrieval", "get", { id: 1 }, "a");
    c.set("retrieval", "get", { id: 2 }, "b");
    c.set("retrieval", "get", { id: 3 }, "c");
    c.set("retrieval", "get", { id: 4 }, "d"); // evicts id=1
    expect(c.get("retrieval", "get", { id: 1 })).toBeUndefined();
    expect(c.get("retrieval", "get", { id: 4 })).toBe("d");
    expect(c.stats().evictions).toBe(1);
  });

  it("LRU touches an entry on get() — it moves to tail", () => {
    c.configure({
      enabled: true,
      ttlMs: 60_000,
      maxEntries: 3,
      cacheable: { retrieval: new Set(["get"]) },
    });
    c.set("retrieval", "get", { id: 1 }, "a");
    c.set("retrieval", "get", { id: 2 }, "b");
    c.set("retrieval", "get", { id: 3 }, "c");
    // Touch id=1 so id=2 is now oldest.
    c.get("retrieval", "get", { id: 1 });
    c.set("retrieval", "get", { id: 4 }, "d"); // evicts id=2
    expect(c.get("retrieval", "get", { id: 1 })).toBe("a");
    expect(c.get("retrieval", "get", { id: 2 })).toBeUndefined();
  });

  it("invalidateServer() drops only the server's entries", () => {
    c.configure({
      enabled: true,
      ttlMs: 60_000,
      maxEntries: 100,
      cacheable: { retrieval: new Set(["get"]), other: new Set(["get"]) },
    });
    c.set("retrieval", "get", { id: 1 }, "x");
    c.set("retrieval", "get", { id: 2 }, "y");
    c.set("other", "get", { id: 1 }, "z");
    const dropped = c.invalidateServer("retrieval");
    expect(dropped).toBe(true);
    expect(c.get("retrieval", "get", { id: 1 })).toBeUndefined();
    expect(c.get("retrieval", "get", { id: 2 })).toBeUndefined();
    expect(c.get("other", "get", { id: 1 })).toBe("z");
    expect(c.stats().invalidations).toBe(1);
  });

  it("invalidateServer() returns false when nothing to drop", () => {
    expect(c.invalidateServer("retrieval")).toBe(false);
  });

  it("serverHasCacheableTools() reflects the allowlist (with master switch)", () => {
    expect(c.serverHasCacheableTools("retrieval")).toBe(true);
    expect(c.serverHasCacheableTools("unknown")).toBe(false);
    c.configure({ enabled: false });
    expect(c.serverHasCacheableTools("retrieval")).toBe(false);
  });

  it("shouldInvalidateOnNonCacheableCall() honours the defensiveInvalidation flag", () => {
    // Default: ON.
    expect(c.shouldInvalidateOnNonCacheableCall("retrieval")).toBe(true);
    // Opt-out (5-agent review Agent 3 finding on mixed-tool servers):
    c.configure({ defensiveInvalidation: false });
    expect(c.shouldInvalidateOnNonCacheableCall("retrieval")).toBe(false);
    // Re-enabling restores behaviour.
    c.configure({ defensiveInvalidation: true });
    expect(c.shouldInvalidateOnNonCacheableCall("retrieval")).toBe(true);
  });

  it("shouldInvalidateOnNonCacheableCall() returns false when server has no cacheable tools", () => {
    expect(c.shouldInvalidateOnNonCacheableCall("unknown-server")).toBe(false);
  });

  it("configure() shrinking maxEntries evicts down to fit", () => {
    c.configure({
      enabled: true,
      ttlMs: 60_000,
      maxEntries: 5,
      cacheable: { retrieval: new Set(["get"]) },
    });
    for (let i = 0; i < 5; i++) c.set("retrieval", "get", { id: i }, `v${i}`);
    expect(c.stats().entries).toBe(5);
    c.configure({ maxEntries: 2 });
    expect(c.stats().entries).toBe(2);
    expect(c.stats().evictions).toBe(3);
  });

  it("reset() clears entries + counters", () => {
    c.set("retrieval", "get", { id: 1 }, "x");
    c.get("retrieval", "get", { id: 1 });
    c.reset();
    const s = c.stats();
    expect(s.entries).toBe(0);
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
  });
});

describe("getResponseCache singleton", () => {
  it("returns the same instance across calls", () => {
    __setResponseCacheForTest(null);
    const a = getResponseCache();
    const b = getResponseCache();
    expect(a).toBe(b);
  });
});
