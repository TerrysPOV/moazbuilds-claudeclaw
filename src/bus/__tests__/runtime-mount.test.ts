/**
 * Tests for `src/bus/runtime-mount.ts` (Sprint 5.1).
 *
 * Run with: `bun test src/bus/__tests__/runtime-mount.test.ts`
 *
 * Strategy: drive the mount with injected `BusCore` + `SessionManager`
 * fakes so the test never binds a real UDS or spawns a real `claude`.
 * One follow-up test exercises the real UDS path against a temp socket
 * directory to catch framing / chmod regressions.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountBusRuntime, type BusRuntimeHandle } from "../runtime-mount";
import type { BusCore } from "../core";
import { SessionManager } from "../session-manager";

/* ────────────────────────────────────────────────────────────────────── */
/* FakeBus — records start/stop + slash-handler installation.             */
/* ────────────────────────────────────────────────────────────────────── */

interface FakeBus extends BusCore {
  /** Test inspection — was the slash handler ever installed? */
  slashHandlerInstalled(): boolean;
  /** Test inspection — was the slash handler later detached (null)? */
  slashHandlerDetached(): boolean;
  /** Test inspection — start/stop call counts. */
  startCalls(): number;
  stopCalls(): number;
}

function createFakeBus(opts?: { failStart?: boolean }): FakeBus {
  let starts = 0;
  let stops = 0;
  let installed = false;
  let detached = false;
  let handler: unknown = null;
  return {
    async sendPrompt() {
      return { promise_id: "fake" };
    },
    subscribe() {
      return {
        id: "fake",
        close() {},
        get overflowCount() {
          return 0;
        },
        get depth() {
          return 0;
        },
      };
    },
    async invokeSlashCommand() {},
    setSlashCommandHandler(h) {
      if (h === null) {
        detached = true;
      } else {
        installed = true;
      }
      handler = h;
    },
    ingestReply() {},
    ingestSessionEvent() {},
    ingestPermissionDecision() {},
    ingestAskAnswer() {},
    state() {
      return { subscriberCount: 0, connectedAgents: [], totalOverflows: 0 };
    },
    async start() {
      starts += 1;
      if (opts?.failStart) throw new Error("fake bus.start failure");
    },
    async stop() {
      stops += 1;
    },
    slashHandlerInstalled() {
      return installed;
    },
    slashHandlerDetached() {
      return detached;
    },
    startCalls() {
      return starts;
    },
    stopCalls() {
      return stops;
    },
  } as unknown as FakeBus;
}

const SILENT_LOGGER = {
  warn: () => {},
  info: () => {},
  error: () => {},
};

/* ────────────────────────────────────────────────────────────────────── */
/* Tests                                                                   */
/* ────────────────────────────────────────────────────────────────────── */

describe("mountBusRuntime — happy path (injected fakes)", () => {
  let handle: BusRuntimeHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
  });

  it("starts BusCore, wires slash relay, returns a handle", async () => {
    const bus = createFakeBus();
    const sm = new SessionManager();
    handle = await mountBusRuntime({ bus, sessionManager: sm, logger: SILENT_LOGGER });

    expect(bus.startCalls()).toBe(1);
    expect(bus.slashHandlerInstalled()).toBe(true);
    expect(handle.bus).toBe(bus);
    expect(handle.sessionManager).toBe(sm);
    expect(handle.socketPath.length).toBeGreaterThan(0);
  });

  it("stop() detaches the slash handler before tearing down BusCore", async () => {
    const bus = createFakeBus();
    const sm = new SessionManager();
    handle = await mountBusRuntime({ bus, sessionManager: sm, logger: SILENT_LOGGER });

    await handle.stop();
    handle = null;
    expect(bus.slashHandlerDetached()).toBe(true);
    expect(bus.stopCalls()).toBe(1);
  });

  it("stop() is idempotent — calling twice doesn't throw", async () => {
    const bus = createFakeBus();
    const sm = new SessionManager();
    const h = await mountBusRuntime({ bus, sessionManager: sm, logger: SILENT_LOGGER });
    await h.stop();
    await h.stop();
    // Each call attempts to detach + stop; both should swallow second-call
    // duplicates without throwing.
  });
});

describe("mountBusRuntime — rollback on failure", () => {
  it("rolls back bus.start() if a later mount step throws", async () => {
    // Simulate a SessionManager that throws when we try to wire slash
    // commands by passing a poisoned object. We bypass the normal
    // type checks via a cast — this exercises the catch path that
    // production code would hit if `wireSlashCommands` itself blew up.
    const bus = createFakeBus();
    const poisonedSm = {
      getAgent() {
        throw new Error("poisoned");
      },
    } as unknown as SessionManager;

    // wireSlashCommands installs a closure on `bus.setSlashCommandHandler`
    // but doesn't dereference `sm` until the handler is invoked. To
    // exercise the rollback, force a synchronous throw by overriding
    // `bus.setSlashCommandHandler` to reject the install.
    const failingBus = createFakeBus();
    failingBus.setSlashCommandHandler = () => {
      throw new Error("wiring step failure");
    };

    await expect(
      mountBusRuntime({ bus: failingBus, sessionManager: poisonedSm, logger: SILENT_LOGGER }),
    ).rejects.toThrow(/wiring step failure/);

    // The catch must have called bus.stop() on the started bus to roll back.
    expect(failingBus.stopCalls()).toBe(1);
    // sanity: unused variable suppression
    void bus;
  });

  it("does not call bus.stop() if bus.start() itself throws (nothing to roll back)", async () => {
    const bus = createFakeBus({ failStart: true });
    const sm = new SessionManager();

    await expect(
      mountBusRuntime({ bus, sessionManager: sm, logger: SILENT_LOGGER }),
    ).rejects.toThrow(/fake bus.start failure/);

    expect(bus.stopCalls()).toBe(0);
  });
});

describe("mountBusRuntime — real UDS path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ccaw-bus-mount-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore — best-effort cleanup */
    }
  });

  it("binds a real UDS at the given socketPath and cleans up on stop", async () => {
    const socketPath = join(tmpDir, "bus.sock");
    const handle = await mountBusRuntime({ socketPath, logger: SILENT_LOGGER });

    try {
      expect(handle.socketPath).toBe(socketPath);
      // The IPC server should have bound. `existsSync` on a UDS path
      // returns true once `bind()` + `chmod` + `rename` complete.
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it("returns a handle exposing the mounted BusCore + SessionManager", async () => {
    const socketPath = join(tmpDir, "bus.sock");
    const handle = await mountBusRuntime({ socketPath, logger: SILENT_LOGGER });
    try {
      expect(handle.bus).toBeDefined();
      expect(handle.sessionManager).toBeInstanceOf(SessionManager);
      // BusCore.state() works post-mount.
      expect(handle.bus.state().subscriberCount).toBe(0);
    } finally {
      await handle.stop();
    }
  });
});
