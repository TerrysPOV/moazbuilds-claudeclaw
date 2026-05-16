/**
 * Tests for the trust-prompt self-heal (issue #81 failure mode #1).
 *
 * Verifies that `ensureTrustAccepted` idempotently sets
 * `projects[<cwd>].hasTrustDialogAccepted: true` in ~/.claude.json.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTrustAccepted } from "../runner/pty-trust-prompt";

let tmpHome: string;
let configPath: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "claudeclaw-trust-test-"));
  configPath = join(tmpHome, ".claude.json");
});

afterEach(() => {
  if (existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

describe("ensureTrustAccepted", () => {
  test("creates ~/.claude.json with the project entry when file is absent", async () => {
    const cwd = "/home/test/project";
    const res = await ensureTrustAccepted(cwd, { homedir: () => tmpHome });

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.configPath).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(raw.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
  });

  test("adds the project entry when ~/.claude.json exists but the cwd is absent", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ projects: { "/other": { hasTrustDialogAccepted: true } } }, null, 2),
    );

    const cwd = "/home/test/project";
    const res = await ensureTrustAccepted(cwd, { homedir: () => tmpHome });

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(raw.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    // Old entries are preserved.
    expect(raw.projects["/other"]?.hasTrustDialogAccepted).toBe(true);
  });

  test("is idempotent: returns changed=false when already true", async () => {
    const cwd = "/home/test/project";
    await ensureTrustAccepted(cwd, { homedir: () => tmpHome });
    const res2 = await ensureTrustAccepted(cwd, { homedir: () => tmpHome });

    expect(res2.ok).toBe(true);
    expect(res2.changed).toBe(false);
  });

  test("flips an explicit `false` to true (operator may have edited the file)", async () => {
    const cwd = "/home/test/project";
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          projects: {
            [cwd]: { hasTrustDialogAccepted: false, customField: "preserved" },
          },
        },
        null,
        2,
      ),
    );

    const res = await ensureTrustAccepted(cwd, { homedir: () => tmpHome });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean; customField?: string }>;
    };
    expect(raw.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    // Other fields are preserved.
    expect(raw.projects[cwd]?.customField).toBe("preserved");
  });

  test("resolves the cwd to an absolute path before using it as a key", async () => {
    // Pass a relative path. The function should resolve it (relative to
    // process.cwd()) so the key matches what claude itself would record.
    const res = await ensureTrustAccepted(".", { homedir: () => tmpHome });
    expect(res.ok).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    const keys = Object.keys(raw.projects);
    expect(keys.length).toBe(1);
    // The recorded key must be an absolute path.
    expect(keys[0]!.startsWith("/")).toBe(true);
  });

  test("refuses to overwrite a malformed ~/.claude.json (surfaces non-fatal error)", async () => {
    writeFileSync(configPath, "{ not valid json");
    const res = await ensureTrustAccepted("/home/test/project", {
      homedir: () => tmpHome,
    });
    expect(res.ok).toBe(false);
    expect(res.changed).toBe(false);
    expect(res.reason).toContain("malformed JSON");
    // The malformed file is left in place — operator must fix it.
    expect(readFileSync(configPath, "utf-8")).toBe("{ not valid json");
  });

  test("honours an explicit configPath override", async () => {
    const altPath = join(tmpHome, "alt-config.json");
    const res = await ensureTrustAccepted("/home/test/project", { configPath: altPath });
    expect(res.ok).toBe(true);
    expect(res.configPath).toBe(altPath);
    expect(existsSync(altPath)).toBe(true);
  });

  test("preserves unrelated top-level fields in ~/.claude.json", async () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          userId: "abc",
          someOtherTopLevel: { keep: "me" },
          projects: {},
        },
        null,
        2,
      ),
    );

    const res = await ensureTrustAccepted("/home/test/project", {
      homedir: () => tmpHome,
    });
    expect(res.ok).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      userId: string;
      someOtherTopLevel: { keep: string };
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(raw.userId).toBe("abc");
    expect(raw.someOtherTopLevel.keep).toBe("me");
    expect(raw.projects["/home/test/project"]?.hasTrustDialogAccepted).toBe(true);
  });
});
