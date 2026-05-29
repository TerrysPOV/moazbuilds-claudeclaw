/**
 * Fresh-install default agent (#196 — cause #1 of #193).
 *
 * `initConfig()` writes DEFAULT_SETTINGS to settings.json only when the file
 * does not yet exist. With `runtime: "bus"` as the default, the shipped
 * default must also declare one agent, otherwise the bus mounts with zero
 * agents and nothing answers on any channel.
 *
 * These tests exercise the real on-disk write path, so they back up and
 * restore the project's settings.json around the run.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdir, copyFile, unlink } from "fs/promises";
import { existsSync } from "fs";

import { initConfig, reloadSettings, getSettings } from "../config";

const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.init-default-agent-backup");

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

describe("initConfig — fresh install default agent (#196)", () => {
  it("writes one default agent so the bus mounts a working agent out of the box", async () => {
    if (existsSync(SETTINGS_FILE)) await unlink(SETTINGS_FILE);

    await initConfig();

    expect(existsSync(SETTINGS_FILE)).toBe(true);
    const written = (await Bun.file(SETTINGS_FILE).json()) as {
      runtime?: unknown;
      agents?: unknown;
    };
    expect(written.runtime).toBe("bus");
    expect(written.agents).toEqual([{ id: "default" }]);

    // And it parses back through loadSettings to exactly one mountable agent.
    await reloadSettings();
    expect(getSettings().agents).toEqual([{ id: "default" }]);
  });
});
