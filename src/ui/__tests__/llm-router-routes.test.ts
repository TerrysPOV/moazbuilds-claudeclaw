/**
 * Integration test for the /api/llm-router/* routes (#70 Phase C).
 * Boots a real startWebUi server on an ephemeral port and injects a fake
 * catalogue via the test seam exported from `src/ui/server.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "path";
import { mkdir, copyFile, unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";

import { startWebUi, __setLlmRouterCatalogueForTests } from "../server";
import type { WebServerHandle, WebSnapshot } from "../types";
import type { ModelCatalogue } from "../../plugins/llm-router/catalogue";

const TOKEN = "test-web-token-abcdefghijklmnop";
const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.llm-router-routes-test-backup");

function snapshot(): WebSnapshot {
  return {
    pid: 1234,
    startedAt: Date.now(),
    heartbeatNextAt: 0,
    settings: {
      apiToken: undefined,
      heartbeat: { enabled: false, interval: 30, prompt: "" },
      security: {},
      telegram: { token: "", allowedUserIds: [] },
      discord: { token: "", allowedUserIds: [] },
      web: { enabled: true, host: "127.0.0.1", port: 0 },
    } as unknown as WebSnapshot["settings"],
    jobs: [],
  };
}

let handle: WebServerHandle;
let base: string;

beforeAll(async () => {
  await mkdir(SETTINGS_DIR, { recursive: true });
  if (existsSync(SETTINGS_FILE)) await copyFile(SETTINGS_FILE, BACKUP_FILE);
  await writeFile(SETTINGS_FILE, `${JSON.stringify({}, null, 2)}\n`);

  handle = startWebUi({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    getSnapshot: snapshot,
  });
  base = `http://${handle.host}:${handle.port}`;
});

afterAll(async () => {
  handle.stop();
  __setLlmRouterCatalogueForTests(null);
  if (existsSync(BACKUP_FILE)) {
    await copyFile(BACKUP_FILE, SETTINGS_FILE);
    await unlink(BACKUP_FILE);
  } else if (existsSync(SETTINGS_FILE)) {
    await unlink(SETTINGS_FILE);
  }
});

beforeEach(async () => {
  await writeFile(SETTINGS_FILE, `${JSON.stringify({}, null, 2)}\n`);
});

const auth = { Authorization: `Bearer ${TOKEN}` };

async function csrf(): Promise<{ token: string; cookie: string }> {
  const res = await fetch(`${base}/api/csrf-token`, { headers: auth });
  const data = (await res.json()) as { token: string };
  const cookie = res.headers.get("set-cookie") ?? "";
  return { token: data.token, cookie };
}

describe("/api/settings/llm-router", () => {
  it("GET returns empty tiers + default base on a fresh settings.json", async () => {
    const res = await fetch(`${base}/api/settings/llm-router`, { headers: auth });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      llmRouter: { tiers: Record<string, string[]>; openRouterBaseUrl: string };
    };
    expect(data.ok).toBe(true);
    expect(data.llmRouter.tiers).toEqual({ fast: [], balanced: [], reasoning: [] });
    expect(data.llmRouter.openRouterBaseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("POST patches tiers and survives a round-trip", async () => {
    const { token, cookie } = await csrf();
    const res = await fetch(`${base}/api/settings/llm-router`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
        Cookie: cookie,
      },
      body: JSON.stringify({ tiers: { fast: ["groq/llama"], reasoning: ["anthropic/opus"] } }),
    });
    const data = (await res.json()) as {
      ok: boolean;
      llmRouter: { tiers: Record<string, string[]> };
    };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.llmRouter.tiers.fast).toEqual(["groq/llama"]);
    expect(data.llmRouter.tiers.reasoning).toEqual(["anthropic/opus"]);

    const round = await fetch(`${base}/api/settings/llm-router`, { headers: auth });
    const back = (await round.json()) as { llmRouter: { tiers: Record<string, string[]> } };
    expect(back.llmRouter.tiers.fast).toEqual(["groq/llama"]);
  });

  it("POST without any tier keys rejects with 400", async () => {
    const { token, cookie } = await csrf();
    const res = await fetch(`${base}/api/settings/llm-router`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
        Cookie: cookie,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("/api/llm-router/models", () => {
  beforeAll(() => {
    // Inject a fake catalogue so the route doesn't try to reach OpenRouter.
    const stub = {
      async search(params: { query?: string }) {
        const all = [
          {
            id: "anthropic/claude-opus",
            name: "Claude Opus",
            context_length: 200000,
            pricing: { prompt: 0.000015, completion: 0.000075 },
          },
          {
            id: "groq/llama-3",
            name: "Llama 3",
            context_length: 8192,
            pricing: { prompt: 0.0000001, completion: 0.0000001 },
          },
        ];
        const q = params.query?.toLowerCase();
        return {
          models: q ? all.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)) : all,
          cachedAt: 1000,
        };
      },
    };
    __setLlmRouterCatalogueForTests(stub as unknown as ModelCatalogue);
  });

  it("503s when OPENROUTER_API_KEY is not set", async () => {
    const prior = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const res = await fetch(`${base}/api/llm-router/models?query=claude`, { headers: auth });
      expect(res.status).toBe(503);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/OPENROUTER_API_KEY/);
    } finally {
      if (prior !== undefined) process.env.OPENROUTER_API_KEY = prior;
    }
  });

  it("proxies the catalogue search when the key is set", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    try {
      const res = await fetch(`${base}/api/llm-router/models?query=claude`, { headers: auth });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; models: Array<{ id: string }> };
      expect(data.ok).toBe(true);
      expect(data.models.map((m) => m.id)).toEqual(["anthropic/claude-opus"]);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});
