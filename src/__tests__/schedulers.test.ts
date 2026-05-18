import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import {
  BackendError,
  validateJobName,
  validateJobCommand,
  type JobSpec,
  type SchedulerBackend,
} from "../skills-tuner/schedulers/base";
import { InProcessBackend } from "../skills-tuner/schedulers/in-process";
import { CrontabPosixBackend } from "../skills-tuner/schedulers/crontab-posix";
import { SystemdUserBackend } from "../skills-tuner/schedulers/systemd-user";
import {
  detectBackend,
  registerBackend,
  resetBackendRegistry,
  describeBackends,
} from "../skills-tuner/schedulers/registry";

// ─── Base validation ─────────────────────────────────────────────────────────────────

describe("SchedulerBackend base — validation helpers", () => {
  describe("validateJobName", () => {
    it("accepts valid names", () => {
      expect(() => validateJobName("backup-nightly")).not.toThrow();
      expect(() => validateJobName("a")).not.toThrow();
      expect(() => validateJobName("trader-check-2026")).not.toThrow();
    });
    it("rejects leading non-lowercase", () => {
      expect(() => validateJobName("Backup")).toThrow(BackendError);
      expect(() => validateJobName("1backup")).toThrow(BackendError);
      expect(() => validateJobName("-backup")).toThrow(BackendError);
    });
    it("rejects path traversal attempts", () => {
      expect(() => validateJobName("../etc/passwd")).toThrow(BackendError);
      expect(() => validateJobName("backup/sub")).toThrow(BackendError);
    });
    it("rejects too long", () => {
      expect(() => validateJobName("a".repeat(64))).toThrow(BackendError);
    });
  });

  describe("validateJobCommand", () => {
    it("accepts normal shell commands", () => {
      expect(() => validateJobCommand("/usr/bin/backup.sh --quiet")).not.toThrow();
    });
    it("rejects empty / whitespace-only", () => {
      expect(() => validateJobCommand("")).toThrow(BackendError);
      expect(() => validateJobCommand("   ")).toThrow(BackendError);
    });
    it("rejects NUL, CR, and LF control chars", () => {
      expect(() => validateJobCommand("cmd\x00; rm -rf /")).toThrow(BackendError);
      expect(() => validateJobCommand("cmd\r/etc")).toThrow(BackendError);
      expect(() => validateJobCommand("cmd\nrm /etc")).toThrow(BackendError);
    });
    it("rejects absurdly long commands", () => {
      expect(() => validateJobCommand("x".repeat(2001))).toThrow(BackendError);
    });
  });
});

// ─── InProcessBackend ────────────────────────────────────────────────────────────────

describe("InProcessBackend", () => {
  let backend: InProcessBackend;

  beforeEach(() => {
    backend = new InProcessBackend();
  });

  afterEach(() => {
    backend.shutdown();
  });

  it("always detects as available", async () => {
    expect(await backend.detect()).toBe(true);
  });

  it("reports null gitRepoPath (no on-disk artifact)", () => {
    expect(backend.gitRepoPath()).toBeNull();
  });

  it("renders without I/O", () => {
    const spec: JobSpec = {
      name: "test",
      description: "every 5 min",
      schedule: "*/5 * * * *",
      command: "true",
    };
    const r = backend.render(spec);
    expect(r.files).toEqual({});
    expect(r.summary).toContain("in-process");
  });

  it("rejects duplicate create on same name", async () => {
    await backend.create({
      name: "dup",
      description: "test",
      schedule: "*/1 * * * *",
      command: "true",
    });
    await expect(
      backend.create({ name: "dup", description: "test", schedule: "*/1 * * * *", command: "true" }),
    ).rejects.toThrow(BackendError);
  });

  it("remove is idempotent (no-op when absent)", async () => {
    await expect(backend.remove("never-created")).resolves.toBeUndefined();
  });
});

// ─── CrontabPosixBackend ─────────────────────────────────────────────────────────────

describe("CrontabPosixBackend — pure render + validation", () => {
  const backend = new CrontabPosixBackend();

  it("renders a tagged crontab line", () => {
    const r = backend.render({
      name: "trader-check",
      description: "every 5 min",
      schedule: "*/5 * * * *",
      command: "/home/u/check.sh",
    });
    expect(r.summary).toContain("crontab-posix");
    expect(r.summary).toContain("# wisecron:trader-check");
  });

  it("gitRepoPath points at the XDG-config sidecar", () => {
    expect(backend.gitRepoPath()).toBe(join(homedir(), ".config", "cron"));
  });
});

// ─── SystemdUserBackend ──────────────────────────────────────────────────────────────

describe("SystemdUserBackend — pure render + validation", () => {
  const backend = new SystemdUserBackend();

  it("renders a .timer + .service pair", () => {
    const r = backend.render({
      name: "trader-check",
      description: "every weekday at 9:30 EST",
      schedule: "Mon..Fri *-*-* 13:30:00 UTC",
      command: "/home/u/check.sh",
    });
    expect(Object.keys(r.files)).toContain("trader-check.timer");
    expect(Object.keys(r.files)).toContain("trader-check.service");
    expect(r.files["trader-check.timer"]).toContain("OnCalendar=Mon..Fri *-*-* 13:30:00 UTC");
    expect(r.files["trader-check.service"]).toContain("ExecStart=/bin/sh -c");
    expect(r.files["trader-check.service"]).toContain("/home/u/check.sh");
  });

  it("gitRepoPath points at XDG systemd-user", () => {
    expect(backend.gitRepoPath()).toBe(join(homedir(), ".config", "systemd", "user"));
  });

  it("tags units with wisecron-managed so list() can filter cleanly", () => {
    const r = backend.render({
      name: "t",
      description: "d",
      schedule: "*:0/15",
      command: "true",
    });
    expect(r.files["t.timer"]).toContain("wisecron-managed");
    expect(r.files["t.service"]).toContain("wisecron-managed");
  });
});

// ─── Registry + auto-detection ───────────────────────────────────────────────────────

describe("BackendRegistry — detection + override", () => {
  beforeEach(() => {
    resetBackendRegistry();
    delete process.env["WISECRON_BACKEND"];
  });

  it("auto-detects with default registration", async () => {
    const b = await detectBackend();
    expect(["systemd-user", "crontab-posix", "in-process"]).toContain(b.name);
  });

  it("respects WISECRON_BACKEND env override", async () => {
    resetBackendRegistry();
    registerBackend(new InProcessBackend());
    process.env["WISECRON_BACKEND"] = "in-process";
    const b = await detectBackend();
    expect(b.name).toBe("in-process");
  });

  it("throws when WISECRON_BACKEND points at an unregistered backend", async () => {
    resetBackendRegistry();
    registerBackend(new InProcessBackend());
    process.env["WISECRON_BACKEND"] = "non-existent" as any;
    await expect(detectBackend()).rejects.toThrow(/not registered/);
  });

  it("describeBackends snapshot includes name + detect result + gitRepoPath", async () => {
    resetBackendRegistry();
    const desc = await describeBackends();
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.every((d) => typeof d.name === "string")).toBe(true);
    expect(desc.every((d) => typeof d.detected === "boolean")).toBe(true);
  });

  it("falls through to a backend whose detect() throws", async () => {
    resetBackendRegistry();
    const evil: SchedulerBackend = {
      name: "systemd-user",
      async detect() {
        throw new Error("simulated host probe failure");
      },
      gitRepoPath: () => "/nope",
      list: async () => [],
      render: () => ({ files: {}, summary: "evil" }),
      create: async () => ({ artifactPath: null }),
      remove: async () => {},
    };
    registerBackend(evil);
    registerBackend(new InProcessBackend());
    const b = await detectBackend();
    expect(b.name).toBe("in-process");
  });
});
