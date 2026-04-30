/**
 * OS-infrastructure env vars that bypass tier-based env.get gating.
 * Plugins of any tier can read these. Override via:
 *   ~/.kaizen/kaizen.json   defaults.env_allowlist
 *   harness  kaizen.json    env_allowlist
 *
 * Each entry is either an exact name (e.g. "PATH") or a trailing-`*`
 * prefix (e.g. "LC_*"). No other glob syntax is supported.
 */
export const DEFAULT_ENV_ALLOWLIST: string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLUMNS",
  "LINES",
  "LANG",
  "LANGUAGE",
  "LC_*",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "PWD",
  "OLDPWD",
];

/** Returns true iff `name` matches any entry in `allowList`. */
export function envAllowed(allowList: string[], name: string): boolean {
  for (const entry of allowList) {
    if (entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      if (prefix.length > 0 && name.startsWith(prefix)) return true;
    } else if (entry === name) {
      return true;
    }
  }
  return false;
}

/**
 * Validate an env-allowlist value loaded from config. Returns the array
 * unchanged on success; throws an Error with the offending entry on failure.
 *
 * `source` is included in error messages (e.g. "~/.kaizen/kaizen.json: defaults.env_allowlist").
 */
export function validateEnvAllowList(value: unknown, source: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source}: must be an array of strings.`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(
        `${source}: each entry must be a non-empty string (got ${JSON.stringify(entry)}).`,
      );
    }
    if (/\s/.test(entry)) {
      throw new Error(`${source}: entry "${entry}" contains whitespace.`);
    }
    const stars = (entry.match(/\*/g) ?? []).length;
    if (stars > 1) {
      throw new Error(
        `${source}: invalid entry "${entry}" — only one trailing '*' allowed (e.g. "LC_*").`,
      );
    }
    if (stars === 1 && !entry.endsWith("*")) {
      throw new Error(
        `${source}: invalid entry "${entry}" — '*' may only appear as the trailing character (e.g. "LC_*").`,
      );
    }
    if (entry === "*") {
      throw new Error(`${source}: invalid entry "*" — empty prefix not allowed.`);
    }
  }
  return value as string[];
}
