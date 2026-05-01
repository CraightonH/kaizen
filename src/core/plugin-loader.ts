import { existsSync, readFileSync } from "fs";
import { join, isAbsolute } from "path";
import type { KaizenPlugin } from "../types/plugin.js";
import { pluginInstallDir } from "./kaizen-config.js";

export async function loadPluginFromInstallDir(
  marketplaceId: string, name: string, version: string,
): Promise<KaizenPlugin> {
  const dir = pluginInstallDir(marketplaceId, name, version);
  if (!existsSync(dir)) {
    throw new Error(`plugin '${marketplaceId}/${name}@${version}' is not installed at ${dir}`);
  }
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) throw new Error(`no package.json at ${dir}`);
  // Prefer the bundled output produced by installPlugin(). Falls back to the raw
  // entry for pre-bundle-era installs and uncompiled-cli local development.
  const bundlePath = join(dir, "dist", "index.js");
  let abs: string;
  if (existsSync(bundlePath)) {
    abs = bundlePath;
  } else {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { main?: string; module?: string };
    const entry = pkg.module ?? pkg.main ?? "index.js";
    abs = isAbsolute(entry) ? entry : join(dir, entry);
  }

  const mod = (await import(abs)) as { default?: KaizenPlugin };
  if (!mod.default || typeof mod.default !== "object") {
    throw new Error(`plugin '${name}' at ${abs} has no default export`);
  }
  return mod.default;
}
