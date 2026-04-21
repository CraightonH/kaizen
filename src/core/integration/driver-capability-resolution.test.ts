import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { PluginManager } from "../plugin-manager.js";
import { EventBus } from "../event-bus.js";
import { ServiceRegistry } from "../service-registry.js";
import { CapabilityRegistry } from "../capability-registry.js";
import { PermissionEnforcer } from "../permission-enforcer.js";
import { AuditLog } from "../audit-log.js";
import { addMarketplace } from "../marketplace.js";
import { runUnifiedInstall } from "../../commands/install.js";
import type { KaizenConfig } from "../../types/plugin.js";

const CI_MARKETPLACE = resolve(__dirname, "../../../tests/fixtures/ci-marketplace");
const MARKETPLACE_ID = "ci-marketplace";

async function installFixtures(names: string[], lockfilePath: string): Promise<void> {
  await addMarketplace(CI_MARKETPLACE, { id: MARKETPLACE_ID, local: true });
  for (const name of names) {
    const code = await runUnifiedInstall({
      ref: `${MARKETPLACE_ID}/${name}@1.0.0`,
      lockfilePath,
      allowUnscoped: false,
      nonInteractive: true,
    });
    if (code !== 0) throw new Error(`install failed for ${name} (code ${code})`);
  }
}

function makeHarness(pluginRefs: string[], lockfilePath: string) {
  const eventBus = new EventBus();
  const capabilityRegistry = new CapabilityRegistry();
  const serviceRegistry = new ServiceRegistry();
  const enforcer = new PermissionEnforcer({ mode: "log-only" });
  const auditLog = new AuditLog({
    rootDir: mkdtempSync(join(tmpdir(), "kz-driver-cap-audit-")),
    sessionId: "test",
    enabled: false,
  });
  const options = { trustLockfile: false, allowUnscoped: false, nonInteractive: true };
  const config: KaizenConfig = { plugins: pluginRefs };

  const manager = new PluginManager(
    config, {},
    eventBus, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, options,
  );
  return { manager, capabilityRegistry };
}

describe("driver capability resolution (post-registry-refactor)", () => {
  let home: string;
  let lockfilePath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kz-driver-cap-home-"));
    process.env.KAIZEN_HOME_OVERRIDE = home;
    lockfilePath = join(mkdtempSync(join(tmpdir(), "kz-driver-cap-lock-")), "kaizen.permissions.lock");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.KAIZEN_HOME_OVERRIDE;
  });

  it("resolves a provider by name via CapabilityRegistry when one plugin provides it", async () => {
    await installFixtures(["cap-provider", "cap-driver"], lockfilePath);

    const { manager, capabilityRegistry } = makeHarness(
      [`${MARKETPLACE_ID}/cap-provider@1.0.0`, `${MARKETPLACE_ID}/cap-driver@1.0.0`],
      lockfilePath,
    );

    await manager.initialize();
    expect(capabilityRegistry.providersOf("cap-provider:thing")).toContain("cap-provider");
  });

  it("fails initialization when a cardinality-one capability has two providers", async () => {
    await installFixtures(
      ["cap-owner", "cap-dup-a", "cap-dup-b", "cap-driver-conflict"],
      lockfilePath,
    );

    const { manager } = makeHarness(
      [
        `${MARKETPLACE_ID}/cap-owner@1.0.0`,
        `${MARKETPLACE_ID}/cap-dup-a@1.0.0`,
        `${MARKETPLACE_ID}/cap-dup-b@1.0.0`,
        `${MARKETPLACE_ID}/cap-driver-conflict@1.0.0`,
      ],
      lockfilePath,
    );

    await expect(manager.initialize()).rejects.toThrow(/Multiple plugins provide/);
  });
});
