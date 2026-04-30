import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PluginManager } from "./plugin-manager.js";
import { runHarness } from "./index.js";
import { EventBus } from "./event-bus.js";
import { ServiceRegistry } from "./service-registry.js";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { AuditLog } from "./audit-log.js";

function makeRegistries() {
  return {
    eventBus: new EventBus(),
    serviceRegistry: new ServiceRegistry(),
  };
}

function makeSandboxStubs() {
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

const createdDirs: string[] = [];
afterEach(() => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface PluginSpec {
  name: string;
  driver?: boolean;
  setupBody?: string;
  onReadyBody?: string;
  hasOnReady?: boolean;
  startBody?: string;
  hasStart?: boolean;
  consumes?: string[];
  provides?: string[];
}

function writePlugin(spec: PluginSpec): string {
  const dir = mkdtempSync(join(tmpdir(), `kz-pm-onready-${spec.name}-`));
  createdDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: spec.name, version: "1.0.0", type: "module", main: "index.mjs",
  }));
  const parts: string[] = [];
  parts.push(`export default {`);
  parts.push(`  name: ${JSON.stringify(spec.name)},`);
  parts.push(`  apiVersion: "3",`);
  if (spec.driver) parts.push(`  driver: true,`);
  if (spec.consumes || spec.provides) {
    parts.push(`  services: ${JSON.stringify({
      ...(spec.consumes ? { consumes: spec.consumes } : {}),
      ...(spec.provides ? { provides: spec.provides } : {}),
    })},`);
  }
  parts.push(`  async setup(ctx) {`);
  if (spec.setupBody) parts.push(spec.setupBody);
  parts.push(`  },`);
  if (spec.hasOnReady) {
    parts.push(`  async onReady(ctx) {`);
    if (spec.onReadyBody) parts.push(spec.onReadyBody);
    parts.push(`  },`);
  }
  if (spec.hasStart) {
    parts.push(`  async start(ctx) {`);
    if (spec.startBody) parts.push(spec.startBody);
    parts.push(`  },`);
  }
  parts.push(`};`);
  writeFileSync(join(dir, "index.mjs"), parts.join("\n"));
  return dir;
}

describe("PluginManager.initialize calls onReady()", () => {
  test("onReady is invoked on every loaded plugin", async () => {
    const bridgeKey = `__kz_onready_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = { calls: [] as string[] };

    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasStart: true,
      startBody: `/* no-op driver */`,
      hasOnReady: true,
      onReadyBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("driver");`,
    });
    const consumerDir = writePlugin({
      name: "consumer",
      hasOnReady: true,
      onReadyBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("consumer");`,
    });

    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [driverDir, consumerDir] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );

    await manager.initialize();

    const bridge = (globalThis as unknown as Record<string, { calls: string[] }>)[bridgeKey]!;
    expect(bridge.calls.sort()).toEqual(["consumer", "driver"]);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });

  test("onReady runs in topological order (provider before consumer)", async () => {
    const bridgeKey = `__kz_onready_topo_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = { calls: [] as string[] };

    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasStart: true,
      startBody: `/* no-op */`,
    });
    const providerDir = writePlugin({
      name: "provider",
      provides: ["provider:thing"],
      setupBody: `ctx.defineService("provider:thing", { schema: {} }); ctx.provideService("provider:thing", { ok: true });`,
      hasOnReady: true,
      onReadyBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("provider");`,
    });
    const consumerDir = writePlugin({
      name: "consumer",
      consumes: ["provider:thing"],
      hasOnReady: true,
      onReadyBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("consumer");`,
    });

    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [consumerDir, providerDir, driverDir] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.initialize();

    const bridge = (globalThis as unknown as Record<string, { calls: string[] }>)[bridgeKey]!;
    const providerIdx = bridge.calls.indexOf("provider");
    const consumerIdx = bridge.calls.indexOf("consumer");
    expect(providerIdx).toBeGreaterThanOrEqual(0);
    expect(consumerIdx).toBeGreaterThan(providerIdx);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });

  test("useService() is legal inside onReady", async () => {
    const bridgeKey = `__kz_onready_useservice_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = { ok: false, error: null as string | null };

    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasStart: true,
      startBody: `/* no-op */`,
    });
    const providerDir = writePlugin({
      name: "provider",
      provides: ["provider:thing"],
      setupBody: `ctx.defineService("provider:thing", { schema: {} }); ctx.provideService("provider:thing", { value: 42 });`,
    });
    const consumerDir = writePlugin({
      name: "consumer",
      consumes: ["provider:thing"],
      hasOnReady: true,
      onReadyBody: `
        try {
          const svc = ctx.useService("provider:thing");
          globalThis[${JSON.stringify(bridgeKey)}].ok = svc.value === 42;
        } catch (e) {
          globalThis[${JSON.stringify(bridgeKey)}].error = e.message;
        }
      `,
    });

    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [providerDir, consumerDir, driverDir] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.initialize();

    const bridge = (globalThis as unknown as Record<string, { ok: boolean; error: string | null }>)[bridgeKey]!;
    expect(bridge.error).toBeNull();
    expect(bridge.ok).toBe(true);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });

  test("setup-only APIs throw inside onReady", async () => {
    const bridgeKey = `__kz_onready_gating_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = {
      provideErr: null as string | null,
      onErr: null as string | null,
      consumeErr: null as string | null,
      defineSvcErr: null as string | null,
      defineEvtErr: null as string | null,
    };

    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasStart: true,
      startBody: `/* no-op */`,
    });
    const pluginDir = writePlugin({
      name: "p",
      hasOnReady: true,
      onReadyBody: `
        const b = globalThis[${JSON.stringify(bridgeKey)}];
        try { ctx.provideService("p:x", {}); } catch (e) { b.provideErr = e.message; }
        try { ctx.on("evt", () => {}); } catch (e) { b.onErr = e.message; }
        try { ctx.consumeService("other:thing"); } catch (e) { b.consumeErr = e.message; }
        try { ctx.defineService("p:y", { schema: {} }); } catch (e) { b.defineSvcErr = e.message; }
        try { ctx.defineEvent("p:evt"); } catch (e) { b.defineEvtErr = e.message; }
      `,
    });

    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [pluginDir, driverDir] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.initialize();

    const bridge = (globalThis as unknown as Record<string, {
      provideErr: string | null; onErr: string | null; consumeErr: string | null;
      defineSvcErr: string | null; defineEvtErr: string | null;
    }>)[bridgeKey]!;
    expect(bridge.provideErr).toMatch(/after initialization/i);
    expect(bridge.onErr).toMatch(/after initialization/i);
    expect(bridge.consumeErr).toMatch(/after initialization/i);
    expect(bridge.defineSvcErr).toMatch(/after initialization/i);
    expect(bridge.defineEvtErr).toMatch(/after initialization/i);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });

  test("a throw from onReady is fatal", async () => {
    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasStart: true,
      startBody: `/* no-op */`,
    });
    const badDir = writePlugin({
      name: "bad",
      hasOnReady: true,
      onReadyBody: `throw new Error("onReady kaboom");`,
    });

    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [badDir, driverDir] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );

    await expect(manager.initialize()).rejects.toThrow(/onReady\(\) failed.*onReady kaboom/);
  });

  test("driver.start() runs after every plugin's onReady", async () => {
    const bridgeKey = `__kz_onready_before_start_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = { calls: [] as string[] };

    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasOnReady: true,
      onReadyBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("driver:onReady");`,
      hasStart: true,
      startBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("driver:start");`,
    });
    const peerDir = writePlugin({
      name: "peer",
      hasOnReady: true,
      onReadyBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("peer:onReady");`,
    });

    const lockfilePath = join(mkdtempSync(join(tmpdir(), "kaizen-test-lock-")), "permissions.lock");
    await runHarness({
      kaizenConfig: { plugins: [peerDir, driverDir] },
      lockfilePath,
    });

    const bridge = (globalThis as unknown as Record<string, { calls: string[] }>)[bridgeKey]!;
    const startIdx = bridge.calls.indexOf("driver:start");
    const peerOnReadyIdx = bridge.calls.indexOf("peer:onReady");
    const driverOnReadyIdx = bridge.calls.indexOf("driver:onReady");
    expect(startIdx).toBeGreaterThan(peerOnReadyIdx);
    expect(startIdx).toBeGreaterThan(driverOnReadyIdx);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });

  test("plugins without onReady() initialize without error", async () => {
    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasStart: true,
      startBody: `/* no-op */`,
    });
    const plainDir = writePlugin({ name: "plain" });

    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [plainDir, driverDir] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );

    await expect(manager.initialize()).resolves.toBeDefined();
    expect(manager.list().map((e) => e.name).sort()).toEqual(["driver", "plain"]);
  });
});
