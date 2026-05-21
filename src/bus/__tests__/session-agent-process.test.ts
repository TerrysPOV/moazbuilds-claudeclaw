/**
 * Unit tests for `PtyAgentProcess` write behaviour (#141 review).
 *
 * Uses a fake `PtyHandle` that records every `write` so we can assert:
 *   - concurrent `send_prompt_stream` calls serialise (no byte interleave),
 *   - a real prompt cancels the pending boot dialog-dismiss CR timers.
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

  it("cancels pending dialog-dismiss timers on the first prompt", async () => {
    const { handle, writes } = fakePty();
    let stray = 0;
    const timers = [10, 20, 30].map((ms) =>
      setTimeout(() => {
        stray += 1;
        handle.write("\r");
      }, ms),
    );
    const proc = new PtyAgentProcess("alpha", handle, timers);

    await proc.send_prompt_stream("hi");
    // Wait well past the longest timer; none should have fired.
    await new Promise((r) => setTimeout(r, 60));

    expect(stray).toBe(0);
    expect(writes).toEqual(["hi", "\r"]);
  });
});
