/**
 * Unit tests for pty-mcp-config-writer.ts (MCP multiplexer, SPEC §4.4 §4.5).
 *
 * No real multiplexer / claude — every test pins a deterministic identity
 * so we can golden-file the synthesized JSON.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  configPathFor,
  deleteConfigForPty,
  writeConfigForPty,
  type PtyIdentity,
  type WriteConfigInput,
} from "../runner/pty-mcp-config-writer";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Deterministic identity for golden-file tests. Mirrors W1's
 *  `_toPublic` shape from src/plugins/mcp-multiplexer/pty-identity.ts. */
function fakeIdentity(
  ptyId: string,
  hexSecret: string,
  issuedAt: number = 1_700_000_000_000,
): PtyIdentity {
  const bearer = `Bearer ${hexSecret}`;
  return {
    ptyId,
    issuedAt,
    bearer,
    headers: {
      Authorization: bearer,
      "X-Claudeclaw-Pty-Id": ptyId,
      "X-Claudeclaw-Ts": String(issuedAt),
    },
  };
}

let TEST_ROOT: string;
const createdRoots: string[] = [];

beforeAll(() => {
  TEST_ROOT = mkdtempSync(join(tmpdir(), "ccw-pty-mcp-writer-"));
});

afterAll(() => {
  for (const r of createdRoots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {}
  }
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

function makeCwd(label: string): string {
  const dir = join(TEST_ROOT, `${label}-${Math.random().toString(36).slice(2, 8)}`);
  createdRoots.push(dir);
  return dir;
}

function baseInput(over: Partial<WriteConfigInput> & { ptyId: string; cwd: string }): WriteConfigInput {
  return {
    sharedServers: [],
    perPtyServers: [],
    bridgeBaseUrl: "http://127.0.0.1:4632",
    identity: fakeIdentity(over.ptyId, "a".repeat(64)),
    ...over,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("writeConfigForPty — basic shape", () => {
  it("writes the expected JSON shape for a single shared server", () => {
    const cwd = makeCwd("shared-only");
    const ptyId = "suzy";
    const result = writeConfigForPty(
      baseInput({
        ptyId,
        cwd,
        sharedServers: [{ name: "graphiti" }],
      }),
    );

    expect(result.path).toBe(join(cwd, ".claudeclaw", "mcp-pty-suzy.json"));
    expect(existsSync(result.path)).toBe(true);

    const parsed = JSON.parse(readFileSync(result.path, "utf8"));
    expect(parsed).toEqual({
      mcpServers: {
        graphiti: {
          type: "http",
          url: "http://127.0.0.1:4632/mcp/graphiti",
          headers: {
            Authorization: `Bearer ${"a".repeat(64)}`,
            "X-Claudeclaw-Pty-Id": "suzy",
            "X-Claudeclaw-Ts": "1700000000000",
          },
        },
      },
    });
  });

  it("writes multiple shared servers with stable URL composition", () => {
    const cwd = makeCwd("multi-shared");
    const result = writeConfigForPty(
      baseInput({
        ptyId: "reg",
        cwd,
        sharedServers: [
          { name: "graphiti" },
          { name: "context7" },
          { name: "mempress" },
        ],
        bridgeBaseUrl: "http://127.0.0.1:4632/",
      }),
    );
    const parsed = JSON.parse(readFileSync(result.path, "utf8"));
    expect(Object.keys(parsed.mcpServers)).toEqual([
      "graphiti",
      "context7",
      "mempress",
    ]);
    // Trailing slash on bridgeBaseUrl is stripped before composing the URL.
    expect(parsed.mcpServers.graphiti.url).toBe(
      "http://127.0.0.1:4632/mcp/graphiti",
    );
  });

  it("writes mixed shared + per-PTY entries", () => {
    const cwd = makeCwd("mixed");
    const result = writeConfigForPty(
      baseInput({
        ptyId: "peggy",
        cwd,
        sharedServers: [{ name: "graphiti" }],
        perPtyServers: [
          {
            name: "filesystem-sandbox",
            command: "bunx",
            args: ["@modelcontextprotocol/server-filesystem", "/tmp/sandbox"],
            env: { SANDBOX_ROOT: "/tmp/sandbox" },
          },
        ],
      }),
    );
    const parsed = JSON.parse(readFileSync(result.path, "utf8"));
    expect(parsed.mcpServers.graphiti.type).toBe("http");
    expect(parsed.mcpServers["filesystem-sandbox"]).toEqual({
      type: "stdio",
      command: "bunx",
      args: ["@modelcontextprotocol/server-filesystem", "/tmp/sandbox"],
      env: { SANDBOX_ROOT: "/tmp/sandbox" },
    });
  });

  it("omits args/env in stdio entries when not provided (no empty arrays/objects)", () => {
    const cwd = makeCwd("stdio-minimal");
    const result = writeConfigForPty(
      baseInput({
        ptyId: "main",
        cwd,
        perPtyServers: [{ name: "noop", command: "/bin/true" }],
      }),
    );
    const parsed = JSON.parse(readFileSync(result.path, "utf8"));
    expect(parsed.mcpServers.noop).toEqual({ type: "stdio", command: "/bin/true" });
  });
});

describe("writeConfigForPty — backward-compat path (SPEC §6.1)", () => {
  it("returns empty path and does NOT create a file when both lists are empty", () => {
    const cwd = makeCwd("empty");
    const result = writeConfigForPty(baseInput({ ptyId: "x", cwd }));
    expect(result.path).toBe("");
    // .claudeclaw/ directory must NOT be created.
    expect(existsSync(join(cwd, ".claudeclaw"))).toBe(false);
  });
});

describe("writeConfigForPty — filesystem hygiene", () => {
  it("creates .claudeclaw/ with 0700 mode when missing", () => {
    const cwd = makeCwd("dir-mode");
    writeConfigForPty(
      baseInput({
        ptyId: "x",
        cwd,
        sharedServers: [{ name: "graphiti" }],
      }),
    );
    const dir = join(cwd, ".claudeclaw");
    const st = statSync(dir);
    // On POSIX, mode & 0o777 should match what we asked for; umask can mask
    // bits OFF but never adds. We only assert "no group/other access".
    expect(st.mode & 0o077).toBe(0);
  });

  it("writes the config file with mode 0600", () => {
    const cwd = makeCwd("file-mode");
    const result = writeConfigForPty(
      baseInput({
        ptyId: "x",
        cwd,
        sharedServers: [{ name: "graphiti" }],
      }),
    );
    const st = statSync(result.path);
    expect(st.mode & 0o077).toBe(0); // owner-only
    expect(st.mode & 0o400).toBeGreaterThan(0); // at least owner-readable
  });

  it("is idempotent — second call with same input overwrites the file", () => {
    const cwd = makeCwd("idempotent");
    const inp = baseInput({
      ptyId: "x",
      cwd,
      sharedServers: [{ name: "graphiti" }],
    });
    const r1 = writeConfigForPty(inp);
    const firstMtime = statSync(r1.path).mtimeMs;

    // Different secret → different bearer header → file content changes.
    const r2 = writeConfigForPty({
      ...inp,
      identity: fakeIdentity("x", "b".repeat(64)),
    });
    expect(r2.path).toBe(r1.path);
    const parsed = JSON.parse(readFileSync(r2.path, "utf8"));
    expect(parsed.mcpServers.graphiti.headers.Authorization).toBe(
      `Bearer ${"b".repeat(64)}`,
    );
    // mtime advances (or at least stays the same — Bun's underlying FS may
    // skip a write if content matches; we forced a content change above).
    expect(statSync(r2.path).mtimeMs).toBeGreaterThanOrEqual(firstMtime);
  });

  it("rejects empty ptyId", () => {
    const cwd = makeCwd("empty-id");
    expect(() =>
      writeConfigForPty(
        baseInput({
          ptyId: "",
          cwd,
          sharedServers: [{ name: "graphiti" }],
        }),
      ),
    ).toThrow(/ptyId must be non-empty/);
  });

  it("rejects empty cwd", () => {
    expect(() =>
      writeConfigForPty(
        baseInput({
          ptyId: "x",
          cwd: "",
          sharedServers: [{ name: "graphiti" }],
        }),
      ),
    ).toThrow(/cwd must be non-empty/);
  });
});

describe("writeConfigForPty — defensive entry hygiene", () => {
  it("skips shared entries with empty names", () => {
    const cwd = makeCwd("skip-empty");
    const result = writeConfigForPty(
      baseInput({
        ptyId: "x",
        cwd,
        sharedServers: [{ name: "" }, { name: "graphiti" }],
      }),
    );
    const parsed = JSON.parse(readFileSync(result.path, "utf8"));
    expect(Object.keys(parsed.mcpServers)).toEqual(["graphiti"]);
  });

  it("does not overwrite a shared entry with a stdio entry of the same name", () => {
    const cwd = makeCwd("collision");
    const result = writeConfigForPty(
      baseInput({
        ptyId: "x",
        cwd,
        sharedServers: [{ name: "graphiti" }],
        perPtyServers: [{ name: "graphiti", command: "/bin/true" }],
      }),
    );
    const parsed = JSON.parse(readFileSync(result.path, "utf8"));
    expect(parsed.mcpServers.graphiti.type).toBe("http");
  });
});

describe("configPathFor", () => {
  it("returns the canonical path layout for any (cwd, ptyId)", () => {
    expect(configPathFor("/var/app", "suzy")).toBe(
      "/var/app/.claudeclaw/mcp-pty-suzy.json",
    );
  });
});

describe("deleteConfigForPty", () => {
  it("removes a written config file", () => {
    const cwd = makeCwd("delete");
    const result = writeConfigForPty(
      baseInput({
        ptyId: "x",
        cwd,
        sharedServers: [{ name: "graphiti" }],
      }),
    );
    expect(existsSync(result.path)).toBe(true);
    deleteConfigForPty(cwd, "x");
    expect(existsSync(result.path)).toBe(false);
  });

  it("swallows ENOENT — second delete is a no-op", () => {
    const cwd = makeCwd("delete-twice");
    writeConfigForPty(
      baseInput({
        ptyId: "x",
        cwd,
        sharedServers: [{ name: "graphiti" }],
      }),
    );
    deleteConfigForPty(cwd, "x");
    // Second call must not throw.
    expect(() => deleteConfigForPty(cwd, "x")).not.toThrow();
  });

  it("is a no-op when called with empty cwd or ptyId", () => {
    expect(() => deleteConfigForPty("", "x")).not.toThrow();
    expect(() => deleteConfigForPty("/tmp", "")).not.toThrow();
  });

  it("is a no-op when the file was never written (backward-compat path)", () => {
    const cwd = makeCwd("never-written");
    expect(() => deleteConfigForPty(cwd, "x")).not.toThrow();
  });
});

afterEach(() => {
  // Cleanup any leaked .claudeclaw dirs between tests.
  for (const r of createdRoots) {
    try {
      rmSync(join(r, ".claudeclaw"), { recursive: true, force: true });
    } catch {}
  }
});
