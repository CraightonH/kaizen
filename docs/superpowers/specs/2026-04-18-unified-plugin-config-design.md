# Design: Unified Plugin Configuration

Date: 2026-04-18
Status: APPROVED
Related:
- `docs/plugin-api.md` (current `ctx.config` usage — this spec replaces that section)
- `docs/superpowers/specs/2026-04-18-plugin-marketplace-design.md` (Spec 1 — install lifecycle hooks)
- `docs/superpowers/specs/2026-04-18-plugin-scaffolder-standards-design.md` (Spec 3 — scaffolded plugins use this config pattern)

---

## Problem Statement

Plugin config today is a raw `Record<string, unknown>` pulled from the plugin's
namespace in `kaizen.json`. There is no schema, no validation, no discoverability,
and no standard way to declare which values are secrets. Authors write patterns like:

```typescript
const key = process.env[ctx.config["api_key_env"] as string];
const timeout = ctx.config["timeout_ms"] as number ?? 5000;
```

This is brittle (wrong key = silent `undefined`), unvalidated (wrong type at runtime),
and undiscoverable (no way to know what a plugin needs without reading its source).

This design adds:

1. **Declared config schema** on the plugin export (JSON Schema + defaults).
2. **Validation at load time** — misconfigured plugins fail fast with clear errors.
3. **Typed `ctx.config`** — the context surface returns a validated, typed object.
4. **Secrets declaration** — `config.secrets` marks which keys are env-var names,
   eliminating the `api_key_env` indirection pattern.
5. **Merge precedence** — a defined order: plugin defaults → kaizen-level defaults →
   harness config → env overrides.
6. **`kaizen config` CLI** — inspect and override config from the command line.

---

## Design Philosophy

- **Fail at load, not at call time.** A plugin whose required config is missing should
  die at startup, not when the first user message hits a code path that reads config.
- **Schema as documentation.** A plugin's `config.schema` is human-readable. `kaizen
  config show <plugin>` surfaces it. Third-party tooling (IDEs, harness authors) can
  validate harness files before running.
- **No new dependency.** ajv is already in the project (used for tool parameter
  validation). Config schema validation reuses it.
- **Backward compatible.** Plugins that don't declare a schema continue to work.
  `ctx.config` stays available as a raw object for legacy access.

---

## Scope

### In Scope

- `config` field on `KaizenPlugin` export: `schema`, `defaults`, `secrets`.
- Config merge pipeline: defaults → kaizen-level → harness → env.
- `ctx.config` typed access (replaces current raw `Record<string, unknown>`).
- `ctx.secrets.get(key)` integration with declared secrets.
- Validation at plugin load time.
- `kaizen config show [<plugin>]` — display effective merged config + schema.
- `kaizen config get <plugin>.<path>` — read a single value.
- `kaizen config set <plugin>.<path> <value>` — write to project harness config.
- Core wiring in `src/core/context.ts` and `src/core/loader.ts`.

### Out of Scope

- Config encryption at rest (secrets are still env var names; actual values come from
  the environment, not kaizen storage).
- Per-user config override layer (beyond the env-var layer already present).
- IDE schema integration / JSON Schema Language Server support (future).
- Harness-level config validation CLI (future).

---

## Plugin Config Declaration

Plugins declare config on their default export alongside `name`, `apiVersion`, etc.:

```typescript
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "my-plugin",
  apiVersion: "2.0.0",
  permissions: { tier: "scoped", env: ["MY_API_KEY"] },
  capabilities: { consumes: ["core-events:service"] },

  config: {
    schema: {
      type: "object",
      properties: {
        api_key:    { type: "string", description: "API key for the service." },
        timeout_ms: { type: "number", description: "Request timeout in milliseconds." },
        base_url:   { type: "string", description: "Service base URL." },
      },
      required: ["api_key"],
    },
    defaults: {
      timeout_ms: 5000,
      base_url: "https://api.example.com",
    },
    secrets: ["api_key"],  // these values are env var names resolved at runtime
  },

  async setup(ctx) {
    const cfg = ctx.config;            // typed as Record<string, unknown> (v1)
    const key = cfg.api_key as string; // resolved from env — not the raw key name
    const timeout = cfg.timeout_ms as number;
    ctx.log(`connecting to ${cfg.base_url} with timeout ${timeout}ms`);
  },
};
```

### The `config` field

```typescript
interface PluginConfigDeclaration {
  /**
   * JSON Schema (draft-07) describing valid config. `type: "object"` is assumed
   * if omitted. Core validates the merged config against this schema at load time.
   */
  schema?: JSONSchema;
  /**
   * Default values merged before harness config. Plugin-level defaults have lowest
   * precedence.
   */
  defaults?: Record<string, unknown>;
  /**
   * Keys whose values are environment variable NAMES. When core resolves config,
   * it replaces the value of a secrets key with `process.env[value]`.
   * Requires the key to appear in `permissions.env`.
   */
  secrets?: string[];
}
```

### Secrets resolution

The `secrets` array names config keys whose values are environment variable names,
not literal values. Core resolves them during the merge pipeline:

```json
// In kaizen.json harness:
{ "my-plugin": { "api_key": "MY_API_KEY" } }
```

```typescript
// ctx.config.api_key === process.env["MY_API_KEY"]  (the actual key value)
```

This eliminates the `api_key_env` indirection. The plugin author no longer needs
to write `process.env[ctx.config["api_key_env"] as string]`.

If the env var is missing and `api_key` is in `required`, load fails with:
`"my-plugin: required config key 'api_key' is missing. Set env var MY_API_KEY."`.

---

## Merge Precedence

Config is built right-to-left (right wins):

```
plugin.config.defaults
  ← ~/.kaizen/kaizen.json defaults.<plugin-name>
    ← <harness>/kaizen.json <plugin-name>
      ← env vars (secrets resolution)
```

**Plugin defaults** are the lowest priority. Authors use them for safe fallback values.

**Kaizen-level defaults** (in `~/.kaizen/kaizen.json` under a `defaults` key) let users
set personal overrides that apply across all harnesses. Example: a personal
`anthropic.api_key_env` preference.

**Harness config** is the main per-project config (today's `kaizen.json`). This is
what harness authors ship.

**Env vars** (secrets resolution) are the highest priority. An env var in the shell
always overrides the harness-specified value.

---

## Validation

Validation runs in `src/core/loader.ts` after merging config, before calling
`plugin.setup(ctx)`.

Steps:
1. Build merged config (defaults → kaizen-level → harness → secrets).
2. Validate against `plugin.config.schema` using ajv.
3. If invalid: fatal error with the plugin name, the failing path, and the schema
   constraint. Example:
   ```
   Error: my-plugin config invalid:
     - /timeout_ms: must be number (got string "5000")
     - /api_key: required
   ```
4. Pass the validated, merged config to `createPluginContext`.

Plugins without `config.schema` skip validation. Their `ctx.config` is the raw
merged object from the harness (today's behaviour).

---

## `ctx.config` Surface

`ctx.config` returns the validated, merged config object. Type is
`Record<string, unknown>` at runtime (typed via schema at declaration time; a future
spec may add TypeScript-level generics).

Secrets keys in `ctx.config` return the **resolved env var value**, not the env var
name. The raw name is not exposed.

```typescript
// plugin declares: secrets: ["api_key"]
// harness has:     "my-plugin": { "api_key": "MY_API_KEY" }
// shell has:       MY_API_KEY=abc123

ctx.config.api_key  // → "abc123"
```

`ctx.secrets.get(key)` remains available as an explicit alternative. It is equivalent
to reading `ctx.config[key]` for a key in `secrets`.

---

## CLI: `kaizen config`

### `kaizen config show [<plugin>]`

Prints the effective merged config for all plugins (or one). Shows:
- Each key with its resolved value (secrets values are redacted: `***`).
- The source of each value: `[default]`, `[global]`, `[harness]`, `[env]`.
- The plugin's declared schema (if any) as a compact table.

Example output:
```
my-plugin config:
  api_key      ***           [env MY_API_KEY]
  timeout_ms   5000          [default]
  base_url     https://...   [harness]

Schema:
  api_key    string   required   "API key for the service."
  timeout_ms number   optional   "Request timeout in milliseconds."
  base_url   string   optional   "Service base URL."
```

### `kaizen config get <plugin>.<path>`

Prints the resolved value at the dotted path. Secrets are redacted.
Exit 1 if plugin or path not found.

### `kaizen config set <plugin>.<path> <value>`

Writes the value to the project's `.kaizen/kaizen.json` under the plugin's namespace.
Validates the new value against the plugin's schema (if available).
Fails if the plugin is not in the current harness.

---

## Component Architecture

### Modified: `src/types/plugin.ts`

Add `PluginConfigDeclaration` interface and `config?: PluginConfigDeclaration` field
to `KaizenPlugin`.

### Modified: `src/core/loader.ts`

Add `mergePluginConfig(plugin, globalConfig, harnessConfig): Record<string, unknown>`
and `validatePluginConfig(plugin, merged): void`.

### Modified: `src/core/context.ts`

`createPluginContext` receives pre-validated merged config and exposes it as
`ctx.config`. Secrets keys return resolved env values.

### New: `src/core/config-validator.ts`

Wraps ajv instance (reuse the one from `tool-registry.ts` or instantiate separately).
Exports `validateConfig(schema, data): ValidationError[]`.

### New: `src/commands/config.ts`

Implements `show`, `get`, `set` subcommands.

### Modified: `src/cli.ts`

Wire `kaizen config` subcommand.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Required config key missing | Fatal at startup: "Plugin <n>: required config key '<k>' missing." |
| Config value wrong type | Fatal at startup: lists all ajv errors |
| Secrets key env var missing (required) | Fatal at startup: "Set env var <VAR_NAME>" |
| Secrets key env var missing (optional) | Config key resolves to `undefined`; plugin handles |
| Schema itself invalid JSON Schema | Fatal at startup: "Plugin <n>: config.schema is not a valid JSON Schema" |
| `kaizen config set` with invalid value | Error; does not write. Shows schema constraint. |

---

## Testing

| Area | Approach |
|------|----------|
| Merge pipeline | Unit tests for all four layers; secrets resolution; right-wins order |
| Validation | Valid config, missing required, wrong type, nested path errors |
| Secrets | Env var present, missing required, missing optional |
| `ctx.config` access | Resolved values match expectations; secrets redacted in `show` |
| CLI `show` | Snapshot test for output format |
| CLI `get` | Found, not found, nested path |
| CLI `set` | Writes to correct config file; validates before write |
| Backward compat | Plugin without `config` field loads unchanged |

---

## Migration

- **Existing plugins** that read `ctx.config["api_key_env"]` then call
  `process.env[...]` continue to work. No breaking change.
- **Recommended migration** for existing built-in plugins: add `config.schema`,
  `config.defaults`, and `config.secrets` to their exports. Update `setup()` to use
  `ctx.config.api_key` directly.
- Migration guide added to `docs/plugin-api.md`.

---

## Future Work

- TypeScript-level typed `ctx.config`: `ctx.config<MyConfigType>()` with compile-time
  safety derived from the declared schema. Requires codegen or TypeScript declaration
  augmentation — deferred for complexity.
- Harness validation CLI: `kaizen validate` checks harness config against all loaded
  plugins' schemas before running. Useful for CI.
- IDE schema integration: emit a JSON Schema for each plugin's config namespace, wire
  into a VS Code extension for `kaizen.json` autocompletion.
