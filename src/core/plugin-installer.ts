import { cpSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { $ } from "bun";
import type { PluginSource } from "../types/plugin.js";
import { marketplaceRepoDir, pluginInstallDir, harnessInstallDir } from "./kaizen-config.js";

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

  await installDeps(target, name, version);
  await bundlePlugin(target, name, version);
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
