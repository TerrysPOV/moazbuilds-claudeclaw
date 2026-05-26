import { describe, expect, it } from "bun:test";
import { flattenChannelMeta } from "../mcp-server";

describe("flattenChannelMeta (#169 — Discord attachment metadata)", () => {
  it("passes primitives (string / number / boolean) through unchanged", () => {
    const out = flattenChannelMeta({
      origin: "discord",
      origin_id: "channel-123",
      message_id: "msg-456",
      size: 4096,
      isDM: true,
    });
    expect(out).toEqual({
      origin: "discord",
      origin_id: "channel-123",
      message_id: "msg-456",
      size: 4096,
      isDM: true,
    });
  });

  it("JSON-stringifies nested objects so they don't render as [object Object]", () => {
    // Shape from src/adapters/discord/index.ts:286 — the real production
    // metadata payload that triggered the bug.
    const out = flattenChannelMeta({
      origin: "discord",
      origin_id: "channel-123",
      attachments: {
        images: [{ filename: "screenshot.png", url: "https://cdn..." }],
        voices: [],
        texts: [],
      },
    });
    expect(typeof out.attachments).toBe("string");
    const parsed = JSON.parse(out.attachments as string);
    expect(parsed.images[0].filename).toBe("screenshot.png");
    expect(parsed.images[0].url).toBe("https://cdn...");
    expect(parsed.voices).toEqual([]);
    expect(out.attachments).not.toBe("[object Object]");
  });

  it("JSON-stringifies arrays", () => {
    const out = flattenChannelMeta({ tags: ["urgent", "billing"] });
    expect(typeof out.tags).toBe("string");
    expect(JSON.parse(out.tags as string)).toEqual(["urgent", "billing"]);
  });

  it("JSON-stringifies null (rather than dropping it)", () => {
    const out = flattenChannelMeta({ parent_message_id: null });
    expect(out.parent_message_id).toBe("null");
  });

  it("drops undefined values entirely", () => {
    const out = flattenChannelMeta({ origin: "discord", parent_message_id: undefined });
    expect(out).toEqual({ origin: "discord" });
    expect("parent_message_id" in out).toBe(false);
  });

  it("handles unserializable values without throwing", () => {
    // Circular reference — JSON.stringify throws TypeError; we fall back to
    // "[unserializable]" rather than crashing the whole prompt delivery.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = flattenChannelMeta({ origin: "discord", circular });
    expect(out.origin).toBe("discord");
    expect(out.circular).toBe("[unserializable]");
  });

  it("preserves empty-object input → empty-object output", () => {
    expect(flattenChannelMeta({})).toEqual({});
  });
});
