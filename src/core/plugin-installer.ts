import { cpSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { $ } from "bun";
import type { MarketplaceCatalog, PluginSource } from "../types/plugin.js";
import { marketplaceRepoDir, pluginInstallDir, harnessInstallDir } from "./kaizen-config.js";
import { readCatalog } from "./marketplace.js";

export async function installPlugin(
  marketplaceId: string, name: string, version: string, source: PluginSource,
): Promise<void> {
  const target = pluginInstallDir(marketplaceId, name, version);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  switch (source.type) {
    case "file": {
      const src = join(marketplaceRepoDir(marketplaceId), source.path);
      if (!existsSync(src)) throw new Error(`file source not found in marketplace: ${source.path}`);
      cpSync(src, target, { recursive: true });
      break;
    }
    case "tarball": {
      await installTarball(source.url, target, source.sha256);
      break;
    }
    case "npm": {
      await installNpm(source.name, source.version, target);
      break;
    }
  }

  const workspaceDepNames = collectWorkspaceDepNames(target);
  if (workspaceDepNames.length > 0) {
    await prepareWorkspaceDeps(target, marketplaceId, workspaceDepNames);
  }
  await installDeps(target, name, version);
  if (workspaceDepNames.length > 0) {
    await materializeWorkspaceDeps(target, marketplaceId, workspaceDepNames);
  }
  await bundlePlugin(target, name, version);
}

/**
 * Before bun install: strip `workspace:` deps from the target's package.json
 * (bun can't resolve them — they're sibling plugins in the same monorepo,
 * not registry packages) and hoist the transitive non-workspace deps from
 * every reachable sibling into the target's `dependencies`. That way bun
 * install fetches the registry packages those siblings need; subsequent
 * `materializeWorkspaceDeps` drops the sibling source into node_modules
 * where the bundler resolves it via standard upward lookup.
 */
async function prepareWorkspaceDeps(
  target: string,
  marketplaceId: string,
  rootDepNames: string[],
): Promise<void> {
  const pkgPath = join(target, "package.json");
  const catalog = await readCatalog(marketplaceId);
  const repo = marketplaceRepoDir(marketplaceId);

  // BFS through workspace closure, collecting non-workspace deps.
  const seen = new Set<string>();
  const queue: string[] = [...rootDepNames];
  const hoisted: Record<string, string> = {};
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const srcPath = lookupPluginSourcePath(catalog, name, marketplaceId);
    const absSrc = join(repo, srcPath);
    const pkg = readPkgOrNull(join(absSrc, "package.json"));
    if (!pkg) continue;
    if (pkg.dependencies) {
      for (const [n, spec] of Object.entries(pkg.dependencies)) {
        if (typeof spec !== "string") continue;
        if (spec.startsWith("workspace:")) { queue.push(n); continue; }
        // Last writer wins: workspace closure is expected to share versions.
        hoisted[n] = spec;
      }
    }
  }

  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { return; }

  pkg.dependencies ??= {};
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [depName, spec] of Object.entries(deps)) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) delete deps[depName];
    }
  }
  for (const [n, spec] of Object.entries(hoisted)) {
    pkg.dependencies[n] ??= spec;
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

/**
 * After bun install, populate `<target>/node_modules/<name>/` for every
 * transitive workspace dep with a real copy of the sibling source. Each
 * copy's own workspace deps are also stripped (they're satisfied by peers
 * hoisted at `<target>/node_modules/`). The bundler resolves through these
 * normally — no symlinks involved.
 */
async function materializeWorkspaceDeps(
  target: string,
  marketplaceId: string,
  rootDepNames: string[],
): Promise<void> {
  const catalog = await readCatalog(marketplaceId);
  const repo = marketplaceRepoDir(marketplaceId);
  const seen = new Set<string>();
  const queue: string[] = [...rootDepNames];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const depSrcPath = lookupPluginSourcePath(catalog, name, marketplaceId);
    const absSrc = join(repo, depSrcPath);
    if (!existsSync(absSrc)) {
      throw new Error(`workspace dep '${name}' source not found at ${absSrc}`);
    }
    const destDir = join(target, "node_modules", name);
    mkdirSync(join(target, "node_modules"), { recursive: true });
    rmSync(destDir, { recursive: true, force: true });
    cpSync(absSrc, destDir, { recursive: true });
    for (const child of collectWorkspaceDepNames(absSrc)) queue.push(child);
    stripWorkspaceDepsInPlace(join(destDir, "package.json"));
  }
}

function collectWorkspaceDepNames(dir: string): string[] {
  const pkg = readPkgOrNull(join(dir, "package.json"));
  if (!pkg) return [];
  const names: string[] = [];
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [n, spec] of Object.entries(deps)) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) names.push(n);
    }
  }
  return names;
}

function stripWorkspaceDepsInPlace(pkgPath: string): void {
  const pkg = readPkgOrNull(pkgPath);
  if (!pkg) return;
  let mutated = false;
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [n, spec] of Object.entries(deps)) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        delete deps[n];
        mutated = true;
      }
    }
  }
  if (mutated) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

function readPkgOrNull(pkgPath: string): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} | null {
  if (!existsSync(pkgPath)) return null;
  try { return JSON.parse(readFileSync(pkgPath, "utf8")); } catch { return null; }
}

function hasWorkspaceSpec(pkgPath: string): boolean {
  try {
    return readFileSync(pkgPath, "utf8").includes("workspace:");
  } catch {
    return false;
  }
}

function lookupPluginSourcePath(
  cat: MarketplaceCatalog,
  name: string,
  marketplaceId: string,
): string {
  const entry = cat.entries.find(
    (e): e is Extract<typeof e, { kind: "plugin" }> => e.kind === "plugin" && e.name === name,
  );
  if (!entry) {
    throw new Error(
      `workspace dep '${name}' is not published in marketplace '${marketplaceId}'. ` +
      `A plugin can only declare workspace deps on other plugins in the same marketplace.`,
    );
  }
  const v = entry.versions[0];
  if (!v || v.source.type !== "file") {
    throw new Error(
      `workspace dep '${name}' resolves to a non-file source (${v?.source.type ?? "?"}). ` +
      `Workspace deps require file-source plugins in the same marketplace repo.`,
    );
  }
  return v.source.path;
}

/**
 * Materialize a marketplace harness's kaizen.json into
 * `~/.kaizen/marketplaces/<id>/harnesses/<name>/`.
 *
 * Preservation contract: this function MUST NOT remove other files in the
 * target directory. The per-harness `permissions.lock` lives here and must
 * survive re-materialization. Plugin grant changes still trigger re-consent
 * via the tier-grant hash comparison in consent-flow. Do not add
 * rmSync(target) here.
 */
export async function installHarness(
  marketplaceId: string, name: string, pathInRepo: string,
): Promise<void> {
  const src = join(marketplaceRepoDir(marketplaceId), pathInRepo);
  if (!existsSync(src)) throw new Error(`harness source not found in marketplace: ${pathInRepo}`);
  const target = harnessInstallDir(marketplaceId, name);
  mkdirSync(target, { recursive: true });
  const raw = readFileSync(src);
  writeFileSync(join(target, "kaizen.json"), raw);
}

async function installTarball(url: string, target: string, sha256?: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tarball fetch failed: ${url} (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (sha256) {
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== sha256) throw new Error(`tarball sha256 mismatch: want ${sha256}, got ${got}`);
  }
  const tmpFile = join(target, "__tarball.tgz");
  writeFileSync(tmpFile, buf);
  await $`tar -xzf ${tmpFile} -C ${target} --strip-components=1`.quiet();
  rmSync(tmpFile, { force: true });
}

async function installNpm(pkgName: string, pkgVersion: string, target: string): Promise<void> {
  const scratch = join(target, "__pack");
  mkdirSync(scratch, { recursive: true });
  await $`npm pack ${pkgName}@${pkgVersion}`.cwd(scratch).quiet();
  const entries = await $`ls ${scratch}`.text();
  const tgz = entries.trim().split("\n").find((n) => n.endsWith(".tgz"));
  if (!tgz) throw new Error(`npm pack produced no tarball for ${pkgName}@${pkgVersion}`);
  await $`tar -xzf ${join(scratch, tgz)} -C ${target} --strip-components=1`.quiet();
  rmSync(scratch, { recursive: true, force: true });
}

/**
 * Resolve a usable `bun` executable path.
 * Preference: `bun` on PATH → `~/.bun/bin/bun` → null.
 *
 * Exported for testing. Internal callers use it via installDeps.
 */
export function resolveBunExecutable(): string | null {
  // PATH lookup: probe with `which` semantics via Bun.which. Pass PATH
  // explicitly so changes to process.env.PATH at runtime are honored
  // (Bun.which() otherwise uses the cached startup PATH).
  const onPath = Bun.which("bun", { PATH: process.env.PATH ?? "" });
  if (onPath) return "bun";
  // Honor process.env.HOME at runtime; fall back to homedir() if HOME is unset.
  const home = process.env.HOME ?? homedir();
  const fallback = join(home, ".bun", "bin", "bun");
  if (existsSync(fallback)) return fallback;
  return null;
}

/**
 * If `target` contains a package.json with non-empty runtime dependencies,
 * run `bun install --production` in it. Otherwise no-op.
 *
 * On bun-install failure: rmSync(target) and throw with bun's stderr.
 * On missing bun: throw with install instructions.
 */
async function installDeps(
  target: string,
  name: string,
  version: string,
  bunResolver: () => string | null = resolveBunExecutable,
): Promise<void> {
  const pkgPath = join(target, "package.json");
  if (!existsSync(pkgPath)) return;

  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    // Malformed package.json — let plugin load surface the real error.
    return;
  }

  const deps = pkg.dependencies;
  if (!deps || Object.keys(deps).length === 0) return;

  const bun = bunResolver();
  if (!bun) {
    throw new Error(
      `plugin '${name}@${version}' declares runtime dependencies but bun is not on PATH or at ~/.bun/bin/bun.\n` +
      `Install bun: curl -fsSL https://bun.sh/install | bash`,
    );
  }

  const proc = Bun.spawnSync({
    cmd: [bun, "install", "--production"],
    cwd: target,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    rmSync(target, { recursive: true, force: true });
    throw new Error(
      `bun install failed for plugin '${name}@${version}' at ${target}\n` +
      stderr.split("\n").map((l) => `  ${l}`).join("\n"),
    );
  }
}

// Test-only export. Not part of the public API.
export const installDepsForTesting = installDeps;

async function bundlePlugin(
  target: string,
  name: string,
  version: string,
  bunResolver: () => string | null = resolveBunExecutable,
): Promise<void> {
  const pkgPath = join(target, "package.json");
  if (!existsSync(pkgPath)) return;

  let pkg: { main?: string; module?: string };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return;
  }

  const entry = pkg.module ?? pkg.main ?? "index.js";
  const entryPath = join(target, entry);
  const outFile = join(target, "dist", "index.js");

  const bun = bunResolver();
  if (!bun) {
    throw new Error(
      `plugin '${name}@${version}' could not be bundled: bun is not on PATH or at ~/.bun/bin/bun.\n` +
      `Install bun: curl -fsSL https://bun.sh/install | bash`,
    );
  }

  const proc = Bun.spawnSync({
    cmd: [bun, "build", "--target=bun", `--outfile=${outFile}`, entryPath],
    cwd: target, stdout: "pipe", stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    rmSync(target, { recursive: true, force: true });
    throw new Error(
      `bun build failed for plugin '${name}@${version}' at ${target}\n` +
      stderr.split("\n").map((l) => `  ${l}`).join("\n"),
    );
  }

  rmSync(join(target, "node_modules"), { recursive: true, force: true });
  rmSync(join(target, "bun.lockb"), { force: true });
  rmSync(join(target, "bun.lock"), { force: true });
}

// Test-only export. Not part of the public API.
export const bundlePluginForTesting = bundlePlugin;
