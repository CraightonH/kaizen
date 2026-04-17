import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "../../src/types/plugin.js";
import {
  makeMockChannel,
  makeMockUiProvider,
  makeTestHarness,
} from "./test-helpers.js";

describe("two UIs driving one shared session (integration)", () => {
  test(
    "messages from either UI drive the shared session; output broadcasts to both",
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

      // Turn 1 — input on channel A; both receive echo.
      a.sendUserMessage("from-a");
      const a1 = await a.waitForSend(
        (m: AgentMessage) => m.type === "text" && m.content.startsWith("echo:from-a"),
      );
      const b1 = await b.waitForSend(
        (m: AgentMessage) => m.type === "text" && m.content.startsWith("echo:from-a"),
      );
      expect(a1.type).toBe("text");
      expect(b1.type).toBe("text");

      // Turn 2 — input on channel B; both receive echo.
      b.sendUserMessage("from-b");
      const a2 = await a.waitForSend(
        (m: AgentMessage) => m.type === "text" && m.content.startsWith("echo:from-b"),
      );
      const b2 = await b.waitForSend(
        (m: AgentMessage) => m.type === "text" && m.content.startsWith("echo:from-b"),
      );
      expect(a2.type).toBe("text");
      expect(b2.type).toBe("text");

      // Terminate — close both channels.
      a.close();
      b.close();
      await runPromise;

      // Sanity: each channel saw BOTH echoes.
      const aEchoes = a.sent.filter(
        (m) => m.type === "text" && (m.content.startsWith("echo:from-a") || m.content.startsWith("echo:from-b")),
      );
      const bEchoes = b.sent.filter(
        (m) => m.type === "text" && (m.content.startsWith("echo:from-a") || m.content.startsWith("echo:from-b")),
      );
      expect(aEchoes.length).toBe(2);
      expect(bEchoes.length).toBe(2);
    },
    10_000,
  );

  test(
    "closing one channel mid-session keeps session alive on the remaining channel",
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

      a.sendUserMessage("first");
      await a.waitForSend(
        (m: AgentMessage) => m.type === "text" && m.content.startsWith("echo:first"),
      );
      await b.waitForSend(
        (m: AgentMessage) => m.type === "text" && m.content.startsWith("echo:first"),
      );

      // Close A; session should continue via B.
      a.close();

      b.sendUserMessage("second");
      const echoB = await b.waitForSend(
        (m: AgentMessage) => m.type === "text" && m.content.startsWith("echo:second"),
      );
      expect(echoB.type).toBe("text");

      b.close();
      await runPromise;
    },
    10_000,
  );
});
