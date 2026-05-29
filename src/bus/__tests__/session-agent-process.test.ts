/**
 * Unit tests for `PtyAgentProcess` write behaviour (#141 review).
 *
 * Uses a fake `PtyHandle` that records every `write` so we can assert:
 *   - concurrent `send_prompt_stream` calls serialise (no byte interleave),
 *   - the boot-dialog watcher answers late dialogs and disengages on the
 *     REPL-ready marker, not on first prompt (issue #193 / Codex P2 on #195).
 */
import { describe, expect, it } from "bun:test";
import { PtyAgentProcess, type PtyHandle } from "../session-agent-process";

function fakePty(): { handle: PtyHandle; writes: string[] } {
  const writes: string[] = [];
  const handle: PtyHandle = {
    pid: 1234,
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write: (data: string) => {
      writes.push(data);
    },
    kill: () => {},
  };
  return { handle, writes };
}

describe("PtyAgentProcess.send_prompt_stream", () => {
  it("serialises concurrent prompts so their bytes don't interleave", async () => {
    const { handle, writes } = fakePty();
    const proc = new PtyAgentProcess("alpha", handle);

    // Fire two prompts without awaiting the first — without serialisation the
    // second `write(line)` would land inside the first's 200ms settle window,
    // producing order [first, second, "\r", "\r"].
    const a = proc.send_prompt_stream("first");
    const b = proc.send_prompt_stream("second");
    await Promise.all([a, b]);

    // Each prompt's text is immediately followed by its own CR.
    expect(writes).toEqual(["first", "\r", "second", "\r"]);
  });

  it("keeps answering dialogs after an early prompt until the REPL is ready, then disengages (Codex P2 on #195)", async () => {
    const writes: string[] = [];
    let dataCb: ((d: string) => void) | null = null;
    const handle: PtyHandle = {
      pid: 1234,
      onData: (cb) => {
        dataCb = cb;
        return { dispose() {} };
      },
      onExit: () => ({ dispose() {} }),
      write: (data: string) => {
        writes.push(data);
      },
      kill: () => {},
    };
    const proc = new PtyAgentProcess("alpha", handle);

    // An early prompt is dispatched BEFORE the boot dialog renders (slow
    // fresh-install boot). The old code disengaged the watcher here, leaving
    // the later dialog unanswered. The watcher must stay engaged.
    await proc.send_prompt_stream("hi");
    writes.length = 0;

    // The bypass dialog renders AFTER the prompt — it must still be answered.
    dataCb?.("WARNING: Bypass Permissions mode\n  2. Yes, I accept\n");
    expect(writes).toContain("\x1b[B"); // watcher still active -> Down
    await new Promise((r) => setTimeout(r, 260));
    expect(writes).toContain("\r"); // then Enter

    // Once the REPL footer appears the watcher disengages — and the marker is
    // mode-independent (Codex P2 #2 on #195): a non-bypass agent shows a
    // mode-specific footer like "plan mode on", but every mode footer carries
    // the "shift+tab to cycle" hint. A later dialog-looking chunk must then be
    // ignored (no keys injected into a live REPL).
    dataCb?.("⏸ plan mode on (shift+tab to cycle)");
    writes.length = 0;
    dataCb?.("stray redraw with 2. Yes, I accept text");
    await new Promise((r) => setTimeout(r, 60));
    expect(writes).toEqual([]);
  });
});
