/**
 * Tests for isHostAllowed — DNS-rebinding Host validation (issue #164
 * item 2), hotfixed after #189 took the live dashboard offline with
 * "Bad Host" because the original check matched host:PORT and tunnelled
 * access sends the client-side forwarded port.
 *
 * Run with: bun test src/ui/__tests__/host-validation.test.ts
 */
import { describe, it, expect } from "bun:test";
import { isHostAllowed } from "../server";

describe("isHostAllowed (loopback bind 127.0.0.1)", () => {
  const bind = "127.0.0.1";

  it("allows the exact bind host:port", () => {
    expect(isHostAllowed("127.0.0.1:4632", bind)).toBe(true);
  });

  it("allows localhost on the bind port", () => {
    expect(isHostAllowed("localhost:4632", bind)).toBe(true);
  });

  it("allows a tunnelled / forwarded MISMATCHED port (the #189 regression)", () => {
    // ssh -L 8080:127.0.0.1:4632 → browser hits localhost:8080 → Host
    // carries 8080, not the bind port 4632. Must still be allowed.
    expect(isHostAllowed("localhost:8080", bind)).toBe(true);
    expect(isHostAllowed("127.0.0.1:55123", bind)).toBe(true);
  });

  it("allows a bare hostname with no port", () => {
    expect(isHostAllowed("localhost", bind)).toBe(true);
    expect(isHostAllowed("127.0.0.1", bind)).toBe(true);
  });

  it("allows the IPv6 loopback in bracket form", () => {
    expect(isHostAllowed("[::1]:4632", bind)).toBe(true);
    expect(isHostAllowed("[::1]", bind)).toBe(true);
  });

  it("allows the bare IPv6 loopback ::1 (not mangled by port strip)", () => {
    // Regression guard: a naive /:\d+$/ strip would turn `::1` into `:`
    // and reject it even though `::1` is in the allowlist.
    expect(isHostAllowed("::1", bind)).toBe(true);
  });

  it("is case-insensitive on the hostname", () => {
    expect(isHostAllowed("LOCALHOST:4632", bind)).toBe(true);
  });

  it("rejects a foreign hostname (DNS-rebinding attacker domain)", () => {
    expect(isHostAllowed("attacker.com:4632", bind)).toBe(false);
    expect(isHostAllowed("evil.example:8080", bind)).toBe(false);
  });

  it("rejects an empty Host header", () => {
    expect(isHostAllowed("", bind)).toBe(false);
  });
});

describe("isHostAllowed (specific LAN bind)", () => {
  it("allows the configured bind host on any port", () => {
    expect(isHostAllowed("192.168.1.50:4632", "192.168.1.50")).toBe(true);
    expect(isHostAllowed("192.168.1.50:9090", "192.168.1.50")).toBe(true);
  });

  it("still allows loopback names when bound to a LAN IP", () => {
    expect(isHostAllowed("localhost:4632", "192.168.1.50")).toBe(true);
  });

  it("rejects a different LAN IP", () => {
    expect(isHostAllowed("192.168.1.99:4632", "192.168.1.50")).toBe(false);
  });

  it("allows a bare IPv6 LAN bind host (not mangled by port strip)", () => {
    // `fe80::1` would strip to `fe80:` under a naive /:\d+$/ — the
    // IPv6-aware hostnameOf leaves bare IPv6 intact.
    expect(isHostAllowed("fe80::1", "fe80::1")).toBe(true);
    expect(isHostAllowed("fe80::2", "fe80::1")).toBe(false);
  });
});

describe("isHostAllowed (wildcard bind)", () => {
  it("allows any host when bound to 0.0.0.0 (operator opted into remote access)", () => {
    expect(isHostAllowed("anything.example:1234", "0.0.0.0")).toBe(true);
    expect(isHostAllowed("", "0.0.0.0")).toBe(true);
  });

  it("allows any host when bound to ::", () => {
    expect(isHostAllowed("whatever:80", "::")).toBe(true);
  });
});
