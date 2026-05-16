import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SKILLS_DIR,
  DEFAULT_SYSTEMD_USER_DIR,
  DEFAULT_CRONTAB_DIR,
  SUBJECT_STANDARD_PATHS,
  subjectConfig,
  isStandardPath,
  loadConfig,
} from "../skills-tuner/core/config";

describe("skills-tuner config — standard discovery paths (issue #52)", () => {
  describe("DEFAULT_* constants", () => {
    it("skills points at Anthropic Skills global path", () => {
      expect(DEFAULT_SKILLS_DIR).toBe(join(homedir(), ".claude", "skills"));
    });

    it("systemd points at XDG user units path", () => {
      expect(DEFAULT_SYSTEMD_USER_DIR).toBe(join(homedir(), ".config", "systemd", "user"));
    });

    it("crontab points at XDG-config sidecar", () => {
      expect(DEFAULT_CRONTAB_DIR).toBe(join(homedir(), ".config", "cron"));
    });
  });

  describe("SUBJECT_STANDARD_PATHS mapping", () => {
    it("maps skills subject to anthropic global path", () => {
      expect(SUBJECT_STANDARD_PATHS["skills"]?.git_repo).toBe(DEFAULT_SKILLS_DIR);
      expect(SUBJECT_STANDARD_PATHS["skills"]?.scan_dirs).toContain(DEFAULT_SKILLS_DIR);
    });

    it("maps wisecron to systemd user dir", () => {
      expect(SUBJECT_STANDARD_PATHS["wisecron"]?.git_repo).toBe(DEFAULT_SYSTEMD_USER_DIR);
    });

    it("maps cron to XDG-config sidecar", () => {
      expect(SUBJECT_STANDARD_PATHS["cron"]?.git_repo).toBe(DEFAULT_CRONTAB_DIR);
    });
  });

  describe("subjectConfig — default injection", () => {
    const emptyConfig = {
      models: {} as any,
      llm: {} as any,
      detection: {} as any,
      proposer: {} as any,
      subjects: {},
      ui: {} as any,
      storage: { schema_version: 1, proposals_jsonl: "", refused_jsonl: "", backup_keep: 7 } as any,
    } as any;

    it("returns standard git_repo for skills when not configured", () => {
      const cfg = subjectConfig(emptyConfig, "skills");
      expect(cfg.git_repo).toBe(DEFAULT_SKILLS_DIR);
    });

    it("returns standard git_repo for wisecron when not configured", () => {
      const cfg = subjectConfig(emptyConfig, "wisecron");
      expect(cfg.git_repo).toBe(DEFAULT_SYSTEMD_USER_DIR);
    });

    it("returns standard scan_dirs for skills when empty", () => {
      const cfg = subjectConfig(emptyConfig, "skills");
      expect(cfg.scan_dirs).toEqual([DEFAULT_SKILLS_DIR]);
    });

    it("user override wins over default git_repo", () => {
      const userCfg = {
        ...emptyConfig,
        subjects: {
          skills: { enabled: true, auto_merge: false, scan_dirs: [], git_repo: "/custom/path" },
        },
      };
      const cfg = subjectConfig(userCfg, "skills");
      expect(cfg.git_repo).toBe("/custom/path");
    });

    it("user scan_dirs win when non-empty", () => {
      const userCfg = {
        ...emptyConfig,
        subjects: {
          skills: { enabled: true, auto_merge: false, scan_dirs: ["/a", "/b"] },
        },
      };
      const cfg = subjectConfig(userCfg, "skills");
      expect(cfg.scan_dirs).toEqual(["/a", "/b"]);
    });

    it("unknown subject without standard returns user config unmodified", () => {
      const userCfg = {
        ...emptyConfig,
        subjects: {
          custom: { enabled: true, auto_merge: false, scan_dirs: [], git_repo: "/x" },
        },
      };
      const cfg = subjectConfig(userCfg, "custom");
      expect(cfg.git_repo).toBe("/x");
    });

    it("TUNER_DISABLE_STANDARD_DEFAULTS=1 bypasses default injection", () => {
      const prev = process.env.TUNER_DISABLE_STANDARD_DEFAULTS;
      process.env.TUNER_DISABLE_STANDARD_DEFAULTS = "1";
      try {
        const cfg = subjectConfig(emptyConfig, "skills");
        expect(cfg.git_repo).toBeUndefined();
        expect(cfg.scan_dirs).toEqual([]);
      } finally {
        if (prev === undefined) delete process.env.TUNER_DISABLE_STANDARD_DEFAULTS;
        else process.env.TUNER_DISABLE_STANDARD_DEFAULTS = prev;
      }
    });
  });

  describe("isStandardPath", () => {
    it("returns true for canonical skills path", () => {
      expect(isStandardPath("skills", DEFAULT_SKILLS_DIR)).toBe(true);
    });

    it("returns false for non-canonical skills path", () => {
      expect(isStandardPath("skills", "/home/user/agent/skills")).toBe(false);
    });

    it("returns false for unknown subject", () => {
      expect(isStandardPath("unknown", DEFAULT_SKILLS_DIR)).toBe(false);
    });

    it("returns false for undefined path", () => {
      expect(isStandardPath("skills", undefined)).toBe(false);
    });
  });

  describe("loadConfig — tilde expansion + scan_dirs", () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "tuner-test-"));
    });

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it("expands ~ in scan_dirs entries (was missing in previous version)", () => {
      const cfgPath = join(tmp, "config.yaml");
      writeFileSync(
        cfgPath,
        `subjects:
  skills:
    scan_dirs:
      - ~/some-skill-dir
      - /absolute/path
`,
        "utf8",
      );
      const c = loadConfig(cfgPath);
      const skills = c.subjects["skills"]!;
      expect(skills.scan_dirs).toContain(join(homedir(), "some-skill-dir"));
      expect(skills.scan_dirs).toContain("/absolute/path");
    });

    it("returns empty parsed config when file missing", () => {
      const c = loadConfig(join(tmp, "absent.yaml"));
      expect(c.subjects).toEqual({});
    });
  });
});

import { SkillsSubject } from "../skills-tuner/subjects/skills";

describe("SkillsSubject constructor — uses standard default", () => {
  it("falls back to DEFAULT_SKILLS_DIR when scanDirs omitted", () => {
    const subject = new SkillsSubject({});
    // Reach into the instance via type assertion — constructor default is the
    // observable contract here. If the field is renamed or made private+inaccessible,
    // expose a getter rather than reverting the assertion.
    const scanDirs = (subject as unknown as { scanDirs: string[] }).scanDirs;
    expect(scanDirs).toEqual([DEFAULT_SKILLS_DIR]);
  });
});
