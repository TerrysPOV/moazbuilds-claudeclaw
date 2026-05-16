/**
 * Streamable HTTP MCP handler for the multiplexer.
 *
 * One handler instance per upstream MCP server (one of the children
 * spawned by the multiplexer at startup — see `./index.ts`). The handler
 * speaks the MCP Streamable HTTP transport (revision 2024-11-05) back
 * out to the per-PTY `claude` clients and proxies every `tools/call`
 * request to the in-process `McpServerProcess.call(tool, args)`.
 *
 * Per-PTY isolation:
 *   - Each (server, ptyId) pair gets its own ephemeral SDK `Server` +
 *     transport pair, lazily created on first request.
 *   - For servers in `settings.mcp.stateless`, the (ptyId) dimension is
 *     collapsed — a single `Server` + transport pair is shared across
 *     all PTYs. Per-PTY HMAC verification still gates access.
 *   - Identity teardown (`McpMultiplexerPlugin.releaseIdentity(ptyId)`)
 *     calls `releasePty(ptyId)` here to tear down the per-PTY transport.
 *
 * Auth model: see `./pty-identity.ts` and `../../planning/mcp-multiplexer/W1-COORD.md`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { getMcpBridge } from "../mcp-bridge.js";
import type { McpServerProcess } from "../mcp-proxy/server-process.js";
import { AUTH_HEADER, PTY_ID_HEADER, verifyBearer } from "./pty-identity.js";

/** Sentinel used when a server is declared stateless: all PTYs collapse
 *  to a single (server, *) bucket so they share one upstream session.
 *  Per-PTY auth verification still happens before any routing. */
const STATELESS_BUCKET = "__stateless__";

/** Pair of objects making up a live MCP session against this server. */
interface ServerBucket {
  /** Owner ptyId or `STATELESS_BUCKET`. */
  bucketKey: string;
  sdkServer: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  /** Last-touched timestamp, for diagnostics. */
  lastUsed: number;
}

export interface McpHttpHandlerOpts {
  /** Server name (matches the key in `mcp-proxy.json`). */
  serverName: string;
  /** Upstream child to which `tools/call` is proxied. */
  proc: McpServerProcess;
  /** When `true`, all PTYs share a single upstream MCP session for this
   *  server. Defaults to `false` (per-PTY isolation). */
  stateless?: boolean;
}

/** Maximum request body size accepted by the multiplexer. Matches the
 *  cap on `/api/plugin/*` in the HTTP gateway. Rejects 4 GB POSTs that
 *  would OOM the daemon. */
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

/** Helper: read raw body bytes once. Phase D #2 (security): enforce a
 *  hard byte cap so a malicious or buggy client can't OOM the daemon
 *  with a multi-GB JSON POST. */
async function _readBody(req: Request): Promise<unknown> {
  // The SDK transport parses JSON itself from the Request — we just pass
  // the raw Request through. This helper exists so the auth path can
  // peek without consuming the body stream.
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("json")) return undefined;
  try {
    const cloned = req.clone();
    return await cloned.json();
  } catch {
    return undefined;
  }
}

/** Check whether a request's declared/streamed body exceeds the cap.
 *  Reads `Content-Length` if provided (rejects oversize before the body is
 *  consumed). For unknown-length requests, materialises into an ArrayBuffer
 *  and rejects if it exceeds the cap. Returns the safe-to-replay Request
 *  on success, or a 413 Response on failure. */
async function _enforceBodyCap(req: Request): Promise<Request | Response> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return _errResponse(
        413,
        "body_too_large",
        `request body ${n}B exceeds ${MAX_BODY_BYTES}B limit`,
      );
    }
    // Content-Length present and within cap → safe to forward.
    return req;
  }
  // No Content-Length (chunked transfer or HTTP/2). Materialise once so we
  // can both enforce the cap and replay to the SDK transport.
  let buf: ArrayBuffer;
  try {
    buf = await req.arrayBuffer();
  } catch {
    return _errResponse(400, "body_read_failed", "could not read request body");
  }
  if (buf.byteLength > MAX_BODY_BYTES) {
    return _errResponse(
      413,
      "body_too_large",
      `request body ${buf.byteLength}B exceeds ${MAX_BODY_BYTES}B limit`,
    );
  }
  // Rebuild a Request the SDK transport can consume. Headers preserved.
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: buf,
  });
}

/**
 * Per-server HTTP handler. Construct one per upstream MCP child;
 * register on the `PluginHttpGateway` via `registerMcpHandler(name, ...)`.
 */
export class McpHttpHandler {
  readonly serverName: string;
  private readonly proc: McpServerProcess;
  private readonly stateless: boolean;
  private readonly buckets = new Map<string, ServerBucket>();
  private closed = false;

  constructor(opts: McpHttpHandlerOpts) {
    this.serverName = opts.serverName;
    this.proc = opts.proc;
    this.stateless = opts.stateless === true;
  }

  /**
   * Handle a single inbound HTTP request from a PTY `claude`.
   * Returns a `Response`. Never throws — errors are converted to
   * `Response`s with appropriate status codes and a small JSON body.
   */
  async handle(req: Request): Promise<Response> {
    if (this.closed) {
      return new Response(JSON.stringify({ error: "multiplexer_stopped" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }

    // ── Body cap (Phase D security #2) ────────────────────────────────
    // Enforce before auth so we don't read multi-GB bodies on unauth'd
    // requests. `_enforceBodyCap` returns either a safe-to-forward Request
    // (possibly rebuilt) or a 413 Response.
    const guarded = await _enforceBodyCap(req);
    if (guarded instanceof Response) return guarded;
    const safeReq = guarded;

    // ── Authentication ────────────────────────────────────────────────
    const ptyId = safeReq.headers.get(PTY_ID_HEADER);
    const bearer = safeReq.headers.get(AUTH_HEADER);
    if (!ptyId) {
      return _errResponse(401, "missing_pty_id", `missing ${PTY_ID_HEADER} header`);
    }
    if (!bearer || !verifyBearer(ptyId, bearer)) {
      // Audit, but only the failure event — do not log the bearer itself.
      try {
        getMcpBridge().audit("multiplexer_auth_rejected", {
          server: this.serverName,
          pty_id: ptyId,
        });
      } catch {}
      return _errResponse(401, "invalid_bearer", "HMAC verification failed");
    }

    // ── Upstream readiness ────────────────────────────────────────────
    // If the upstream child is mid-restart we return 503 immediately so
    // the MCP client retries instead of hanging on a dead session.
    if (this.proc.status !== "up") {
      return _errResponse(
        503,
        "upstream_unavailable",
        `server ${this.serverName} status=${this.proc.status}`,
      );
    }

    // ── Dispatch to per-(server, pty) bucket ──────────────────────────
    const bucketKey = this.stateless ? STATELESS_BUCKET : ptyId;
    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      try {
        bucket = await this._createBucket(bucketKey);
        this.buckets.set(bucketKey, bucket);
      } catch (err) {
        return _errResponse(
          500,
          "bucket_init_failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    bucket.lastUsed = Date.now();

    // Peek at the body for audit observability without consuming the
    // request stream (the transport needs to re-read it).
    const peek = await _readBody(safeReq);

    try {
      getMcpBridge().audit("multiplexer_invoke", {
        server: this.serverName,
        pty_id: ptyId,
        stateless: this.stateless,
        rpc_method: _peekRpcMethod(peek),
      });
    } catch {}

    // Hand off to the SDK transport. It will read the body, dispatch
    // to the registered handlers on the SDK Server, and return a
    // Web-Standard Response with framing.
    try {
      return await bucket.transport.handleRequest(safeReq);
    } catch (err) {
      // Ensure the bucket is torn down if the transport itself errored;
      // future calls will lazily reinitialise.
      this.buckets.delete(bucketKey);
      try {
        await bucket.transport.close();
      } catch {}
      try {
        await bucket.sdkServer.close();
      } catch {}
      return _errResponse(500, "transport_error", err instanceof Error ? err.message : String(err));
    }
  }

  /** Tear down a per-PTY bucket. Called by the plugin's
   *  `releaseIdentity(ptyId)`. Idempotent. */
  async releasePty(ptyId: string): Promise<void> {
    if (this.stateless) return; // no per-PTY bucket exists
    const bucket = this.buckets.get(ptyId);
    if (!bucket) return;
    this.buckets.delete(ptyId);
    try {
      await bucket.transport.close();
    } catch {}
    try {
      await bucket.sdkServer.close();
    } catch {}
  }

  /** Tear down every bucket and refuse further requests. */
  async stop(): Promise<void> {
    this.closed = true;
    const buckets = [...this.buckets.values()];
    this.buckets.clear();
    await Promise.allSettled(
      buckets.map(async (b) => {
        try {
          await b.transport.close();
        } catch {}
        try {
          await b.sdkServer.close();
        } catch {}
      }),
    );
  }

  /** Diagnostics snapshot. */
  health(): Record<string, unknown> {
    return {
      server: this.serverName,
      stateless: this.stateless,
      active_buckets: this.buckets.size,
      bucket_keys: [...this.buckets.keys()],
      closed: this.closed,
    };
  }

  private async _createBucket(bucketKey: string): Promise<ServerBucket> {
    // Each bucket gets its own SDK Server + transport pair. The SDK
    // assigns a fresh MCP session ID per bucket via sessionIdGenerator.
    const sdkServer = new Server(
      { name: `mcp-multiplexer/${this.serverName}`, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    // tools/list — exposes only the tools the upstream child advertises
    // (already filtered by `allowedTools` in `mcp-proxy.json`).
    sdkServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.proc.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
          type: "object",
        },
      })),
    }));

    // Defense-in-depth (Phase D #6): build the allowed-tool set from the
    // already-filtered `proc.tools`. tools/list returns only this set, and
    // tools/call rejects anything not in it — so a caller forging a non-
    // allowed name fails inside the multiplexer instead of relying on the
    // upstream child's own rejection.
    const allowedNames = new Set(this.proc.tools.map((t) => t.name));

    // tools/call — proxy through to the upstream child after gating.
    sdkServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      if (!allowedNames.has(name)) {
        try {
          getMcpBridge().audit("multiplexer_tool_rejected", {
            server: this.serverName,
            tool: name,
            reason: "not_in_allowed_set",
          });
        } catch {}
        return {
          content: [
            {
              type: "text",
              text: `Error: tool '${name}' is not exposed by server '${this.serverName}'`,
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await this.proc.call(name, args ?? {});
        return {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true, // simpler for HTTP-only callers
    });
    await sdkServer.connect(transport);

    return {
      bucketKey,
      sdkServer,
      transport,
      lastUsed: Date.now(),
    };
  }
}

function _errResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function _peekRpcMethod(body: unknown): string | undefined {
  if (
    body &&
    typeof body === "object" &&
    "method" in body &&
    typeof (body as { method: unknown }).method === "string"
  ) {
    return (body as { method: string }).method;
  }
  return undefined;
}
