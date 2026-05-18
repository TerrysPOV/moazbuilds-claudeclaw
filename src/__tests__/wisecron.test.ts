import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { WiseCronSubject } from "../skills-tuner/subjects/wisecron";

describe("WiseCronSubject — instantiation + defaults", () => {
  it("constructs with empty config (uses defaults)", () => {
    const s = new WiseCronSubject({});
    expect(s).toBeInstanceOf(WiseCronSubject);
  });

  it("uses XDG state path for default logDir", () => {
    const s = new WiseCronSubject({});
    // logDir is private; exercise indirectly via the field exposure cast (audit-only).
    const logDir = (s as unknown as { logDir: string }).logDir;
    expect(logDir).toBe(join(homedir(), ".local", "state", "cron-logs"));
  });

  it("honors logDir override from constructor", () => {
    const s = new WiseCronSubject({ logDir: "/custom/path" });
    const logDir = (s as unknown as { logDir: string }).logDir;
    expect(logDir).toBe("/custom/path");
  });

  it("exposes the expected subject name", () => {
    const s = new WiseCronSubject({});
    expect(s.name).toBe("wisecron");
  });
});

describe("WiseCronSubject — risk_tier", () => {
  it("declares medium risk_tier (text-level crontab edits, reversible via revert)", () => {
    const s = new WiseCronSubject({});
    expect(s.risk_tier).toBe("medium");
  });
});

describe("WiseCronSubject — validate()", () => {
  it("validate() accepts cron_change patches", async () => {
    const s = new WiseCronSubject({});
    const result = await s.validate({
      target_path: "crontab",
      kind: "cron_change",
      applied_content: "0 7 * * * /bin/true",
    });
    expect(result.valid).toBe(true);
  });
});
