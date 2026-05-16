/**
 * Fixture-capture script for the sentinel-echo PTY parser (issue #81).
 *
 * Captures a raw byte stream from a live `claude` PTY exercising the full
 * sentinel-echo round-trip: prompt → response → quiet window → sentinel
 * write → echo. The output is a `.bin` file (raw bytes) and a `.markers.json`
 * file recording the byte offsets of each phase, so the parser's
 * golden-fixture test can validate against real claude output.
 *
 * Usage (on the Hetzner production host where claude 2.1.89 is installed
 * AND `~/.claude.json` already has hasTrustDialogAccepted: true for the
 * cwd):
 *
 *     bun run scripts/capture-sentinel-fixture.ts \
 *       [--cwd /home/claw/project] \
 *       [--out /tmp/sentinel-fixture] \
 *       [--prompt "hi, reply only with the word ack"]
 *
 * After capture, scp the .bin + .markers.json files to your dev machine and
 * drop them into `.planning/pty-migration/fixtures/`.
 */
import { spawn } from "bun-pty";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith("--")) {
        out[key] = val;
        i += 1;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cwd = resolvePath(args.cwd ?? process.cwd());
const outBase = args.out ?? "/tmp/sentinel-fixture";
const prompt = args.prompt ?? "hi, reply only with the word ack";
const quietWindowMs = Number(args.quiet ?? "500");
const captureMs = Number(args.captureMs ?? "25000");
const cols = Number(args.cols ?? "100");
const rows = Number(args.rows ?? "30");

const binPath = `${outBase}.bin`;
const markersPath = `${outBase}.markers.json`;
writeFileSync(binPath, "");

console.error(`[capture] cwd=${cwd}`);
console.error(`[capture] out=${binPath} + ${markersPath}`);
console.error(`[capture] prompt=${JSON.stringify(prompt)}`);
console.error(`[capture] quietWindowMs=${quietWindowMs}, captureMs=${captureMs}`);

const pty = spawn("claude", ["--dangerously-skip-permissions"], {
  name: "xterm-256color",
  cols,
  rows,
  cwd,
  env: process.env as Record<string, string>,
});

const uuid = randomUUID();
const sentinel = `<<<CCAW_TURN_END_${uuid}>>>`;
let lastByteAt = Date.now();
let bytesSoFar = 0;
const markers: Record<string, number | string> = { sentinel };

pty.onData((data) => {
  const bytes = Buffer.from(data, "utf8");
  appendFileSync(binPath, bytes);
  bytesSoFar += bytes.length;
  lastByteAt = Date.now();
});

// After TUI settles (4s), send the prompt.
setTimeout(() => {
  markers.promptWrite = bytesSoFar;
  console.error(`[capture] T+4000ms → writing prompt at byte offset ${bytesSoFar}`);
  pty.write(`${prompt}\r`);
  lastByteAt = Date.now(); // reset quiet window so we don't fire prematurely
}, 4000);

// Poll for the quiet window after prompt write → send sentinel.
const poller = setInterval(() => {
  if (markers.promptWrite == null) return;
  if (markers.sentinelWrite != null) {
    // After sentinel write, look for it in the bytes captured.
    // The detection happens via the markers file post-process; we just keep
    // capturing until captureMs elapses.
    return;
  }
  if (Date.now() - lastByteAt > quietWindowMs) {
    markers.quietFired = bytesSoFar;
    markers.sentinelWrite = bytesSoFar;
    console.error(`[capture] quiet window elapsed → writing sentinel at byte offset ${bytesSoFar}`);
    pty.write(sentinel);
  }
}, 50);

// End the capture after captureMs.
setTimeout(() => {
  clearInterval(poller);
  markers.captureEnd = bytesSoFar;
  markers.totalBytes = bytesSoFar;

  // Post-process: find the sentinel echo offset in the captured bytes.
  try {
    const allBytes = Buffer.from(readFileSync(binPath));
    const sentinelBytes = Buffer.from(sentinel, "utf8");
    const writeOffset = typeof markers.sentinelWrite === "number" ? markers.sentinelWrite : 0;
    // Search AFTER the sentinelWrite offset so we don't match before the echo
    // could have arrived.
    const echoIdx = allBytes.indexOf(sentinelBytes, writeOffset);
    markers.sentinelEchoFound = echoIdx >= 0 ? echoIdx : -1;
  } catch (err) {
    markers.sentinelEchoFound = -1;
    markers.error = `failed to post-process sentinel offset: ${(err as Error).message}`;
  }

  writeFileSync(markersPath, `${JSON.stringify(markers, null, 2)}\n`);
  console.error(`[capture] wrote ${bytesSoFar} bytes to ${binPath}`);
  console.error(`[capture] markers → ${markersPath}`);
  console.error(JSON.stringify(markers, null, 2));
  try {
    pty.kill();
  } catch {
    /* ignore */
  }
  process.exit(0);
}, captureMs);
