/**
 * Public entry point for the runner subdirectory.
 *
 * Re-exports the PtyProcess wrapper and the OSC turn-boundary parser so the
 * supervisor (engineer-pty-supervisor's work, parallel) can import as
 *
 *     import { spawnPty, PtyProcess } from "../runner";
 *
 * without reaching into the implementation files.
 *
 * DO NOT add imports from pty-supervisor.ts here — that file lives in the
 * sibling worktree and is owned by a different engineer.
 */

export {
  spawnPty,
  PtyTurnTimeoutError,
  PtyClosedError,
  type PtyProcess,
  type PtyProcessOptions,
  type PtyTurnResult,
} from "./pty-process";

export {
  createParser,
  feed,
  stripAnsi,
  normaliseNewlines,
  extractResponseText,
  decodeTurn,
  PROGRESS_MARKERS,
  type Parser,
  type ParserEvent,
} from "./pty-output-parser";
