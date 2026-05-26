import { describe, expect, it } from "bun:test";
import { detectOrphanAgents, formatOrphanWarnings } from "../orphan-agent-detect";

const IO = (dirs: Record<string, string[]>) => ({
  listDir: (path: string) => {
    // The detector calls listDir on `<projectRoot>/agents` only.
    const trimmed = path.endsWith("/agents") ? path.slice(0, -"/agents".length) : path;
    return dirs[`${trimmed}/agents`] ?? [];
  },
  countJobs: (path: string) => {
    return dirs[path]?.length ?? 0;
  },
});

describe("detectOrphanAgents", () => {
  it("returns empty report when agents/ directory doesn't exist", () => {
    const r = detectOrphanAgents([{ id: "default" }], "/proj", IO({}));
    expect(r.orphanedDirs).toEqual([]);
    expect(r.orphanedDecls).toEqual([]);
  });

  it("flags on-disk agent with jobs but no declaration", () => {
    const r = detectOrphanAgents([{ id: "default" }], "/proj", {
      listDir: () => ["default", "reg"],
      countJobs: (path) => (path === "/proj/agents/reg/jobs" ? 3 : 0),
    });
    expect(r.orphanedDirs).toEqual([{ name: "reg", jobCount: 3 }]);
    expect(r.orphanedDecls).toEqual([]);
  });

  it("ignores on-disk agent dir with NO jobs (operator may use it as workspace)", () => {
    const r = detectOrphanAgents([{ id: "default" }], "/proj", {
      listDir: () => ["default", "alice"],
      countJobs: () => 0,
    });
    expect(r.orphanedDirs).toEqual([]);
    expect(r.orphanedDecls).toEqual([]);
  });

  it("flags declared agent missing its on-disk dir", () => {
    const r = detectOrphanAgents([{ id: "default" }, { id: "ghost" }], "/proj", {
      listDir: () => ["default"],
      countJobs: () => 0,
    });
    expect(r.orphanedDirs).toEqual([]);
    expect(r.orphanedDecls).toEqual([{ id: "ghost" }]);
  });

  it("reports both directions when they coexist", () => {
    const r = detectOrphanAgents([{ id: "default" }, { id: "ghost" }], "/proj", {
      listDir: () => ["default", "reg"],
      countJobs: (path) => (path === "/proj/agents/reg/jobs" ? 7 : 0),
    });
    expect(r.orphanedDirs).toEqual([{ name: "reg", jobCount: 7 }]);
    expect(r.orphanedDecls).toEqual([{ id: "ghost" }]);
  });

  it("clean state (declarations match on-disk exactly) returns empty report", () => {
    const r = detectOrphanAgents([{ id: "default" }, { id: "suzy" }, { id: "reg" }], "/proj", {
      listDir: () => ["default", "suzy", "reg"],
      countJobs: (path) => (path === "/proj/agents/reg/jobs" ? 3 : 0),
    });
    expect(r.orphanedDirs).toEqual([]);
    expect(r.orphanedDecls).toEqual([]);
  });
});

describe("formatOrphanWarnings", () => {
  it("emits a directive line per orphan dir", () => {
    const lines = formatOrphanWarnings({
      orphanedDirs: [{ name: "reg", jobCount: 7 }],
      orphanedDecls: [],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('agent dir "reg"');
    expect(lines[0]).toContain("7 scheduled job(s)");
    expect(lines[0]).toContain('"id": "reg"');
  });

  it("emits a directive line per orphan declaration", () => {
    const lines = formatOrphanWarnings({
      orphanedDirs: [],
      orphanedDecls: [{ id: "ghost" }],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('agent "ghost"');
    expect(lines[0]).toContain("no matching agents/ghost/ directory");
  });

  it("empty report → no lines", () => {
    expect(formatOrphanWarnings({ orphanedDirs: [], orphanedDecls: [] })).toEqual([]);
  });

  it("reports both kinds in one pass with stable ordering (dirs then decls)", () => {
    const lines = formatOrphanWarnings({
      orphanedDirs: [{ name: "reg", jobCount: 7 }],
      orphanedDecls: [{ id: "ghost" }],
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('agent dir "reg"');
    expect(lines[1]).toContain('agent "ghost"');
  });
});
