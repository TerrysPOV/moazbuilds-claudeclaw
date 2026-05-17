/**
 * Tests for skills-tuner SlackAdapter.
 *
 * Run with: bun test src/__tests__/skills-tuner/slack-adapter.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { SlackAdapter, type SlackAdapterConfig } from "../../skills-tuner/adapters/slack";
import type { Proposal } from "../../skills-tuner/core/types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 42,
    cluster_id: "cluster-1",
    subject: "skills",
    kind: "create",
    target_path: "/home/user/.claude/skills/foo.md",
    alternatives: [
      { id: "a", label: "Tight option", diff_or_content: "x", tradeoff: "fast but terse" },
      { id: "b", label: "Verbose option", diff_or_content: "y", tradeoff: "longer but clearer" },
    ],
    pattern_signature: "sig-1",
    created_at: new Date("2026-05-17T00:00:00Z"),
    signature: "test-signature",
    ...overrides,
  } as Proposal;
}

function makeConfig(overrides: Partial<SlackAdapterConfig> = {}): SlackAdapterConfig {
  return {
    botToken: "xoxb-test-token",
    channelId: "C0123456",
    baseUrl: "https://slack.test/api",
    allowedUserIds: ["U_ALICE", "U_BOB"],
    ...overrides,
  };
}

// fetch mock — captures calls and returns canned responses
type CapturedCall = { url: string; init?: RequestInit };
let capturedCalls: CapturedCall[];
let nextResponse: { ok: boolean; status: number; body: string };
const origFetch = globalThis.fetch;

beforeEach(() => {
  capturedCalls = [];
  nextResponse = { ok: true, status: 200, body: '{"ok":true,"ts":"1700000000.000100"}' };
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    capturedCalls.push({ url: url.toString(), init });
    return new Response(nextResponse.body, { status: nextResponse.status });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

// ─── Constructor ─────────────────────────────────────────────────────────────

describe("SlackAdapter constructor", () => {
  it("rejects empty allowedUserIds", () => {
    expect(() => new SlackAdapter(makeConfig({ allowedUserIds: [] }))).toThrow(
      /at least one allowedUserId/,
    );
  });

  it("rejects missing botToken", () => {
    expect(() => new SlackAdapter(makeConfig({ botToken: "" }))).toThrow(/requires botToken/);
  });

  it("rejects missing channelId", () => {
    expect(() => new SlackAdapter(makeConfig({ channelId: "" }))).toThrow(/requires channelId/);
  });

  it("accepts valid config", () => {
    expect(() => new SlackAdapter(makeConfig())).not.toThrow();
  });
});

// ─── renderProposal ──────────────────────────────────────────────────────────

describe("SlackAdapter.renderProposal", () => {
  it("posts to /chat.postMessage with Bearer auth header", async () => {
    const adapter = new SlackAdapter(makeConfig());
    await adapter.renderProposal(makeProposal());
    expect(capturedCalls).toHaveLength(1);
    const call = capturedCalls[0]!;
    expect(call.url).toBe("https://slack.test/api/chat.postMessage");
    const headers = (call.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-test-token");
    expect(headers["Content-Type"]).toBe("application/json; charset=utf-8");
  });

  it("never embeds botToken in the URL", async () => {
    const adapter = new SlackAdapter(makeConfig());
    await adapter.renderProposal(makeProposal());
    expect(capturedCalls[0]!.url).not.toContain("xoxb-test-token");
  });

  it("builds an Apply button per alternative + Refuse/Edit + correct channel + text fallback", async () => {
    const adapter = new SlackAdapter(makeConfig());
    await adapter.renderProposal(makeProposal());
    const body = JSON.parse(capturedCalls[0]!.init?.body as string);
    expect(body.channel).toBe("C0123456");
    expect(body.text).toContain("Proposal #42");
    expect(body.blocks).toHaveLength(2);
    expect(body.blocks[0].type).toBe("section");
    expect(body.blocks[1].type).toBe("actions");
    const elements = body.blocks[1].elements;
    // 2 alternatives + Refuse + Edit = 4 buttons
    expect(elements).toHaveLength(4);
    expect(elements[0].value).toBe("apply:42:a");
    expect(elements[1].value).toBe("apply:42:b");
    expect(elements[2].value).toBe("refuse:42");
    expect(elements[3].value).toBe("edit:42");
  });

  it("uses primary style on Apply and danger on Refuse", async () => {
    const adapter = new SlackAdapter(makeConfig());
    await adapter.renderProposal(makeProposal());
    const body = JSON.parse(capturedCalls[0]!.init?.body as string);
    const elements = body.blocks[1].elements;
    expect(elements[0].style).toBe("primary");
    expect(elements[1].style).toBe("primary");
    expect(elements[2].style).toBe("danger");
    expect(elements[3].style).toBeUndefined();
  });

  it("truncates button text exceeding Slack's 75-char limit", async () => {
    const adapter = new SlackAdapter(makeConfig());
    const longLabel = "x".repeat(200);
    await adapter.renderProposal(
      makeProposal({
        alternatives: [{ id: "a", label: longLabel, diff_or_content: "", tradeoff: "" }],
      }),
    );
    const body = JSON.parse(capturedCalls[0]!.init?.body as string);
    const text: string = body.blocks[1].elements[0].text.text;
    expect(text.length).toBeLessThanOrEqual(75);
  });

  it("throws on HTTP failure", async () => {
    nextResponse = { ok: false, status: 401, body: "invalid_auth" };
    const adapter = new SlackAdapter(makeConfig());
    await expect(adapter.renderProposal(makeProposal())).rejects.toThrow(
      /Slack chat\.postMessage failed: 401/,
    );
  });

  it("throws on Slack API error returned with HTTP 200", async () => {
    nextResponse = { ok: true, status: 200, body: '{"ok":false,"error":"channel_not_found"}' };
    const adapter = new SlackAdapter(makeConfig());
    await expect(adapter.renderProposal(makeProposal())).rejects.toThrow(/channel_not_found/);
  });

  it("does not leak the botToken in error messages", async () => {
    nextResponse = { ok: false, status: 500, body: "some error" };
    const adapter = new SlackAdapter(makeConfig({ botToken: "xoxb-secret-token-do-not-leak" }));
    let err: Error | null = null;
    try {
      await adapter.renderProposal(makeProposal());
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain("xoxb-secret-token-do-not-leak");
  });
});

// ─── handleCallback ──────────────────────────────────────────────────────────

describe("SlackAdapter.handleCallback", () => {
  it("rejects users not in allowedUserIds", async () => {
    const adapter = new SlackAdapter(makeConfig());
    await expect(adapter.handleCallback("apply:1:a", "U_EVE")).rejects.toThrow(
      /not in allowedUserIds/,
    );
  });

  it("accepts users in allowedUserIds and fires callback", async () => {
    const seen: { proposalId: number; alternativeId?: string; action: string }[] = [];
    const adapter = new SlackAdapter(
      makeConfig({
        callbackHandler: async (p) => {
          seen.push(p);
        },
      }),
    );
    await adapter.handleCallback("apply:42:a", "U_ALICE");
    expect(seen).toEqual([{ proposalId: 42, alternativeId: "a", action: "apply" }]);
  });

  it("rejects malformed action value", async () => {
    const adapter = new SlackAdapter(makeConfig());
    await expect(adapter.handleCallback("malformed", "U_ALICE")).rejects.toThrow(
      /Slack callback malformed/,
    );
  });

  it("rejects unknown action verb", async () => {
    const adapter = new SlackAdapter(makeConfig());
    await expect(adapter.handleCallback("destroy:1", "U_ALICE")).rejects.toThrow(/unknown action/);
  });

  it("rejects non-numeric proposalId", async () => {
    const adapter = new SlackAdapter(makeConfig());
    await expect(adapter.handleCallback("apply:abc:x", "U_ALICE")).rejects.toThrow(
      /invalid proposalId/,
    );
  });

  it("rejects proposalId < 1", async () => {
    const adapter = new SlackAdapter(makeConfig());
    await expect(adapter.handleCallback("apply:0:x", "U_ALICE")).rejects.toThrow(
      /invalid proposalId/,
    );
  });

  it("calls verifyProposalFn before firing callback when provided", async () => {
    let verified: number | null = null;
    let callbackFired = false;
    const adapter = new SlackAdapter(
      makeConfig({
        verifyProposalFn: async (id) => {
          verified = id;
          return true;
        },
        callbackHandler: async () => {
          callbackFired = true;
        },
      }),
    );
    await adapter.handleCallback("apply:42:a", "U_ALICE");
    expect(verified).toBe(42);
    expect(callbackFired).toBe(true);
  });

  it("blocks the callback when verifyProposalFn returns false", async () => {
    let callbackFired = false;
    const adapter = new SlackAdapter(
      makeConfig({
        verifyProposalFn: async () => false,
        callbackHandler: async () => {
          callbackFired = true;
        },
      }),
    );
    await expect(adapter.handleCallback("apply:42:a", "U_ALICE")).rejects.toThrow(
      /verifyProposalFn rejected/,
    );
    expect(callbackFired).toBe(false);
  });

  it("parses refuse without alternativeId", async () => {
    const seen: { proposalId: number; alternativeId?: string; action: string }[] = [];
    const adapter = new SlackAdapter(
      makeConfig({
        callbackHandler: async (p) => {
          seen.push(p);
        },
      }),
    );
    await adapter.handleCallback("refuse:42", "U_ALICE");
    expect(seen[0]).toEqual({ proposalId: 42, alternativeId: undefined, action: "refuse" });
  });
});

// ─── formatProposalText ──────────────────────────────────────────────────────

describe("SlackAdapter.formatProposalText", () => {
  it("includes proposal id, subject/kind, target path, alternatives", () => {
    const adapter = new SlackAdapter(makeConfig());
    const txt = adapter.formatProposalText(makeProposal());
    expect(txt).toContain("Proposal #42");
    expect(txt).toContain("skills/create");
    expect(txt).toContain("/home/user/.claude/skills/foo.md");
    expect(txt).toContain("Tight option");
    expect(txt).toContain("Verbose option");
  });

  it("substitutes 'no tradeoff' when tradeoff is empty", () => {
    const adapter = new SlackAdapter(makeConfig());
    const txt = adapter.formatProposalText(
      makeProposal({
        alternatives: [{ id: "a", label: "Plain", diff_or_content: "", tradeoff: "" }],
      }),
    );
    expect(txt).toContain("no tradeoff");
  });
});
