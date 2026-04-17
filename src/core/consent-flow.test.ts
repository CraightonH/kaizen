import { describe, test, expect } from "bun:test";
import { decideConsent } from "./consent-flow.js";
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

  test("plugin not in lockfile, scoped, interactive: prompt", () => {
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: BASE_MANIFEST,
      lockfile: { schemaVersion: 1, plugins: {} },
      interactive: true, allowUnscoped: false,
    });
    expect(decision.kind).toBe("prompt-scoped");
  });

  test("plugin not in lockfile, unscoped, interactive: prompt-unscoped", () => {
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: { tier: "unscoped" },
      lockfile: { schemaVersion: 1, plugins: {} },
      interactive: true, allowUnscoped: true,
    });
    expect(decision.kind).toBe("prompt-unscoped");
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
});
