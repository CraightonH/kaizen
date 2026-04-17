import { describe, test, expect } from "bun:test";
import { decideConsent, normalizeSort } from "./consent-flow.js";
import type { LockfileEntry, PermissionsLockfile } from "./lockfile.js";

const BASE_MANIFEST = { tier: "scoped" as const, env: ["KEY"] };

describe("decideConsent", () => {
  test("plugin in lockfile with matching hash+perms: auto-accept", () => {
    const lf: PermissionsLockfile = {
      schemaVersion: 1,
      plugins: {
        p1: {
          version: "1.0", hash: "sha256:abc", tier: "scoped",
          consentedAt: "t", consentedBy: "u",
          permissions: { env: ["KEY"] },
        },
      },
    };
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: BASE_MANIFEST, lockfile: lf, interactive: false,
      allowUnscoped: false,
    });
    expect(decision.kind).toBe("accept");
  });

  test("plugin in lockfile, hash drift: refuse in non-interactive", () => {
    const lf: PermissionsLockfile = {
      schemaVersion: 1,
      plugins: {
        p1: {
          version: "1.0", hash: "sha256:old", tier: "scoped",
          consentedAt: "t", consentedBy: "u",
          permissions: { env: ["KEY"] },
        },
      },
    };
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:new",
      permissions: BASE_MANIFEST, lockfile: lf, interactive: false,
      allowUnscoped: false,
    });
    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") expect(decision.reason).toMatch(/hash/i);
  });

  test("plugin in lockfile, manifest drift: refuse", () => {
    const lf: PermissionsLockfile = {
      schemaVersion: 1,
      plugins: {
        p1: {
          version: "1.0", hash: "sha256:abc", tier: "scoped",
          consentedAt: "t", consentedBy: "u",
          permissions: { env: ["OTHER_KEY"] },
        },
      },
    };
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: BASE_MANIFEST, lockfile: lf, interactive: false,
      allowUnscoped: false,
    });
    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") expect(decision.reason).toMatch(/permission/i);
  });

  test("plugin not in lockfile, trusted: silent add", () => {
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: { tier: "trusted" },
      lockfile: { schemaVersion: 1, plugins: {} },
      interactive: false, allowUnscoped: false,
    });
    expect(decision.kind).toBe("accept-and-record");
  });

  test("plugin not in lockfile, scoped, non-interactive: refuse", () => {
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: BASE_MANIFEST,
      lockfile: { schemaVersion: 1, plugins: {} },
      interactive: false, allowUnscoped: false,
    });
    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") expect(decision.reason).toMatch(/consent/i);
  });

  test("plugin not in lockfile, scoped, interactive: prompt with pre-built entry", () => {
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: BASE_MANIFEST,
      lockfile: { schemaVersion: 1, plugins: {} },
      interactive: true, allowUnscoped: false,
    });
    expect(decision.kind).toBe("prompt-scoped");
    if (decision.kind === "prompt-scoped") {
      expect(decision.entry.hash).toBe("sha256:abc");
      expect(decision.entry.tier).toBe("scoped");
    }
  });

  test("plugin not in lockfile, unscoped, interactive: prompt-unscoped with pre-built entry", () => {
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: { tier: "unscoped" },
      lockfile: { schemaVersion: 1, plugins: {} },
      interactive: true, allowUnscoped: true,
    });
    expect(decision.kind).toBe("prompt-unscoped");
    if (decision.kind === "prompt-unscoped") {
      expect(decision.entry.hash).toBe("sha256:abc");
      expect(decision.entry.tier).toBe("unscoped");
    }
  });

  test("plugin not in lockfile, unscoped, non-interactive, allowUnscoped=false: refuse", () => {
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: { tier: "unscoped" },
      lockfile: { schemaVersion: 1, plugins: {} },
      interactive: false, allowUnscoped: false,
    });
    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") expect(decision.reason).toMatch(/unscoped/i);
  });

  test("same grants in lockfile reordered still accepted (normalizeSort)", () => {
    // Lockfile recorded env as ["B", "A"]; declared as ["A", "B"] — should still accept.
    const lf: PermissionsLockfile = {
      schemaVersion: 1,
      plugins: {
        p1: {
          version: "1.0", hash: "sha256:abc", tier: "scoped",
          consentedAt: "t", consentedBy: "u",
          permissions: { env: ["B", "A"] },
        },
      },
    };
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: { tier: "scoped", env: ["A", "B"] },
      lockfile: lf, interactive: false, allowUnscoped: false,
    });
    expect(decision.kind).toBe("accept");
  });
});

describe("normalizeSort", () => {
  test("sorts env array", () => {
    const result = normalizeSort({ env: ["Z", "A", "M"] }) as { env: string[] };
    expect(result.env).toEqual(["A", "M", "Z"]);
  });

  test("grants reordered produce identical JSON", () => {
    const a = JSON.stringify(normalizeSort({ env: ["B", "A"], exec: { binaries: ["curl", "bash"] } }));
    const b = JSON.stringify(normalizeSort({ env: ["A", "B"], exec: { binaries: ["bash", "curl"] } }));
    expect(a).toBe(b);
  });
});
