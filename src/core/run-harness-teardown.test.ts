// Test path: PluginManager.unloadAll() only (not a full runHarness invocation).
//
// Why: Bootstrapping a real runHarness in a test requires fixture work beyond
// what similar tests do (driver plugin on disk, kaizen config + lockfile wiring,
// initializePluginSystem's full path). The runHarness wiring is a one-liner
// (`await manager.unloadAll()` in finally) that's trivial to verify by
// inspection and is covered by the regression check in Task 9. Here we prove
// the mechanism: unloadAll() fires stop() on every loaded plugin and clears
// them from the registry.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PluginManager } from "./plugin-manager.js";
import { EventBus } from "./event-bus.js";
import { ServiceRegistry } from "./service-registry.js";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { AuditLog } from "./audit-log.js";

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
  stopBridgeKey: string;
}

function writePlugin(spec: PluginSpec): string {
  const dir = mkdtempSync(join(tmpdir(), `kz-unloadall-${spec.name}-`));
  createdDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: spec.name, version: "1.0.0", type: "module", main: "index.mjs",
  }));
  const parts: string[] = [];
  parts.push(`export default {`);
  parts.push(`  name: ${JSON.stringify(spec.name)},`);
  parts.push(`  apiVersion: "2",`);
  if (spec.driver) parts.push(`  driver: true,`);
  parts.push(`  async setup(ctx) {},`);
  if (spec.driver) parts.push(`  async start(ctx) {},`);
  parts.push(`  async stop(ctx) {`);
  parts.push(`    const b = globalThis[${JSON.stringify(spec.stopBridgeKey)}];`);
  parts.push(`    b.calls.push(${JSON.stringify(spec.name)});`);
  parts.push(`  },`);
  parts.push(`};`);
  writeFileSync(join(dir, "index.mjs"), parts.join("\n"));
  return dir;
}

describe("PluginManager.unloadAll", () => {
  test("calls stop() on every loaded plugin and clears the registry", async () => {
    const bridgeKey = `__kz_unloadall_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = { calls: [] as string[] };

    const driverDir = writePlugin({ name: "driver-plug", driver: true, stopBridgeKey: bridgeKey });
    const otherDir = writePlugin({ name: "other-plug", stopBridgeKey: bridgeKey });

    const eventBus = new EventBus();
    const serviceRegistry = new ServiceRegistry();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );

    await manager.load(driverDir);
    await manager.load(otherDir);
    expect(manager.list().map((e) => e.name).sort()).toEqual(["driver-plug", "other-plug"]);

    await manager.unloadAll();

    const bridge = (globalThis as unknown as Record<string, { calls: string[] }>)[bridgeKey]!;
    expect(bridge.calls.sort()).toEqual(["driver-plug", "other-plug"]);
    expect(manager.list()).toEqual([]);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });
});
