/**
 * Unit tests for `PtyAgentProcess` write behaviour (#141 review).
 *
 * Uses a fake `PtyHandle` that records every `write` so we can assert:
 *   - concurrent `send_prompt_stream` calls serialise (no byte interleave),
 *   - a real prompt disengages the boot-dialog watcher (issue #193).
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

  it("disengages the boot-dialog watcher once a real prompt is dispatched", async () => {
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

    await proc.send_prompt_stream("hi"); // claude has reached the REPL
    writes.length = 0;
    // A dialog-looking chunk arriving AFTER the first prompt must be ignored —
    // the watcher disengages so it can't inject keys mid-session.
    dataCb?.("...\u276f 2. Yes, I accept...");
    await new Promise((r) => setTimeout(r, 60));
    expect(writes).toEqual([]);
  });
});
