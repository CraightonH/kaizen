import { readFileSync } from "fs";

/**
 * Regex-based import scan. Not a full AST parser — we're looking for escape hatches,
 * not doing semantic analysis. Obfuscated or dynamic imports are caught at runtime
 * by the require patch.
 */
export function scanPluginEntryImports(filePath: string): string[] {
  const src = readFileSync(filePath, "utf8");
  const found = new Set<string>();

  // ESM: import ... from "specifier";  /  import "specifier";
  const importRe = /\bimport\s+(?:[^'"]*?\bfrom\s+)?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src))) {
    found.add(m[1]!);
  }

  // ESM dynamic: import("specifier")
  const dynImportRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynImportRe.exec(src))) {
    found.add(m[1]!);
  }

  // CJS: require("specifier")
  const requireRe = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = requireRe.exec(src))) {
    found.add(m[1]!);
  }

  return Array.from(found);
}
