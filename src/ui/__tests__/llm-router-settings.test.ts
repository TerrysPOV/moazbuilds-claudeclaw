/**
 * Tests for `src/ui/services/llm-router-settings.ts` (#70 Phase C).
 *
 * Exercises the real settings.json read/write path with backup + restore around
 * the run, matching the harness used by runtime-config.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "path";
import { mkdir, copyFile, unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";

import { readLlmRouterSettings, updateLlmRouterSettings } from "../services/llm-router-settings";

const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.llm-router-test-backup");

beforeAll(async () => {
  await mkdir(SETTINGS_DIR, { recursive: true });
  if (existsSync(SETTINGS_FILE)) await copyFile(SETTINGS_FILE, BACKUP_FILE);
});

afterAll(async () => {
  if (existsSync(BACKUP_FILE)) {
    await copyFile(BACKUP_FILE, SETTINGS_FILE);
    await unlink(BACKUP_FILE);
  } else if (existsSync(SETTINGS_FILE)) {
    await unlink(SETTINGS_FILE);
  }
});

async function seed(json: Record<string, unknown>): Promise<void> {
  await writeFile(SETTINGS_FILE, `${JSON.stringify(json, null, 2)}\n`);
}

describe("readLlmRouterSettings", () => {
  beforeEach(async () => {
    await seed({});
  });

  it("returns empty tiers + the default base when llmRouter is absent", async () => {
    const r = await readLlmRouterSettings();
    expect(r).toEqual({
      tiers: { fast: [], balanced: [], reasoning: [] },
      openRouterBaseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("returns configured tiers + optional ollamaBaseUrl", async () => {
    await seed({
      llmRouter: {
        tiers: { fast: ["g/llama"], balanced: ["a/b", "c/d"], reasoning: ["x/y"] },
        openRouterBaseUrl: "https://or.example/api/v1",
        ollamaBaseUrl: "http://127.0.0.1:11434/v1",
      },
    });
    const r = await readLlmRouterSettings();
    expect(r).toEqual({
      tiers: { fast: ["g/llama"], balanced: ["a/b", "c/d"], reasoning: ["x/y"] },
      openRouterBaseUrl: "https://or.example/api/v1",
      ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    });
  });

  it("drops non-string / empty tier entries", async () => {
    await seed({
      llmRouter: { tiers: { fast: ["  g/llama  ", "", 42, null], balanced: "nope" } },
    });
    const r = await readLlmRouterSettings();
    expect(r.tiers.fast).toEqual(["g/llama"]);
    expect(r.tiers.balanced).toEqual([]);
  });
});

describe("updateLlmRouterSettings", () => {
  beforeEach(async () => {
    await seed({});
  });

  it("creates the llmRouter block on a settings.json that lacks it", async () => {
    const next = await updateLlmRouterSettings({ tiers: { fast: ["g/llama"] } });
    expect(next.tiers.fast).toEqual(["g/llama"]);
    expect(next.tiers.balanced).toEqual([]);
    // Round-trip from disk to confirm it wrote.
    const round = await readLlmRouterSettings();
    expect(round.tiers.fast).toEqual(["g/llama"]);
  });

  it("only patches the tiers the caller supplied", async () => {
    await seed({
      llmRouter: { tiers: { fast: ["keep/me"], balanced: ["b/1"], reasoning: ["r/1"] } },
    });
    await updateLlmRouterSettings({ tiers: { balanced: ["new/b"] } });
    const r = await readLlmRouterSettings();
    expect(r.tiers.fast).toEqual(["keep/me"]);
    expect(r.tiers.balanced).toEqual(["new/b"]);
    expect(r.tiers.reasoning).toEqual(["r/1"]);
  });

  it("trims + filters ids on write", async () => {
    await updateLlmRouterSettings({
      tiers: { fast: ["  groq/llama  ", "", 0 as unknown as string] },
    });
    const r = await readLlmRouterSettings();
    expect(r.tiers.fast).toEqual(["groq/llama"]);
  });
});
