import { dirname, join } from "path";

/**
 * Derive the per-harness lockfile path from a harness's kaizen.json path.
 * Lockfile lives alongside kaizen.json: `<harness-dir>/permissions.lock`.
 */
export function deriveLockfilePath(kaizenJsonPath: string): string {
  return join(dirname(kaizenJsonPath), "permissions.lock");
}
