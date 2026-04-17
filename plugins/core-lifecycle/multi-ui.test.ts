import { describe, expect, test } from "bun:test";
import {
  makeMockChannel,
  makeMockUiProvider,
  makeTestHarness,
} from "./test-helpers.js";

describe("core-lifecycle multi-UI race + broadcast", () => {
  test(
    "single user message on one channel triggers broadcast to all channels",
    async () => {
      const a = makeMockChannel("ui-a");
      const b = makeMockChannel("ui-b");

      const harness = await makeTestHarness({
        uiProviderPlugins: [
          makeMockUiProvider([a.channel], "mock-ui-a"),
          makeMockUiProvider([b.channel], "mock-ui-b"),
        ],
      });

      const runPromise = harness.run();

      // Send from A; both A and B should receive the echo.
      a.sendUserMessage("hello");

      const msgA = await a.waitForSend(
        (m) => m.type === "text" && m.content.startsWith("echo:hello"),
      );
      const msgB = await b.waitForSend(
        (m) => m.type === "text" && m.content.startsWith("echo:hello"),
      );

      expect(msgA.type).toBe("text");
      expect(msgB.type).toBe("text");

      // Close both channels to exit the session loop.
      a.close();
      b.close();
      await runPromise;
    },
    10_000,
  );

  test(
    "zero channels returns cleanly (headless)",
    async () => {
      const harness = await makeTestHarness({
        uiProviderPlugins: [makeMockUiProvider([], "mock-ui-empty")],
      });
      await harness.run();
    },
    10_000,
  );
});
