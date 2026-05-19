/**
 * Unit tests for `buildClaudeArgs`.
 *
 * History — four wire-up attempts before the current one worked
 * end-to-end against a live `claude` 2.1.89 in PTY-stdin mode:
 *
 *   1. `--dangerously-load-development-channels plugin:plus-bus@local`
 *      (PR #110) — silently loaded no channel.
 *   2. `--dangerously-load-development-channels server:plus-bus` +
 *      synth `--mcp-config` (PR #131) — interactive TUI confirmation
 *      the PTY supervisor can't drive.
 *   3. `--plugin-dir <root>` alone — channel loaded but notifications
 *      silently dropped (allowlist gate).
 *   4. `--plugin-dir` + `--settings channelsEnabled` + `--channels` —
 *      managed-settings allowlist override is `team`/`enterprise` only.
 *
 * Current: `--plugin-dir` + `--dangerously-load-development-channels
 * plugin:claudeclaw-plus@inline` + `--allowedTools <plus-bus tools>`.
 * The danger flag's dialog stays dormant when `channelsEnabled` is
 * unset; we still send a belt-and-braces Enter from the PTY supervisor
 * shortly after spawn in case the account has the channels feature flag
 * on.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  CLAUDECLAW_PLUGIN_NAME,
  PLUS_BUS_CHANNEL,
  buildClaudeArgs,
  resolveClaudeclawPluginRoot,
} from "../session-manager";
import type { AgentConfig } from "../types";

function makeAgent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: over.id ?? "test-agent",
    cwd: over.cwd ?? process.cwd(),
    session_id: over.session_id ?? "00000000-0000-0000-0000-000000000000",
    permission_mode: over.permission_mode,
    system_prompt_file: over.system_prompt_file,
    mcp_config: over.mcp_config,
    supervision: over.supervision ?? "pty-stdin",
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "claudeclaw-bus-args-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("PLUS_BUS_CHANNEL", () => {
  it("is 'plus-bus' (matches the mcpServers key in .mcp.json)", () => {
    expect(PLUS_BUS_CHANNEL).toBe("plus-bus");
  });
});

describe("CLAUDECLAW_PLUGIN_NAME", () => {
  it("is 'claudeclaw-plus' (matches .claude-plugin/plugin.json name)", () => {
    expect(CLAUDECLAW_PLUGIN_NAME).toBe("claudeclaw-plus");
  });
});

describe("resolveClaudeclawPluginRoot", () => {
  it("points at a directory containing .claude-plugin/plugin.json and .mcp.json", () => {
    const root = resolveClaudeclawPluginRoot();
    expect(existsSync(join(root, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(root, ".mcp.json"))).toBe(true);
  });
});

describe("buildClaudeArgs", () => {
  it("passes --plugin-dir at the plugin root", () => {
    const args = buildClaudeArgs(makeAgent({ id: "mu" }), "pty-stdin");
    const pluginIdx = args.indexOf("--plugin-dir");
    expect(pluginIdx).toBeGreaterThanOrEqual(0);
    expect(args[pluginIdx + 1]).toBe(resolveClaudeclawPluginRoot());
  });

  it("passes --dangerously-load-development-channels with the tagged channel name", () => {
    const args = buildClaudeArgs(makeAgent({ id: "nu" }), "pty-stdin");
    const chanIdx = args.indexOf("--dangerously-load-development-channels");
    expect(chanIdx).toBeGreaterThanOrEqual(0);
    // Tagged form: `plugin:<plugin-name>@<marketplace>`. Marketplace tag
    // is whatever claude assigns to `--plugin-dir`-loaded plugins.
    expect(args[chanIdx + 1]).toMatch(new RegExp(`^plugin:${CLAUDECLAW_PLUGIN_NAME}@[a-z-]+$`));
  });

  it("auto-allowlists the plus-bus channel's own MCP tools via --allowedTools", () => {
    const args = buildClaudeArgs(makeAgent({ id: "xi" }), "pty-stdin");
    const allowIdx = args.indexOf("--allowedTools");
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    const allowed = args[allowIdx + 1] ?? "";
    expect(allowed).toContain("mcp__plugin_claudeclaw-plus_plus-bus__reply");
    expect(allowed).toContain("mcp__plugin_claudeclaw-plus_plus-bus__ask");
    expect(allowed).toContain("mcp__plugin_claudeclaw-plus_plus-bus__cancel");
    expect(allowed).toContain("mcp__plugin_claudeclaw-plus_plus-bus__request_human");
  });

  it("prepends -p stream-json flags for process-stream-json mode", () => {
    const args = buildClaudeArgs(makeAgent({ id: "omicron" }), "process-stream-json");
    expect(args[0]).toBe("-p");
    expect(args).toContain("--input-format=stream-json");
    expect(args).toContain("--output-format=stream-json");
    expect(args).toContain("--plugin-dir");
  });

  it("passes through operator-supplied --mcp-config alongside the plugin dir", () => {
    const userCfgPath = join(tmp, "user-mcp.json");
    writeFileSync(userCfgPath, JSON.stringify({ mcpServers: {} }));
    const agent = makeAgent({ id: "rho", mcp_config: userCfgPath });
    const args = buildClaudeArgs(agent, "pty-stdin");
    expect(args).toContain("--plugin-dir");
    const mcpIdx = args.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    expect(args[mcpIdx + 1]).toBe(userCfgPath);
  });

  it("omits --mcp-config entirely when no operator config is set", () => {
    const args = buildClaudeArgs(makeAgent({ id: "sigma" }), "pty-stdin");
    expect(args).not.toContain("--mcp-config");
  });

  it("passes through permission_mode and session_id", () => {
    const agent = makeAgent({
      id: "tau",
      permission_mode: "default",
      session_id: "deadbeef-1234-1234-1234-000000000000",
    });
    const args = buildClaudeArgs(agent, "pty-stdin");
    const pmIdx = args.indexOf("--permission-mode");
    const sidIdx = args.indexOf("--session-id");
    expect(args[pmIdx + 1]).toBe("default");
    expect(args[sidIdx + 1]).toBe("deadbeef-1234-1234-1234-000000000000");
  });
});
