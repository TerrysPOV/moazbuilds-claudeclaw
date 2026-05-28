/**
 * Integration test for issue #164 PR B: the web token is enforced on
 * every /api/* route. Boots a real startWebUi server on an ephemeral
 * port and exercises the auth gate end-to-end.
 *
 * Run with: bun test src/ui/__tests__/api-auth-enforcement.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startWebUi } from "../server";
import type { WebServerHandle, WebSnapshot } from "../types";

const TOKEN = "test-web-token-abcdefghijklmnop";

function snapshot(): WebSnapshot {
  return {
    pid: 1234,
    startedAt: Date.now(),
    heartbeatNextAt: 0,
    // Minimal settings shape the routes read; apiToken stays undefined so
    // the /api/inject legacy path isn't accidentally satisfied.
    settings: {
      apiToken: undefined,
      heartbeat: { enabled: false, interval: 30, prompt: "" },
      security: {},
      telegram: { token: "", allowedUserIds: [] },
      discord: { token: "", allowedUserIds: [] },
      web: { enabled: true, host: "127.0.0.1", port: 0 },
    } as unknown as WebSnapshot["settings"],
    jobs: [],
  };
}

let handle: WebServerHandle;
let base: string;

beforeAll(() => {
  handle = startWebUi({
    host: "127.0.0.1",
    port: 0, // ephemeral
    token: TOKEN,
    getSnapshot: snapshot,
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => {
  handle.stop();
});

describe("/api/* web token enforcement (issue #164 PR B)", () => {
  it("serves the HTML shell pre-auth", async () => {
    const res = await fetch(`${base}/`, { headers: { Host: `127.0.0.1:${handle.port}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });

  it("allows /api/health pre-auth", async () => {
    const res = await fetch(`${base}/api/health`, {
      headers: { Host: `127.0.0.1:${handle.port}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects /api/state without a token (401)", async () => {
    const res = await fetch(`${base}/api/state`, {
      headers: { Host: `127.0.0.1:${handle.port}` },
    });
    expect(res.status).toBe(401);
  });

  it("allows /api/state with a valid Bearer token", async () => {
    const res = await fetch(`${base}/api/state`, {
      headers: { Host: `127.0.0.1:${handle.port}`, Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("allows /api/state with the token via ?token= query", async () => {
    const res = await fetch(`${base}/api/state?token=${TOKEN}`, {
      headers: { Host: `127.0.0.1:${handle.port}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects /api/state with a wrong token (401)", async () => {
    const res = await fetch(`${base}/api/state`, {
      headers: { Host: `127.0.0.1:${handle.port}`, Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects /api/settings without a token (401)", async () => {
    const res = await fetch(`${base}/api/settings`, {
      headers: { Host: `127.0.0.1:${handle.port}` },
    });
    expect(res.status).toBe(401);
  });
});
