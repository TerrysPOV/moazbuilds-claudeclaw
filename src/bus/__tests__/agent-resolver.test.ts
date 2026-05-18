/**
 * Tests for `src/bus/agent-resolver.ts` (Sprint 5.2a).
 *
 * Run with: `bun test src/bus/__tests__/agent-resolver.test.ts`
 *
 * The default `defaultResolveSessionId` path reads/writes
 * `agents/<id>/session.json` via `src/sessions.ts`. To keep the suite
 * hermetic we inject `resolveSessionId` for the bulk of tests; a single
 * end-to-end case exercises the real persistence layer against a temp
 * project dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BusAgentSettings } from "../../config";
import { resolveBusAgentConfig, resolveBusAgentConfigs } from "../agent-resolver";

/* ────────────────────────────────────────────────────────────────────── */
/* Pure resolution (with injected resolveSessionId)                        */
/* ────────────────────────────────────────────────────────────────────── */

describe("resolveBusAgentConfig — defaults", () => {
  it("applies defaults for cwd, permission_mode, session_id", async () => {
    const out = await resolveBusAgentConfig(
      { id: "triage" },
      { defaultCwd: "/tmp/proj", resolveSessionId: async () => "uuid-fixed" },
    );
    expect(out).toEqual({
      id: "triage",
      cwd: "/tmp/proj",
      session_id: "uuid-fixed",
      permission_mode: "plan",
    });
  });

  it("preserves explicit cwd over defaultCwd", async () => {
    const out = await resolveBusAgentConfig(
      { id: "triage", cwd: "/srv/triage" },
      { defaultCwd: "/tmp/proj", resolveSessionId: async () => "uuid-fixed" },
    );
    expect(out.cwd).toBe("/srv/triage");
  });

  it("falls back to process.cwd() when neither entry.cwd nor defaultCwd is set", async () => {
    const out = await resolveBusAgentConfig(
      { id: "triage" },
      { resolveSessionId: async () => "uuid-fixed" },
    );
    expect(out.cwd).toBe(process.cwd());
  });

  it("passes through every optional file path field when set", async () => {
    const entry: BusAgentSettings = {
      id: "research",
      system_prompt_file: "/etc/cc/prompt.md",
      memory_file: "/etc/cc/mem.md",
      mcp_config: "/etc/cc/mcp.json",
    };
    const out = await resolveBusAgentConfig(entry, {
      resolveSessionId: async () => "uuid-fixed",
    });
    expect(out.system_prompt_file).toBe("/etc/cc/prompt.md");
    expect(out.memory_file).toBe("/etc/cc/mem.md");
    expect(out.mcp_config).toBe("/etc/cc/mcp.json");
  });

  it("forwards supervision override", async () => {
    const out = await resolveBusAgentConfig(
      { id: "triage", supervision: "pty-stdin" },
      { resolveSessionId: async () => "uuid-fixed" },
    );
    expect(out.supervision).toBe("pty-stdin");
  });

  it("forwards explicit permission_mode override", async () => {
    const out = await resolveBusAgentConfig(
      { id: "triage", permission_mode: "bypassPermissions" },
      { resolveSessionId: async () => "uuid-fixed" },
    );
    expect(out.permission_mode).toBe("bypassPermissions");
  });
});

describe("resolveBusAgentConfigs — batch", () => {
  it("resolves every entry in declaration order", async () => {
    const seq = ["s1", "s2", "s3"];
    let i = 0;
    const entries: BusAgentSettings[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const out = await resolveBusAgentConfigs(entries, {
      defaultCwd: "/tmp/proj",
      resolveSessionId: async () => seq[i++],
    });
    expect(out.map((r) => r.entry.id)).toEqual(["a", "b", "c"]);
    expect(out.every((r) => r.config !== null)).toBe(true);
    expect(out.map((r) => r.config?.session_id)).toEqual(["s1", "s2", "s3"]);
  });

  it("returns config:null + error for a failed resolution without aborting the rest", async () => {
    const entries: BusAgentSettings[] = [{ id: "ok-a" }, { id: "broken" }, { id: "ok-b" }];
    const out = await resolveBusAgentConfigs(entries, {
      resolveSessionId: async (id) => {
        if (id === "broken") throw new Error("disk full");
        return `sess-${id}`;
      },
    });
    expect(out[0]?.config).not.toBeNull();
    expect(out[1]?.config).toBeNull();
    expect(out[1]?.error).toBeInstanceOf(Error);
    expect((out[1]?.error as Error).message).toContain("disk full");
    expect(out[2]?.config).not.toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* Default resolveSessionId — real disk round-trip                         */
/* ────────────────────────────────────────────────────────────────────── */

describe("resolveBusAgentConfig — default resolveSessionId persistence", () => {
  let tmpProj: string;
  let savedCwd: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    tmpProj = mkdtempSync(join(tmpdir(), "ccaw-agent-resolver-"));
    process.chdir(tmpProj);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    try {
      rmSync(tmpProj, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("generates a UUID on first call and reuses it on the second", async () => {
    const first = await resolveBusAgentConfig({ id: "triage" });
    expect(first.session_id).toMatch(/^[0-9a-f-]{36}$/i);
    const second = await resolveBusAgentConfig({ id: "triage" });
    expect(second.session_id).toBe(first.session_id);
  });

  it("different agents get different ids", async () => {
    const a = await resolveBusAgentConfig({ id: "agent-a" });
    const b = await resolveBusAgentConfig({ id: "agent-b" });
    expect(a.session_id).not.toBe(b.session_id);
  });
});
