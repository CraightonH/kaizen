import { describe, it, expect, mock } from "bun:test";
import { registerHostApi, _resetForTesting } from "./host-api-register.js";
import { hostApi } from "../host-api.js";

describe("registerHostApi", () => {
  it("makes `kaizen/types` resolvable with the host-api exports", async () => {
    _resetForTesting();
    registerHostApi();
    const mod = (await import("kaizen/types")) as Record<string, unknown>;
    expect(mod.createLLMRuntime).toBe(hostApi.createLLMRuntime);
    expect(mod.readStdinLine).toBe(hostApi.readStdinLine);
    expect(mod.PLUGIN_API_VERSION).toBe(hostApi.PLUGIN_API_VERSION);
  });

  it("warns on second call and does not throw", () => {
    _resetForTesting();
    registerHostApi();
    const errorSpy = mock((_msg: string) => {});
    const originalError = console.error;
    console.error = errorSpy;
    try {
      registerHostApi(); // must not throw
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      console.error = originalError;
    }
  });
});
