import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { validateSchemaItself } from "../core/config-validator.js";

export interface ValidationResult {
  rule: string;
  status: "pass" | "fail" | "warn";
  message?: string;
}

const SEMVER_RE = /^\d+\.\d+\.\d+/;
const KEBAB_RE = /^[a-z][a-z0-9-]*$/;

const FLAGGED_IMPORTS = new Set([
  "node:fs",
  "node:child_process",
  "node:worker_threads",
  "bun:ffi",
  "fs",
  "child_process",
  "worker_threads",
]);

export async function checkPackageJson(dir: string): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const pkgPath = join(dir, "package.json");

  if (!existsSync(pkgPath)) {
    results.push({ rule: "package.json present", status: "fail", message: "package.json not found" });
    return results;
  }
  results.push({ rule: "package.json present", status: "pass" });

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  } catch {
    results.push({ rule: "package.json parseable", status: "fail", message: "Failed to parse package.json" });
    return results;
  }

  // name
  if (!pkg.name || typeof pkg.name !== "string") {
    results.push({ rule: "name present", status: "fail", message: "package.json missing name" });
  } else if (!KEBAB_RE.test(pkg.name)) {
    results.push({ rule: "name is kebab-case", status: "fail", message: `name "${pkg.name}" does not match ^[a-z][a-z0-9-]*$` });
  } else {
    results.push({ rule: `name is kebab-case: ${pkg.name}`, status: "pass" });
  }

  // type: module
  if (pkg.type !== "module") {
    results.push({ rule: "type: module", status: "fail", message: `"type" must be "module", got ${JSON.stringify(pkg.type)}` });
  } else {
    results.push({ rule: "type: module", status: "pass" });
  }

  // exports["."]
  const exports = pkg.exports as Record<string, unknown> | undefined;
  if (!exports || !exports["."]) {
    results.push({ rule: 'exports["."] present', status: "fail", message: 'package.json must have exports["."]' });
  } else {
    results.push({ rule: 'exports["."] present', status: "pass" });
  }

  // keywords includes kaizen-plugin
  const keywords = pkg.keywords as string[] | undefined;
  if (!Array.isArray(keywords) || !keywords.includes("kaizen-plugin")) {
    results.push({ rule: 'keywords includes "kaizen-plugin"', status: "fail", message: 'keywords must include "kaizen-plugin"' });
  } else {
    results.push({ rule: 'keywords includes "kaizen-plugin"', status: "pass" });
  }

  // version semver
  if (!pkg.version || typeof pkg.version !== "string") {
    results.push({ rule: "version present", status: "fail", message: "package.json missing version" });
  } else if (!SEMVER_RE.test(pkg.version)) {
    results.push({ rule: "version is semver", status: "fail", message: `version "${pkg.version}" is not semver` });
  } else {
    results.push({ rule: "version is semver", status: "pass" });
  }

  return results;
}

export async function checkManifest(dir: string, pkg: Record<string, unknown>): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const exports = pkg.exports as Record<string, unknown> | undefined;
  const entryRelative = exports?.["."] as string | undefined;

  if (!entryRelative) {
    results.push({ rule: "plugin manifest loadable", status: "fail", message: 'No exports["."] to load plugin from' });
    return results;
  }

  const entryPath = join(dir, entryRelative);
  let plugin: Record<string, unknown>;
  try {
    const mod = await import(pathToFileURL(entryPath).href) as { default?: unknown };
    plugin = (mod.default ?? mod) as Record<string, unknown>;
  } catch (e) {
    results.push({ rule: "plugin manifest loadable", status: "fail", message: `Failed to import plugin: ${String(e)}` });
    return results;
  }
  results.push({ rule: "plugin manifest loadable", status: "pass" });

  // plugin.name matches package.json name
  if (plugin.name !== pkg.name) {
    results.push({
      rule: "plugin.name matches package.json name",
      status: "fail",
      message: `plugin.name "${String(plugin.name)}" does not match package.json name "${String(pkg.name)}"`,
    });
  } else {
    results.push({ rule: "plugin.name matches package.json name", status: "pass" });
  }

  // apiVersion present and semver
  if (!plugin.apiVersion || typeof plugin.apiVersion !== "string") {
    results.push({ rule: "plugin.apiVersion present", status: "fail", message: "plugin.apiVersion is missing" });
  } else if (!SEMVER_RE.test(plugin.apiVersion)) {
    results.push({ rule: "plugin.apiVersion is semver", status: "fail", message: `plugin.apiVersion "${plugin.apiVersion}" is not semver` });
  } else {
    results.push({ rule: "plugin.apiVersion present and semver", status: "pass" });
  }

  // permissions present
  const permissions = plugin.permissions as Record<string, unknown> | undefined;
  if (!permissions || typeof permissions !== "object") {
    results.push({ rule: "plugin.permissions present", status: "fail", message: "plugin.permissions is missing" });
  } else {
    results.push({ rule: "plugin.permissions present", status: "pass" });

    // tier
    const tier = permissions.tier as string | undefined;
    if (!tier || !["trusted", "scoped", "unscoped"].includes(tier)) {
      results.push({
        rule: "plugin.permissions.tier valid",
        status: "fail",
        message: `permissions.tier must be "trusted", "scoped", or "unscoped", got ${JSON.stringify(tier)}`,
      });
    } else {
      results.push({ rule: "plugin.permissions.tier valid", status: "pass" });

      // scoped requires at least one grant
      if (tier === "scoped") {
        const grantKeys = ["fs", "net", "env", "exec", "events"];
        const hasGrant = grantKeys.some((k) => {
          const v = permissions[k];
          if (!v) return false;
          if (Array.isArray(v)) return v.length > 0;
          if (typeof v === "object") return Object.keys(v as object).length > 0;
          return Boolean(v);
        });
        if (!hasGrant) {
          results.push({
            rule: "scoped tier has at least one grant",
            status: "fail",
            message: 'tier is "scoped" but no grant keys (fs, net, env, exec, events) are populated',
          });
        } else {
          results.push({ rule: "scoped tier has at least one grant", status: "pass" });
        }
      }
    }
  }

  // capabilities present
  if (!plugin.capabilities || typeof plugin.capabilities !== "object") {
    results.push({ rule: "plugin.capabilities present", status: "fail", message: "plugin.capabilities is missing (may be {})" });
  } else {
    results.push({ rule: "plugin.capabilities present", status: "pass" });
  }

  // run config schema checks if config declared
  const configResults = await checkConfigSchema(plugin);
  results.push(...configResults);

  return results;
}

export async function checkConfigSchema(plugin: Record<string, unknown>): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const config = plugin.config as Record<string, unknown> | undefined;
  if (!config) return results;

  // schema is valid JSON Schema
  if (config.schema !== undefined) {
    const valid = validateSchemaItself(config.schema as Record<string, unknown>);
    if (!valid) {
      results.push({ rule: "plugin.config.schema is valid JSON Schema", status: "fail", message: "config.schema is not a valid JSON Schema" });
    } else {
      results.push({ rule: "plugin.config.schema is valid JSON Schema", status: "pass" });
    }
  }

  // secrets keys appear in schema.properties
  const secrets = config.secrets as string[] | undefined;
  const schema = config.schema as Record<string, unknown> | undefined;
  const schemaProperties = (schema?.properties as Record<string, unknown> | undefined) ?? {};

  if (Array.isArray(secrets)) {
    for (const key of secrets) {
      if (!(key in schemaProperties)) {
        results.push({
          rule: `config secrets key "${key}" declared in schema`,
          status: "fail",
          message: `config secrets key "${key}" not declared in config.schema.properties`,
        });
      } else {
        results.push({ rule: `config secrets key "${key}" declared in schema`, status: "pass" });
      }
    }

    // warn if secrets non-empty and core-secrets:provider not in consumes
    if (secrets.length > 0) {
      const capabilities = plugin.capabilities as Record<string, unknown> | undefined;
      const consumes = capabilities?.consumes as string[] | undefined;
      if (!Array.isArray(consumes) || !consumes.includes("core-secrets:provider")) {
        results.push({
          rule: "core-secrets:provider in consumes",
          status: "warn",
          message: "core-secrets:provider dependency is implicit per Spec 2; list it explicitly for discoverability.",
        });
      } else {
        results.push({ rule: "core-secrets:provider in consumes", status: "pass" });
      }
    }
  }

  return results;
}

export async function scanImports(filePath: string): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  let src: string;
  try {
    src = readFileSync(filePath, "utf8");
  } catch {
    results.push({
      rule: "import scan",
      status: "warn",
      message: `Could not parse ${filePath} for import scan.`,
    });
    return results;
  }

  let imports: string[];
  try {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    imports = transpiler.scanImports(src).map((i) => i.path);
  } catch {
    results.push({
      rule: "import scan",
      status: "warn",
      message: `Could not parse ${filePath} for import scan.`,
    });
    return results;
  }

  for (const imp of imports) {
    if (FLAGGED_IMPORTS.has(imp)) {
      results.push({
        rule: `import "${imp}" flagged`,
        status: "warn",
        message: `Direct import of "${imp}" detected. Note: runtime enforcer will block this regardless of validate status.`,
      });
    }
  }

  return results;
}

export async function checkFilesPresent(dir: string): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  // test file
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    results.push({ rule: "test file present", status: "fail", message: `Could not read directory: ${dir}` });
    results.push({ rule: "README.md present", status: "fail", message: `Could not read directory: ${dir}` });
    return results;
  }

  const hasTest = files.some((f) => f.endsWith(".test.ts"));
  if (hasTest) {
    results.push({ rule: "*.test.ts file present", status: "pass" });
  } else {
    results.push({ rule: "*.test.ts file present", status: "fail", message: "No *.test.ts file found in plugin directory" });
  }

  const hasReadme = files.includes("README.md");
  if (hasReadme) {
    results.push({ rule: "README.md present", status: "pass" });
  } else {
    results.push({ rule: "README.md present", status: "fail", message: "README.md not found" });
  }

  return results;
}

function icon(status: "pass" | "fail" | "warn" | "info"): string {
  switch (status) {
    case "pass": return "✓";
    case "fail": return "✗";
    case "warn": return "⚠";
    case "info": return "ℹ";
  }
}

export async function runPluginValidate(dir: string): Promise<number> {
  console.log(`kaizen plugin validate ${dir}\n`);

  const allResults: ValidationResult[] = [];

  // 1. Check package.json
  const pkgResults = await checkPackageJson(dir);
  allResults.push(...pkgResults);

  // Load pkg for manifest checks
  let pkg: Record<string, unknown> | undefined;
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    } catch {
      // already reported
    }
  }

  // 2. Check manifest (if we have a valid pkg with exports)
  if (pkg) {
    const manifestResults = await checkManifest(dir, pkg);
    allResults.push(...manifestResults);

    // 4. Scan imports on entry file
    const exports = pkg.exports as Record<string, unknown> | undefined;
    const entryRelative = exports?.["."] as string | undefined;
    if (entryRelative) {
      const entryPath = join(dir, entryRelative);
      if (existsSync(entryPath)) {
        const importResults = await scanImports(entryPath);
        allResults.push(...importResults);
      }
    }
  }

  // 5. Check files present
  const fileResults = await checkFilesPresent(dir);
  allResults.push(...fileResults);

  // Print results
  for (const r of allResults) {
    const ic = icon(r.status === "warn" ? "warn" : r.status === "fail" ? "fail" : "pass");
    if (r.status === "fail") {
      console.log(`  ${ic} ${r.message ?? r.rule}`);
    } else if (r.status === "warn") {
      console.log(`  ⚠ ${r.message ?? r.rule}`);
    } else {
      console.log(`  ${ic} ${r.rule}`);
    }
  }

  const failures = allResults.filter((r) => r.status === "fail");
  const warns = allResults.filter((r) => r.status === "warn");

  console.log("");
  if (failures.length > 0) {
    const warnNote = warns.length > 0 ? ` (${warns.length} warning(s))` : "";
    console.log(`${failures.length} error(s) found${warnNote}. Fix errors before publishing.`);
    return 1;
  } else {
    if (warns.length > 0) {
      console.log(`All checks passed (${warns.length} warning(s)).`);
    } else {
      console.log("All checks passed.");
    }
    return 0;
  }
}
