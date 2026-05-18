/**
 * Tests for `computeJobsDigest` (extracted from `src/commands/start.ts`
 * in the Codex P1 fix on PR #126).
 *
 * The digest determines whether the daemon's 30s hot-reload loop
 * triggers a Bus scheduler rebuild. If the digest misses a
 * scheduler-relevant field, in-memory triggers go stale until restart.
 */

import { describe, it, expect } from "bun:test";
import { computeJobsDigest } from "../commands/start";
import type { Job } from "../jobs";

function job(over: Partial<Job> = {}): Job {
  return {
    name: over.name ?? "test",
    schedule: over.schedule ?? "*/5 * * * *",
    prompt: over.prompt ?? "do the thing",
    recurring: over.recurring ?? true,
    notify: over.notify ?? false,
    ...over,
  };
}

describe("computeJobsDigest", () => {
  it("returns identical digests for identical lists", () => {
    const a = [job({ name: "a" }), job({ name: "b" })];
    const b = [job({ name: "b" }), job({ name: "a" })]; // order shouldn't matter
    expect(computeJobsDigest(a)).toBe(computeJobsDigest(b));
  });

  it("differs when schedule changes", () => {
    const a = computeJobsDigest([job({ name: "x", schedule: "*/5 * * * *" })]);
    const b = computeJobsDigest([job({ name: "x", schedule: "*/10 * * * *" })]);
    expect(a).not.toBe(b);
  });

  it("differs when prompt changes", () => {
    const a = computeJobsDigest([job({ name: "x", prompt: "ping" })]);
    const b = computeJobsDigest([job({ name: "x", prompt: "pong" })]);
    expect(a).not.toBe(b);
  });

  it("differs when enabled toggles (Codex P1 on PR #126)", () => {
    const enabled = computeJobsDigest([job({ name: "x", enabled: true })]);
    const disabled = computeJobsDigest([job({ name: "x", enabled: false })]);
    expect(enabled).not.toBe(disabled);
  });

  it("missing enabled treated as true (default semantics)", () => {
    // `enabled` is optional in the legacy Job shape; absence means
    // enabled. The digest must treat it the same so a settings file
    // that promotes a job from "no field" to "enabled: true" doesn't
    // false-positive a reload.
    const missing = computeJobsDigest([job({ name: "x" })]);
    const explicit = computeJobsDigest([job({ name: "x", enabled: true })]);
    expect(missing).toBe(explicit);
  });

  it("differs when agent changes (Codex P1 on PR #126)", () => {
    const a = computeJobsDigest([job({ name: "x", agent: "triage" })]);
    const b = computeJobsDigest([job({ name: "x", agent: "research" })]);
    expect(a).not.toBe(b);
  });

  it("missing agent matches empty-string agent (no false-positive reload)", () => {
    const missing = computeJobsDigest([job({ name: "x" })]);
    const empty = computeJobsDigest([job({ name: "x", agent: "" })]);
    expect(missing).toBe(empty);
  });

  it("adding a job changes the digest", () => {
    const a = computeJobsDigest([job({ name: "x" })]);
    const b = computeJobsDigest([job({ name: "x" }), job({ name: "y" })]);
    expect(a).not.toBe(b);
  });

  it("empty list digest is stable", () => {
    expect(computeJobsDigest([])).toBe(computeJobsDigest([]));
  });
});
