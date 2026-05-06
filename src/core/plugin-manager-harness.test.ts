// src/core/plugin-manager-harness.test.ts
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PluginManager } from "./plugin-manager.js";
import { EventBus } from "./event-bus.js";
import { ServiceRegistry } from "./service-registry.js";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { AuditLog } from "./audit-log.js";

const createdDirs: string[] = [];
afterEach(() => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeProbePlugin(name: string, bridgeKey: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kz-pm-harness-${name}-`));
  createdDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name, version: "1.0.0", type: "module", main: "index.mjs",
  }));
  writeFileSync(join(dir, "index.mjs"), `
export default {
  name: ${JSON.stringify(name)},
  apiVersion: "3",
  driver: true,
  async setup(ctx) {
    globalThis[${JSON.stringify(bridgeKey)}].setup = ctx.harness;
  },
  async onReady(ctx) {
    globalThis[${JSON.stringify(bridgeKey)}].onReady = ctx.harness;
  },
  async start(ctx) {
    globalThis[${JSON.stringify(bridgeKey)}].start = ctx.harness;
  },
};
`);
  return dir;
}

function makeStubs() {
  const enforcer = new PermissionEnforcer({ mode: "log-only" });
  const auditLog = new AuditLog({
    rootDir: mkdtempSync(join(tmpdir(), "kaizen-test-audit-")),
    sessionId: "test",
    enabled: false,
  });
  const lockfilePath = join(mkdtempSync(join(tmpdir(), "kaizen-test-lock-")), "permissions.lock");
  const options = { trustLockfile: false, allowUnscoped: false, nonInteractive: true };
  return { enforcer, auditLog, lockfilePath, options };
}

describe("PluginContext.harness", () => {
  test("populated from PluginManager harness opt", async () => {
    const bridgeKey = `__kz_harness_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = {};
    const driverDir = writeProbePlugin("driver", bridgeKey);

    const { enforcer, auditLog, lockfilePath, options } = makeStubs();
    const manager = new PluginManager(
      { plugins: [driverDir] },
      new EventBus(), new ServiceRegistry(),
      enforcer, auditLog,
      lockfilePath, options,
      undefined, // globalConfig
      { jsonPath: "/abs/path/kaizen.json", ref: "official/openai-compatible@1.2.3" },
    );

    await manager.initialize();

    const bridge = (globalThis as Record<string, { setup: unknown; onReady: unknown }>)[bridgeKey]!;
    expect(bridge.setup).toEqual({
      jsonPath: "/abs/path/kaizen.json",
      ref: "official/openai-compatible@1.2.3",
    });
    expect(bridge.onReady).toEqual(bridge.setup);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });

  test("defaults to empty object when no harness opt provided", async () => {
    const bridgeKey = `__kz_harness_default_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = {};
    const driverDir = writeProbePlugin("driver", bridgeKey);

    const { enforcer, auditLog, lockfilePath, options } = makeStubs();
    const manager = new PluginManager(
      { plugins: [driverDir] },
      new EventBus(), new ServiceRegistry(),
      enforcer, auditLog,
      lockfilePath, options,
    );

    await manager.initialize();

    const bridge = (globalThis as Record<string, { setup: unknown }>)[bridgeKey]!;
    expect(bridge.setup).toEqual({});
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });

  test("runHarness forwards harness opt to driver ctx", async () => {
    const { runHarness } = await import("./index.js");
    const bridgeKey = `__kz_harness_runharness_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = {};
    const driverDir = writeProbePlugin("driver", bridgeKey);

    const lockfilePath = join(
      mkdtempSync(join(tmpdir(), "kaizen-test-lock-")),
      "permissions.lock",
    );

    await runHarness({
      kaizenConfig: { plugins: [driverDir] },
      lockfilePath,
      enforcer: new PermissionEnforcer({ mode: "log-only" }),
      harness: { jsonPath: "/abs/path/kaizen.json", ref: "x/y@1.0.0" },
    });

    const bridge = (globalThis as Record<string, { start: unknown }>)[bridgeKey]!;
    expect(bridge.start).toEqual({
      jsonPath: "/abs/path/kaizen.json",
      ref: "x/y@1.0.0",
    });
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });
});
