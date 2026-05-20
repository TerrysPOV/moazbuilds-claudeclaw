/**
 * Response caching for idempotent multiplexer tools (issue #69).
 *
 * When several PTYs hit the same retrieval/lookup MCP for the same
 * record, the multiplexer should be able to serve identical responses
 * from a short-TTL in-memory cache instead of dispatching to the
 * upstream child every time. Particularly useful for the
 * `get_*` / `list_*` shape of tools.
 *
 * Design constraints (issue #69 acceptance + Nibbler's review on #64):
 *   - **Opt-in per (server, tool)** — operator declares cacheable
 *     tools in `settings.mcp.cache.cacheable`. No tool is cacheable
 *     by default. Caching the wrong tool would silently corrupt
 *     behaviour for state-changing calls.
 *   - **Short TTL** — default 5 s, operator-tunable. The point is
 *     deduplicating concurrent fan-out, not warming a long-lived
 *     cache. State drifts in seconds.
 *   - **Defensive invalidation** — when ANY non-cacheable tool is
 *     called against a server that has at least one cacheable tool,
 *     drop every cached entry for that server. Conservative but
 *     correct: a non-cacheable call signals "this server might have
 *     mutated state", and we can't tell what it touched.
 *   - **In-memory only** — cleared on bridge restart. No persistence;
 *     the whole point is "fresh enough".
 *   - **Bounded** — LRU cap on total entries to keep memory predictable
 *     under bursty workloads.
 *
 * Cache key shape: `${serverName}::${toolName}::${argsHash}` where
 * `argsHash` is a deterministic SHA-256 of canonical-JSON-stringified
 * arguments. Canonical = recursively sorted keys, no trailing whitespace.
 */

import { createHash } from "node:crypto";

/** Cap on total entries across all (server, tool, args) keys. Older
 *  entries are evicted on insertion when the cap is hit. */
const DEFAULT_MAX_ENTRIES = 1000;

/** Default cache TTL in milliseconds. */
const DEFAULT_TTL_MS = 5_000;

/** Configuration shape consumed by the cache. Sourced from
 *  `settings.mcp.cache` at startup; see `src/config.ts` for the
 *  parser. */
export interface ResponseCacheConfig {
  /** Master switch. Default false. When false, `get()` always misses
   *  and `set()` is a no-op. */
  enabled: boolean;
  /** TTL in milliseconds. Default 5000. */
  ttlMs: number;
  /** Max entries across all cache keys. Default 1000. */
  maxEntries: number;
  /** Per-server allowlist of cacheable tool names. A tool is cacheable
   *  iff it appears in the array for its server. */
  cacheable: Record<string, ReadonlySet<string>>;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  /** Insertion order key for LRU eviction. Map iteration order is
   *  insertion-order in JS, so a fresh `set()` after `delete()` moves
   *  the entry to the tail naturally. */
  key: string;
}

export interface CacheStats {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
  /** Defensive invalidations triggered by non-cacheable calls. */
  invalidations: number;
  /** Calls bypassed because the (server, tool) wasn't on the allowlist. */
  skipped: number;
}

/**
 * Canonical JSON: sort keys recursively so semantically-equivalent
 * argument objects produce the same hash regardless of key order. The
 * MCP arguments shape is operator-controlled, so we can't rely on the
 * upstream sending consistent ordering.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function hashArgs(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

const DEFAULT_CONFIG: ResponseCacheConfig = {
  enabled: false,
  ttlMs: DEFAULT_TTL_MS,
  maxEntries: DEFAULT_MAX_ENTRIES,
  cacheable: {},
};

export class ResponseCache {
  private config: ResponseCacheConfig = { ...DEFAULT_CONFIG };
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private invalidations = 0;
  private skipped = 0;

  configure(opts: Partial<ResponseCacheConfig>): void {
    this.config = {
      enabled: opts.enabled ?? this.config.enabled,
      ttlMs: opts.ttlMs ?? this.config.ttlMs,
      maxEntries: opts.maxEntries ?? this.config.maxEntries,
      cacheable: opts.cacheable ?? this.config.cacheable,
    };
    // If the cap shrunk, evict from the head until we fit.
    while (this.entries.size > this.config.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
  }

  /** Is the (server, tool) pair on the operator's allowlist? Used by
   *  the dispatch path to decide whether to consult the cache at all. */
  isCacheable(serverName: string, toolName: string): boolean {
    if (!this.config.enabled) return false;
    const allowed = this.config.cacheable[serverName];
    return allowed !== undefined && allowed.has(toolName);
  }

  /**
   * Look up a cached response. Returns the cached value on hit, or
   * `undefined` on miss or TTL expiry. Records hit/miss counters even
   * when the cache is disabled — operators want to see "we tried but
   * the flag was off" in `health()`.
   *
   * Caller MUST gate this with `isCacheable()` first; calling `get()`
   * on a non-cacheable tool is treated as a skip (incremented in the
   * `skip` counter) and returns `undefined`.
   */
  get(serverName: string, toolName: string, args: unknown): unknown | undefined {
    if (!this.isCacheable(serverName, toolName)) {
      this.skipped += 1;
      return undefined;
    }
    const key = `${serverName}::${toolName}::${hashArgs(args)}`;
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Re-insert to move to LRU tail.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  /**
   * Cache a response. No-op when the cache is disabled or the
   * (server, tool) isn't on the allowlist (defensive — protects
   * against callers who forgot to gate with `isCacheable()`).
   */
  set(serverName: string, toolName: string, args: unknown, value: unknown): void {
    if (!this.isCacheable(serverName, toolName)) return;
    const key = `${serverName}::${toolName}::${hashArgs(args)}`;
    const entry: CacheEntry = {
      value,
      expiresAt: Date.now() + this.config.ttlMs,
      key,
    };
    // Existing entry → delete first so the re-insert moves to LRU tail.
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, entry);
    // Cap enforcement.
    while (this.entries.size > this.config.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
  }

  /**
   * Drop every cached entry for a server. Called when a non-cacheable
   * tool is dispatched against a server that has cacheable tools —
   * the non-cacheable call MIGHT have mutated state we don't track,
   * so the safe move is to invalidate.
   *
   * Returns true if at least one entry was dropped.
   */
  invalidateServer(serverName: string): boolean {
    if (!this.config.enabled) return false;
    const prefix = `${serverName}::`;
    let dropped = false;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        dropped = true;
      }
    }
    if (dropped) this.invalidations += 1;
    return dropped;
  }

  /**
   * Does the server have any cacheable tools declared? Used by the
   * dispatch path to decide whether a non-cacheable call should
   * trigger defensive invalidation — if the server has NO cacheable
   * tools, there's nothing to invalidate.
   */
  serverHasCacheableTools(serverName: string): boolean {
    if (!this.config.enabled) return false;
    const allowed = this.config.cacheable[serverName];
    return allowed !== undefined && allowed.size > 0;
  }

  stats(): CacheStats {
    return {
      enabled: this.config.enabled,
      ttlMs: this.config.ttlMs,
      maxEntries: this.config.maxEntries,
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      invalidations: this.invalidations,
      skipped: this.skipped,
    };
  }

  /** Test seam — drop all entries and reset counters. */
  reset(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.invalidations = 0;
    this.skipped = 0;
  }
}

let cache: ResponseCache | null = null;

export function getResponseCache(): ResponseCache {
  if (!cache) cache = new ResponseCache();
  return cache;
}

/** Test seam — swap in a fresh cache for isolation. */
export function __setResponseCacheForTest(c: ResponseCache | null): void {
  cache = c;
}
