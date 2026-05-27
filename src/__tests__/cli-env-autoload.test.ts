/**
 * Tests for src/cli-env-autoload.ts
 *
 * Run with: bun test src/__tests__/cli-env-autoload.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDotenv, autoLoadClaudeClawEnv } from "../cli-env-autoload";

describe("applyDotenv", () => {
  const sentinels = ["TEST_FOO_KEY_A", "TEST_FOO_KEY_B", "TEST_FOO_KEY_C", "TEST_FOO_KEY_D"];

  beforeEach(() => {
    for (const k of sentinels) delete process.env[k];
  });

  afterEach(() => {
    for (const k of sentinels) delete process.env[k];
  });

  it("parses well-formed KEY=value lines", () => {
    const count = applyDotenv("TEST_FOO_KEY_A=alpha\nTEST_FOO_KEY_B=beta\n");
    expect(count).toBe(2);
    expect(process.env.TEST_FOO_KEY_A).toBe("alpha");
    expect(process.env.TEST_FOO_KEY_B).toBe("beta");
  });

  it("does NOT overwrite already-set vars", () => {
    process.env.TEST_FOO_KEY_A = "preexisting";
    const count = applyDotenv("TEST_FOO_KEY_A=replaced\nTEST_FOO_KEY_B=fresh\n");
    expect(count).toBe(1);
    expect(process.env.TEST_FOO_KEY_A).toBe("preexisting");
    expect(process.env.TEST_FOO_KEY_B).toBe("fresh");
  });

  it("strips matching surrounding quotes", () => {
    applyDotenv(`TEST_FOO_KEY_A="quoted-double"\nTEST_FOO_KEY_B='quoted-single'\n`);
    expect(process.env.TEST_FOO_KEY_A).toBe("quoted-double");
    expect(process.env.TEST_FOO_KEY_B).toBe("quoted-single");
  });

  it("does NOT strip mismatched quote pairs", () => {
    applyDotenv(`TEST_FOO_KEY_A="mixed'\n`);
    expect(process.env.TEST_FOO_KEY_A).toBe(`"mixed'`);
  });

  it("ignores comments and blank lines", () => {
    const count = applyDotenv("# a comment\n\n  \nTEST_FOO_KEY_A=ok\n");
    expect(count).toBe(1);
    expect(process.env.TEST_FOO_KEY_A).toBe("ok");
  });

  it("ignores malformed lines", () => {
    const count = applyDotenv(
      "no equals sign\n=no key\n9STARTS_WITH_DIGIT=x\nTEST_FOO_KEY_A=good\n",
    );
    expect(count).toBe(1);
    expect(process.env.TEST_FOO_KEY_A).toBe("good");
  });

  it("preserves '=' inside values", () => {
    applyDotenv("TEST_FOO_KEY_A=key=with=equals\n");
    expect(process.env.TEST_FOO_KEY_A).toBe("key=with=equals");
  });

  it("treats empty value as empty string and counts it", () => {
    const count = applyDotenv("TEST_FOO_KEY_A=\n");
    expect(count).toBe(1);
    expect(process.env.TEST_FOO_KEY_A).toBe("");
  });
});

describe("autoLoadClaudeClawEnv", () => {
  let tmp: string;
  const sentinels = [
    "CLAUDECLAW_TEST_OAUTH",
    "CLAUDECLAW_TEST_API_KEY",
    "CLAUDECLAW_ENV_FILE",
    "CLAUDECLAW_ENV_AUTOLOAD",
  ];
  const previous = new Map<string, string | undefined>();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "claudeclaw-env-autoload-"));
    for (const k of sentinels) {
      previous.set(k, process.env[k]);
      delete process.env[k];
    }
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const k of sentinels) {
      const prev = previous.get(k);
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
    previous.clear();
  });

  it("loads from CLAUDECLAW_ENV_FILE override", () => {
    const path = join(tmp, "override.env");
    writeFileSync(path, "CLAUDECLAW_TEST_OAUTH=sk-ant-oat01-fake-token\n");
    chmodSync(path, 0o600);
    process.env.CLAUDECLAW_ENV_FILE = path;

    const result = autoLoadClaudeClawEnv();

    expect(result).not.toBeNull();
    expect(result?.path).toBe(path);
    expect(result?.loaded).toBe(1);
    expect(process.env.CLAUDECLAW_TEST_OAUTH).toBe("sk-ant-oat01-fake-token");
  });

  it("returns null when no env file exists in any candidate path", () => {
    process.env.CLAUDECLAW_ENV_FILE = join(tmp, "nonexistent.env");
    const result = autoLoadClaudeClawEnv();
    expect(result).toBeNull();
  });

  it("respects CLAUDECLAW_ENV_AUTOLOAD=0 opt-out", () => {
    const path = join(tmp, "skipped.env");
    writeFileSync(path, "CLAUDECLAW_TEST_OAUTH=should-not-load\n");
    process.env.CLAUDECLAW_ENV_FILE = path;
    process.env.CLAUDECLAW_ENV_AUTOLOAD = "0";

    const result = autoLoadClaudeClawEnv();

    expect(result).toBeNull();
    expect(process.env.CLAUDECLAW_TEST_OAUTH).toBeUndefined();
  });

  it("does NOT overwrite already-set vars", () => {
    const path = join(tmp, "override.env");
    writeFileSync(path, "CLAUDECLAW_TEST_OAUTH=from-file\nCLAUDECLAW_TEST_API_KEY=fresh\n");
    process.env.CLAUDECLAW_ENV_FILE = path;
    process.env.CLAUDECLAW_TEST_OAUTH = "from-env";

    const result = autoLoadClaudeClawEnv();

    expect(result?.loaded).toBe(1);
    expect(process.env.CLAUDECLAW_TEST_OAUTH).toBe("from-env");
    expect(process.env.CLAUDECLAW_TEST_API_KEY).toBe("fresh");
  });
});
