/**
 * Per-PTY identity issuance + verification for the MCP multiplexer.
 *
 * See `.planning/mcp-multiplexer/SPEC.md` §4.3 ("Auth: per-PTY HMAC headers")
 * and `.planning/mcp-multiplexer/W1-COORD.md` for the resolution of the
 * SPEC's per-request signing scheme.
 *
 * Summary of the auth model implemented here:
 *
 *   - Each PTY (keyed by `ptyId = sessionKey` from `pty-supervisor`) is
 *     minted a fresh 32-byte cryptographic secret on spawn / respawn.
 *   - The "bearer token" baked into the synthesized `--mcp-config` JSON is
 *     the literal hex encoding of that secret. Claude Code's stock MCP
 *     HTTP client sends static headers; per-request HMAC signing isn't
 *     possible without a client-side hook.
 *   - The multiplexer's HTTP handler verifies inbound requests by
 *     extracting the asserted `X-Claudeclaw-Pty-Id`, looking up the
 *     stored secret for that PTY, and constant-time-comparing the bearer.
 *   - Replay protection comes from secret rotation on every PTY respawn
 *     (driven by `pty.idleReapMinutes`, default 30) plus loopback-only
 *     binding. There is no per-request timestamp window — Claude Code
 *     resends the same headers for the lifetime of the PTY, so a strict
 *     window would expire tokens within seconds of issuance.
 *
 * The identity store is in-memory only. Daemon restart drops every
 * identity; the PTY supervisor's respawn path mints fresh ones on
 * demand.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** Length in bytes of the per-PTY secret. 32 bytes = 256 bits. */
export const PTY_SECRET_BYTES = 32;

/** HTTP header that carries the asserted PTY identifier. */
export const PTY_ID_HEADER = "X-Claudeclaw-Pty-Id";

/** HTTP header that carries the identity issuance timestamp (epoch ms). */
export const PTY_TS_HEADER = "X-Claudeclaw-Ts";

/** HTTP header that carries the bearer (= hex-encoded secret). */
export const AUTH_HEADER = "Authorization";

export interface PtyIdentity {
  /** PTY session key. Matches `sessionKey` in `pty-supervisor.PtyEntry`. */
  ptyId: string;
  /** Issuance timestamp in epoch milliseconds. Stable for the identity's
   *  lifetime; rotates on revoke→re-issue. Carried in the
   *  `X-Claudeclaw-Ts` header for audit observability. */
  issuedAt: number;
  /** Complete headers map ready to splat into the synthesized
   *  `--mcp-config` JSON's `headers` field. The Authorization header
   *  carries the bearer literal (`Bearer <hex>`) — never exposed as a
   *  standalone field on this interface; consumers that need the raw
   *  bearer for verification go through `verifyBearer(ptyId, header)`. */
  headers: Record<string, string>;
}

interface InternalIdentity {
  ptyId: string;
  issuedAt: number;
  secret: Buffer;
  /**
   * Cached `_toPublic(record)` result (#72 item 14). The headers/bearer
   * are fully determined by `(ptyId, issuedAt, secret)` — all immutable
   * for the lifetime of the record — so we build the public projection
   * once at issuance and reuse it on every `getIdentity()` call. Without
   * this, every `getIdentity()` rebuilt the headers object + re-hex'd
   * the secret. Microsecond-scale on the hot path; effectively free
   * caching since the record itself is the lifetime anchor.
   */
  public: PtyIdentity;
}

// Singleton in-memory store. Module-scope on purpose: only one daemon
// process and only one multiplexer per daemon.
const identities = new Map<string, InternalIdentity>();

/**
 * Allowed shape for `ptyId`. Mirrors the supervisor's sessionKey grammar:
 *   - Named-agent names matching `/^[a-z][a-z0-9-]*$/` (alphanumeric +
 *     hyphen, lowercase, must start with a letter).
 *   - Thread IDs (Discord/Telegram-issued numeric/alphanumeric strings).
 *   - The literal `"global"` for the daemon's default session.
 *   - The qualified shapes `agent:<name>`, `thread:<id>` prefixed by the
 *     supervisor in some callsites (hence `:` is allowed).
 *
 * Codepoints permitted: ASCII letters + digits + `_`, `.`, `:`, `-`.
 * Anything else (path separators, whitespace, unicode) is rejected so
 * the ptyId can be used unescaped as a header value AND as the basename
 * of `${cwd}/.claudeclaw/mcp-pty-${ptyId}.json` (see
 * `pty-mcp-config-writer.ts:configPathFor`).
 *
 * Length ≤ 128 to bound memory + match what HTTP header parsers tolerate
 * comfortably. Empty rejected — there's no legitimate empty PTY.
 *
 * Filed as #72 item 10. See `src/runner/pty-supervisor.ts` for the
 * sessionKey grammar that feeds this regex.
 */
const PTY_ID_REGEX = /^[A-Za-z0-9_.:-]+$/;
const PTY_ID_MAX_LEN = 128;

function _validatePtyId(ptyId: string): void {
  if (typeof ptyId !== "string" || ptyId.length === 0 || ptyId.length > PTY_ID_MAX_LEN) {
    throw new Error(`invalid ptyId: ${JSON.stringify(ptyId)} (must be 1-${PTY_ID_MAX_LEN} chars)`);
  }
  if (!PTY_ID_REGEX.test(ptyId)) {
    throw new Error(`invalid ptyId: ${JSON.stringify(ptyId)} (must match ${PTY_ID_REGEX})`);
  }
}

function _toPublic(record: InternalIdentity): PtyIdentity {
  const bearer = `Bearer ${record.secret.toString("hex")}`;
  // Codex P2 on PR #98 (#72 item 14 follow-up): freeze the projection
  // before caching it. The cache stores ONE PtyIdentity object that's
  // returned from every `issueIdentity` / `getIdentity` call for the
  // record's lifetime. Without the freeze, a caller doing e.g.
  // `identity.headers.Authorization = "[REDACTED]"` for debug logging
  // would mutate the cached value and poison every subsequent reader
  // for that PTY — breaking auth on the next inbound request.
  //
  // Freeze the headers map AND the outer object. `Object.freeze` is
  // shallow, so both levels need an explicit call. In strict-mode (Bun
  // + ESM, always strict) any attempted mutation throws a TypeError —
  // the bug surfaces immediately at the offending callsite instead of
  // poisoning silently.
  const headers = Object.freeze({
    [AUTH_HEADER]: bearer,
    [PTY_ID_HEADER]: record.ptyId,
    [PTY_TS_HEADER]: String(record.issuedAt),
  });
  return Object.freeze({
    ptyId: record.ptyId,
    issuedAt: record.issuedAt,
    headers,
  });
}

/**
 * Mint a fresh identity for `ptyId`. If an identity already exists for
 * this PTY (caller forgot to revoke before respawn) it is silently
 * replaced — the old secret is discarded and any in-flight bearer
 * pointing at it will fail verification on the next request.
 *
 * Returns the public-facing identity (bearer header + headers map).
 * The raw secret is NOT exposed; only `verifyBearer` can compare against it.
 */
export function issueIdentity(ptyId: string): PtyIdentity {
  _validatePtyId(ptyId);
  const issuedAt = Date.now();
  const secret = randomBytes(PTY_SECRET_BYTES);
  // Build the public projection ONCE and cache on the record (#72 item
  // 14). The projection is immutable for the record's lifetime — secret,
  // issuedAt, and ptyId never change after issuance. revokeIdentity()
  // discards the whole record, so the cache lifetime tracks the record.
  const partial: Omit<InternalIdentity, "public"> = { ptyId, issuedAt, secret };
  const publicProjection = _toPublic(partial as InternalIdentity);
  const record: InternalIdentity = { ...partial, public: publicProjection };
  identities.set(ptyId, record);
  return record.public;
}

/**
 * Look up the public identity for `ptyId`. Useful for audit logging.
 * Returns `undefined` if no identity is currently issued.
 */
export function getIdentity(ptyId: string): PtyIdentity | undefined {
  const record = identities.get(ptyId);
  return record?.public;
}

/**
 * Drop the identity for `ptyId`. Idempotent — returns `true` if an
 * identity was actually removed, `false` otherwise.
 */
export function revokeIdentity(ptyId: string): boolean {
  return identities.delete(ptyId);
}

/**
 * Verify an inbound `Authorization` header value against the stored
 * secret for the asserted `ptyId`.
 *
 * Constant-time comparison via `timingSafeEqual`. Returns `false` for
 * any malformed input rather than throwing, so the caller's error path
 * is a simple `401`.
 *
 * Inputs:
 *   - `ptyId`: asserted by the client via `X-Claudeclaw-Pty-Id`.
 *     Already validated as a non-empty string by the HTTP handler.
 *   - `bearerHeaderValue`: the literal `Authorization` header
 *     (e.g. `"Bearer 7c2d4f...e9"`). May be `null`/missing.
 */
export function verifyBearer(ptyId: string, bearerHeaderValue: string | null | undefined): boolean {
  if (!bearerHeaderValue) return false;
  const record = identities.get(ptyId);
  if (!record) return false;

  // Strip the "Bearer " prefix; tolerate case-insensitive scheme.
  const match = /^bearer\s+([0-9a-f]+)$/i.exec(bearerHeaderValue.trim());
  if (!match) return false;
  const hex = match[1]!;

  let supplied: Buffer;
  try {
    supplied = Buffer.from(hex, "hex");
  } catch {
    return false;
  }
  if (supplied.length !== record.secret.length) return false;
  try {
    return timingSafeEqual(supplied, record.secret);
  } catch {
    return false;
  }
}

/**
 * Snapshot of currently-issued identities. Test-only.
 */
export function _listIssuedPtyIds(): string[] {
  return [...identities.keys()];
}

/**
 * Clear the entire identity store. Test-only.
 */
export function _resetIdentityStore(): void {
  identities.clear();
}
