import { hostApi } from "../host-api.js";
import { warn, fatal } from "./errors.js";

let registered = false;

/**
 * Register the `kaizen/types` virtual module with bun's runtime resolver.
 * Must be called once at binary boot, before any dynamic plugin import.
 * Safe to call again — subsequent calls warn and no-op.
 */
export function registerHostApi(): void {
  if (registered) {
    warn("registerHostApi() called more than once; ignoring subsequent call");
    return;
  }
  if (typeof Bun === "undefined" || typeof Bun.plugin !== "function") {
    fatal("kaizen requires the bun runtime; Bun.plugin is unavailable");
  }
  Bun.plugin({
    name: "kaizen-host-api",
    setup(build) {
      build.module("kaizen/types", () => ({
        loader: "object",
        exports: hostApi as unknown as Record<string, unknown>,
      }));
    },
  });
  registered = true;
}

/** Test-only: reset the one-shot flag. Do not call from production code. */
export function _resetForTesting(): void {
  registered = false;
}
