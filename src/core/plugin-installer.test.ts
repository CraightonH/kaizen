import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installPlugin, installHarness, resolveBunExecutable, installDepsForTesting, bundlePluginForTesting } from "./plugin-installer.js";
import { pluginInstallDir, harnessInstallDir, marketplaceRepoDir } from "./kaizen-config.js";

let home: string;
let upstream: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
  upstream = mkdtempSync(join(tmpdir(), "kz-up-"));
  // Simulate an "added" marketplace whose repo is the upstream dir (symlink).
  mkdirSync(join(home, "marketplaces", "m"), { recursive: true });
  symlinkSync(upstream, marketplaceRepoDir("m"), "dir");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(upstream, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("installPlugin — file source", () => {
  it("copies plugin contents into pluginInstallDir", async () => {
    const pluginSrc = join(upstream, "plugins", "demo");
    mkdirSync(pluginSrc, { recursive: true });
    writeFileSync(join(pluginSrc, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(pluginSrc, "index.js"), "export default { name: 'demo', apiVersion: '2', setup(){} };");

    await installPlugin("m", "demo", "1.0.0",
      { type: "file", path: "plugins/demo" });

    const target = pluginInstallDir("m", "demo", "1.0.0");
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "index.js"))).toBe(true);
  });

});

describe("resolveBunExecutable", () => {
  it("returns 'bun' when bun is on PATH", () => {
    // The test runner is bun itself, so `bun` resolves on PATH.
    const got = resolveBunExecutable();
    expect(got).not.toBeNull();
    // Either "bun" (PATH hit) or an absolute path ending with /bin/bun.
    expect(got === "bun" || got!.endsWith("/bin/bun")).toBe(true);
  });

  it("falls back to ~/.bun/bin/bun when not on PATH", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "kz-bun-home-"));
    const fakeBunDir = join(fakeHome, ".bun", "bin");
    mkdirSync(fakeBunDir, { recursive: true });
    const fakeBun = join(fakeBunDir, "bun");
    writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBun, 0o755);

    const origPath = process.env.PATH;
    const origHome = process.env.HOME;
    process.env.PATH = "/nonexistent-empty-path";
    process.env.HOME = fakeHome;
    try {
      expect(resolveBunExecutable()).toBe(fakeBun);
    } finally {
      process.env.PATH = origPath;
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns null when bun is nowhere", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "kz-bun-home-"));
    const origPath = process.env.PATH;
    const origHome = process.env.HOME;
    process.env.PATH = "/nonexistent-empty-path";
    process.env.HOME = fakeHome;
    try {
      expect(resolveBunExecutable()).toBeNull();
    } finally {
      process.env.PATH = origPath;
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("installDeps — no-op cases", () => {
  let target: string;
  beforeEach(() => { target = mkdtempSync(join(tmpdir(), "kz-deps-")); });
  afterEach(() => { rmSync(target, { recursive: true, force: true }); });

  it("no-ops when package.json missing", async () => {
    await installDepsForTesting(target, "demo", "1.0.0");
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  });

  it("no-ops when package.json has no dependencies field", async () => {
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
    await installDepsForTesting(target, "demo", "1.0.0");
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  });

  it("no-ops when dependencies is an empty object", async () => {
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", dependencies: {} }));
    await installDepsForTesting(target, "demo", "1.0.0");
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  });

  it("no-ops when package.json is malformed", async () => {
    writeFileSync(join(target, "package.json"), "{ not valid json");
    await installDepsForTesting(target, "demo", "1.0.0");
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  });
});

describe("installDeps — runs bun install", () => {
  it("creates node_modules/<dep> for a declared runtime dep", async () => {
    const target = mkdtempSync(join(tmpdir(), "kz-deps-real-"));
    try {
      writeFileSync(
        join(target, "package.json"),
        JSON.stringify({
          name: "demo",
          version: "1.0.0",
          dependencies: { "is-odd": "3.0.1" },
        }),
      );

      await installDepsForTesting(target, "demo", "1.0.0");

      expect(existsSync(join(target, "node_modules", "is-odd"))).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }, 30_000); // network + cache pull on first run
});

describe("installDeps — failure path", () => {
  it("wipes target and throws with bun stderr when bun install fails", async () => {
    const target = mkdtempSync(join(tmpdir(), "kz-deps-fail-"));
    try {
      writeFileSync(
        join(target, "package.json"),
        JSON.stringify({
          name: "demo",
          version: "1.0.0",
          // Scoped name in a kaizen-reserved scope guaranteed not to exist.
          dependencies: { "@kaizen-test-does-not-exist/nope": "1.0.0" },
        }),
      );
      writeFileSync(join(target, "marker.txt"), "x");

      let err: Error | null = null;
      try {
        await installDepsForTesting(target, "demo", "1.0.0");
      } catch (e) {
        err = e as Error;
      }

      expect(err).not.toBeNull();
      expect(err!.message).toContain("bun install failed for plugin 'demo@1.0.0'");
      expect(existsSync(target)).toBe(false); // wiped
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("installDeps — bun missing", () => {
  it("throws with install instructions when no bun is resolvable", async () => {
    const target = mkdtempSync(join(tmpdir(), "kz-deps-nobun-"));
    try {
      writeFileSync(
        join(target, "package.json"),
        JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { "is-odd": "3.0.1" } }),
      );

      let err: Error | null = null;
      try {
        await installDepsForTesting(target, "demo", "1.0.0", () => null);
      } catch (e) {
        err = e as Error;
      }

      expect(err).not.toBeNull();
      expect(err!.message).toContain("bun is not on PATH or at ~/.bun/bin/bun");
      expect(err!.message).toContain("curl -fsSL https://bun.sh/install | bash");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("installHarness", () => {
  it("copies the harness JSON into harnessInstallDir/kaizen.json", async () => {
    const hSrc = join(upstream, "harnesses", "anth.json");
    mkdirSync(join(upstream, "harnesses"), { recursive: true });
    const doc = { plugins: ["official/timestamps@1.0.0"] };
    writeFileSync(hSrc, JSON.stringify(doc));

    await installHarness("m", "anthropic-default", "harnesses/anth.json");

    const target = join(harnessInstallDir("m", "anthropic-default"), "kaizen.json");
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(doc);
  });
});

describe("installPlugin — bundling", () => {
  it("produces dist/index.js and removes node_modules after a deps-free file install", async () => {
    const pluginSrc = join(upstream, "plugins", "trivial");
    mkdirSync(pluginSrc, { recursive: true });
    writeFileSync(
      join(pluginSrc, "package.json"),
      JSON.stringify({ name: "trivial", version: "1.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(
      join(pluginSrc, "index.js"),
      "export default { name: 'trivial', apiVersion: '2', setup(){} };",
    );

    await installPlugin("m", "trivial", "1.0.0", { type: "file", path: "plugins/trivial" });

    const target = pluginInstallDir("m", "trivial", "1.0.0");
    expect(existsSync(join(target, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(target, "node_modules"))).toBe(false);
    expect(existsSync(join(target, "index.js"))).toBe(true);
    expect(existsSync(join(target, "package.json"))).toBe(true);
  }, 30_000);

  it("produces dist/index.js and removes node_modules after a with-deps file install", async () => {
    const pluginSrc = join(upstream, "plugins", "with-deps");
    mkdirSync(pluginSrc, { recursive: true });
    writeFileSync(
      join(pluginSrc, "package.json"),
      JSON.stringify({
        name: "with-deps",
        version: "1.0.0",
        type: "module",
        main: "index.js",
        dependencies: { "is-odd": "3.0.1" },
      }),
    );
    writeFileSync(
      join(pluginSrc, "index.js"),
      "import isOdd from 'is-odd'; export default { name: 'with-deps', apiVersion: '2', setup(){ isOdd(1); } };",
    );

    await installPlugin("m", "with-deps", "1.0.0", { type: "file", path: "plugins/with-deps" });

    const target = pluginInstallDir("m", "with-deps", "1.0.0");
    expect(existsSync(join(target, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  }, 60_000);
});

describe("installPlugin — workspace deps", () => {
  function writeCatalog(entries: Array<{ name: string; version: string; path: string }>): void {
    const catDir = join(upstream, ".kaizen");
    mkdirSync(catDir, { recursive: true });
    writeFileSync(join(catDir, "marketplace.json"), JSON.stringify({
      version: "1.0.0",
      name: "m",
      url: "https://example.invalid/m.git",
      entries: entries.map((e) => ({
        kind: "plugin",
        name: e.name,
        versions: [{ version: e.version, source: { type: "file", path: e.path } }],
      })),
    }));
  }

  it("flattens workspace:* deps into file: paths and bundles cleanly", async () => {
    const leafSrc = join(upstream, "plugins", "leaf");
    mkdirSync(leafSrc, { recursive: true });
    writeFileSync(
      join(leafSrc, "package.json"),
      JSON.stringify({ name: "leaf", version: "1.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(join(leafSrc, "index.js"), "export const greet = () => 'hi-from-leaf';");

    const consumerSrc = join(upstream, "plugins", "consumer");
    mkdirSync(consumerSrc, { recursive: true });
    writeFileSync(
      join(consumerSrc, "package.json"),
      JSON.stringify({
        name: "consumer", version: "1.0.0", type: "module", main: "index.js",
        dependencies: { leaf: "workspace:*" },
      }),
    );
    writeFileSync(
      join(consumerSrc, "index.js"),
      "import { greet } from 'leaf'; export default { name: 'consumer', apiVersion: '2', setup(){ greet(); } };",
    );
    writeCatalog([
      { name: "leaf", version: "1.0.0", path: "plugins/leaf" },
      { name: "consumer", version: "1.0.0", path: "plugins/consumer" },
    ]);

    await installPlugin("m", "consumer", "1.0.0", { type: "file", path: "plugins/consumer" });

    const target = pluginInstallDir("m", "consumer", "1.0.0");
    expect(existsSync(join(target, "dist", "index.js"))).toBe(true);
    // .kaizen-workspace-deps is scratch; should be cleaned up post-bundle.
    expect(existsSync(join(target, ".kaizen-workspace-deps"))).toBe(false);
    // Bundle inlines leaf source.
    expect(readFileSync(join(target, "dist", "index.js"), "utf8")).toContain("hi-from-leaf");
  }, 60_000);

  it("flattens transitive workspace chains (a → b → c)", async () => {
    const cSrc = join(upstream, "plugins", "c");
    mkdirSync(cSrc, { recursive: true });
    writeFileSync(join(cSrc, "package.json"),
      JSON.stringify({ name: "c", version: "1.0.0", type: "module", main: "index.js" }));
    writeFileSync(join(cSrc, "index.js"), "export const cVal = 'val-from-c';");

    const bSrc = join(upstream, "plugins", "b");
    mkdirSync(bSrc, { recursive: true });
    writeFileSync(join(bSrc, "package.json"), JSON.stringify({
      name: "b", version: "1.0.0", type: "module", main: "index.js",
      dependencies: { c: "workspace:*" },
    }));
    writeFileSync(join(bSrc, "index.js"), "import { cVal } from 'c'; export const bVal = cVal + '-via-b';");

    const aSrc = join(upstream, "plugins", "a");
    mkdirSync(aSrc, { recursive: true });
    writeFileSync(join(aSrc, "package.json"), JSON.stringify({
      name: "a", version: "1.0.0", type: "module", main: "index.js",
      dependencies: { b: "workspace:*" },
    }));
    writeFileSync(join(aSrc, "index.js"),
      "import { bVal } from 'b'; export default { name: 'a', apiVersion: '2', setup(){ console.log(bVal); } };");

    writeCatalog([
      { name: "a", version: "1.0.0", path: "plugins/a" },
      { name: "b", version: "1.0.0", path: "plugins/b" },
      { name: "c", version: "1.0.0", path: "plugins/c" },
    ]);

    await installPlugin("m", "a", "1.0.0", { type: "file", path: "plugins/a" });

    const target = pluginInstallDir("m", "a", "1.0.0");
    const bundled = readFileSync(join(target, "dist", "index.js"), "utf8");
    expect(bundled).toContain("val-from-c");
    expect(bundled).toContain("-via-b");
  }, 60_000);

  it("throws when a workspace dep names a plugin not in the marketplace", async () => {
    const src = join(upstream, "plugins", "broken");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "package.json"), JSON.stringify({
      name: "broken", version: "1.0.0", type: "module", main: "index.js",
      dependencies: { ghost: "workspace:*" },
    }));
    writeFileSync(join(src, "index.js"), "export default {};");
    writeCatalog([{ name: "broken", version: "1.0.0", path: "plugins/broken" }]);

    await expect(installPlugin("m", "broken", "1.0.0", { type: "file", path: "plugins/broken" }))
      .rejects.toThrow(/workspace dep 'ghost' is not published/);
  }, 30_000);
});

describe("bundlePlugin", () => {
  let target: string;
  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), "kz-bundle-"));
  });
  afterEach(() => {
    rmSync(target, { recursive: true, force: true });
  });

  it("produces dist/index.js for a deps-free plugin and removes node_modules/lockfiles", async () => {
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ name: "trivial", version: "1.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(
      join(target, "index.js"),
      "export default { name: 'trivial', apiVersion: '2', setup(){} };",
    );
    // Pretend a previous installDeps left these behind.
    mkdirSync(join(target, "node_modules"), { recursive: true });
    writeFileSync(join(target, "node_modules", "marker"), "");
    writeFileSync(join(target, "bun.lock"), "{}\n");

    await bundlePluginForTesting(target, "trivial", "1.0.0");

    expect(existsSync(join(target, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(target, "node_modules"))).toBe(false);
    expect(existsSync(join(target, "bun.lock"))).toBe(false);
    // Source survives.
    expect(existsSync(join(target, "index.js"))).toBe(true);
    expect(existsSync(join(target, "package.json"))).toBe(true);
  }, 30_000);

  it("rolls back target and includes stderr when bun build fails", async () => {
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ name: "broken", version: "1.0.0", type: "module", main: "index.js" }),
    );
    // Syntax error: unterminated string.
    writeFileSync(join(target, "index.js"), "export default { broken: 'oops");

    await expect(bundlePluginForTesting(target, "broken", "1.0.0")).rejects.toThrow(/bun build failed/);
    expect(existsSync(target)).toBe(false);
  }, 30_000);

});
