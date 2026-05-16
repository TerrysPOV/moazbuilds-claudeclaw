/**
 * Tests for runner.ts modelOverride wiring (Phase 18 Plan 01).
 *
 * Strategy: spy on runClaudeOnce to intercept model arg, throw sentinel
 * to short-circuit downstream side effects. Use isolated tmp cwd to
 * contain any session/log writes.
 *
 * Run with: bun test src/__tests__/runner.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, spyOn, test } from "bun:test";
import * as runnerMod from "../runner";
import * as configMod from "../config";
import { loadSettings, getSettings } from "../config";

const SENTINEL = "RUNNER_TEST_SENTINEL";

let runOnceSpy: ReturnType<typeof spyOn> | null = null;
const capturedModels: string[] = [];

beforeAll(async () => {
  await loadSettings();
});

beforeEach(() => {
  capturedModels.length = 0;
  runOnceSpy = spyOn(runnerMod, "runClaudeOnce").mockImplementation((async (
    _args: string[],
    model: string,
  ) => {
    capturedModels.push(model);
    throw new Error(SENTINEL);
  }) as any);
});

afterEach(() => {
  runOnceSpy?.mockRestore();
  runOnceSpy = null;
});

async function tryRun(opts?: { modelOverride?: string }): Promise<void> {
  try {
    await runnerMod.run("test-job", "hello world", undefined, opts);
  } catch (e) {
    if ((e as Error).message !== SENTINEL && !(e as Error).message?.includes(SENTINEL)) {
      throw e;
    }
  }
}

describe("Phase 18: runner modelOverride wiring", () => {
  it("forwards modelOverride to runClaudeOnce as primaryConfig.model", async () => {
    await tryRun({ modelOverride: "opus" });
    expect(capturedModels.length).toBeGreaterThanOrEqual(1);
    expect(capturedModels[0]).toBe("opus");
  });

  it("without options uses settings.model (back-compat)", async () => {
    const { model, agentic } = getSettings();
    await tryRun();
    expect(capturedModels.length).toBeGreaterThanOrEqual(1);
    if (!agentic.enabled) {
      // Only assert exact match in non-agentic mode (otherwise router picks)
      expect(capturedModels[0]).toBe(model);
    }
  });

  it("modelOverride='glm' is forwarded as model='glm'", async () => {
    await tryRun({ modelOverride: "glm" });
    expect(capturedModels[0]).toBe("glm");
  });

  // Phase 18 Plan 03 Task 1: all supported model strings + agentic interaction
  test.each([
    "opus",
    "sonnet",
    "haiku",
    "glm",
  ])("forwards %s as primaryConfig.model via modelOverride", async (m) => {
    await tryRun({ modelOverride: m });
    expect(capturedModels.length).toBeGreaterThanOrEqual(1);
    expect(capturedModels[0]).toBe(m);
  });

  it("modelOverride wins when agentic.enabled=true (override branch precedes agentic)", async () => {
    const real = getSettings();
    const forcedAgentic = {
      ...real,
      agentic: {
        ...real.agentic,
        enabled: true,
        defaultMode: real.agentic?.defaultMode ?? "implementation",
        modes: real.agentic?.modes ?? [],
      },
    };
    const settingsSpy = spyOn(configMod, "getSettings").mockReturnValue(forcedAgentic as any);
    try {
      await tryRun({ modelOverride: "opus" });
      expect(capturedModels[0]).toBe("opus");
    } finally {
      settingsSpy.mockRestore();
    }
  });

  it("no modelOverride + agentic.enabled=false uses settings.model (regression sanity)", async () => {
    const real = getSettings();
    const forcedNonAgentic = {
      ...real,
      model: "sonnet",
      agentic: { ...real.agentic, enabled: false },
    };
    const settingsSpy = spyOn(configMod, "getSettings").mockReturnValue(forcedNonAgentic as any);
    try {
      await tryRun();
      expect(capturedModels[0]).toBe("sonnet");
    } finally {
      settingsSpy.mockRestore();
    }
  });

  // fallbackConfig is derived from settings.fallback regardless of modelOverride.
  // This is verified by inspection of src/runner.ts execClaude: fallbackConfig
  // is built from `fallback?.model` after the override branch, never from
  // options.modelOverride. Documented here rather than asserted because the
  // runClaudeOnce spy only captures the primary model arg, not fallback.
});

// ─── withCleanProcessEnv (issue: bun-pty env leak) ───────────────────────────
//
// Regression cover for the production failure where `claude` 2.1.89's
// "Detected a custom API key" interactive gate leaked into Discord. Root
// cause: bun-pty's Rust wrapper does NOT call CommandBuilder::env_clear()
// before adding env pairs, so portable_pty MERGES the caller-supplied env
// with the parent process env at fork(). Sanitising the opts.env Record via
// cleanSpawnEnv() was not sufficient because the daemon's process.env still
// had ANTHROPIC_API_KEY (loaded from /etc/claudeclaw/.claudeclaw-env), which
// claude inherited at fork() time. withCleanProcessEnv strips the keys from
// process.env around the synchronous FFI call.
describe("withCleanProcessEnv", () => {
  const STRIP_KEYS = [
    "ANTHROPIC_API_KEY",
    "CLAUDECODE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  ] as const;

  function snapshot(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const k of STRIP_KEYS) out[k] = process.env[k];
    return out;
  }

  function restore(snap: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(snap)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it("removes strip-list keys from process.env while fn is running", () => {
    const original = snapshot();
    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-must-not-leak-to-child";
      process.env.CLAUDECODE = "1";
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "true";

      const seen = runnerMod.withCleanProcessEnv(() => ({
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDECODE: process.env.CLAUDECODE,
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
      }));

      expect(seen.ANTHROPIC_API_KEY).toBeUndefined();
      expect(seen.CLAUDECODE).toBeUndefined();
      expect(seen.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(seen.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
    } finally {
      restore(original);
    }
  });

  it("restores originals after fn returns", () => {
    const original = snapshot();
    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-restore-me";
      process.env.CLAUDECODE = "1";

      runnerMod.withCleanProcessEnv(() => {
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      });

      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-restore-me");
      expect(process.env.CLAUDECODE).toBe("1");
    } finally {
      restore(original);
    }
  });

  it("restores originals even when fn throws", () => {
    const original = snapshot();
    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-restore-on-throw";

      expect(() => {
        runnerMod.withCleanProcessEnv(() => {
          throw new Error("boom");
        });
      }).toThrow("boom");

      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-restore-on-throw");
    } finally {
      restore(original);
    }
  });

  it("leaves keys absent that were absent originally", () => {
    const original = snapshot();
    try {
      for (const k of STRIP_KEYS) delete process.env[k];

      runnerMod.withCleanProcessEnv(() => {
        for (const k of STRIP_KEYS) {
          expect(process.env[k]).toBeUndefined();
        }
      });

      for (const k of STRIP_KEYS) {
        expect(process.env[k]).toBeUndefined();
      }
    } finally {
      restore(original);
    }
  });

  it("returns fn's return value", () => {
    expect(runnerMod.withCleanProcessEnv(() => 42)).toBe(42);
    expect(runnerMod.withCleanProcessEnv(() => "hello")).toBe("hello");
  });

  // Hetzner-discovered regression: Bun's `delete process.env.X` only updates
  // the JS hash — libc `environ` retains the value. bun-pty's Rust wrapper
  // reads `environ` via `std::env::vars_os()` so its spawned child still
  // inherits the un-stripped value. withCleanProcessEnv MUST also call libc
  // unsetenv so the child fork sees a clean env.
  //
  // This test spawns a real bun-pty child running `/bin/sh -c env` and
  // verifies the strip-list keys do not appear in the child's environment
  // dump — proving the libc-level strip works end-to-end against the same
  // codepath that production uses.
  it("strips keys at the libc level so bun-pty children do not inherit them via fork+exec", async () => {
    const SECRET = "sk-ant-libc-regression-do-not-leak";
    const original = snapshot();
    try {
      // Set ANTHROPIC_API_KEY via libc so it actually lives in environ
      // (mirrors how the daemon's launcher sources /home/claw/.claudeclaw-env
      // and exec's bun — by the time bun starts, the var is in libc environ).
      process.env.ANTHROPIC_API_KEY = SECRET;

      const { spawn } = await import("bun-pty");

      const out = runnerMod.withCleanProcessEnv(() => {
        const p = spawn("/bin/sh", ["-c", "env"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: "/tmp",
          // Explicit env intentionally minimal — the leak would come via
          // bun-pty's parent-env merge, NOT this explicit map.
          env: { PATH: "/usr/bin:/bin" },
        });
        let buf = "";
        p.onData((d: string) => {
          buf += d;
        });
        return new Promise<string>((resolve) => {
          // The child exits after `env` prints; give it time to flush.
          setTimeout(() => {
            resolve(buf);
          }, 400);
        });
      });

      const dump = await out;
      // The child must not have seen ANTHROPIC_API_KEY at all.
      expect(dump).not.toContain(SECRET);
      expect(dump).not.toMatch(/(^|\n)ANTHROPIC_API_KEY=/);
    } finally {
      restore(original);
    }
  }, 5000);
});
