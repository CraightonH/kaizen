import { describe, test, expect } from "bun:test";
import { renderScopedUAC, renderUnscopedUAC } from "./uac-renderer.js";

describe("renderScopedUAC", () => {
  test("shows all declared permissions", () => {
    const out = renderScopedUAC({
      pluginName: "cool-unknown-plugin",
      version: "1.2.3",
      source: "https://npm.im/cool-unknown-plugin",
      permissions: {
        tier: "scoped",
        net: { connect: ["api.example.com:443"] },
        env: ["EXAMPLE_API_KEY"],
        events: { subscribe: ["core-lifecycle:tool:before"] },
      },
    });
    expect(out).toContain("cool-unknown-plugin@1.2.3");
    expect(out).toContain("SCOPED");
    expect(out).toContain("api.example.com:443");
    expect(out).toContain("EXAMPLE_API_KEY");
    expect(out).toContain("core-lifecycle:tool:before");
  });

  test("empty grants render as '(none)'", () => {
    const out = renderScopedUAC({
      pluginName: "x", version: "1.0", source: "",
      permissions: { tier: "scoped" },
    });
    expect(out).toContain("(none)");
  });

  test("fs wildcards rendered verbatim", () => {
    const out = renderScopedUAC({
      pluginName: "x", version: "1.0", source: "",
      permissions: { tier: "scoped", fs: { read: ["/**"] } },
    });
    expect(out).toContain("/**");
  });
});

describe("renderUnscopedUAC", () => {
  test("calls out full access and no enforcement", () => {
    const out = renderUnscopedUAC({
      pluginName: "x", version: "1.0", source: "https://x",
      permissions: { tier: "unscoped" },
    });
    expect(out).toContain("UNSCOPED");
    expect(out).toMatch(/full system access/i);
    expect(out).toMatch(/cannot enforce/i);
    expect(out).toContain("Type the plugin name");
  });
});
