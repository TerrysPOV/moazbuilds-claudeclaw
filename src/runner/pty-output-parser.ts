/**
 * PTY output parser for Claude Code's interactive TUI (claude 2.1.89+).
 *
 * ─── Why a sentinel-echo round-trip ──────────────────────────────────────────
 *
 * Earlier claude versions emitted OSC 9;4 ("ConEmu progress") sequences around
 * each turn — START before processing, END when done. Claude 2.1.89 dropped
 * those markers and only emits OSC 0 (set window title) with spinner glyphs,
 * which are unreliable for turn-boundary detection. See issue #81.
 *
 * The new model uses a **sentinel-echo round-trip**:
 *
 *   1. Supervisor writes the user prompt + `\r` (Enter) to the PTY.
 *   2. Parser transitions `idle → accumulating` and buffers every byte after
 *      the prompt-write offset.
 *   3. Whenever the byte stream goes quiet for `quietWindowMs` (default 500),
 *      the parser emits a `quiet` event. The supervisor reacts by writing a
 *      unique sentinel string (no `\r`) into the PTY.
 *   4. claude's TUI is in raw mode — it echoes our sentinel bytes back into
 *      its own stdout (visible as "user typing into prompt area"). When the
 *      parser sees that echo, it emits `sentinel-found` and the turn is
 *      complete. The response bytes are the slice from `turn-start.offset` up
 *      to (but not including) `sentinel-found.offset`.
 *   5. Supervisor sends cleanup bytes (backspaces × sentinel length) to clear
 *      claude's in-progress input buffer before the next turn.
 *
 * The sentinel format `<<<CCAW_TURN_END_<uuid>>>>` is pure printable ASCII so
 * it won't collide with any control codes claude emits, and a fresh UUID per
 * turn guarantees a stale sentinel from an aborted turn can never match the
 * next turn. To defend against the (vanishing) chance of claude literally
 * producing the sentinel string in response text, we scan ONLY new bytes
 * after each chunk arrives — the supervisor writes the sentinel only AFTER
 * the `quiet` event fires, so the echo always lands strictly after that
 * boundary.
 *
 * ─── Event model ─────────────────────────────────────────────────────────────
 *
 * The parser is a pure state machine over the byte stream:
 *
 *   idle ─── start(uuid) ──▶ accumulating ─── feed() quiets ──▶ awaiting-sentinel
 *                                                            ◀── feed() (more bytes) ──╮
 *                                                                                     │
 *                                                                  awaiting-sentinel ─┘
 *                                                                          │
 *                                                                  sentinel echoed
 *                                                                          ▼
 *                                                                       complete
 *
 * Events:
 *   - `turn-start`     — synchronous emit from `startTurn()` at the offset of
 *                        the first response byte (everything before the offset
 *                        is pre-turn TUI noise the parser ignores).
 *   - `quiet`          — emitted by `tick(now)` when no bytes have arrived for
 *                        `quietWindowMs`. Supervisor reacts by writing the
 *                        sentinel.
 *   - `sentinel-found` — emitted by `feed()` when the sentinel string appears
 *                        in the accumulated bytes. Carries the offset of the
 *                        FIRST byte of the matched sentinel.
 *
 * NO I/O, NO globals, NO side effects beyond the `Parser` instance. The
 * supervisor (pty-process.ts) drives I/O.
 */

/** Quiet window before the supervisor writes the sentinel. Default 500ms. */
export const DEFAULT_QUIET_WINDOW_MS = 500;

/** State of the parser. */
export type ParserState = "idle" | "accumulating" | "awaiting-sentinel" | "complete";

/** Event types emitted by the parser. */
export type ParserEvent =
  | { type: "turn-start"; offset: number }
  | { type: "quiet"; offset: number }
  | { type: "sentinel-found"; offset: number; uuid: string };

/** Public parser state. Callers create one per turn (call `resetTurn`). */
export interface Parser {
  state: ParserState;
  /** UUID of the active turn's sentinel; empty when idle/complete. */
  uuid: string;
  /** Encoded sentinel bytes for the active turn (the string we wrote and are
   *  scanning for in the echo). */
  sentinelBytes: Uint8Array;
  /** Number of bytes seen across the entire stream so far. */
  totalBytes: number;
  /** Byte offset where the active turn started (start of response slice). */
  turnStartOffset: number;
  /** Byte offset of the sentinel match within the stream (only meaningful
   *  in `complete` state). */
  sentinelOffset: number;
  /** Last time `feed()` was called with a non-empty chunk. ms-epoch (or
   *  whatever the supervisor's clock returns). */
  lastByteAt: number;
  /** Quiet window in ms; supervisor reads this to size its tick interval. */
  quietWindowMs: number;
  /** Whether `quiet` has been emitted for the current accumulation. Reset on
   *  every new byte so the supervisor only writes the sentinel once per
   *  quiet period. */
  quietEmitted: boolean;
  /** Carry-over from previous chunks needed to detect a sentinel that
   *  straddles a chunk boundary. At most `sentinelBytes.length - 1` bytes. */
  pending: Uint8Array;
  /** Stream offset that the first byte of `pending` represents. */
  pendingBaseOffset: number;
}

/** Create a fresh parser instance (in `idle` state). */
export function createParser(opts?: { quietWindowMs?: number }): Parser {
  return {
    state: "idle",
    uuid: "",
    sentinelBytes: new Uint8Array(0),
    totalBytes: 0,
    turnStartOffset: 0,
    sentinelOffset: 0,
    lastByteAt: 0,
    quietWindowMs: opts?.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS,
    quietEmitted: false,
    pending: new Uint8Array(0),
    pendingBaseOffset: 0,
  };
}

/**
 * Begin a new turn. The supervisor calls this immediately after writing the
 * user prompt + `\r` to the PTY. `turnStartOffset` should equal the parser's
 * current `totalBytes` (i.e. the offset of the next byte we expect from
 * claude). `uuid` is a fresh per-turn UUID — the supervisor encodes it into
 * the sentinel string and passes the encoded form via `sentinelBytes`.
 *
 * Returns the `turn-start` event so callers can record the offset.
 */
export function startTurn(
  parser: Parser,
  uuid: string,
  sentinelBytes: Uint8Array,
  now: number,
): ParserEvent {
  parser.state = "accumulating";
  parser.uuid = uuid;
  parser.sentinelBytes = sentinelBytes;
  parser.turnStartOffset = parser.totalBytes;
  parser.sentinelOffset = 0;
  parser.lastByteAt = now;
  parser.quietEmitted = false;
  parser.pending = new Uint8Array(0);
  parser.pendingBaseOffset = parser.totalBytes;
  return { type: "turn-start", offset: parser.turnStartOffset };
}

/**
 * Feed a chunk of raw PTY bytes through the parser. Returns any events
 * produced by this chunk, in order.
 *
 * Offsets in events are absolute byte offsets within the cumulative stream
 * (measured from the very first byte fed to this parser instance), and point
 * to the FIRST byte of the matched sentinel.
 */
export function feed(parser: Parser, chunk: Uint8Array, now: number): ParserEvent[] {
  const events: ParserEvent[] = [];
  if (chunk.length === 0) return events;

  const chunkBaseOffset = parser.totalBytes;
  parser.totalBytes += chunk.length;
  parser.lastByteAt = now;
  parser.quietEmitted = false; // any new byte resets the quiet emitter

  // We only scan for the sentinel after the supervisor has actually written
  // it (state === "awaiting-sentinel"). Until then there's nothing to find,
  // and scanning would risk a false match if claude were to emit our sentinel
  // string in legitimate output before we wrote it (impossible in practice
  // given the fresh UUID, but cheap to enforce).
  if (parser.state !== "awaiting-sentinel") {
    // Drop pending: we're not yet looking for the sentinel.
    parser.pending = new Uint8Array(0);
    parser.pendingBaseOffset = chunkBaseOffset + chunk.length;
    return events;
  }

  // Combine pending carryover (last few bytes of previous chunks) with the
  // new chunk to detect a sentinel that straddles a chunk boundary.
  const search = new Uint8Array(parser.pending.length + chunk.length);
  search.set(parser.pending, 0);
  search.set(chunk, parser.pending.length);
  const searchBase = parser.pendingBaseOffset;

  const matchIdx = indexOfBytes(search, parser.sentinelBytes);
  if (matchIdx >= 0) {
    const absOffset = searchBase + matchIdx;
    parser.state = "complete";
    parser.sentinelOffset = absOffset;
    parser.pending = new Uint8Array(0);
    parser.pendingBaseOffset = chunkBaseOffset + chunk.length;
    events.push({ type: "sentinel-found", offset: absOffset, uuid: parser.uuid });
    return events;
  }

  // No match. Keep the last (sentinelBytes.length - 1) bytes as pending so a
  // sentinel straddling the next chunk boundary still gets caught.
  const keep = Math.max(0, parser.sentinelBytes.length - 1);
  const carryStart = Math.max(0, search.length - keep);
  parser.pending = search.slice(carryStart);
  parser.pendingBaseOffset = searchBase + carryStart;
  return events;
}

/**
 * Tick the parser's quiet timer. The supervisor should call this on a regular
 * interval (e.g. every 50ms). When the parser is in `accumulating` state and
 * `now - lastByteAt >= quietWindowMs`, emits a single `quiet` event so the
 * supervisor knows to write the sentinel. Idempotent within a quiet window —
 * only fires once until a new byte resets `quietEmitted`.
 *
 * Calling `tick` in any other state is a no-op.
 */
export function tick(parser: Parser, now: number): ParserEvent[] {
  if (parser.state !== "accumulating") return [];
  if (parser.quietEmitted) return [];
  if (now - parser.lastByteAt < parser.quietWindowMs) return [];
  parser.quietEmitted = true;
  return [{ type: "quiet", offset: parser.totalBytes }];
}

/**
 * Signal to the parser that the supervisor has written the sentinel bytes.
 * The parser transitions to `awaiting-sentinel` and starts scanning incoming
 * bytes for the echo.
 */
export function markSentinelWritten(parser: Parser): void {
  if (parser.state === "accumulating") {
    parser.state = "awaiting-sentinel";
  }
}

/**
 * Reset parser back to `idle`, clearing per-turn state. Total byte count is
 * preserved so subsequent turns get correct absolute offsets.
 */
export function resetTurn(parser: Parser): void {
  parser.state = "idle";
  parser.uuid = "";
  parser.sentinelBytes = new Uint8Array(0);
  parser.turnStartOffset = 0;
  parser.sentinelOffset = 0;
  parser.lastByteAt = 0;
  parser.quietEmitted = false;
  parser.pending = new Uint8Array(0);
  parser.pendingBaseOffset = parser.totalBytes;
}

/**
 * Build the canonical sentinel string for a given UUID. Pure printable ASCII
 * so the bytes survive claude's input echo intact.
 */
export function buildSentinel(uuid: string): string {
  return `<<<CCAW_TURN_END_${uuid}>>>`;
}

/** Encode a sentinel string into bytes (UTF-8 / ASCII-safe). */
export function encodeSentinel(sentinel: string): Uint8Array {
  return new TextEncoder().encode(sentinel);
}

// ─── Byte-level search ───────────────────────────────────────────────────────

/** Find the first index of `needle` in `haystack`. -1 if not found. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  if (needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// ─── Response-text extraction ────────────────────────────────────────────────

/**
 * Strip ANSI control sequences from text. Removes:
 *   - OSC sequences:  ESC ] ... (BEL | ESC \)
 *   - CSI sequences:  ESC [ ... <final byte 0x40-0x7E>
 *   - Charset-select: ESC ( <byte>, ESC ) <byte>
 *   - Solo ESC bytes (defensive)
 *
 * Preserves all non-ANSI Unicode (emoji, box-drawing, CJK, etc.).
 */
export function stripAnsi(text: string): string {
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
 * buffer. claude's TUI renders the assistant message prefixed with the `⏺`
 * glyph (U+23FA), sometimes followed by a space.
 *
 * Algorithm:
 *   1. Find the last occurrence of `⏺` in the buffer.
 *   2. Take text from just after `⏺` up to the first occurrence of any
 *      spinner / tool-result terminator.
 *   3. Trim whitespace; if empty, fall back to the whole stripped buffer.
 */
export function extractResponseText(strippedNormalised: string): string {
  const marker = "⏺";
  // Spinner glyphs and `⎿` tool-result indent are the natural terminators
  // that follow the assistant message in the TUI. We intentionally do NOT
  // include `❯` alone — it can legitimately appear inside response text
  // (e.g. a shell-prompt example).
  const terminatorRe = /[✻✶✳✢✽✺✷·◉]| {2,}⎿/u;
  const idx = strippedNormalised.lastIndexOf(marker);
  if (idx < 0) return strippedNormalised.trim();

  let after = strippedNormalised.slice(idx + marker.length);
  if (after.startsWith(" ")) after = after.slice(1);

  const termMatch = after.match(terminatorRe);
  const body = termMatch ? after.slice(0, termMatch.index) : after;
  const trimmed = body.trim();
  if (trimmed.length > 0) return trimmed;
  return strippedNormalised.trim();
}

/**
 * Convenience: take a raw byte slice (the bytes seen between turn-start and
 * sentinel-found), strip ANSI, normalise newlines, extract response.
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
