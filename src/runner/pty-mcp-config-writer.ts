/**
 * pty-mcp-config-writer.ts — synthesises the per-PTY `--mcp-config` JSON
 * consumed by `claude` inside a long-lived PTY.
 *
 * Per SPEC §4.4 / §4.5:
 *   - Path: `${cwd}/.claudeclaw/mcp-pty-${ptyId}.json`
 *   - File mode: 0600 (bearer token at rest)
 *   - Directory mode: 0700 (created lazily if missing)
 *   - JSON shape matches `claude mcp add-json` semantics:
 *       { "mcpServers": { "<name>": { "type": "http", "url", "headers" } } }
 *     for shared servers; per-PTY stdio entries (rare) get
 *       { "type": "stdio", "command", "args", "env" }
 *
 * The writer is the consumer of the multiplexer's `issueIdentity(ptyId)` /
 * `releaseIdentity(ptyId)` interface — see
 * src/plugins/mcp-multiplexer/pty-identity.ts. The supervisor minted-and-passes
 * the identity; the writer splats `identity.headers` verbatim into the
 * synthesized JSON.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PtyIdentity } from "../plugins/mcp-multiplexer/pty-identity";

// Re-export so callers can import the type from a single neighbour module.
export type { PtyIdentity };

// ─── Public types ───────────────────────────────────────────────────────────

/** One shared MCP server entry as embedded in the synthesized JSON. */
export interface SharedServerEntry {
  /** Server name as defined in mcp-proxy.json. Used as the `mcpServers` key
   *  and as the path segment in the bridge URL. */
  name: string;
}

/** One per-PTY (stdio) MCP server entry as embedded in the synthesized JSON.
 *  Mirrors the operator's mcp-proxy.json schema for servers NOT marked
 *  `shared`. We don't introspect or modify these — pass-through only. */
export interface PerPtyServerEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface WriteConfigInput {
  /** Stable PTY identifier (= supervisor's sessionKey). Used in the file
   *  name and as the multiplexer's identity key. */
  ptyId: string;
  /** Working directory of the PTY. The .claudeclaw/ subdirectory is created
   *  here if absent. */
  cwd: string;
  /** Shared MCP servers — multiplexed via local HTTP. */
  sharedServers: SharedServerEntry[];
  /** Per-PTY stdio MCP servers — spawned by claude itself (status quo for
   *  non-shared servers). Usually empty. */
  perPtyServers: PerPtyServerEntry[];
  /** Multiplexer's HTTP listener base URL, e.g. "http://127.0.0.1:4632".
   *  Combined with `/mcp/<server-name>` for each shared entry. */
  bridgeBaseUrl: string;
  /** Per-PTY identity. Pre-minted by the multiplexer; the writer splats
   *  `identity.headers` verbatim into each shared server's `headers` field. */
  identity: PtyIdentity;
}

export interface WriteConfigResult {
  /** Absolute path to the written JSON file. Caller threads this through as
   *  PtyProcessOptions.mcpConfigPath. */
  path: string;
}

// ─── Implementation ─────────────────────────────────────────────────────────

const CONFIG_SUBDIR = ".claudeclaw";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Compute the absolute path where the synthesized config WOULD live for a
 * given (cwd, ptyId). Exposed so the supervisor can compute the path for
 * cleanup even when the writer was never called (idempotent unlink).
 */
export function configPathFor(cwd: string, ptyId: string): string {
  return join(cwd, CONFIG_SUBDIR, `mcp-pty-${ptyId}.json`);
}

/**
 * Synthesize and write the per-PTY `--mcp-config` JSON.
 *
 * Idempotent — overwrites any existing file at the same path. Returns the
 * absolute path on success; throws on filesystem error so the supervisor
 * fails the spawn early (SPEC §4.5 "Failure to write → fail the spawn
 * early; do NOT silently fall through to no-MCP mode").
 *
 * When both `sharedServers` and `perPtyServers` are empty, the writer
 * SKIPS file creation and returns `{ path: "" }`. The caller MUST check
 * for the empty path and avoid setting `PtyProcessOptions.mcpConfigPath`
 * — there's nothing for claude to consult. This keeps the backward-compat
 * path (settings.mcp.shared=[]) byte-identical to today.
 */
export function writeConfigForPty(input: WriteConfigInput): WriteConfigResult {
  const { ptyId, cwd, sharedServers, perPtyServers, bridgeBaseUrl, identity } = input;

  if (!ptyId || ptyId.length === 0) {
    throw new Error("[mcp-config-writer] ptyId must be non-empty");
  }
  if (!cwd || cwd.length === 0) {
    throw new Error("[mcp-config-writer] cwd must be non-empty");
  }

  // Backward-compat: nothing to write → return empty path. Supervisor
  // omits the --mcp-config flag entirely. Matches the rollback contract
  // in SPEC §6.1.
  if (sharedServers.length === 0 && perPtyServers.length === 0) {
    return { path: "" };
  }

  // Normalise the bridge URL (no trailing slash) — defensive only.
  const baseUrl = bridgeBaseUrl.replace(/\/+$/, "");

  // Build the mcpServers payload. Shared entries go first (HTTP transport),
  // then per-PTY entries (stdio). Order does not matter to Claude Code but
  // makes the file easier to read for operators.
  const mcpServers: Record<string, unknown> = {};

  for (const { name } of sharedServers) {
    if (!name || name.length === 0) continue;
    mcpServers[name] = {
      type: "http",
      url: `${baseUrl}/mcp/${name}`,
      // Splat W1's headers map — includes Authorization (Bearer <hex>),
      // X-Claudeclaw-Pty-Id, and X-Claudeclaw-Ts. Single source of truth
      // for what claude sends; the bridge expects exactly these.
      headers: { ...identity.headers },
    };
  }

  for (const entry of perPtyServers) {
    if (!entry.name || entry.name.length === 0) continue;
    // Skip if a shared entry already claimed this name. perPtyOnly + shared
    // is supposed to be mutually exclusive (config validation enforces
    // this); the defensive de-dupe keeps the synthesized JSON well-formed.
    if (Object.prototype.hasOwnProperty.call(mcpServers, entry.name)) continue;

    const stdioEntry: Record<string, unknown> = {
      type: "stdio",
      command: entry.command,
    };
    if (entry.args && entry.args.length > 0) {
      stdioEntry.args = [...entry.args];
    }
    if (entry.env && Object.keys(entry.env).length > 0) {
      stdioEntry.env = { ...entry.env };
    }
    mcpServers[entry.name] = stdioEntry;
  }

  const payload = { mcpServers };
  const path = configPathFor(cwd, ptyId);

  // Ensure the .claudeclaw/ directory exists with 0700 mode. mkdirSync's
  // mode argument is the create-time mode; if the directory already exists
  // we don't aggressively chmod it (operator may have intentionally set
  // different perms — we only own this subtree by convention).
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }

  // Write atomically-ish: writeFileSync with mode 0600. If the file already
  // exists, the mode flag is ignored on most platforms — we re-write the
  // bytes but the perms stay as they were. We don't chmod separately
  // because:
  //   (a) the file we created in a prior turn already has 0600 from this
  //       writer, so it's already correct;
  //   (b) if an operator manually changed the mode we don't fight them.
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", {
    mode: FILE_MODE,
    encoding: "utf8",
  });

  return { path };
}

/**
 * Delete a previously-synthesized config file. Idempotent — swallows ENOENT
 * (file already gone, e.g. operator manual cleanup or path computed but
 * never written). Other filesystem errors are re-thrown so the supervisor
 * can log them; cleanup failures are not load-bearing but should be loud.
 */
export function deleteConfigForPty(cwd: string, ptyId: string): void {
  if (!cwd || !ptyId) return; // nothing to do
  const path = configPathFor(cwd, ptyId);
  try {
    unlinkSync(path);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return; // already gone — fine
    throw err;
  }
}
