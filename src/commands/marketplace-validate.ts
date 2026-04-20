import { readFileSync, existsSync } from "fs";
import { join } from "path";

const SEMVER_RE = /^\d+\.\d+\.\d+/;
const BARE_SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SEMVER_RANGE_PREFIX = /^[\^~>=<]/;
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;

export interface ValidationResult {
  rule: string;
  status: "pass" | "fail";
  message?: string;
}

function pass(rule: string): ValidationResult {
  return { rule, status: "pass" };
}

function fail(rule: string, message: string): ValidationResult {
  return { rule, status: "fail", message };
}

function validateSource(
  dir: string,
  source: Record<string, unknown>,
  prefix: string,
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const type = source.type;

  if (type === "npm") {
    const name = source.name;
    const version = source.version;
    if (!name || typeof name !== "string" || name.trim() === "") {
      results.push(fail(`${prefix}: npm source name`, `${prefix}: npm source missing non-empty name`));
    } else {
      results.push(pass(`${prefix}: npm source name`));
    }
    if (!version || typeof version !== "string" || !SEMVER_RE.test(version)) {
      results.push(fail(`${prefix}: npm source version semver`, `${prefix}: npm source version "${String(version)}" is not semver`));
    } else {
      results.push(pass(`${prefix}: npm source version semver`));
    }
  } else if (type === "tarball") {
    const url = source.url;
    if (!url || typeof url !== "string" || url.trim() === "") {
      results.push(fail(`${prefix}: tarball source url`, `${prefix}: tarball source missing non-empty url`));
    } else {
      results.push(pass(`${prefix}: tarball source url`));
    }
    if (source.sha256 !== undefined) {
      if (typeof source.sha256 !== "string" || !SHA256_RE.test(source.sha256)) {
        results.push(fail(`${prefix}: tarball source sha256`, `${prefix}: tarball source sha256 must be 64 hex chars, got "${String(source.sha256)}"`));
      } else {
        results.push(pass(`${prefix}: tarball source sha256`));
      }
    }
  } else if (type === "file") {
    const path = source.path;
    if (!path || typeof path !== "string" || path.trim() === "") {
      results.push(fail(`${prefix}: file source path`, `${prefix}: file source missing non-empty path`));
    } else {
      const abs = join(dir, path);
      if (!existsSync(abs)) {
        results.push(fail(`${prefix}: file source path exists`, `${prefix}: file source path '${path}' not found`));
      } else {
        results.push(pass(`${prefix}: file source path exists`));
      }
    }
  } else {
    results.push(fail(`${prefix}: source type`, `${prefix}: unknown source type "${String(type)}"`));
  }

  return results;
}

export async function runMarketplaceValidate(dir: string): Promise<number> {
  console.log(`kaizen marketplace validate ${dir}\n`);

  const results: ValidationResult[] = [];
  const catalogPath = join(dir, ".kaizen", "marketplace.json");

  // 1. File exists
  if (!existsSync(catalogPath)) {
    results.push(fail(".kaizen/marketplace.json present", ".kaizen/marketplace.json not found"));
    printResults(results);
    return 1;
  }
  results.push(pass(".kaizen/marketplace.json present"));

  // 2. Parse JSON
  let catalog: Record<string, unknown>;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Record<string, unknown>;
  } catch {
    results.push(fail("marketplace.json parseable", "Failed to parse marketplace.json: invalid JSON"));
    printResults(results);
    return 1;
  }
  results.push(pass("marketplace.json parseable"));

  // 3. Legacy shape rejection
  if (
    Array.isArray((catalog as Record<string, unknown>).plugins) ||
    Array.isArray((catalog as Record<string, unknown>).harnesses)
  ) {
    results.push(
      fail(
        "entries[] shape",
        "marketplace.json uses the legacy {plugins, harnesses} shape; convert to entries[] with kind tags per Spec 1.",
      ),
    );
    printResults(results);
    return 1;
  }

  // 4. version = "1.0.0"
  if (catalog.version !== "1.0.0") {
    results.push(fail("version: 1.0.0", `version must be "1.0.0", got ${JSON.stringify(catalog.version)}`));
  } else {
    results.push(pass("version: 1.0.0"));
  }

  // 5. name non-empty string
  if (!catalog.name || typeof catalog.name !== "string" || catalog.name.trim() === "") {
    results.push(fail("name non-empty", "name must be a non-empty string"));
  } else {
    results.push(pass(`name: ${catalog.name}`));
  }

  // 6. url non-empty string
  if (!catalog.url || typeof catalog.url !== "string" || catalog.url.trim() === "") {
    results.push(fail("url non-empty", "url must be a non-empty string"));
  } else {
    results.push(pass(`url: ${catalog.url}`));
  }

  // 7. entries is array
  if (!Array.isArray(catalog.entries)) {
    results.push(fail("entries is array", "entries must be an array"));
    printResults(results);
    return 1;
  }
  results.push(pass("entries is array"));

  const entries = catalog.entries as Record<string, unknown>[];

  // 9. Cross-kind name uniqueness (pre-scan before per-entry checks)
  const nameMap = new Map<string, string>(); // name -> kind
  for (const entry of entries) {
    const entryName = typeof (entry as Record<string, unknown>).name === "string" ? (entry as Record<string, unknown>).name as string : "";
    const entryKind = typeof (entry as Record<string, unknown>).kind === "string" ? (entry as Record<string, unknown>).kind as string : "";
    if (entryName && entryKind) {
      if (nameMap.has(entryName)) {
        const existingKind = nameMap.get(entryName)!;
        results.push(
          fail(
            `entry name uniqueness: '${entryName}'`,
            `entry name '${entryName}' is used by both a ${existingKind} and a ${entryKind}`,
          ),
        );
      } else {
        nameMap.set(entryName, entryKind);
      }
    }
  }

  // 8. Per-entry checks
  let entryIdx = 0;
  for (const entry of entries) {
    const i = entryIdx++;
    const entryName = typeof entry.name === "string" ? entry.name : `[${i}]`;
    const prefix = `entry '${entryName}'`;

    // kind
    const kind = entry.kind;
    if (kind !== "plugin" && kind !== "harness") {
      results.push(fail(`${prefix}: kind`, `${prefix}: kind must be "plugin" or "harness", got ${JSON.stringify(kind)}`));
      continue;
    }
    results.push(pass(`${prefix}: kind`));

    // name matches regex
    if (!NAME_RE.test(entryName)) {
      results.push(fail(`${prefix}: name format`, `${prefix}: name "${entryName}" must match ^[a-z][a-z0-9-]*$`));
    } else {
      results.push(pass(`${prefix}: name format`));
    }

    // description non-empty
    if (!entry.description || typeof entry.description !== "string" || entry.description.trim() === "") {
      results.push(fail(`${prefix}: description`, `${prefix}: description must be a non-empty string`));
    } else {
      results.push(pass(`${prefix}: description`));
    }

    // versions non-empty array
    if (!Array.isArray(entry.versions) || entry.versions.length === 0) {
      results.push(fail(`${prefix}: versions non-empty`, `${prefix}: versions must be a non-empty array`));
      continue;
    }
    results.push(pass(`${prefix}: versions non-empty`));

    const versions = entry.versions as Record<string, unknown>[];
    let verIdx = 0;
    for (const ver of versions) {
      const j = verIdx++;
      const verStr = typeof ver.version === "string" ? ver.version : `[${j}]`;
      const vprefix = `${prefix}: version '${verStr}'`;

      // version is valid semver
      if (!ver.version || typeof ver.version !== "string" || !SEMVER_RE.test(ver.version)) {
        results.push(fail(`${vprefix}: semver`, `${vprefix}: version "${String(ver.version)}" is not valid semver`));
      } else {
        results.push(pass(`${vprefix}: semver`));
      }

      if (kind === "plugin") {
        // source must be present and valid
        if (!ver.source || typeof ver.source !== "object") {
          results.push(fail(`${vprefix}: source present`, `${vprefix}: source must be present`));
        } else {
          results.push(pass(`${vprefix}: source present`));
          const sourceResults = validateSource(dir, ver.source as Record<string, unknown>, vprefix);
          results.push(...sourceResults);
        }
      } else if (kind === "harness") {
        // path non-empty and exists
        const harnessPath = ver.path;
        if (!harnessPath || typeof harnessPath !== "string" || harnessPath.trim() === "") {
          results.push(fail(`${vprefix}: path non-empty`, `${vprefix}: path must be a non-empty string`));
        } else {
          const abs = join(dir, harnessPath);
          if (!existsSync(abs)) {
            results.push(fail(`${vprefix}: path exists`, `${vprefix}: harness path '${harnessPath}' not found`));
          } else {
            results.push(pass(`${vprefix}: path exists`));
          }
        }
      }

      // optional minKaizenVersion: bare semver only (no ranges)
      if (ver.minKaizenVersion !== undefined) {
        const mkv = ver.minKaizenVersion;
        if (typeof mkv !== "string" || SEMVER_RANGE_PREFIX.test(mkv) || !BARE_SEMVER_RE.test(mkv)) {
          results.push(
            fail(
              `${vprefix}: minKaizenVersion`,
              `${vprefix}: minKaizenVersion "${String(mkv)}" must be a bare semver (e.g. "1.0.0"), not a range`,
            ),
          );
        } else {
          results.push(pass(`${vprefix}: minKaizenVersion`));
        }
      }
    }
  }

  printResults(results);
  return results.some((r) => r.status === "fail") ? 1 : 0;
}

function printResults(results: ValidationResult[]): void {
  for (const r of results) {
    if (r.status === "fail") {
      console.log(`  ✗ ${r.message ?? r.rule}`);
    } else {
      console.log(`  ✓ ${r.rule}`);
    }
  }

  const failures = results.filter((r) => r.status === "fail");
  console.log("");
  if (failures.length > 0) {
    console.log(`${failures.length} error(s) found.`);
  } else {
    console.log("All checks passed.");
  }
}
