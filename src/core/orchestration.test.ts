import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { bootstrap } from "./index.js";
import { bootstrapMissingPlugins } from "./bootstrap.js";
import type { KaizenPlugin } from "../types/plugin.js";

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

    const observed: string[] = [];
    const payloads: Record<string, unknown[]> = {};
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
    const spy: KaizenPlugin = {
      name: "spy",
      apiVersion: "2",
      permissions: { tier: "scoped", events: { subscribe: ["*"] } },
      async setup(ctx) {
        for (const name of EVENTS) {
          ctx.on(name, async (payload) => {
            observed.push(name);
            (payloads[name] ??= []).push(payload);
          });
        }
      },
    };

    await bootstrap(
      {
        plugins: [
          "ci/fixture-events@1.0.0",
          "spy",
          "ci/fixture-executor@1.0.0",
          "ci/fixture-ui@1.0.0",
          "ci/fixture-lifecycle@1.0.0",
        ],
        marketplaces: [{ id: "ci", url: FIXTURE_MARKETPLACE }],
      },
      { spy },
    );

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
  });
});
