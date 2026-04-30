import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installPlugin, installHarness, resolveBunExecutable, installDepsForTesting, readBundleExternalsForTesting, bundlePluginForTesting } from "./plugin-installer.js";
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

  it("resolves runtime deps after copying file source", async () => {
    const pluginSrc = join(upstream, "plugins", "with-deps");
    mkdirSync(pluginSrc, { recursive: true });
    writeFileSync(
      join(pluginSrc, "package.json"),
      JSON.stringify({
        name: "with-deps",
        version: "1.0.0",
        main: "index.js",
        dependencies: { "is-odd": "3.0.1" },
      }),
    );
    writeFileSync(join(pluginSrc, "index.js"), "export default { name: 'with-deps', apiVersion: '2', setup(){} };");

    await installPlugin("m", "with-deps", "1.0.0", { type: "file", path: "plugins/with-deps" });

    const target = pluginInstallDir("m", "with-deps", "1.0.0");
    expect(existsSync(join(target, "node_modules", "is-odd"))).toBe(true);
  }, 30_000);
});

describe("installPlugin — lockfile honored", () => {
  it("preserves bun.lock from source through install", async () => {
    const pluginSrc = join(upstream, "plugins", "locked");
    mkdirSync(pluginSrc, { recursive: true });
    // No dependencies so installDeps no-ops; we only need to verify cpSync
    // carries the committed lockfile through to the install dir.
    writeFileSync(
      join(pluginSrc, "package.json"),
      JSON.stringify({
        name: "locked",
        version: "1.0.0",
        main: "index.js",
      }),
    );
    writeFileSync(join(pluginSrc, "index.js"), "export default { name: 'locked', apiVersion: '2', setup(){} };");
    // A pre-existing bun.lock in the source — bun will use it.
    // We can't easily fabricate a valid binary lockfile in a test, so we just
    // verify that any lockfile present in source is copied into target.
    writeFileSync(join(pluginSrc, "bun.lock"), "{}\n");

    await installPlugin("m", "locked", "1.0.0", { type: "file", path: "plugins/locked" });

    const target = pluginInstallDir("m", "locked", "1.0.0");
    expect(existsSync(join(target, "bun.lock"))).toBe(true);
  }, 30_000);
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

describe("readBundleExternals", () => {
  it("returns [] when kaizen field is missing", () => {
    expect(readBundleExternalsForTesting({ name: "x", version: "1" })).toEqual([]);
  });

  it("returns [] when kaizen.bundleExternals is missing", () => {
    expect(readBundleExternalsForTesting({ kaizen: {} })).toEqual([]);
  });

  it("returns the array verbatim when well-formed", () => {
    expect(readBundleExternalsForTesting({
      kaizen: { bundleExternals: ["react-devtools-core", "fsevents"] },
    })).toEqual(["react-devtools-core", "fsevents"]);
  });

  it("returns [] when kaizen is not an object", () => {
    expect(readBundleExternalsForTesting({ kaizen: "nope" })).toEqual([]);
    expect(readBundleExternalsForTesting({ kaizen: null })).toEqual([]);
    expect(readBundleExternalsForTesting({ kaizen: ["a"] })).toEqual([]);
  });

  it("returns [] when bundleExternals is not an array", () => {
    expect(readBundleExternalsForTesting({ kaizen: { bundleExternals: "react" } })).toEqual([]);
    expect(readBundleExternalsForTesting({ kaizen: { bundleExternals: { a: 1 } } })).toEqual([]);
  });

  it("filters non-string entries", () => {
    expect(readBundleExternalsForTesting({
      kaizen: { bundleExternals: ["ok", 42, null, "also-ok"] },
    })).toEqual(["ok", "also-ok"]);
  });
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

  it("passes kaizen.bundleExternals as --external flags to bun build", async () => {
    // Fake bun executable that records argv and writes a stub bundle.
    const fakeBun = join(target, "fake-bun.sh");
    const argLog = join(target, "args.log");
    writeFileSync(
      fakeBun,
      `#!/bin/sh
echo "$@" > ${JSON.stringify(argLog)}
# argv: build --target=bun --outfile=<...> [--external X]... <entry>
# Find --outfile=<path> and create the file.
for a in "$@"; do
  case "$a" in
    --outfile=*)
      out="\${a#--outfile=}"
      mkdir -p "$(dirname "$out")"
      echo "// stub" > "$out"
      ;;
  esac
done
exit 0
`,
    );
    chmodSync(fakeBun, 0o755);

    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({
        name: "with-ext",
        version: "1.0.0",
        type: "module",
        main: "index.js",
        kaizen: { bundleExternals: ["react-devtools-core", "fsevents"] },
      }),
    );
    writeFileSync(join(target, "index.js"), "export default { name: 'x', apiVersion: '2', setup(){} };");

    await bundlePluginForTesting(target, "with-ext", "1.0.0", () => fakeBun);

    const argv = readFileSync(argLog, "utf8");
    expect(argv).toContain("--external react-devtools-core");
    expect(argv).toContain("--external fsevents");
    expect(argv).toContain("--target=bun");
    expect(existsSync(join(target, "dist", "index.js"))).toBe(true);
  });
});
