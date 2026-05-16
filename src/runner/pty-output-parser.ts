/**
 * PTY output parser for Claude Code's interactive TUI.
 *
 * Detects turn boundaries via OSC progress sequences (see SPEC §2):
 *   - Progress START: `ESC ] 9 ; 4 ; 3 ; BEL`  (Claude began a turn)
 *   - Progress END:   `ESC ] 9 ; 4 ; 0 ; BEL`  (Claude finished a turn)
 *
 * The parser is a pure stateful function over the byte stream. It maintains a
 * single `working: boolean` flag. The first `progress-end` while `working ===
 * false` is ignored (fires once at TUI init before any prompt). Each subsequent
 * `progress-end` while `working === true` flips `working` back to false and
 * emits a `turn-complete` event.
 *
 * NO I/O, NO globals, NO side effects beyond the `Parser` instance.
 *
 * Pure-function shim: `feed(parser, chunkBytes)` returns the events produced
 * by that chunk; callers maintain the parser instance externally.
 */

/** OSC progress-start sequence as raw bytes. */
const PROGRESS_START_BYTES = new Uint8Array([0x1b, 0x5d, 0x39, 0x3b, 0x34, 0x3b, 0x33, 0x3b, 0x07]);
/** OSC progress-end sequence as raw bytes. */
const PROGRESS_END_BYTES = new Uint8Array([0x1b, 0x5d, 0x39, 0x3b, 0x34, 0x3b, 0x30, 0x3b, 0x07]);
/** Max sequence length we might be straddling across chunks. */
const MAX_MARKER_LEN = Math.max(PROGRESS_START_BYTES.length, PROGRESS_END_BYTES.length);

/** Event types emitted by the parser. */
export type ParserEvent =
  | { type: "turn-start"; offset: number }
  | { type: "turn-end"; offset: number };

/** Public parser state. Callers create one per PTY session. */
export interface Parser {
  /** True while we are between a turn-start and the matching turn-end. */
  working: boolean;
  /** Number of bytes seen across the entire stream so far. */
  totalBytes: number;
  /** Carry-over bytes from the end of the previous chunk that might begin a
   *  marker sequence. At most MAX_MARKER_LEN - 1 bytes. */
  pending: Uint8Array;
  /** Number of bytes from the underlying stream that `pending` represents
   *  (so reported offsets line up with the stream, not the search buffer). */
  pendingBaseOffset: number;
}

/** Create a fresh parser. */
export function createParser(): Parser {
  return {
    working: false,
    totalBytes: 0,
    pending: new Uint8Array(0),
    pendingBaseOffset: 0,
  };
}

/**
 * Feed a chunk of raw PTY bytes through the parser. Returns any boundary
 * events produced by this chunk, in order.
 *
 * Offsets in events are absolute byte offsets within the cumulative stream
 * (i.e. measured from the very first byte fed to this parser instance), and
 * point to the FIRST byte of the matched OSC marker (the `ESC` byte).
 */
export function feed(parser: Parser, chunk: Uint8Array): ParserEvent[] {
  const events: ParserEvent[] = [];
  if (chunk.length === 0) return events;

  // Combine pending carryover with new chunk into a single search window.
  const search = new Uint8Array(parser.pending.length + chunk.length);
  search.set(parser.pending, 0);
  search.set(chunk, parser.pending.length);
  const searchBase = parser.pendingBaseOffset;

  let i = 0;
  while (i <= search.length - MAX_MARKER_LEN) {
    if (search[i] === 0x1b) {
      if (matchAt(search, i, PROGRESS_START_BYTES)) {
        const absOffset = searchBase + i;
        if (!parser.working) {
          parser.working = true;
          events.push({ type: "turn-start", offset: absOffset });
        }
        i += PROGRESS_START_BYTES.length;
        continue;
      }
      if (matchAt(search, i, PROGRESS_END_BYTES)) {
        const absOffset = searchBase + i;
        if (parser.working) {
          parser.working = false;
          events.push({ type: "turn-end", offset: absOffset });
        }
        // If !working: this is a pre-turn TUI-init `]9;4;0;` — ignored.
        i += PROGRESS_END_BYTES.length;
        continue;
      }
    }
    i++;
  }

  // Any tail bytes that could be the prefix of a marker stay as carryover.
  // We keep at most MAX_MARKER_LEN - 1 bytes.
  const carryStart = Math.max(0, search.length - (MAX_MARKER_LEN - 1));
  parser.pending = search.slice(carryStart);
  parser.pendingBaseOffset = searchBase + carryStart;
  parser.totalBytes = searchBase + search.length;

  return events;
}

/** True iff `needle` matches `haystack` starting at `start`. */
function matchAt(haystack: Uint8Array, start: number, needle: Uint8Array): boolean {
  if (start + needle.length > haystack.length) return false;
  for (let j = 0; j < needle.length; j++) {
    if (haystack[start + j] !== needle[j]) return false;
  }
  return true;
}

// ─── Response-text extraction ────────────────────────────────────────────────

/**
 * Strip ANSI control sequences from text. Removes:
 *   - OSC sequences:  ESC ] ... (BEL | ESC \)
 *   - CSI sequences:  ESC [ ... <final byte 0x40-0x7E>
 *   - Solo ESC bytes (defensive)
 *
 * Preserves all non-ANSI Unicode (emoji, box-drawing, CJK, etc.).
 */
export function stripAnsi(text: string): string {
  // OSC: ESC ] ... terminator (BEL or ESC \)
  // CSI/ESC[: ESC [ <params/intermediates>* <final byte>
  // Catch-all single ESC: drop it.
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI/OSC escape sequences require control bytes.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI escape stripper.
      .replace(/\x1b\[[?0-9;]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI charset-select escape stripper.
      .replace(/\x1b[()][0-9A-Za-z]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: catch-all ESC byte stripper.
      .replace(/\x1b/g, "")
  );
}

/**
 * Normalise carriage returns. PTYs emit CRLF; we convert `\r\n` → `\n` and
 * drop bare `\r` carriage returns.
 */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

/**
 * Extract the assistant's response text from a stripped-and-normalised turn
 * buffer.
 *
 * The TUI renders the assistant message prefixed with the `⏺` glyph (U+23FA),
 * sometimes followed by a space, sometimes not. After the response, the TUI
 * draws a "working" sigil from this set: ✻ ✶ ✳ ✢ ✽ ✺ ✷ · ◉ ❯.
 *
 * Algorithm (SPEC §2):
 *   1. Find the last occurrence of `⏺` in the buffer.
 *   2. Take text from just after `⏺` (and optional leading space) up to the
 *      first occurrence of any of the terminator sigils.
 *   3. Trim whitespace; if empty, fall back to the whole stripped buffer.
 */
export function extractResponseText(strippedNormalised: string): string {
  const marker = "⏺"; // ⏺
  // Terminators that immediately follow the assistant text in the TUI.
  // We INTENTIONALLY do not include "❯" alone — its presence elsewhere on the
  // screen (e.g. a literal `❯` appearing inside Claude's own response text,
  // such as a shell-prompt example) would split the response too early. The
  // spinner glyphs that always appear right after the assistant message are
  // sufficient to anchor the turn boundary.
  const terminatorRe = /[✻✶✳✢✽✺✷·◉]| {2,}⎿/u;
  const idx = strippedNormalised.lastIndexOf(marker);
  if (idx < 0) return strippedNormalised.trim();

  let after = strippedNormalised.slice(idx + marker.length);
  // Drop a single leading space if present.
  if (after.startsWith(" ")) after = after.slice(1);

  const termMatch = after.match(terminatorRe);
  const body = termMatch ? after.slice(0, termMatch.index) : after;
  const trimmed = body.trim();
  if (trimmed.length > 0) return trimmed;
  return strippedNormalised.trim();
}

/**
 * Convenience: take a raw byte slice (the bytes seen between a TURN_START and
 * its matching TURN_END), strip ANSI, normalise newlines, extract response.
 */
export function decodeTurn(rawBytes: Uint8Array): {
  stripped: string;
  text: string;
} {
  const decoded = new TextDecoder("utf-8").decode(rawBytes);
  const stripped = normaliseNewlines(stripAnsi(decoded));
  const text = extractResponseText(stripped);
  return { stripped, text };
}

/** Re-exports of the byte sequences in case callers want to detect them. */
export const PROGRESS_MARKERS = {
  start: PROGRESS_START_BYTES,
  end: PROGRESS_END_BYTES,
} as const;
