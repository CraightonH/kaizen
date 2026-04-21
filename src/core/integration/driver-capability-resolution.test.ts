import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PluginManager } from "../plugin-manager.js";
import { EventBus } from "../event-bus.js";
import { ServiceRegistry } from "../service-registry.js";
import { CapabilityRegistry } from "../capability-registry.js";
import { PermissionEnforcer } from "../permission-enforcer.js";
import { AuditLog } from "../audit-log.js";
import type { KaizenPlugin, KaizenConfig } from "../../types/plugin.js";

function makeHarness(builtins: Record<string, KaizenPlugin>, pluginRefs: string[]) {
  const eventBus = new EventBus();
  const capabilityRegistry = new CapabilityRegistry();
  const serviceRegistry = new ServiceRegistry();
  const enforcer = new PermissionEnforcer({ mode: "log-only" });
  const auditLog = new AuditLog({
    rootDir: mkdtempSync(join(tmpdir(), "kz-driver-cap-audit-")),
    sessionId: "test",
    enabled: false,
  });
  const lockfilePath = join(mkdtempSync(join(tmpdir(), "kz-driver-cap-lock-")), "kaizen.permissions.lock");
  const options = { trustLockfile: false, allowUnscoped: false, nonInteractive: true };
  const config: KaizenConfig = { plugins: pluginRefs };

  const manager = new PluginManager(
    config, builtins,
    eventBus, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, options,
  );
  return { manager, capabilityRegistry };
}

describe("driver capability resolution (post-registry-refactor)", () => {
  it("resolves a provider by name via CapabilityRegistry when one plugin provides it", async () => {
    const providerPlugin: KaizenPlugin = {
      name: "test-helper",
      apiVersion: "2",
      capabilities: { provides: ["test-helper:collaborator"] },
      async setup(ctx) {
        ctx.defineCapability("test-helper:collaborator", { cardinality: "one", description: "test" });
      },
    };
    const driverPlugin: KaizenPlugin = {
      name: "test-driver",
      apiVersion: "2",
      lifecycle: true,
      capabilities: { consumes: ["test-helper:collaborator"] },
      async setup() {},
      async start() {},
    };

    const { manager, capabilityRegistry } = makeHarness(
      { "test-driver": driverPlugin, "test-helper": providerPlugin },
      ["test-helper", "test-driver"],
    );

    await manager.initialize();
    expect(capabilityRegistry.providersOf("test-helper:collaborator")).toContain("test-helper");
  });

  it("fails initialization when a cardinality-one capability has two providers", async () => {
    const helperA: KaizenPlugin = {
      name: "helper-a",
      apiVersion: "2",
      capabilities: { provides: ["owner:thing"] },
      async setup() {},
    };
    const helperB: KaizenPlugin = {
      name: "helper-b",
      apiVersion: "2",
      capabilities: { provides: ["owner:thing"] },
      async setup() {},
    };
    const owner: KaizenPlugin = {
      name: "owner",
      apiVersion: "2",
      async setup(ctx) {
        ctx.defineCapability("owner:thing", { cardinality: "one", description: "" });
      },
    };
    const driver: KaizenPlugin = {
      name: "test-driver",
      apiVersion: "2",
      lifecycle: true,
      capabilities: { consumes: ["owner:thing"] },
      async setup() {},
      async start() {},
    };

    const { manager } = makeHarness(
      { owner, "helper-a": helperA, "helper-b": helperB, "test-driver": driver },
      ["owner", "helper-a", "helper-b", "test-driver"],
    );

    await expect(manager.initialize()).rejects.toThrow(/Multiple plugins provide/);
  });
});
