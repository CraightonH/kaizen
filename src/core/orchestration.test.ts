import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { bootstrap } from "./index.js";
import { bootstrapMissingPlugins } from "./bootstrap.js";
import { writeLockfile, upsertPluginEntry, readLockfile } from "./lockfile.js";
import { canonicalTierGrantHash } from "./plugin-hash.js";

const FIXTURE_MARKETPLACE = resolve(process.cwd(), "tests", "fixtures", "ci-marketplace");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kz-orch-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("core orchestration against ci-marketplace fixtures", () => {
  it("boots plugins, runs one session turn, tears down cleanly", async () => {
    const lockfilePath = join(home, "kaizen.permissions.lock");
    await bootstrapMissingPlugins(
      {
        plugins: [
          "ci/fixture-events@1.0.0",
          "ci/fixture-executor@1.0.0",
          "ci/fixture-ui@1.0.0",
          "ci/fixture-lifecycle@1.0.0",
        ],
        marketplaces: [{ id: "ci", url: FIXTURE_MARKETPLACE }],
      },
      { lockfilePath, trustLockfile: false, nonInteractive: true, allowUnscoped: true },
    );

    const EVENTS = [
      "test:lifecycle:start",
      "session:start",
      "session:user_message",
      "test:executor:send",
      "session:response",
      "test:ui:sent",
      "session:end",
      "test:lifecycle:end",
    ];

    // Write spy plugin to disk; stash observations in globalThis to
    // bridge back to the test after the plugin runs in its own module scope.
    const bridgeKey = `__kaizen_spy_${Date.now()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = { observed: [], payloads: {} };
    const spyDir = mkdtempSync(join(tmpdir(), "kz-orch-spy-"));
    writeFileSync(join(spyDir, "package.json"), JSON.stringify({
      name: "spy", version: "1.0.0", type: "module", main: "index.mjs",
    }));
    writeFileSync(join(spyDir, "index.mjs"), [
      `const BRIDGE = globalThis[${JSON.stringify(bridgeKey)}];`,
      `const EVENTS = ${JSON.stringify(EVENTS)};`,
      `export default {`,
      `  name: "spy",`,
      `  apiVersion: "2",`,
      `  permissions: { tier: "scoped", events: { subscribe: ["*"] } },`,
      `  async setup(ctx) {`,
      `    for (const name of EVENTS) {`,
      `      ctx.on(name, async (payload) => {`,
      `        BRIDGE.observed.push(name);`,
      `        (BRIDGE.payloads[name] ??= []).push(payload);`,
      `      });`,
      `    }`,
      `  },`,
      `};`,
    ].join("\n"));

    // Pre-consent the scoped spy plugin by seeding the lockfile.
    // bootstrap() reads cwd()/kaizen.permissions.lock; we write a matching entry.
    const cwdLockfile = join(process.cwd(), "kaizen.permissions.lock");
    const hadLockfile = existsSync(cwdLockfile);
    const lockBackup = hadLockfile ? readLockfile(cwdLockfile) : null;
    const spyPerms = { tier: "scoped" as const, events: { subscribe: ["*"] } };
    const spyHash = canonicalTierGrantHash(spyPerms);
    const seeded = upsertPluginEntry(lockBackup ?? { version: 1, plugins: {} }, "spy", {
      version: "1.0.0",
      hash: spyHash,
      tier: "scoped",
      consentedAt: new Date().toISOString(),
      consentedBy: "test",
      permissions: { events: { subscribe: ["*"] } },
    });
    writeLockfile(cwdLockfile, seeded);
    try {
      await bootstrap({
        plugins: [
          "ci/fixture-events@1.0.0",
          spyDir,
          "ci/fixture-executor@1.0.0",
          "ci/fixture-ui@1.0.0",
          "ci/fixture-lifecycle@1.0.0",
        ],
        marketplaces: [{ id: "ci", url: FIXTURE_MARKETPLACE }],
      });

      const { observed, payloads } = (globalThis as unknown as Record<string, { observed: string[]; payloads: Record<string, unknown[]> }>)[bridgeKey]!;

      expect(observed).toEqual([
        "test:lifecycle:start",
        "session:start",
        "session:user_message",
        "test:executor:send",
        "session:response",
        "test:ui:sent",
        "session:end",
        "test:lifecycle:end",
      ]);
      expect(payloads["test:executor:send"]?.[0]).toMatchObject({ messageCount: 1 });
      expect(payloads["session:response"]?.[0]).toMatchObject({ content: "fixture response" });
    } finally {
      if (hadLockfile && lockBackup) writeLockfile(cwdLockfile, lockBackup);
      else if (existsSync(cwdLockfile)) rmSync(cwdLockfile, { force: true });
      delete (globalThis as Record<string, unknown>)[bridgeKey];
      rmSync(spyDir, { recursive: true, force: true });
    }
  });
});
