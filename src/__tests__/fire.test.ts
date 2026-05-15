/**
 * Tests for src/commands/fire.ts — Phase 17 GAP-02 manual fire command.
 *
 * Run with: bun test src/__tests__/fire.test.ts
 */

import { describe, it, expect, afterEach } from "bun:test";
import { rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { fireJob, runFireCommand, parseFireArgs } from "../commands/fire";
import type { Job } from "../jobs";

const PROJECT = process.cwd();
const AGENTS_DIR = join(PROJECT, "agents");

const TEST_PREFIX = "tst-fire-";
const createdAgents: string[] = [];

function uniq(suffix: string): string {
  return `${TEST_PREFIX}${suffix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

async function writeAgentJob(
  agent: string,
  label: string,
  frontmatter: string,
  body = "do the thing",
): Promise<void> {
  const dir = join(AGENTS_DIR, agent, "jobs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${label}.md`), `---\n${frontmatter}\n---\n${body}\n`, "utf8");
  if (!createdAgents.includes(agent)) createdAgents.push(agent);
}

afterEach(async () => {
  for (const a of createdAgents.splice(0)) {
    await rm(join(AGENTS_DIR, a), { recursive: true, force: true });
  }
});

// A fake runner/prompt resolver keeps tests hermetic (no real `claude` exec).
function fakeRunner(calls: Array<{ name: string; prompt: string; agent?: string }>, exitCode = 0) {
  return async (name: string, prompt: string, agent?: string) => {
    calls.push({ name, prompt, agent });
    return { exitCode, stdout: `ran:${name}`, stderr: "" };
  };
}

const passthroughResolver = async (p: string) => p;

describe("parseFireArgs", () => {
  it("parses agent:label form", () => {
    expect(parseFireArgs(["reg:daily-research"])).toEqual({
      agent: "reg",
      label: "daily-research",
    });
  });
  it("parses agent label form", () => {
    expect(parseFireArgs(["reg", "daily-research"])).toEqual({
      agent: "reg",
      label: "daily-research",
    });
  });
  it("rejects empty args", () => {
    expect(parseFireArgs([])).toBeNull();
  });
  it("rejects single token without colon", () => {
    expect(parseFireArgs(["reg"])).toBeNull();
  });
  it("rejects empty agent or label", () => {
    expect(parseFireArgs([":foo"])).toBeNull();
    expect(parseFireArgs(["foo:"])).toBeNull();
  });
});

describe("fireJob", () => {
  it("loads and fires a matching agent job via run() with agent scoping", async () => {
    const agent = uniq("ok");
    await writeAgentJob(
      agent,
      "daily-research",
      "schedule: 0 9 * * *\nrecurring: true",
      "research briefing",
    );

    const calls: Array<{ name: string; prompt: string; agent?: string }> = [];
    const result = await fireJob(agent, "daily-research", {
      runner: fakeRunner(calls),
      promptResolver: passthroughResolver,
    });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe(agent);
    expect(calls[0].prompt).toBe("research briefing");
    expect(calls[0].name).toBe(`${agent}/daily-research`);
  });

  it("errors clearly when agent directory does not exist", async () => {
    const result = await fireJob("no-such-agent-xyz-1234", "anything", {
      runner: fakeRunner([]),
      promptResolver: passthroughResolver,
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("no-such-agent-xyz-1234");
    expect(result.error).toContain("not found");
  });

  it("errors clearly when label file does not exist within an agent", async () => {
    const agent = uniq("missing-label");
    await writeAgentJob(agent, "daily", "schedule: 0 9 * * *\nrecurring: true");

    const result = await fireJob(agent, "weekly", {
      runner: fakeRunner([]),
      promptResolver: passthroughResolver,
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain(`${agent}:weekly`);
    expect(result.error).toContain("not found");
  });

  it("can fire a disabled job (bypasses enabled filter)", async () => {
    const agent = uniq("disabled");
    await writeAgentJob(
      agent,
      "off-job",
      "schedule: 0 9 * * *\nrecurring: true\nenabled: false",
      "disabled prompt",
    );

    const calls: Array<{ name: string; prompt: string; agent?: string }> = [];
    const result = await fireJob(agent, "off-job", {
      runner: fakeRunner(calls),
      promptResolver: passthroughResolver,
    });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe("disabled prompt");
  });

  it("propagates runner exitCode on failure", async () => {
    const agent = uniq("fail");
    await writeAgentJob(agent, "bad", "schedule: 0 9 * * *\nrecurring: true");

    const result = await fireJob(agent, "bad", {
      runner: fakeRunner([], 7),
      promptResolver: passthroughResolver,
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(7);
  });
});

describe("runFireCommand", () => {
  it("returns 2 on usage error", async () => {
    let errText = "";
    const code = await runFireCommand([], {
      runner: fakeRunner([]),
      promptResolver: passthroughResolver,
      stdout: () => {},
      stderr: (s) => {
        errText += s;
      },
    });
    expect(code).toBe(2);
    expect(errText).toContain("Usage");
  });

  it("returns 1 when agent missing", async () => {
    let errText = "";
    const code = await runFireCommand(["no-such-agent-zzz:whatever"], {
      runner: fakeRunner([]),
      promptResolver: passthroughResolver,
      stdout: () => {},
      stderr: (s) => {
        errText += s;
      },
    });
    expect(code).toBe(1);
    expect(errText).toContain("not found");
  });

  it("returns 1 when label missing", async () => {
    const agent = uniq("cli-missing");
    await writeAgentJob(agent, "alpha", "schedule: 0 9 * * *\nrecurring: true");

    let errText = "";
    const code = await runFireCommand([`${agent}:beta`], {
      runner: fakeRunner([]),
      promptResolver: passthroughResolver,
      stdout: () => {},
      stderr: (s) => {
        errText += s;
      },
    });
    expect(code).toBe(1);
    expect(errText).toContain(`${agent}:beta`);
  });

  it("returns 0 on success and streams output", async () => {
    const agent = uniq("cli-ok");
    await writeAgentJob(agent, "go", "schedule: 0 9 * * *\nrecurring: true", "fire me");

    let outText = "";
    const code = await runFireCommand([agent, "go"], {
      runner: fakeRunner([]),
      promptResolver: passthroughResolver,
      stdout: (s) => {
        outText += s;
      },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(outText).toContain(`Firing ${agent}:go`);
    expect(outText).toContain(`ran:${agent}/go`);
    expect(outText).toContain("Done.");
  });
});
