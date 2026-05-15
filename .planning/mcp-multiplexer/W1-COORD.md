# W1 Coordination Notes

Living doc for cross-worktree decisions and any SPEC clarifications that
W1 made while implementing. W2 reads this before writing
`pty-mcp-config-writer.ts`.

---

## Resolved: HMAC scheme — bearer-as-secret, not per-request signature

**SPEC §4.3 issue.** SPEC §4.3 describes a per-request HMAC scheme:

> HMAC-SHA256(secret, "<method> <path>\n<ts>\n<body-sha256>"). The body-sha256
> is the SHA-256 of the request body... <ts> is an ISO-8601 timestamp
> included in the X-Claudeclaw-Ts header; the bridge rejects timestamps
> outside a 5-minute window.

This scheme assumes the MCP client can compute SHA-256 of the body and sign
each request. **Claude Code's stock MCP HTTP client does not support that.**
The `--mcp-config` JSON only supports a static `headers` map (per
`claude mcp add --header "Authorization: Bearer ..."`); headers are fixed
at config-load time and re-sent verbatim on every request.

**Resolution.** Implement the pragmatic equivalent that the stock client can
honour:

- **Per-PTY secret.** 32-byte random buffer minted by
  `issueIdentity(ptyId)` on each PTY spawn. Stored in memory only; never
  on disk except inside the synthesized `--mcp-config` JSON (mode `0600`).
- **Bearer literal.** `Authorization: Bearer <hex(secret)>` — the literal
  32-byte hex secret IS the bearer. Verification is a constant-time
  comparison against the stored secret for the asserted `ptyId`.
- **Identifier header.** `X-Claudeclaw-Pty-Id: <ptyId>` carries the
  PTY identity. The handler looks up the secret for that `ptyId` and
  compares against the bearer.
- **Issuance timestamp.** `X-Claudeclaw-Ts: <epoch_ms>` is the issuance
  millisecond at which the identity was minted. Recorded in the audit log
  for observability. NOT enforced as a replay window — Claude Code re-sends
  the same headers on every request for the lifetime of the PTY, so a strict
  replay window would expire tokens within seconds of issuance.

**Why this is safe (operator-approved security envelope, SPEC §7 row 3).**
The replay-protection role moves from per-request timestamp checks to
**secret rotation on respawn**. The supervisor regenerates the secret on:
- Every PTY spawn (fresh `ptyId` → new identity).
- Every PTY respawn (crash recovery, idle reap, LRU eviction).
The vulnerability window is bounded by PTY uptime since last respawn,
which `settings.pty.idleReapMinutes` (default 30) keeps small.

Combined with loopback-only binding (`127.0.0.1`), the threat model is:
- An attacker on the same host who can read the synthesized config file
  in `${cwd}/.claudeclaw/mcp-pty-<id>.json` (mode `0600`, owner-only).
- That requires already having pwned the daemon's UID, at which point
  HMAC is irrelevant — they could read the daemon's memory directly.

If a future Claude Code version supports per-request signing, this layer
can be tightened. For now, bearer-as-secret matches the actual
capability of the stock MCP client.

---

## Published interface for W2

W2 imports from `src/plugins/mcp-multiplexer/pty-identity.ts`:

```typescript
export interface PtyIdentity {
  /** PTY session key (= sessionKey from pty-supervisor.PtyEntry). */
  ptyId: string;
  /** Issuance timestamp in epoch milliseconds. */
  issuedAt: number;
  /** Headers map for the synthesized --mcp-config JSON. The bearer
   *  literal (`Bearer <hex>`) is at `headers["Authorization"]`. The
   *  bearer is NEVER exposed as a standalone field on the public
   *  interface — Phase D security finding #1 removed it as a
   *  future-leak surface (a stray `console.log(identity)` would have
   *  exposed the secret). Consumers needing verification go through
   *  `verifyBearer(ptyId, header)` rather than reading the bearer
   *  directly. */
  headers: Record<string, string>;
}

export function issueIdentity(ptyId: string): PtyIdentity;
export function revokeIdentity(ptyId: string): boolean;
export function getIdentity(ptyId: string): PtyIdentity | undefined;
export function verifyBearer(
  ptyId: string,
  bearerHeaderValue: string,
): boolean;
export function _resetIdentityStore(): void; // tests only
```

**Headers shape returned by `issueIdentity`:**

```typescript
{
  "Authorization": "Bearer <hex-secret>",
  "X-Claudeclaw-Pty-Id": "<ptyId>",
  "X-Claudeclaw-Ts": "<epoch-ms-as-string>"
}
```

W2 splatts this directly into the `headers` field of every HTTP MCP server
entry in the synthesized `--mcp-config` JSON.

W2 imports from `src/plugins/mcp-multiplexer/index.ts`:

```typescript
export interface McpMultiplexerPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Record<string, unknown>;
  isActive(): boolean;
  sharedServerNames(): string[];
  /** Issue a fresh identity for a PTY. Replaces any existing identity
   *  for the same ptyId (W2 calls this on every respawn). */
  issueIdentity(ptyId: string): PtyIdentity;
  /** Drop the identity, the (ptyId,server)→sessionId map entries,
   *  and revoke the secret. Safe to call multiple times. */
  releaseIdentity(ptyId: string): Promise<void>;
  /** Base URL the synthesized --mcp-config writes for HTTP entries.
   *  E.g. `http://127.0.0.1:4632`. */
  bridgeBaseUrl(): string;
}

export function getMcpMultiplexerPlugin(): McpMultiplexerPlugin;
export function _resetMcpMultiplexer(): void; // tests only
```

W2 calls in `pty-mcp-config-writer.ts`:

```typescript
const mux = getMcpMultiplexerPlugin();
if (!mux.isActive()) return null; // backward-compat path
const identity = mux.issueIdentity(ptyId);
const base = mux.bridgeBaseUrl();
const shared = mux.sharedServerNames();
// for each name in shared:
//   { type: "http",
//     url: `${base}/mcp/${name}`,
//     headers: identity.headers }
```

And in pty-supervisor dispose:

```typescript
await getMcpMultiplexerPlugin().releaseIdentity(ptyId);
```

---

## FQN namespacing for bridge-callback registration

The `PluginMcpBridge.registerPluginTool(pluginId, tool)` always prefixes
the stored FQN with the pluginId — see `mcp-bridge.ts` L65:
`const fqn = \`${pluginId}__${tool.name}\``.

The multiplexer registers under `pluginId = "mcp-multiplexer"` (operator
constraint) with the `name` argument set to `<server>__<tool>`. The
resulting stored FQNs are therefore:

- `mcp-multiplexer__<server>__<tool>` (multiplexer-claimed servers)
- `mcp-proxy__<server>__<tool>` (mcp-proxy-claimed servers)

These two FQN spaces never overlap; collision is impossible regardless of
the skip-shared rule. The skip-shared rule remains as a structural
guarantee against double-spawn of the upstream child.

**Behavioural note for legacy callers.** When a server moves from
`mcp-proxy` to `mcp-multiplexer` (operator adds it to
`settings.mcp.shared`), tool callers that looked up
`mcp-proxy__<server>__<tool>` must now look up
`mcp-multiplexer__<server>__<tool>`. This is a small migration burden
on any code that hardcodes FQNs (e.g. tests, scripted prompts); typical
LLM `tools/list` callers walk the bridge's listing and don't care about
the prefix.

---

## Open questions awaiting Phase C / operator decision

(none currently — implementation matches SPEC + this clarification)
