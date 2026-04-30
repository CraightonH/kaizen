# Sandbox env allow-list

**Issue:** [#64 — sandbox-bootstrap process.env Proxy hides PATH from spawn() under trusted tier](https://github.com/CraightonH/kaizen/issues/64)
**Date:** 2026-04-30
**Status:** Approved (brainstorm complete, ready for implementation plan)

## Problem

`src/core/sandbox-bootstrap.ts` installs a `Proxy` over `process.env` that
delegates each get/has/ownKeys to the permission enforcer's
`env.get` check. Under the **trusted** tier the enforcer denies all external
ops, so every `process.env.X` read from a trusted-tier plugin returns
`undefined` — including `PATH`.

This breaks any stdlib call that depends on PATH:
`child_process.spawn("<binary>", args, { env: process.env })` invokes Bun's
resolver, which reads PATH through the proxy, gets `undefined`, and fails
with `Executable not found in $PATH: "<binary>"`. The same code works fine
in `unscoped`, in `scoped` with `env: ["PATH"]`, or outside any plugin
context.

The docs compound the confusion. `docs/guides/plugin-authoring.md:385-391`
claims that globals (`process.env`, `process.cwd()`, etc.) are *not*
filtered. `docs/concepts/security.md:70` correctly states env reads are
gated. The implementation matches `security.md`; `plugin-authoring.md` is
wrong.

## Goal

Preserve the proxy's value (static auditability of declared env grants;
secret isolation across plugins) while removing the stdlib-spawn footgun.
Do this without baking permanent opinions into kaizen core: the platform
ships a sensible default allow-list and lets users and harnesses override
it via config.

## Non-goals

- Changing tier semantics for `fs` / `net` / `exec` / `events`.
- Glob/regex support beyond a trailing `*` prefix in allow-list entries.
- Per-plugin allow-list overrides (plugins still declare `env: [...]` for
  anything outside the allow-list).
- Filtering of non-env globals (`process.cwd()`, `process.platform`,
  `os.platform()`, etc.) — out of scope; remains unfiltered.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Resolution path | Infrastructure allow-list bypasses tier check; doc fix lands alongside | Preserves goals 1+2 of the proxy (auditability, secret isolation) while removing the implicit-PATH trap. |
| Where the check lives | `permission-enforcer.ts:evaluate()` for `op.kind === "env.get"` | Single source of truth; any future caller of `env.get` inherits the same behavior. |
| Allow-list shape | List of strings; entries are exact names or `PREFIX_*` (trailing wildcard only) | Tiny implementation; covers the realistic POSIX case (`LC_*`); no regex foot-guns. |
| Config plumbing | `DEFAULT_ENV_ALLOWLIST` in code; user `defaults.env_allowlist` in `~/.kaizen/kaizen.json`; harness `env_allowlist` in harness `kaizen.json` | Kaizen ships a working default; users and harnesses override without forking. |
| Precedence | harness > user > default | Mirrors the existing harness-overrides-user pattern in kaizen config. |
| Explicit `[]` semantics | Valid override meaning "no allow-list; gate everything" | Distinguishable from absent. Strict-mode escape hatch for users who want the original behavior. |
| Invalid entries | Reject at config load with offending entry in error | Fail fast; never boot with unenforceable policy. |

## Default allow-list

```
PATH
HOME
USER
LOGNAME
SHELL
TERM
COLUMNS
LINES
LANG
LANGUAGE
LC_*
TZ
TMPDIR
TEMP
TMP
PWD
OLDPWD
```

Every entry is read by either the OS process resolver, Node/Bun stdlib
(`os.homedir`, `os.tmpdir`, child-process resolution), or terminal/locale
code. None are conventional secret-bearing variables.

Deliberately **excluded** from the default — plugins that need these declare
`env: [...]`:

- `BUN_*`, `NODE_*` — runtime tuning.
- `KAIZEN_*` — kaizen-internal.
- `SSH_*`, `GPG_*`, `AWS_*`, etc. — credential adjacent.
- `XDG_*` — used by some apps but not Node/Bun stdlib.

## Design

### Allow-list module (`src/core/env-allowlist.ts`)

New file. Exports:

```ts
export const DEFAULT_ENV_ALLOWLIST: string[] = [
  "PATH", "HOME", "USER", "LOGNAME",
  "SHELL", "TERM", "COLUMNS", "LINES",
  "LANG", "LANGUAGE", "LC_*", "TZ",
  "TMPDIR", "TEMP", "TMP",
  "PWD", "OLDPWD",
];

/** Returns true iff `name` matches any entry in `allowList`. */
export function envAllowed(allowList: string[], name: string): boolean;

/** Validates allow-list entries. Throws with the offending entry on invalid input. */
export function validateEnvAllowList(entries: unknown, source: string): string[];
```

`envAllowed`: each entry is either an exact name or ends with a single `*`.
For prefix entries, match if `name.startsWith(entry.slice(0, -1))` and the
prefix is non-empty. Exact match is case-sensitive (env var names are
case-sensitive on POSIX; on Windows we still match exactly — kaizen's
runtime is Bun, which is POSIX-leaning).

`validateEnvAllowList`: confirms input is `string[]`, each entry is a
non-empty string, contains no whitespace, contains at most one `*` and
only as a trailing character. `source` is used in the error message
(e.g., `"~/.kaizen/kaizen.json"`).

### Permission enforcer change (`src/core/permission-enforcer.ts`)

Constructor gains a new option `envAllowList: string[]` (default
`DEFAULT_ENV_ALLOWLIST`). Add to the existing options bag.

In `evaluate()` for `op.kind === "env.get"`, before tier-specific logic:

```ts
case "env.get": {
  if (envAllowed(this.envAllowList, op.name)) return null;
  if (tier === "trusted") return `tier 'trusted' permits no external ops (attempted env.get)`;
  return (m.env ?? []).includes(op.name) ? null : `env var '${op.name}' not in env grants`;
}
```

The existing `if (tier === "unscoped") return null;` early-return at the
top of `evaluate()` stays in place, so unscoped is unaffected.

### Proxy (`src/core/sandbox-bootstrap.ts`)

No code change. The proxy already calls `enforcer.check({kind: "env.get",
name})` for `get`, `has`, and `ownKeys`. The new allow-list logic in the
enforcer takes effect transparently for all three traps.

### Config plumbing

**Type changes:**

- `KaizenConfig` (user-level): `defaults.env_allowlist?: string[]` (optional).
- Harness manifest type: `env_allowlist?: string[]` (optional).

**Loader behavior:**

- On config load, if `env_allowlist` is present at either level, run
  `validateEnvAllowList(entries, source)`. Invalid entries → load error
  (kaizen does not boot).
- Resolution at the point where `PermissionEnforcer` is constructed
  (currently in the bootstrap flow):

  ```ts
  const envAllowList =
    harnessConfig.env_allowlist ??     // present? use it (incl. empty [])
    userConfig.defaults?.env_allowlist ??
    DEFAULT_ENV_ALLOWLIST;
  ```

  `??` (not `||`) preserves explicit `[]` overrides.

### Error messages

- **Invalid allow-list entry at load:**
  ```
  invalid env_allowlist entry "<entry>" in <source>:
  entries must be a non-empty string, optionally ending with a single trailing '*' (e.g. "LC_*")
  ```
- **Trusted-tier env denial (after fix):** unchanged from today —
  `tier 'trusted' permits no external ops (attempted env.get)`. Now only
  fires for non-allow-listed names; PATH/HOME/etc. silently pass.

## Testing

### `src/core/env-allowlist.test.ts` (new)

- Exact match: `["PATH"]` matches `"PATH"`, not `"PATHS"`, not `"path"`.
- Prefix match: `["LC_*"]` matches `"LC_ALL"`, `"LC_CTYPE"`; not `"LC"`,
  not `"MYLC_FOO"`.
- Mixed list works: `["PATH", "LC_*"]`.
- Empty list: nothing matches.
- Validator rejects: non-array, non-string entry, empty string, entry
  containing whitespace, entry with `*` not at end (e.g., `"*FOO"`,
  `"FOO*BAR"`), entry with multiple `*`.
- Validator passes: empty array, `["PATH"]`, `["LC_*"]`, `["PATH", "LC_*"]`.

### `src/core/permission-enforcer.test.ts` (extend)

- Trusted + default allow-list → `env.get("PATH")` permitted.
- Trusted + default allow-list → `env.get("AWS_SECRET")` denied with the
  existing trusted-tier message.
- Trusted + `[]` → `env.get("PATH")` denied.
- Scoped + `env: ["DB_URL"]` + default → both `PATH` and `DB_URL`
  permitted; `OTHER` denied.
- Scoped + custom allow-list `["MY_*"]` (default replaced) → `MY_FOO`
  permitted; `PATH` denied. Confirms override replaces default.
- Unscoped → all permitted regardless of allow-list.

### `src/core/sandbox-bootstrap.test.ts` (extend, or add focused file)

Run inside a stubbed `getCurrentPlugin()` returning a trusted plugin
manifest, with the enforcer constructed using the default allow-list:

- `process.env.PATH` returns the real value.
- `process.env.AWS_SECRET` (real value set in the test process) returns `undefined`.
- `"PATH" in process.env` is `true`.
- `"AWS_SECRET" in process.env` is `false`.
- `Object.keys(process.env)` includes `PATH`, excludes `AWS_SECRET`.

### Config-load tests (extend the existing `kaizen-config.test.ts` and
harness loader test)

- Absent at both levels → resolved list is `DEFAULT_ENV_ALLOWLIST`.
- User-only `defaults.env_allowlist: ["FOO"]` → resolved is `["FOO"]`.
- Harness-only `env_allowlist: ["BAR"]` → resolved is `["BAR"]`.
- Both present → harness wins.
- Explicit `[]` at user level → resolved is `[]` (not the default).
- Invalid entry at either level → config-load error names the offending entry and source.

### Integration smoke

Add (or extend) an integration test that runs a trusted-tier plugin
calling `child_process.spawn` for a binary on PATH (use `echo` for
portability, or another binary kaizen tests already rely on). Confirms
the spawn succeeds end-to-end.

## Documentation updates

To land alongside the code:

1. **`docs/guides/plugin-authoring.md` (lines 385-391):** replace the
   incorrect "globals are not filtered" paragraph with an accurate one
   describing the env proxy, the allow-list, and the override knobs.

2. **`docs/concepts/security.md`:** extend the existing env-proxy
   explanation to describe the allow-list, the precedence (harness >
   user > default), and the override mechanisms. Update the
   `process.env.X returns undefined unexpectedly` troubleshooting note
   to point at the allow-list first.

3. **Configuration reference** (existing `docs/concepts/configuration.md`
   or `docs/reference/host-api.md` — pick whichever already documents
   `KaizenConfig.defaults.*` and harness fields): document
   `defaults.env_allowlist` and `env_allowlist` (per-harness), the
   syntax (exact name or `PREFIX_*`), the precedence rule, and the
   explicit-empty semantics.

## Risks & open questions

- **Default allow-list ages.** New "infrastructure" vars may emerge (rare,
  but possible). Mitigation: users/harnesses can extend without forking.
  The default is data-shaped, easy to update.
- **Plugins relying on the trusted-tier-blocks-everything behavior.** A
  plugin author who somehow depended on `process.env.PATH === undefined`
  (unlikely) would see a behavior change. Acceptable; the previous
  behavior was a bug.
- **Windows env-var case-insensitivity.** Bun is POSIX-leaning and kaizen
  doesn't claim Windows support today. Match remains case-sensitive.
- **Harness override of an unrelated user policy.** If a user sets a
  strict `[]` and a harness sets a permissive list, the harness wins.
  This is consistent with the existing model: harnesses curate plugin
  behavior. Documented in the config reference.
