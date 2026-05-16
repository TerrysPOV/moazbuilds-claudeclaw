import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { fileURLToPath } from "node:url";
import { McpServerProcess } from "../../mcp-proxy/server-process.js";
import { McpHttpHandler } from "../http-handler.js";
import {
  issueIdentity,
  revokeIdentity,
  _resetIdentityStore,
  AUTH_HEADER,
  PTY_ID_HEADER,
} from "../pty-identity.js";

const MOCK_SERVER = fileURLToPath(
  new URL("../../../__tests__/fixtures/mock-mcp-server.ts", import.meta.url),
);
const BUN_BIN = process.execPath;

function makeServerConfig() {
  return {
    command: BUN_BIN,
    args: ["run", MOCK_SERVER],
    allowedTools: ["echo"],
  };
}

/** Wrap a JSON-RPC message in a Web-standard Request shaped the way the
 *  Streamable HTTP transport expects (POST + content-type json + Accept). */
function rpcRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:4632/mcp/test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("McpHttpHandler — auth", () => {
  let proc: McpServerProcess | null = null;
  let handler: McpHttpHandler | null = null;

  beforeEach(async () => {
    _resetIdentityStore();
    proc = new McpServerProcess("test", makeServerConfig());
    await proc.start();
    handler = new McpHttpHandler({ serverName: "test", proc });
  });

  afterEach(async () => {
    if (handler) await handler.stop();
    if (proc) await proc.stop();
    proc = null;
    handler = null;
    _resetIdentityStore();
  });

  it("rejects requests missing X-Claudeclaw-Pty-Id with 401", async () => {
    const resp = await handler!.handle(rpcRequest({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_pty_id");
  });

  it("rejects requests missing Authorization header with 401", async () => {
    issueIdentity("suzy");
    const resp = await handler!.handle(
      rpcRequest({ jsonrpc: "2.0", id: 1, method: "ping" }, { [PTY_ID_HEADER]: "suzy" }),
    );
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_bearer");
  });

  it("rejects requests with a bad bearer with 401", async () => {
    issueIdentity("suzy");
    const resp = await handler!.handle(
      rpcRequest(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        {
          [PTY_ID_HEADER]: "suzy",
          [AUTH_HEADER]: "Bearer " + "00".repeat(32),
        },
      ),
    );
    expect(resp.status).toBe(401);
  });

  it("rejects requests for an unknown ptyId with 401", async () => {
    const id = issueIdentity("suzy");
    const resp = await handler!.handle(
      rpcRequest(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        {
          [PTY_ID_HEADER]: "reg",
          [AUTH_HEADER]: id.headers[AUTH_HEADER],
        },
      ),
    );
    expect(resp.status).toBe(401);
  });

  it("auth-rejected requests do not reach the upstream MCP process", async () => {
    const beforeCallCount = proc!.lastInvocationAt;
    const resp = await handler!.handle(rpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(resp.status).toBe(401);
    // upstream `lastInvocationAt` must not have been touched
    expect(proc!.lastInvocationAt).toBe(beforeCallCount);
  });
});

describe("McpHttpHandler — successful auth + RPC dispatch", () => {
  let proc: McpServerProcess | null = null;
  let handler: McpHttpHandler | null = null;

  beforeEach(async () => {
    _resetIdentityStore();
    proc = new McpServerProcess("test", makeServerConfig());
    await proc.start();
    handler = new McpHttpHandler({ serverName: "test", proc });
  });

  afterEach(async () => {
    if (handler) await handler.stop();
    if (proc) await proc.stop();
    proc = null;
    handler = null;
    _resetIdentityStore();
  });

  it("503 when upstream child is not 'up'", async () => {
    issueIdentity("suzy");
    await proc!.stop();
    const id = issueIdentity("suzy");
    const resp = await handler!.handle(
      rpcRequest(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: id.headers[AUTH_HEADER] },
      ),
    );
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upstream_unavailable");
  });

  it("releasePty tears down only the requested PTY bucket", async () => {
    const a = issueIdentity("suzy");
    const b = issueIdentity("reg");

    // Force bucket creation by sending an initialize/ping for each PTY.
    // Even if the SDK can't fully complete (mock server is minimal),
    // the bucket creation happens inside `handle()` before the transport
    // takes over.
    await handler!.handle(
      rpcRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        },
        { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: a.headers[AUTH_HEADER] },
      ),
    );
    await handler!.handle(
      rpcRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        },
        { [PTY_ID_HEADER]: "reg", [AUTH_HEADER]: b.headers[AUTH_HEADER] },
      ),
    );

    const before = handler!.health();
    expect((before.active_buckets as number) >= 1).toBe(true);

    await handler!.releasePty("suzy");
    const after = handler!.health();
    const remaining = after.bucket_keys as string[];
    expect(remaining).not.toContain("suzy");
  });

  it("stateless handler does not have per-PTY buckets", async () => {
    await handler!.stop();
    handler = new McpHttpHandler({ serverName: "test", proc: proc!, stateless: true });
    // releasePty is a no-op for stateless
    await handler.releasePty("suzy");
    const h = handler.health();
    expect(h.stateless).toBe(true);
  });
});

describe("McpHttpHandler — closed state", () => {
  it("returns 503 after stop()", async () => {
    const proc = new McpServerProcess("test", makeServerConfig());
    await proc.start();
    const handler = new McpHttpHandler({ serverName: "test", proc });
    await handler.stop();
    const id = issueIdentity("suzy");
    const resp = await handler.handle(
      rpcRequest(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: id.headers[AUTH_HEADER] },
      ),
    );
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("multiplexer_stopped");
    await proc.stop();
    revokeIdentity("suzy");
  });
});
