/**
 * Day 1 spike: verify plugin resolution AND loading works from a compiled Bun binary.
 *
 * Tests three things a real plugin dev needs to work:
 *   1. require.resolve() finds an ESM package (exports field, no main field)
 *   2. import() on the resolved path actually loads the module
 *   3. A plugin with its own dependency can resolve that dep at runtime
 *
 * Prior finding: createRequire(import.meta.url) fails — import.meta.url resolves
 * to "/$bunfs/root/<name>" inside a compiled binary. Fix: anchor to process.execPath.
 *
 * Run via: bun run spike
 * Prerequisite: bun add --global is-odd
 *               (probe plugin at /tmp/kaizen-probe-plugin — created by spike script)
 */
import { createRequire } from "module";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Setup: write a minimal ESM plugin with a dependency to /tmp
// ---------------------------------------------------------------------------
const PLUGIN_DIR = "/tmp/kaizen-probe-plugin";
const PLUGIN_NAME = "kaizen-probe-plugin"; // resolved by name from global node_modules
const DEP_PACKAGE = "is-odd"; // must be globally installed: bun add --global is-odd

function writeProbePlugin() {
  mkdirSync(PLUGIN_DIR, { recursive: true });
  writeFileSync(
    join(PLUGIN_DIR, "package.json"),
    JSON.stringify({
      name: "kaizen-probe-plugin",
      version: "1.0.0",
      type: "module",
      // ESM-only: exports field, no "main" — this is how real plugins will ship
      exports: { ".": "./index.js" },
    }, null, 2)
  );
  // Plugin imports a dependency (is-odd) — tests that plugin deps resolve correctly
  writeFileSync(
    join(PLUGIN_DIR, "index.js"),
    `import isOdd from 'is-odd';
export default {
  name: 'kaizen-probe-plugin',
  apiVersion: '1.0.0',
  async setup(ctx) {
    const result = isOdd(3);
    ctx.log('dep call result (isOdd(3)): ' + result);
  }
};
`
  );
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------
function getBunGlobalRoot(): string {
  try {
    const line = execSync("bun pm ls --global 2>/dev/null", { timeout: 5000 })
      .toString()
      .split("\n")[0] ?? "";
    const match = line.match(/^(\S+)\s+node_modules/);
    return match ? `${match[1]}/node_modules` : "";
  } catch {
    return "";
  }
}

function getNpmGlobalRoot(): string {
  try {
    return execSync("npm root -g 2>/dev/null", { timeout: 5000 }).toString().trim();
  } catch {
    return "";
  }
}

// Resolve a package to an absolute path, trying explicit paths first.
// Falls back to require.resolve default resolution.
function resolvePlugin(name: string, extraPaths: string[]): string {
  const require = createRequire(process.execPath);
  return require.resolve(name, { paths: extraPaths });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  writeProbePlugin();

  const bunGlobal = getBunGlobalRoot();
  const npmGlobal = getNpmGlobalRoot();
  const resolvePaths = [
    ...(bunGlobal ? [bunGlobal] : []),
    ...(npmGlobal ? [npmGlobal] : []),
    process.cwd() + "/node_modules",
    // Local path support: plugins referenced by path in kaizen.json
    PLUGIN_DIR,
  ].filter(Boolean);

  console.log(`process.execPath : ${process.execPath}`);
  console.log(`bun global root  : ${bunGlobal || "(not found)"}`);
  console.log(`resolve paths    : ${resolvePaths.join(", ")}`);
  console.log("");

  let passed = 0;
  let failed = 0;

  async function test(label: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`PASS  ${label}`);
      passed++;
    } catch (err) {
      console.error(`FAIL  ${label}`);
      console.error(`      ${err}`);
      failed++;
    }
  }

  // Test 1: resolve a CJS package (baseline from prior spike)
  await test("require.resolve — CJS package with 'main' field (is-odd)", async () => {
    resolvePlugin(DEP_PACKAGE, resolvePaths);
  });

  // Test 2: resolve an ESM package with only 'exports' field (no 'main')
  // Resolved by NAME from global node_modules (simulates real installed plugin)
  await test("require.resolve — ESM package with 'exports' only (probe plugin, by name)", async () => {
    const resolved = resolvePlugin(PLUGIN_NAME, resolvePaths);
    console.log(`        resolved: ${resolved}`);
  });

  // Test 3: import() the resolved ESM plugin — actually loads the module
  await test("import() — load ESM plugin module from resolved path", async () => {
    const resolved = resolvePlugin(PLUGIN_NAME, resolvePaths);
    const mod = await import(resolved);
    if (!mod.default?.name) throw new Error("module.default.name missing — not a valid plugin shape");
  });

  // Test 4: plugin's own dependency resolves at runtime (is-odd imported inside plugin)
  await test("plugin deps — plugin can import its own dependency at runtime", async () => {
    const resolved = resolvePlugin(PLUGIN_NAME, resolvePaths);
    const mod = await import(resolved);
    const log: string[] = [];
    await mod.default.setup({ log: (msg: string) => log.push(msg) });
    if (!log.some(m => m.includes("true"))) {
      throw new Error(`expected isOdd(3)=true in log, got: ${JSON.stringify(log)}`);
    }
  });

  console.log("");
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
