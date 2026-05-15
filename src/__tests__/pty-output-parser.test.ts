import { describe, test, expect } from "bun:test";
import { join } from "path";
import {
  createParser,
  feed,
  stripAnsi,
  normaliseNewlines,
  extractResponseText,
  decodeTurn,
  PROGRESS_MARKERS,
} from "../runner/pty-output-parser";

const FIXTURE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  ".planning",
  "pty-migration",
  "fixtures",
  "turn-boundary-sample.txt",
);

// ─── Fixture-driven golden tests ─────────────────────────────────────────────

describe("pty-output-parser — golden fixture", () => {
  test("detects exactly 2 turn boundaries with pre-init END ignored", async () => {
    const bytes = await Bun.file(FIXTURE_PATH).bytes();
    const parser = createParser();
    const events = feed(parser, bytes);

    const starts = events.filter((e) => e.type === "turn-start");
    const ends = events.filter((e) => e.type === "turn-end");

    expect(starts.length).toBe(2);
    expect(ends.length).toBe(2);

    // The fixture contains 3 raw progress-END markers; the FIRST is the
    // pre-turn TUI init `]9;4;0;` and MUST be ignored. The two emitted ENDs
    // are the actual turn boundaries.
    const startOffsets = starts.map((e) => e.offset);
    const endOffsets = ends.map((e) => e.offset);

    expect(startOffsets).toEqual([5530, 16879]);
    expect(endOffsets).toEqual([16452, 26387]);
  });

  test("turn 1 response contains 'ack'", async () => {
    const bytes = await Bun.file(FIXTURE_PATH).bytes();
    // From start of turn 1 (after the START marker) to the END marker.
    const turn1Start = 5530 + PROGRESS_MARKERS.start.length;
    const turn1End = 16452;
    const slice = bytes.slice(turn1Start, turn1End);
    const { text } = decodeTurn(slice);
    expect(text.toLowerCase()).toContain("ack");
  });

  test("turn 2 response contains 'goodbye'", async () => {
    const bytes = await Bun.file(FIXTURE_PATH).bytes();
    const turn2Start = 16879 + PROGRESS_MARKERS.start.length;
    const turn2End = 26387;
    const slice = bytes.slice(turn2Start, turn2End);
    const { text } = decodeTurn(slice);
    expect(text.toLowerCase()).toContain("goodbye");
  });

  test("feeding fixture byte-by-byte produces same events as one-shot", async () => {
    const bytes = await Bun.file(FIXTURE_PATH).bytes();
    const parser = createParser();
    const events: ReturnType<typeof feed> = [];
    // Walk byte-by-byte to prove the carryover logic is sound.
    for (let i = 0; i < bytes.length; i++) {
      const chunk = bytes.slice(i, i + 1);
      events.push(...feed(parser, chunk));
    }
    expect(events.filter((e) => e.type === "turn-start").length).toBe(2);
    expect(events.filter((e) => e.type === "turn-end").length).toBe(2);
  });

  test("feeding fixture in odd-sized chunks (7 bytes) is identical to one-shot", async () => {
    const bytes = await Bun.file(FIXTURE_PATH).bytes();
    const parser = createParser();
    const events: ReturnType<typeof feed> = [];
    for (let i = 0; i < bytes.length; i += 7) {
      events.push(...feed(parser, bytes.slice(i, i + 7)));
    }
    const starts = events.filter((e) => e.type === "turn-start");
    const ends = events.filter((e) => e.type === "turn-end");
    expect(starts.map((e) => e.offset)).toEqual([5530, 16879]);
    expect(ends.map((e) => e.offset)).toEqual([16452, 26387]);
  });
});

// ─── Synthetic-input tests ───────────────────────────────────────────────────

describe("pty-output-parser — synthetic", () => {
  test("ignores pre-turn END marker (working=false on first END)", () => {
    const parser = createParser();
    const events = feed(parser, PROGRESS_MARKERS.end);
    expect(events).toEqual([]);
    expect(parser.working).toBe(false);
  });

  test("simple START → text → END flow", () => {
    const parser = createParser();
    const enc = new TextEncoder();
    const events: ReturnType<typeof feed> = [];

    events.push(...feed(parser, PROGRESS_MARKERS.start));
    expect(parser.working).toBe(true);

    events.push(...feed(parser, enc.encode("hello, world.\r\n")));
    expect(parser.working).toBe(true);

    events.push(...feed(parser, PROGRESS_MARKERS.end));
    expect(parser.working).toBe(false);

    expect(events.filter((e) => e.type === "turn-start").length).toBe(1);
    expect(events.filter((e) => e.type === "turn-end").length).toBe(1);
  });

  test("nested START events while already working are ignored", () => {
    const parser = createParser();
    const events: ReturnType<typeof feed> = [];
    events.push(...feed(parser, PROGRESS_MARKERS.start));
    events.push(...feed(parser, PROGRESS_MARKERS.start)); // duplicate START
    events.push(...feed(parser, PROGRESS_MARKERS.end));
    expect(events.filter((e) => e.type === "turn-start").length).toBe(1);
    expect(events.filter((e) => e.type === "turn-end").length).toBe(1);
  });

  test("marker spanning chunk boundary is detected", () => {
    const parser = createParser();
    // Split the START marker across two feeds.
    const split = 4;
    feed(parser, PROGRESS_MARKERS.start.slice(0, split));
    const events = feed(parser, PROGRESS_MARKERS.start.slice(split));
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("turn-start");
  });
});

// ─── ANSI strip + response extraction ────────────────────────────────────────

describe("stripAnsi", () => {
  test("strips CSI sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
    expect(stripAnsi("\x1b[1;31;47mboth\x1b[m")).toBe("both");
  });

  test("strips OSC sequences (BEL terminator)", () => {
    expect(stripAnsi("\x1b]0;window title\x07after")).toBe("after");
  });

  test("strips OSC sequences (ESC backslash terminator)", () => {
    expect(stripAnsi("\x1b]0;title\x1b\\after")).toBe("after");
  });

  test("preserves emoji and box-drawing characters", () => {
    const input = "\x1b[32mhello 🌟 ─── ⏺ack box: ┌─┐ │ │ └─┘\x1b[0m";
    const out = stripAnsi(input);
    expect(out).toBe("hello 🌟 ─── ⏺ack box: ┌─┐ │ │ └─┘");
  });

  test("preserves Unicode multi-byte characters around stripped sequences", () => {
    const input = "日本語 \x1b[1mtext\x1b[0m 中文";
    expect(stripAnsi(input)).toBe("日本語 text 中文");
  });
});

describe("normaliseNewlines", () => {
  test("converts CRLF to LF and drops bare CR", () => {
    expect(normaliseNewlines("a\r\nb\rc\nd")).toBe("a\nbc\nd");
  });
});

describe("extractResponseText", () => {
  test("extracts text after ⏺ and before terminator sigil", () => {
    const text = "garbage\n⏺hello world✻ Worked for 2s\n more";
    expect(extractResponseText(text)).toBe("hello world");
  });

  test("handles ⏺ with leading space", () => {
    const text = "garbage\n⏺ hello world✻ Worked for 2s";
    expect(extractResponseText(text)).toBe("hello world");
  });

  test("uses the LAST ⏺ (response area, not echoed prompt)", () => {
    const text = "⏺nope ✻done\n⏺yes✻";
    expect(extractResponseText(text)).toBe("yes");
  });

  test("falls back to whole text when ⏺ absent", () => {
    expect(extractResponseText("  some text  ")).toBe("some text");
  });

  // Codex Phase D #4 regression: a literal `❯` inside the assistant response
  // (e.g. a shell-prompt example) must NOT split the response. Spinner glyphs
  // remain the only terminators.
  test("does not truncate when response contains a literal `❯` glyph", () => {
    const text =
      "⏺ Try running `❯ bun install` in your shell and then re-run the build.✻ Worked for 1s";
    expect(extractResponseText(text)).toBe(
      "Try running `❯ bun install` in your shell and then re-run the build.",
    );
  });

  test("does not truncate when `❯` appears mid-sentence without a spinner", () => {
    // No spinner terminator — should return the whole post-⏺ tail trimmed.
    const text = "⏺ The prompt looked like `user@host ❯` when I tested it.";
    expect(extractResponseText(text)).toBe(
      "The prompt looked like `user@host ❯` when I tested it.",
    );
  });
});

// ─── Idle-timeout fallback (parser-level decision, used by pty-process) ──────

describe("idle-timeout fallback", () => {
  test("when no END marker arrives, working stays true (consumer must time out)", () => {
    const parser = createParser();
    const enc = new TextEncoder();
    feed(parser, PROGRESS_MARKERS.start);
    feed(parser, enc.encode("a".repeat(500)));
    // No END marker. Parser remains in `working = true` state.
    expect(parser.working).toBe(true);
    // The IDLE TIMEOUT itself is implemented in pty-process.ts (driven by
    // an injectable clock); the parser only owns the OSC detection. This test
    // documents that contract.
  });
});
