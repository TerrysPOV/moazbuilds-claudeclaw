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
