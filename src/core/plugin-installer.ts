import { cpSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "fs";
import { createHash } from "crypto";
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
      return;
    }
    case "tarball": {
      await installTarball(source.url, target, source.sha256);
      return;
    }
    case "npm": {
      await installNpm(source.name, source.version, target);
      return;
    }
  }
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
