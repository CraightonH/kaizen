import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PluginManager } from "./plugin-manager.js";
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
  setupBody?: string;
  stopBody?: string;
  hasStop?: boolean;
}

function writePlugin(spec: PluginSpec): string {
  const dir = mkdtempSync(join(tmpdir(), `kz-pm-stop-${spec.name}-`));
  createdDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: spec.name, version: "1.0.0", type: "module", main: "index.mjs",
  }));
  const parts: string[] = [];
  parts.push(`export default {`);
  parts.push(`  name: ${JSON.stringify(spec.name)},`);
  parts.push(`  apiVersion: "2",`);
  parts.push(`  async setup(ctx) {`);
  if (spec.setupBody) parts.push(spec.setupBody);
  parts.push(`  },`);
  if (spec.hasStop) {
    parts.push(`  async stop(ctx) {`);
    if (spec.stopBody) parts.push(spec.stopBody);
    parts.push(`  },`);
  }
  parts.push(`};`);
  writeFileSync(join(dir, "index.mjs"), parts.join("\n"));
  return dir;
}

describe("PluginManager.unload calls stop()", () => {
  test("unload calls plugin.stop(ctx) before deregistering", async () => {
    const bridgeKey = `__kz_stop_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = {
      calls: 0,
      hasLog: false,
      hasEmit: false,
    };
    const dir = writePlugin({
      name: "stoppable",
      hasStop: true,
      stopBody: `
        const b = globalThis[${JSON.stringify(bridgeKey)}];
        b.calls += 1;
        b.hasLog = typeof ctx?.log === "function";
        b.hasEmit = typeof ctx?.emit === "function";
      `,
    });

    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.load(dir);
    expect(manager.list().map((e) => e.name)).toContain("stoppable");

    await manager.unload(dir);

    const bridge = (globalThis as unknown as Record<string, { calls: number; hasLog: boolean; hasEmit: boolean }>)[bridgeKey]!;
    expect(bridge.calls).toBe(1);
    expect(bridge.hasLog).toBe(true);
    expect(bridge.hasEmit).toBe(true);
    expect(manager.list().map((e) => e.name)).not.toContain("stoppable");
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });

  test("unload succeeds when plugin has no stop()", async () => {
    const dir = writePlugin({ name: "no-stop-plugin" });
    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.load(dir);
    expect(manager.list().map((e) => e.name)).toContain("no-stop-plugin");
    await expect(manager.unload(dir)).resolves.toBeUndefined();
    expect(manager.list().map((e) => e.name)).not.toContain("no-stop-plugin");
  });

  test("unload logs but does not block deregistration when stop() throws", async () => {
    const dir = writePlugin({
      name: "bad-stopper",
      hasStop: true,
      stopBody: `throw new Error("stop kaboom");`,
    });
    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.load(dir);
    expect(manager.list().map((e) => e.name)).toContain("bad-stopper");

    await expect(manager.unload(dir)).resolves.toBeUndefined();
    expect(manager.list().map((e) => e.name)).not.toContain("bad-stopper");
  });
});
