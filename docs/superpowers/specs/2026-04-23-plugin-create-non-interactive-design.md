# Non-interactive flags for `kaizen plugin create`

**Status:** approved
**Date:** 2026-04-23
**Closes:** #38, #41

## Problem

`kaizen plugin create <path>` is interactive-only (readline prompts in
`src/commands/plugin-create.ts`). That blocks scripted scaffolding (agents, CI,
bulk plugin generation), reproducible harness bootstrapping, and onboarding
scripts that want to create N plugins in one shot. The `--defaults` flag skips
prompts but gives no control over fields — you get a minimal trusted plugin or
you get prompts.

The scaffolder also omits the `driver` field entirely. Authors building a
session driver must scaffold, then hand-edit `index.ts` to add `driver: true`
and a `start(ctx)` method. Easy to miss; not surfaced anywhere.

## Goals

- Make every scaffold input settable via CLI flag.
- Auto-detect non-interactive environments (no TTY) and skip prompts.
- Preserve the current interactive flow when run from a terminal with no flags.
- Preserve `--defaults` back-compat.
- Add `driver` to the scaffold (interactive prompt + flag + generator support).

## Non-goals

- Rewriting the CLI arg-parsing layer for other commands.
- Adding a third-party arg-parsing dependency.
- Validating the user's config schema shape beyond the `ConfigKey` structure.
- Adding a `--yes` / `--non-interactive` mode flag (superseded by auto-detect).

## Mode selection

No new mode flag. The command picks a mode automatically:

| Condition                                     | Mode            |
|-----------------------------------------------|-----------------|
| `--defaults` passed                           | defaults        |
| `process.stdin.isTTY === true` AND no scaffold flags passed | interactive     |
| otherwise                                     | non-interactive |

"Scaffold flags" means any of: `--name`, `--description`, `--tier`, `--grant`,
`--provides`, `--consumes`, `--driver`, `--config-keys-json`,
`--config-keys-file`.

In non-interactive mode, unset fields take the same defaults as `--defaults`
mode (name = basename of path, tier = trusted, empty grants / provides /
consumes, no config, driver = false). No field is strictly required; the
command cannot fail due to missing input. It can fail due to *invalid* input —
see Validation below.

## Flag surface

```
kaizen plugin create <path> [flags]

  --name <kebab>                  Plugin name (default: basename of path)
  --description <string>          Description text
  --tier trusted|scoped|unscoped  Permission tier (default: trusted)
  --grant <list>                  Grants; repeatable and/or comma-separated.
                                  Valid: fs, net, env, exec, events
  --provides <svc>                Service provided; repeatable and/or comma-separated
  --consumes <svc>                Service consumed; repeatable and/or comma-separated
  --driver                        Scaffold as a session driver
  --config-keys-json <string>     Inline JSON array of ConfigKey objects
  --config-keys-file <path>       Path to JSON file containing a ConfigKey array
  --defaults                      Use all defaults; skip prompts (existing)
```

- `--grant`, `--provides`, `--consumes` are repeatable. Each occurrence may
  also be a comma-separated list. Implementation: `flags.flatMap(s =>
  s.split(",").map(x => x.trim()).filter(Boolean))`.
- `--config-keys-json` and `--config-keys-file` are mutually exclusive;
  passing both is a usage error (exit 1).
- Providing either config-keys flag implicitly sets `hasConfig: true`.

## Config keys JSON shape

Both `--config-keys-json` (inline) and `--config-keys-file` (path) accept the
same format: a JSON array of `ConfigKey` objects.

```json
[
  { "name": "api_key", "type": "string", "required": true,  "secret": true },
  { "name": "port",    "type": "number", "required": false, "secret": false }
]
```

Each entry MUST be an object with:

- `name`: non-empty string
- `type`: `"string"` or `"number"`
- `required`: boolean
- `secret`: boolean

Kaizen validates this shape and rejects malformed input with a clear error
naming the offending entry. Kaizen does not validate the semantics of the
user's config schema beyond this structural check — the user (or CI system)
is responsible for supplying a correct shape.

## Validation

Non-interactive input is validated before any files are written:

- `--tier` must be one of `trusted`, `scoped`, `unscoped`.
- `--grant` values must each be one of `fs`, `net`, `env`, `exec`, `events`.
- `--config-keys-json` must parse as JSON.
- `--config-keys-file` must exist and contain parseable JSON.
- Parsed config-keys input must be an array of objects matching the shape
  above.
- `--config-keys-json` and `--config-keys-file` must not both be passed.

Any failure prints a targeted error to stderr and exits 1. The existing
"target path already exists" check remains the first gate.

## Implementation

### Arg parsing

Use `node:util`'s `parseArgs` (available in Bun and Node; zero new deps).
The parsing lives in `src/cli.ts`, in the `plugin create` branch, and produces
a typed `CliFlags` object passed to `runPluginCreate`.

```ts
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: true,
  options: {
    name:              { type: "string" },
    description:       { type: "string" },
    tier:              { type: "string" },
    grant:             { type: "string", multiple: true },
    provides:          { type: "string", multiple: true },
    consumes:          { type: "string", multiple: true },
    driver:            { type: "boolean" },
    "config-keys-json":{ type: "string" },
    "config-keys-file":{ type: "string" },
    defaults:          { type: "boolean" },
  },
});
```

### Entry-point changes

`runPluginCreate(targetPath, opts)` grows a richer opts type:

```ts
interface PluginCreateOpts {
  defaults?: boolean;
  flags?: Partial<{
    name: string;
    description: string;
    tier: "trusted" | "scoped" | "unscoped";
    grants: Array<"fs" | "net" | "env" | "exec" | "events">;
    provides: string[];
    consumes: string[];
    driver: boolean;
    configKeysJson: string;
    configKeysFile: string;
  }>;
}
```

### Data model

`PluginScaffoldConfig` gains a `driver: boolean` field:

```ts
export interface PluginScaffoldConfig {
  name: string;
  description: string;
  tier: "trusted" | "scoped" | "unscoped";
  grants: Array<"fs" | "net" | "env" | "exec" | "events">;
  provides: string[];
  consumes: string[];
  hasConfig: boolean;
  configKeys: ConfigKey[];
  driver: boolean;          // new
}
```

All existing default-builders (the `--defaults` path in `runPluginCreate`)
initialise `driver: false`.

### Flow

1. `cli.ts` parses flags into `CliFlags`; builds `opts` for `runPluginCreate`.
2. `runPluginCreate` selects mode (defaults / interactive / non-interactive)
   per the table above.
3. For non-interactive mode: `buildConfigFromFlags(targetPath, opts.flags)`
   produces a validated `PluginScaffoldConfig`, or exits 1 with an error.
4. The rest of the flow (mkdir, write files, print success) is unchanged.

### Generator changes

`generateIndexTs(cfg)`:

- When `cfg.driver === true`, emit `driver: true,` in the manifest object.
- When `cfg.driver === true`, append a `start(ctx)` method after `setup`:
  ```ts
  async start(ctx) {
    // TODO: implement session loop
    ctx.log("driver started");
  },
  ```

`generateIndexTestTs(cfg)`:

- When `cfg.driver === true`, add an assertion:
  ```ts
  it("declares driver: true", () => {
    expect(plugin.driver).toBe(true);
  });
  ```

### Interactive prompt

`promptConfig` gains one question, after `consumes` and before the config
question:

```
Is this a session driver? (y/N) [N]:
```

`y` → `driver: true`; anything else → `false`.

## Tests

Added to `src/commands/plugin-create.test.ts`:

- `buildConfigFromFlags` builds the expected `PluginScaffoldConfig` from a
  full flag set.
- Comma-separated and repeated `--grant` produce identical results.
- Invalid `--tier` → error, non-zero exit.
- Invalid `--grant` value → error, non-zero exit.
- `--config-keys-json` with valid JSON → `hasConfig: true`, configKeys parsed.
- `--config-keys-json` with invalid JSON → error, non-zero exit.
- `--config-keys-file` with valid file → same result as equivalent inline JSON.
- Both `--config-keys-json` and `--config-keys-file` passed → error.
- `--driver` → generated `index.ts` includes `driver: true` and a `start`
  method; generated test asserts `plugin.driver === true`.
- Non-interactive path with zero flags and non-TTY stdin produces the same
  output as `--defaults`.
- `--defaults` path still works (back-compat).

Interactive-flow tests remain unchanged; the prompt additions for `driver`
are covered by a unit test of `promptConfig` if one exists (today the
interactive path is not covered; we do not add coverage for it here).

## Docs

Updated:

- `docs/guides/plugin-authoring.md` — scaffold section adds a non-interactive
  example (agent/CI invocation with full flags) and notes the auto-detect
  behavior.
- `docs/reference/plugin-standards.md` (if it documents `kaizen plugin create`
  surface) — reflect new flags.

## Files touched

- `src/commands/plugin-create.ts` — `PluginScaffoldConfig.driver`, generator
  updates, interactive driver prompt, `buildConfigFromFlags()`,
  mode-selection logic.
- `src/cli.ts` — `parseArgs` for the `plugin create` subcommand.
- `src/commands/plugin-create.test.ts` — new tests listed above.
- `docs/guides/plugin-authoring.md` — document non-interactive usage.

## Rollout

- No breaking changes. Existing interactive flow, `--defaults` flag, and
  generator output for non-driver plugins are unchanged.
- Existing callers of `runPluginCreate({ defaults: true })` continue to work;
  the new `flags` field is optional.
