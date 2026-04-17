import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { join, relative, sep } from "path";
import { createHash } from "crypto";

/**
 * Hash a plugin package. Recursively walks the plugin directory, ignoring
 * node_modules and dotfiles, sorting paths for determinism. Returns
 * `sha256:<hex>`.
 */
export function computePluginHash(pluginDir: string): string {
  const files = collectFiles(pluginDir).sort();
  const hash = createHash("sha256");
  for (const absPath of files) {
    const rel = relative(pluginDir, absPath).split(sep).join("/");
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(absPath));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collectFiles(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}
