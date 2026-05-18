/**
 * parseSettings round-trip tests for the new `runtime` field (Sprint 5.1).
 *
 * Same harness pattern as `pty-config.test.ts`: mutate settings.json and
 * call `reloadSettings()` so we exercise the real parseSettings path.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdir, copyFile, unlink } from "fs/promises";
import { existsSync } from "fs";

import { reloadSettings, getSettings } from "../config";

const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.runtime-cfg-test-backup");

async function writeRawSettings(obj: unknown): Promise<void> {
  await mkdir(SETTINGS_DIR, { recursive: true });
  await Bun.write(SETTINGS_FILE, JSON.stringify(obj, null, 2) + "\n");
}

beforeAll(async () => {
  await mkdir(SETTINGS_DIR, { recursive: true });
  if (existsSync(SETTINGS_FILE)) {
    await copyFile(SETTINGS_FILE, BACKUP_FILE);
  }
});

afterAll(async () => {
  if (existsSync(BACKUP_FILE)) {
    await copyFile(BACKUP_FILE, SETTINGS_FILE);
    await unlink(BACKUP_FILE);
  } else if (existsSync(SETTINGS_FILE)) {
    await unlink(SETTINGS_FILE);
  }
  try {
    await reloadSettings();
  } catch {
    /* ok — restore may have removed the file */
  }
});

describe("parseSettings — runtime field (Sprint 5.1)", () => {
  it('defaults to "pty" when the field is absent', async () => {
    await writeRawSettings({});
    await reloadSettings();
    expect(getSettings().runtime).toBe("pty");
  });

  it('accepts "bus"', async () => {
    await writeRawSettings({ runtime: "bus" });
    await reloadSettings();
    expect(getSettings().runtime).toBe("bus");
  });

  it('accepts "pty" explicitly', async () => {
    await writeRawSettings({ runtime: "pty" });
    await reloadSettings();
    expect(getSettings().runtime).toBe("pty");
  });

  it('falls back to "pty" on an unknown value', async () => {
    // Unknown string — parseRuntimeMode logs a warning but never throws.
    await writeRawSettings({ runtime: "buss" });
    await reloadSettings();
    expect(getSettings().runtime).toBe("pty");
  });

  it('falls back to "pty" when the field is non-string', async () => {
    await writeRawSettings({ runtime: 42 });
    await reloadSettings();
    expect(getSettings().runtime).toBe("pty");
  });

  it("trims whitespace before matching", async () => {
    await writeRawSettings({ runtime: "  bus  " });
    await reloadSettings();
    expect(getSettings().runtime).toBe("bus");
  });
});

describe("parseSettings — agents field (Sprint 5.2a)", () => {
  it("defaults to empty array when the field is absent", async () => {
    await writeRawSettings({});
    await reloadSettings();
    expect(getSettings().agents).toEqual([]);
  });

  it("accepts a minimal entry (id only)", async () => {
    await writeRawSettings({ agents: [{ id: "triage" }] });
    await reloadSettings();
    expect(getSettings().agents).toEqual([{ id: "triage" }]);
  });

  it("preserves all optional fields when set", async () => {
    await writeRawSettings({
      agents: [
        {
          id: "research",
          cwd: "/srv/research",
          permission_mode: "bypassPermissions",
          supervision: "pty-stdin",
          system_prompt_file: "/etc/cc/research.md",
          memory_file: "/etc/cc/research-memory.md",
          mcp_config: "/etc/cc/research-mcp.json",
        },
      ],
    });
    await reloadSettings();
    expect(getSettings().agents[0]).toMatchObject({
      id: "research",
      cwd: "/srv/research",
      permission_mode: "bypassPermissions",
      supervision: "pty-stdin",
      system_prompt_file: "/etc/cc/research.md",
      memory_file: "/etc/cc/research-memory.md",
      mcp_config: "/etc/cc/research-mcp.json",
    });
  });

  it("drops entries missing or with invalid id", async () => {
    await writeRawSettings({
      agents: [
        { id: "ok-1" },
        { id: "" },
        { cwd: "/no/id" },
        { id: "Has-Caps-And-Periods.bad" },
        { id: "ok_2" },
      ],
    });
    await reloadSettings();
    expect(getSettings().agents.map((a) => a.id)).toEqual(["ok-1", "ok_2"]);
  });

  it("dedupes by id keeping the first occurrence", async () => {
    await writeRawSettings({
      agents: [
        { id: "triage", cwd: "/first" },
        { id: "triage", cwd: "/second" },
      ],
    });
    await reloadSettings();
    expect(getSettings().agents).toEqual([{ id: "triage", cwd: "/first" }]);
  });

  it("drops invalid permission_mode and supervision but keeps the rest", async () => {
    await writeRawSettings({
      agents: [
        {
          id: "triage",
          permission_mode: "all-the-powers",
          supervision: "windows-fancy",
          cwd: "/srv",
        },
      ],
    });
    await reloadSettings();
    expect(getSettings().agents[0]).toEqual({ id: "triage", cwd: "/srv" });
  });

  it("falls back to empty array when the field is not an array", async () => {
    await writeRawSettings({ agents: "triage" });
    await reloadSettings();
    expect(getSettings().agents).toEqual([]);
  });

  it("enforces 36-char id cap (sun_path budget)", async () => {
    const tooLong = "a".repeat(37);
    await writeRawSettings({ agents: [{ id: tooLong }, { id: "a".repeat(36) }] });
    await reloadSettings();
    expect(getSettings().agents.map((a) => a.id)).toEqual(["a".repeat(36)]);
  });
});
