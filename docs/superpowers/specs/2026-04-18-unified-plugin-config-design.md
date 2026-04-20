# Design: Unified Plugin Configuration & Pluggable Secrets

Date: 2026-04-18
Status: APPROVED
Related:
- `docs/plugin-api.md` (current `ctx.config` usage — this spec replaces that section)
- `docs/superpowers/specs/2026-04-18-plugin-marketplace-design.md` (Spec 1 — consumes `kaizen-config.ts` module; marketplace-qualified refs)
- `docs/superpowers/specs/2026-04-18-plugin-scaffolder-standards-design.md` (Spec 3 — scaffolded plugins use this config pattern)
- `docs/superpowers/specs/2026-04-17-capability-registry-design.md` (capability ordering for secret providers)

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

Secrets are a second-class concern. Plugins read `process.env` directly. There is no
OS-portable secret store, no way to swap in Doppler/Vault, and no mechanism for
runtime secret fetches when an LLM navigates into a code path the author didn't
anticipate.

This design adds:

1. **Declared config schema** on the plugin export (JSON Schema + defaults).
2. **Validation at install + load time** — shape errors fail fast with clear messages.
3. **Typed `ctx.config`** — the context surface returns a validated object containing
   non-secret values only.
4. **Structured secret references** — `{ provider, ref }` in harness config; bare
   string is shorthand for the default provider.
5. **Pluggable secret providers** — the `core-secrets:provider` capability lets any
   plugin supply secrets. Default `core-secrets` plugin uses OS keychain (macOS
   Keychain, Windows Credential Manager, Linux libsecret / file fallback). Doppler,
   Vault, etc. ship as replacement plugins.
6. **Lazy async `ctx.secrets.get(key)`** — declared secrets pre-fetched in
   background at setup; undeclared secrets resolvable mid-workflow for LLM-driven
   paths.
7. **Merge precedence** — a defined order: plugin defaults → kaizen-level defaults
   → harness config → env overrides.
8. **`kaizen config` CLI** — inspect, override, and set secrets from the command
   line.

---

## Design Philosophy

- **Fail at install or load, not at call time.** A misconfigured plugin dies at
  startup, not when the first user message hits a code path that reads config.
  Schema-shape errors are catchable at `kaizen install`; secret value resolution is
  deferred to runtime.
- **Schema as documentation.** A plugin's `config.schema` is human-readable. `kaizen
  config show <plugin>` surfaces it. Third-party tooling validates harness files
  before running.
- **Non-secret config never leaks to env.** Kaizen stores non-secret config in its
  own files. It does not export plugin config as env vars the way Claude Code does
  (`CLAUDE_PLUGIN_OPTION_*`). Env vars may *override* config values when set, but
  kaizen never writes them.
- **Secrets are pluggable at runtime.** Providers are plain kaizen plugins declaring
  the `core-secrets:provider` capability. The capability-registry ordering
  guarantees any consumer loads after its provider. Providers that need network
  I/O (Doppler, Vault) get to stay live for the whole session.
- **OS-portable defaults.** The built-in `core-secrets` provider uses the native
  OS secret store on macOS, Windows, and Linux, with an encrypted-file fallback for
  headless environments. No reliance on user-managed env vars.
- **Authority lives with the provider.** Kaizen does not duplicate a provider's
  access-control rules. If Doppler rejects a secret lookup, kaizen surfaces the
  error; it does not pre-filter keys.
- **No new dependency.** ajv is already in the project (tool parameter validation).
  Config schema validation reuses it.
- **Backward compatible.** Plugins that don't declare `config` continue to work.
  `ctx.config` stays available as a raw `Record<string, unknown>` for legacy access.

---

## Scope

### In Scope

- `config` field on `KaizenPlugin` export: `schema`, `defaults`, `secrets`.
- Config merge pipeline: plugin defaults → kaizen-level defaults → harness → env.
- Env override convention: `KAIZEN_<PLUGIN>_<KEY>` (uppercased, underscored),
  plus optional per-key `envOverride` escape hatch.
- `ctx.config` typed access — contains validated non-secret config values only.
- `ctx.secrets.get(key): Promise<string | undefined>` — async, provider-backed;
  declared secrets pre-fetched at setup.
- Structured secret reference format in harness config: `{ provider, ref }`; bare
  string = default provider.
- `core-secrets:provider` capability (registered in Spec's capability registry).
- `core-secrets` built-in plugin: OS keychain on macOS / Windows / Linux, file
  fallback at `~/.kaizen/.credentials.json` (chmod 600).
- Install-time validation: schema shape, non-secret required keys, registered
  provider existence for every declared secret ref.
- Load-time validation: same schema check post-merge; secret values resolved
  lazily (first `ctx.secrets.get(key)` call, with background pre-fetch).
- `kaizen config show [<plugin>]` — effective merged config + schema.
- `kaizen config get <plugin> <path>` — read a single value.
- `kaizen config set <plugin> <path> <value>` — write to project harness config.
- `kaizen config set-secret <plugin> <key>` — interactive prompt, writes via the
  default provider (OS keychain).
- Core wiring: `src/core/context.ts`, `src/core/loader.ts`, new
  `src/core/config-validator.ts`, `src/core/config-merge.ts`, `src/core/secrets.ts`,
  `src/core/secret-providers/*`.

### Out of Scope

- Non-default secret providers (Doppler, Vault, AWS Secrets Manager). These ship
  as separate plugins authored by the community or kaizen-sh.
- Kaizen-side secret access-control (globs, allowlists). Providers own auth.
- Per-user overlay config file beyond the env-var layer.
- IDE schema integration / JSON Schema Language Server support.
- Harness-level config validation CLI (`kaizen validate`) — future.
- TypeScript-typed `ctx.config<T>()` with compile-time guarantees — future.

---

## Plugin Config Declaration

Plugins declare config on their default export alongside `name`, `apiVersion`, etc.:

```typescript
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "stripe-billing",
  apiVersion: "2.0.0",
  permissions: { tier: "scoped", net: ["api.stripe.com"] },
  capabilities: { consumes: ["core-events:service", "core-secrets:provider"] },

  config: {
    schema: {
      type: "object",
      properties: {
        api_key:    { type: "string", description: "Stripe secret key." },
        timeout_ms: { type: "number", description: "Request timeout in ms." },
        base_url:   { type: "string", description: "API base URL." },
      },
      required: ["api_key"],
    },
    defaults: {
      timeout_ms: 5000,
      base_url: "https://api.stripe.com",
    },
    secrets: ["api_key"],
  },

  async setup(ctx) {
    const apiKey = await ctx.secrets.get("api_key");
    ctx.log(`stripe: timeout=${ctx.config.timeout_ms}ms base=${ctx.config.base_url}`);
    // ...
  },
};
```

### The `config` field

```typescript
interface PluginConfigDeclaration {
  /**
   * JSON Schema (draft-07) describing valid config. `type: "object"` is assumed at
   * the root. Validates the merged, non-secret config at install and load time.
   */
  schema?: JSONSchema;
  /**
   * Default values. Lowest-precedence layer in the merge pipeline.
   */
  defaults?: Record<string, unknown>;
  /**
   * Config keys whose values are secret references (not plain data). Core does NOT
   * expose these on `ctx.config`; they are accessed exclusively through
   * `ctx.secrets.get(key)`.
   *
   * A plugin that declares any secret automatically gains an implicit
   * `consumes: ["core-secrets:provider"]` capability dependency (the
   * capability-registry orders secret providers before consumers).
   */
  secrets?: string[];
}
```

### Config keying in harness files

Harness `kaizen.json` keys plugin config by the plugin's **declared `name`**. When
two loaded plugins share a name (e.g. shadowing from different marketplaces), the
full marketplace-qualified ref (e.g. `official/stripe-billing`) is accepted as the
config key and resolves unambiguously. Shorthand is canonicalized to the qualified
ref on write (via `kaizen config set`) when disambiguation is needed.

Name collision without an explicit qualified config key is a fatal load-time error
with guidance to qualify in the harness.

---

## Secret References

Secret values live outside the harness. The harness stores *how to fetch* the value:

```json
{
  "stripe-billing": {
    "api_key": { "provider": "kaizen", "ref": "stripe-prod" },
    "timeout_ms": 3000
  }
}
```

### Reference shape

```typescript
interface StructuredSecretRef {
  /** Registered provider name (capability slot). `kaizen` = default provider. */
  provider: string;
  /** Provider-specific identifier (env var name, keychain item, Doppler key, ...). */
  ref: string;
  /** Optional override: read env var first, use its value if set. */
  envOverride?: string;
}

type SecretRef = string | StructuredSecretRef;
```

Bare string shorthand:
```json
"api_key": "stripe-prod"
```
is equivalent to:
```json
"api_key": { "provider": "kaizen", "ref": "stripe-prod" }
```

### Provider naming

Providers register under a **name**, not a URI scheme. The default `core-secrets`
plugin registers under `kaizen`. A Doppler plugin registers under `doppler`. Name
collisions (two installed providers claiming the same name) are a fatal load-time
error.

### Env override

For every secret key, core checks env overrides in this order before calling the
provider:

1. If `envOverride` is set on the ref and `process.env[envOverride]` is defined —
   use it.
2. If `process.env["KAIZEN_<PLUGIN>_<KEY>"]` is defined (uppercased,
   non-alphanumeric → `_`) — use it.
3. Otherwise, call the provider: `provider.get(ref)`.

The fixed `KAIZEN_<PLUGIN>_<KEY>` convention means any secret (or non-secret
config value; see below) can be overridden in CI without harness changes. The
`envOverride` field exists for CI systems that already export secrets under
pre-existing names (e.g. `STRIPE_KEY`) and don't want to rename.

### Non-secret env overrides

Non-secret config values are overridden by the same
`KAIZEN_<PLUGIN>_<KEY>` convention but with no `envOverride` escape hatch
(since there is no structured form to attach it to). Env values are parsed as
strings unless the schema's type is `number` or `boolean`, in which case core
coerces.

---

## Secret Provider Capability

`core-secrets:provider` is a capability (per
`2026-04-17-capability-registry-design.md`). Providers declare:

```typescript
capabilities: {
  provides: [
    { kind: "core-secrets:provider", name: "kaizen" }
  ],
},
```

The `name` field distinguishes providers. Consumers never pick a provider by id;
they reference it by name from harness config.

### Provider interface

```typescript
interface SecretProvider {
  /** Unique provider name (must match the `name` in the capability declaration). */
  readonly name: string;

  /**
   * Fetch a secret by provider-specific ref.
   * Returns `undefined` if the ref is unknown (not an error — core decides what to
   * do based on whether the key is required).
   * Throws on auth/transport failure.
   */
  get(ref: string): Promise<string | undefined>;

  /**
   * Optional: write a secret. Invoked by `kaizen config set-secret` when this
   * provider is the target. Read-only providers (Doppler, Vault) omit this.
   */
  set?(ref: string, value: string): Promise<void>;

  /**
   * Optional: warm the provider's cache for a known list of refs. Called once at
   * setup time with all declared secrets that target this provider.
   */
  prefetch?(refs: string[]): Promise<void>;
}
```

Providers register themselves during `setup()` via the capability registry API:

```typescript
ctx.capabilities.register("core-secrets:provider", myProvider);
```

### Default provider: `core-secrets`

Ships as a built-in plugin. Registers under the name `kaizen`. Storage:

- **macOS:** Keychain via the `security` CLI (or a binding if we pick one).
- **Windows:** Credential Manager via `wincred` / PowerShell.
- **Linux:** libsecret via `secret-tool`.
- **Fallback (any OS):** `~/.kaizen/.credentials.json`, chmod 600, JSON object
  `{ "<ref>": "<value>" }`. Used when OS store is unavailable or `KAIZEN_SECRETS_BACKEND=file`.

Implements `get`, `set`, and `prefetch` (trivial — keychain reads are cheap, but
prefetch is still useful as a "surface auth errors early" hook).

The `core-secrets` plugin is distributed alongside kaizen built-ins and installed
by default. Users replace it by installing a different provider plugin and
removing or shadowing `core-secrets`.

### Dependency ordering

Any plugin that declares `config.secrets` gains an implicit
`consumes: ["core-secrets:provider"]` dependency. The capability-registry orders
all provider plugins before any consumer. If no provider registers the `name` a
ref targets, that consumer fails to load with a clear error.

---

## Merge Precedence

Non-secret config is built right-to-left (right wins):

```
plugin.config.defaults
  ← ~/.kaizen/kaizen.json defaults[<plugin>]
    ← <harness>/kaizen.json [<plugin>]
      ← env overrides (KAIZEN_<PLUGIN>_<KEY>)
```

Merge is **shallow per top-level key** (matching Claude Code's `pluginConfigs`
semantics). A harness that overrides `retry: { max: 5 }` on a plugin whose default
is `retry: { max: 3, delay: 100 }` replaces the entire `retry` object. Document
this prominently in `docs/plugin-api.md` and surface it in `kaizen config show`
output.

Secrets do not participate in this merge. Only the *reference* for a given secret
key participates (same shallow-replace semantics as other keys); resolution
happens via the provider.

---

## Validation

Runs in two phases.

### Install-time (`kaizen install <ref>`)

After fetching plugin bits and before writing to the lockfile:

1. Parse `config.schema`. Invalid JSON Schema → fatal.
2. Merge plugin defaults + kaizen-level defaults + harness config (if a project
   harness is active).
3. Validate merged config against schema. **Secrets keys** (those declared in
   `config.secrets`) are stripped before validation — their *refs* are validated
   structurally only (must be a string or `{ provider, ref }`), not against the
   schema's type.
4. For each declared secret, check the referenced `provider` is a registered
   capability name. Fatal if unknown (with guidance: "install a plugin that
   provides this provider, or change the ref").
5. Do NOT attempt to fetch secret values. The install machine may lack auth; CI
   is a legitimate reason for values to be absent at install time.

### Load-time (`kaizen run`)

1. Repeat the merge + schema validation (harness or env vars may have changed).
2. For each declared secret, background-prefetch via `provider.prefetch?.(refs)`.
   Failures are logged but non-fatal — the actual `get(key)` call surfaces the
   error to the plugin.
3. Call `plugin.setup(ctx)`. `ctx.config` contains only non-secret values;
   `ctx.secrets.get(key)` is the only access path for declared secrets.

### Error format

```
Error: my-plugin config invalid:
  - /timeout_ms: must be number (got string "5000")
  - /api_key: references provider 'doppler' but no plugin provides it.
    Install a provider: kaizen install doppler-secrets
    Or change the ref: kaizen config set my-plugin api_key '{"provider":"kaizen","ref":"..."}'
```

---

## `ctx.config` and `ctx.secrets` Surface

### `ctx.config`

Returns the validated, merged, **non-secret** config object. Type:
`Record<string, unknown>` at runtime. Secret keys are absent — accessing
`ctx.config.api_key` when `api_key` is declared in `config.secrets` returns
`undefined`.

```typescript
ctx.config.timeout_ms  // → 5000
ctx.config.base_url    // → "https://api.stripe.com"
ctx.config.api_key     // → undefined (declared secret)
```

### `ctx.secrets.get(key)`

```typescript
get(key: string): Promise<string | undefined>
```

Resolves a secret. If `key` is declared in `config.secrets`, core uses the
harness's ref for that key (pre-fetched at setup for fast first access). If `key`
is undeclared, core treats it as a ref against the default provider — useful for
LLM-driven flows where the plugin author can't know secret names upfront:

```typescript
// Declared — fast, uses harness ref, honors envOverride
const stripe = await ctx.secrets.get("api_key");

// Undeclared — live provider lookup, no env override convention
const other = await ctx.secrets.get("random-runtime-key");
```

Provider errors propagate. Missing values (provider returned `undefined`) return
`undefined` — the caller decides whether that's fatal.

### `ctx.secrets.refresh(key)`

```typescript
refresh(key: string): Promise<string | undefined>
```

Forces a re-fetch, bypassing any cache. Intended for long-running plugins whose
secrets rotate.

---

## CLI: `kaizen config`

Space-separated arguments (no dot-notation) to avoid collisions with
marketplace-qualified refs and dotted config paths.

### `kaizen config show [<plugin>]`

Prints the effective merged config for all plugins (or one). Shows:

- Each non-secret key with its resolved value and source annotation (`[default]`,
  `[global]`, `[harness]`, `[env KAIZEN_X_Y]`).
- Each secret key with provider/ref (value redacted as `***`).
- The plugin's declared schema as a compact table.
- A footnote if shallow-merge replaced a nested object (heuristic: any top-level
  key whose value is an object present in both defaults and harness).

Example:
```
stripe-billing:
  timeout_ms  5000                     [default]
  base_url    https://api.stripe.com   [default]
  api_key     *** (provider: kaizen, ref: stripe-prod)  [harness]

Schema:
  api_key     string   required   "Stripe secret key."
  timeout_ms  number   optional   "Request timeout in ms."
  base_url    string   optional   "API base URL."
```

### `kaizen config get <plugin> <path>`

Prints the resolved value at the dotted path. Secrets redacted unless `--reveal`
is passed. Exit 1 if plugin or path not found.

### `kaizen config set <plugin> <path> <value>`

Writes the value to the project's `.kaizen/kaizen.json` under the plugin's
namespace. Validates the new value against the schema. Fails if the plugin is not
in the current harness. `--global` writes to `~/.kaizen/kaizen.json` `defaults[<plugin>]`
instead.

### `kaizen config set-secret <plugin> <key>`

Interactive prompt (value never echoed). Writes via the default provider's `set()`
method. Refuses if the default provider doesn't implement `set` (e.g. the user
has swapped in a read-only provider like Doppler). Stores the ref in the harness
(or `--global` for kaizen-level defaults) as `{ provider: "kaizen", ref: "<chosen-ref>" }`.

`--provider <name>` targets a specific non-default provider that implements `set`.
Rare; mostly unused.

---

## Component Architecture

### Modified: `src/types/plugin.ts`

Add `PluginConfigDeclaration`, `SecretRef`, `StructuredSecretRef` interfaces. Add
`config?: PluginConfigDeclaration` field to `KaizenPlugin`.

### Modified: `src/core/loader.ts`

Add `mergePluginConfig(plugin, globalConfig, harnessConfig): Record<string, unknown>`
and `validatePluginConfig(plugin, merged): void`. Wire install-time and load-time
validation phases described above.

### Modified: `src/core/context.ts`

`createPluginContext` receives pre-validated merged config. Exposes `ctx.config`
(non-secrets only) and `ctx.secrets` (from new `src/core/secrets.ts`).

### Modified: `src/cli.ts`

Wire `kaizen config` subcommand with `show`, `get`, `set`, `set-secret`.

### Modified: `src/commands/install.ts`

Add install-time config validation step (post-lockfile-write would be too late —
wire before lockfile write).

### New: `src/core/config-validator.ts`

Wraps ajv instance (reuse from `tool-registry.ts` or instantiate separately).
Exports `validateConfig(schema, data): ValidationError[]` and
`validateSchemaItself(schema): boolean`.

### New: `src/core/config-merge.ts`

Exports `mergePluginConfig`, `applyEnvOverrides(pluginName, merged, schema)`,
`separateSecrets(merged, secretKeys): { config, secretRefs }`.

### New: `src/core/secrets.ts`

`SecretsRegistry` — tracks registered providers by name. Instantiated once per
kaizen run.
- `register(name, provider)` — called by provider plugins during `setup()`.
- `resolve(pluginName, key, ref): Promise<string | undefined>` — the env-override
  + provider-call pipeline.
- `prefetch(pluginName, secrets, refs)` — called by loader once per plugin.
- `createSecretsContext(pluginName, declaredRefs)` — returns the `ctx.secrets`
  handle bound to a specific plugin.

### New: `src/core/secret-providers/` (types only here; implementations in `plugins/core-secrets/`)

`SecretProvider` interface export. Canonical location for third-party providers
to import from.

### New: `plugins/core-secrets/`

Built-in plugin. Implements the default `kaizen` provider:
- `plugins/core-secrets/index.ts` — plugin entry; registers the provider.
- `plugins/core-secrets/keychain-macos.ts` — `security` CLI wrapper.
- `plugins/core-secrets/keychain-windows.ts` — PowerShell `CredentialManager` wrapper.
- `plugins/core-secrets/keychain-linux.ts` — `secret-tool` wrapper.
- `plugins/core-secrets/file-fallback.ts` — `~/.kaizen/.credentials.json` (chmod 600).
- `plugins/core-secrets/detect.ts` — picks backend at startup (OS + availability).

### New: `src/commands/config.ts`

Implements `show`, `get`, `set`, `set-secret` subcommands.

---

## Error Handling

| Scenario | Phase | Behaviour |
|----------|-------|-----------|
| Required non-secret config key missing | install + load | Fatal with key name |
| Config value wrong type | install + load | Fatal; lists all ajv errors |
| Schema itself invalid JSON Schema | install + load | Fatal with plugin name |
| Declared secret ref targets unknown provider | install + load | Fatal; suggests `kaizen install <provider>` or ref change |
| Declared secret ref is not a string or `{ provider, ref }` object | install + load | Fatal with plugin + key |
| `provider.get(ref)` throws (auth, network) | runtime | Propagates to plugin via `ctx.secrets.get` |
| `provider.get(ref)` returns `undefined` for declared-required secret | runtime (first access) | Plugin-author choice — core returns `undefined` |
| `provider.prefetch(refs)` fails | runtime (setup) | Logged, non-fatal; later `get` surfaces real error |
| Two providers register under the same name | runtime (setup) | Fatal at second registration |
| Two loaded plugins share `name` without qualified harness key | load | Fatal; asks user to qualify |
| `kaizen config set` with invalid value | CLI | Error; does not write |
| `kaizen config set-secret` on read-only default provider | CLI | Error with provider name and guidance |

---

## Testing

| Area | Approach |
|------|----------|
| Merge pipeline | Unit: four-layer order; shallow replace; env override precedence |
| Env override convention | Unit: `KAIZEN_<PLUGIN>_<KEY>` coercion for number / boolean / string; `envOverride` escape hatch |
| Schema validation | Valid, missing required, wrong type, nested-path errors, invalid-schema |
| Install-time validation | Plugin with bad schema rejected at `kaizen install`; plugin with missing required key rejected; secret pointing at unknown provider rejected |
| Secret references | Bare string = default provider; structured form parsed; unknown provider → fatal |
| Provider registry | Two-provider name collision → fatal; ordering via capability-registry covered separately |
| `ctx.secrets.get` declared | Pre-fetched; env override wins; provider returns value |
| `ctx.secrets.get` undeclared | Live provider lookup; no env override convention |
| `ctx.secrets.refresh` | Bypasses cache; re-calls provider |
| `core-secrets` macOS | Integration test gated on platform; writes + reads a test item; cleans up |
| `core-secrets` Linux | Same, via `secret-tool`; skipped if libsecret absent |
| `core-secrets` file fallback | Forced via `KAIZEN_SECRETS_BACKEND=file`; writes JSON at chmod 600 |
| CLI `show` | Snapshot test; secrets redacted; shallow-merge footnote fires correctly |
| CLI `get` | Found, not found; `--reveal` surfaces secret |
| CLI `set` | Writes correct file; validates before write; `--global` path |
| CLI `set-secret` | Prompts; writes via provider; refuses when provider is read-only |
| Backward compat | Plugin without `config` field loads unchanged; `ctx.config` is raw harness config |
| Built-in migration | Updated `core-executor-*` plugins pass schema validation |

---

## Migration

- **Existing plugins** that read `ctx.config["api_key_env"]` then call
  `process.env[...]` continue to work — they never declared `config.secrets` so
  kaizen doesn't intercept. Recommended migration: add `config.schema`,
  `config.defaults`, `config.secrets`; access via `ctx.secrets.get("api_key")`.
- **Built-in plugins** (executor-anthropic, executor-openai, etc.) migrate in
  Phase 9 of the plan. Each gains `config.secrets: ["api_key"]`; the old
  `api_key_env` indirection is removed.
- **Migration guide** added to `docs/plugin-api.md` covering both the config
  schema pattern and the secret-reference shape.

---

## Future Work

- **Non-default providers.** Doppler, Vault, AWS Secrets Manager, 1Password
  Connect. Each is an independent plugin that declares
  `provides: [{ kind: "core-secrets:provider", name: "<name>" }]` and implements
  `SecretProvider`. Out of scope for this spec — the capability and interface are
  the extension point.
- **Typed `ctx.config<T>()`** with compile-time safety derived from the declared
  schema. Requires codegen or declaration augmentation.
- **Harness validation CLI** (`kaizen validate`): check harness config against
  all loaded plugins' schemas without running. CI-friendly.
- **IDE schema integration**: emit per-plugin JSON Schema for harness
  autocompletion in VS Code.
- **Secret rotation notifications.** Providers could emit an event when a secret
  changes (`core-secrets:rotated`); plugins listen and call `refresh`.
- **Deep-merge opt-in.** A `mergeStrategy: "deep" | "shallow"` field on
  `config.schema` for plugins with nested defaults that want deep-merge semantics.
- **Dotted `kaizen config` paths.** If nested access becomes common, reintroduce
  dotted paths with explicit separator escaping.
