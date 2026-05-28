/**
 * Tests for the boot-dialog watcher (issue #193).
 *
 * PtyAgentProcess answers claude's interactive startup confirmation dialogs by
 * inspecting early PTY output and sending the correct key per dialog: Enter for
 * the dev-channels confirmation, and Down+Enter for the new "Bypass Permissions
 * mode" dialog (whose default is "No, exit" — a blind Enter would kill the
 * agent).
 */
import { describe, test, expect } from "bun:test";
import { PtyAgentProcess, type PtyHandle } from "../bus/session-agent-process";

function makeFakePty() {
  const writes: string[] = [];
  let dataCb: ((d: string) => void) | null = null;
  const pty: PtyHandle = {
    pid: 4242,
    onData(cb) {
      dataCb = cb;
      return { dispose() {} };
    },
    onExit() {
      return { dispose() {} };
    },
    write(d) {
      writes.push(d);
    },
    kill() {},
  };
  return { pty, writes, emit: (s: string) => dataCb?.(s) };
}

describe("PtyAgentProcess boot-dialog watcher (issue #193)", () => {
  test("answers the Bypass Permissions dialog with Down then Enter", async () => {
    const { pty, writes, emit } = makeFakePty();
    new PtyAgentProcess("main", pty);
    emit(
      "WARNING: Claude Code running in Bypass Permissions mode\n" +
        "❯ 1. No, exit\n  2. Yes, I accept\nEnter to confirm · Esc to exit",
    );
    expect(writes).toContain("\x1b[B"); // down arrow → select "Yes, I accept"
    await new Promise((r) => setTimeout(r, 260));
    expect(writes).toContain("\r"); // then submit
  });

  test("answers the dev-channels dialog with a bare Enter (its default is accept)", () => {
    const { pty, writes, emit } = makeFakePty();
    new PtyAgentProcess("main", pty);
    emit(
      "WARNING: Loading development channels\n" +
        "❯ 1. I am using this for local development\n  2. Exit",
    );
    expect(writes).toEqual(["\r"]);
  });

  test("does not trigger on the REPL footer that also says 'bypass permissions on'", () => {
    const { pty, writes, emit } = makeFakePty();
    new PtyAgentProcess("main", pty);
    emit("⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents");
    expect(writes).toEqual([]);
  });

  test("answers the bypass dialog only once even if it redraws", async () => {
    const { pty, writes, emit } = makeFakePty();
    new PtyAgentProcess("main", pty);
    emit("...2. Yes, I accept...");
    emit("...2. Yes, I accept... (redraw)");
    await new Promise((r) => setTimeout(r, 260));
    expect(writes.filter((w) => w === "\x1b[B").length).toBe(1);
  });
});
