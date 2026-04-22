# Unified Plugin Configuration & Pluggable Secrets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add declared config schema, validated typed `ctx.config` (non-secrets only),
a pluggable secrets system with an OS-portable default provider, async
`ctx.secrets.get(key)` with background pre-fetch, install-time + load-time
validation, env-override convention, and a `kaizen config` CLI (including
`set-secret`). After this plan: a misconfigured plugin fails at `kaizen install`
with a clear error, `api_key_env` indirection is gone, and secrets live in the OS
keychain by default with Doppler/Vault as drop-in replacements.

**Spec:** `docs/superpowers/specs/2026-04-18-unified-plugin-config-design.md`

**Prerequisites:**
- Spec 1 (marketplace) — provides `src/core/kaizen-config.ts` and the
  `KaizenGlobalConfig.defaults` slice this plan consumes.
- Spec 2026-04-17 (capability registry) — provides the `core-secrets:provider`
  capability slot + dependency ordering.

---

## File Structure

**New files:**
- `src/core/config-validator.ts` — ajv wrapper for plugin config schemas
- `src/core/config-validator.test.ts`
- `src/core/config-merge.ts` — merge pipeline + env override + secret separation
- `src/core/config-merge.test.ts`
- `src/core/secrets.ts` — `SecretsRegistry`, `createSecretsContext`
- `src/core/secrets.test.ts`
- `src/core/secret-providers/types.ts` — `SecretProvider` interface
- `src/commands/config.ts` — `kaizen config show|get|set|set-secret`
- `plugins/core-secrets/index.ts` — built-in default provider plugin
- `plugins/core-secrets/detect.ts` — backend detection (OS + availability)
- `plugins/core-secrets/keychain-macos.ts`
- `plugins/core-secrets/keychain-windows.ts`
- `plugins/core-secrets/keychain-linux.ts`
- `plugins/core-secrets/file-fallback.ts`
- `plugins/core-secrets/*.test.ts`

**Modified files:**
- `src/types/plugin.ts` — add `PluginConfigDeclaration`, `SecretRef`, `config` field
- `src/core/loader.ts` — merge + validate + prefetch before `setup(ctx)`
- `src/core/context.ts` — pass merged non-secret config + secrets handle
- `src/commands/install.ts` — install-time validation step
- `src/cli.ts` — wire `kaizen config` subcommand
- Built-in plugins (`core-executor-anthropic`, `core-executor-openai`,
  `core-cli`, etc.) — adopt `config` declaration + `ctx.secrets`

---

## Phase 1 — Types

### Task 1: Add config + secret ref types

**File:** `src/types/plugin.ts`

- [ ] **Step 1: `PluginConfigDeclaration`**

```typescript
export interface PluginConfigDeclaration {
  schema?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  secrets?: string[];
}
```

- [ ] **Step 2: Secret ref types**

```typescript
export interface StructuredSecretRef {
  provider: string;
  ref: string;
  envOverride?: string;
}

export type SecretRef = string | StructuredSecretRef;
```

- [ ] **Step 3: Context types**

```typescript
export interface SecretsContext {
  get(key: string): Promise<string | undefined>;
  refresh(key: string): Promise<string | undefined>;
}

// Extend PluginContext
interface PluginContext {
  // ... existing ...
  config: Record<string, unknown>;     // non-secret only
  secrets: SecretsContext;
}
```

- [ ] **Step 4: Add `config` field to `KaizenPlugin`**

```typescript
interface KaizenPlugin {
  // ... existing ...
  config?: PluginConfigDeclaration;
}
```

---

## Phase 2 — Config Validator

### Task 2: Implement `src/core/config-validator.ts`

- [ ] **Step 1: Create ajv wrapper**

```typescript
import Ajv from "ajv";
const ajv = new Ajv({ allErrors: true });

export interface ConfigValidationError {
  path: string;
  message: string;
}

export function validateConfig(
  schema: Record<string, unknown>,
  data: Record<string, unknown>,
): ConfigValidationError[] {
  const validate = ajv.compile({ type: "object", ...schema });
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => ({
    path: e.instancePath || "/",
    message: e.message ?? "invalid",
  }));
}

export function validateSchemaItself(schema: Record<string, unknown>): boolean {
  try { ajv.compile(schema); return true; } catch { return false; }
}
```

- [ ] **Step 2: Tests** — valid, missing required, wrong type, nested, invalid schema.

---

## Phase 3 — Merge Pipeline + Env Overrides

### Task 3: Implement `src/core/config-merge.ts`

- [ ] **Step 1: `mergePluginConfig`**

```typescript
export function mergePluginConfig(
  declaration: PluginConfigDeclaration | undefined,
  globalDefaults: Record<string, unknown>,
  harnessConfig: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(declaration?.defaults ?? {}),
    ...globalDefaults,
    ...harnessConfig,
  };
}
```

- [ ] **Step 2: `separateSecrets`** — splits merged config into `{ config, secretRefs }`
      based on `PluginConfigDeclaration.secrets`. Validates each ref is a string or
      `{ provider, ref }` object (fatal on malformed).

- [ ] **Step 3: `applyEnvOverrides(pluginName, config, schema)`** — walks top-level
      keys, checks `KAIZEN_<PLUGIN>_<KEY>` env vars, coerces based on schema type
      (`number` → parseFloat; `boolean` → "true"/"false"; else string).

- [ ] **Step 4: `envVarNameFor(pluginName, key)`** — helper applying the
      upper-snake convention (non-alphanumeric → `_`).

- [ ] **Step 5: Tests** — shallow replace, right-wins, env coercion, `envOverride`
      precedence for secrets, plugin name with non-alphanumeric chars.

---

## Phase 4 — Secret Provider Interface + Registry

### Task 4: Define provider interface

**File:** `src/core/secret-providers/types.ts`

- [ ] **Step 1:**

```typescript
export interface SecretProvider {
  readonly name: string;
  get(ref: string): Promise<string | undefined>;
  set?(ref: string, value: string): Promise<void>;
  prefetch?(refs: string[]): Promise<void>;
}
```

### Task 5: Implement `src/core/secrets.ts`

- [ ] **Step 1: `SecretsRegistry` class**

```typescript
class SecretsRegistry {
  private providers = new Map<string, SecretProvider>();
  private cache = new Map<string, string | undefined>();  // key: `<provider>:<ref>`

  register(provider: SecretProvider): void {
    if (this.providers.has(provider.name)) {
      fatal(`secret provider '${provider.name}' already registered`);
    }
    this.providers.set(provider.name, provider);
  }

  getProvider(name: string): SecretProvider | undefined { ... }

  async resolve(pluginName: string, key: string, ref: SecretRef,
                opts: { bypassCache?: boolean } = {}): Promise<string | undefined> {
    // 1. envOverride
    // 2. KAIZEN_<PLUGIN>_<KEY>
    // 3. Cache (unless bypassCache)
    // 4. provider.get(ref)
  }

  async prefetchForPlugin(pluginName: string, declared: Record<string, SecretRef>): Promise<void> {
    // Group refs by provider; call provider.prefetch?(refs)
  }
}
```

- [ ] **Step 2: `createSecretsContext(registry, pluginName, declaredRefs)`**

Returns the `SecretsContext` handle:

```typescript
return {
  get: (key) => {
    const ref = declaredRefs[key];
    if (ref !== undefined) return registry.resolve(pluginName, key, ref);
    // Undeclared: treat as ref against default provider
    const defaultProvider = registry.getProvider("kaizen");
    if (!defaultProvider) throw new Error(...);
    return defaultProvider.get(key);
  },
  refresh: (key) => {
    const ref = declaredRefs[key];
    if (ref === undefined) return this.get(key);
    return registry.resolve(pluginName, key, ref, { bypassCache: true });
  },
};
```

- [ ] **Step 3: Tests** — register collision, env override order, cache behaviour,
      undeclared-key path, missing provider error, refresh bypasses cache.

---

## Phase 5 — Default Provider (`core-secrets` plugin)

### Task 6: Backend detection

**File:** `plugins/core-secrets/detect.ts`

- [ ] **Step 1:** `detectBackend(): "macos" | "windows" | "linux" | "file"`.
      Honors `KAIZEN_SECRETS_BACKEND=file` override. Falls back to `file` if OS
      tool (e.g. `secret-tool`) is missing.

### Task 7: Platform backends

- [ ] **Step 1:** `keychain-macos.ts` — shells out to `security add-generic-password`,
      `security find-generic-password`, scoped under service `kaizen`. Account =
      `<ref>`.

- [ ] **Step 2:** `keychain-windows.ts` — PowerShell `New-StoredCredential` /
      `Get-StoredCredential` (or `cmdkey` / `wincred` binding).

- [ ] **Step 3:** `keychain-linux.ts` — `secret-tool store`, `secret-tool lookup`,
      attribute `service=kaizen`, `account=<ref>`.

- [ ] **Step 4:** `file-fallback.ts` — reads/writes `~/.kaizen/.credentials.json`,
      chmod 600, JSON `{ "<ref>": "<value>" }`. Creates file on first write with
      correct perms.

- [ ] **Step 5:** Each backend exports a `SecretProvider`-shaped object with
      `get` and `set`. `prefetch` is a no-op for keychain backends (cheap reads);
      for file backend it preloads the JSON once.

### Task 8: `plugins/core-secrets/index.ts`

- [ ] **Step 1:** Plugin entry. Declares:

```typescript
const plugin: KaizenPlugin = {
  name: "core-secrets",
  apiVersion: "2.0.0",
  permissions: { tier: "trusted" },  // OS keychain + file I/O
  capabilities: {
    provides: [{ kind: "core-secrets:provider", name: "kaizen" }],
  },
  async setup(ctx) {
    const backend = pickBackend(detectBackend());
    ctx.capabilities.register("core-secrets:provider", backend);
  },
};
```

- [ ] **Step 2:** Tests — platform-gated (`describe.skipIf`) for each OS; file
      fallback always tested.

---

## Phase 6 — Loader Integration

### Task 9: Wire validation + merge + prefetch in `src/core/loader.ts`

- [ ] **Step 1: Install-time validation hook** — called from
      `src/commands/install.ts` after plugin bits land but before lockfile write:

```typescript
async function validateInstallTimeConfig(plugin, globalConfig, harnessConfig) {
  if (!plugin.config?.schema) return;
  if (!validateSchemaItself(plugin.config.schema)) fatal(...);
  const merged = mergePluginConfig(plugin.config, globalConfig.defaults?.[plugin.name] ?? {}, harnessConfig[plugin.name] ?? {});
  const { config, secretRefs } = separateSecrets(merged, plugin.config.secrets ?? []);
  const errors = validateConfig(plugin.config.schema, config);
  if (errors.length > 0) fatal(formatErrors(errors));
  // Provider existence check is LOAD-TIME only — provider plugins may not be
  // installed yet at the moment this plugin installs. Move to load-time.
  // (Document: install-time catches shape; load-time catches provider wiring.)
}
```

- [ ] **Step 2: Load-time `setupPlugin(plugin, ctx, harnessConfig, globalConfig, registry)`:**

```typescript
// 1. Merge
const merged = mergePluginConfig(
  plugin.config,
  globalConfig.defaults?.[plugin.name] ?? {},
  harnessConfig[plugin.name] ?? {},
);

// 2. Split secrets
const { config, secretRefs } = separateSecrets(merged, plugin.config?.secrets ?? []);

// 3. Env overrides on non-secrets
applyEnvOverrides(plugin.name, config, plugin.config?.schema);

// 4. Validate
if (plugin.config?.schema) {
  const errors = validateConfig(plugin.config.schema, config);
  if (errors.length > 0) fatal(...);
}

// 5. Check every declared secret's provider is registered
for (const [key, ref] of Object.entries(secretRefs)) {
  const providerName = typeof ref === "string" ? "kaizen" : ref.provider;
  if (!registry.getProvider(providerName)) {
    fatal(`${plugin.name}: secret '${key}' targets provider '${providerName}' — no plugin provides it`);
  }
}

// 6. Prefetch
await registry.prefetchForPlugin(plugin.name, secretRefs);

// 7. Build context
const secrets = createSecretsContext(registry, plugin.name, secretRefs);
const ctx = createPluginContext(plugin, config, secrets, ...);
await plugin.setup(ctx);
```

- [ ] **Step 3:** Thread the `SecretsRegistry` through loader init — one instance
      per kaizen run, passed into each `setupPlugin` call.

---

## Phase 7 — Context Surface

### Task 10: Update `src/core/context.ts`

- [ ] **Step 1:** `createPluginContext(plugin, config, secrets, ...)` — replace
      direct harness-config lookup. `ctx.config` returns the validated non-secret
      merged object. `ctx.secrets` returns the `SecretsContext` from Phase 6.

- [ ] **Step 2: Deprecate `ctx.secrets.get` pre-existing env lookup** (if any).
      New path is the only path. Keep behaviour for plugins that call
      `ctx.secrets.get` without declaring `config.secrets` — resolves via default
      provider.

---

## Phase 8 — CLI Commands

### Task 11: Implement `src/commands/config.ts`

- [ ] **Step 1: `cmdConfigShow(pluginName?)`** — loads both configs, merges per
      plugin, prints:
  - Non-secret keys with source annotation.
  - Secret keys as `*** (provider: X, ref: Y) [harness|default|global]`.
  - Compact schema table.
  - Shallow-merge footnote if nested object replaced.

- [ ] **Step 2: `cmdConfigGet(plugin, path)`** — parses space-separated
      `<plugin> <path>`. Builds merged non-secret config, walks dotted path, prints
      value. `--reveal` for secrets. Exit 1 if not found.

- [ ] **Step 3: `cmdConfigSet(plugin, path, value)`** — loads project harness
      (or global with `--global`), sets value at path. Validates whole plugin
      config against schema before write. Writes atomically.

- [ ] **Step 4: `cmdConfigSetSecret(plugin, key, opts)`** — interactive prompt
      (tty-only, hidden input). Resolves target provider (`--provider <name>`
      overrides default `kaizen`). If `provider.set` is undefined → error.
      Writes the value via provider, then updates harness (or `--global`) to
      store `{ provider: <name>, ref: <chosen-ref> }` under
      `<plugin>.<key>`.

- [ ] **Step 5: Wire in `src/cli.ts`**

```typescript
if (subcommand === "config") {
  const sub = rawArgs[1];
  if (sub === "show")        return cmdConfigShow(rawArgs[2]);
  if (sub === "get")         return cmdConfigGet(rawArgs[2], rawArgs[3]);
  if (sub === "set")         return cmdConfigSet(rawArgs[2], rawArgs[3], rawArgs[4], flags);
  if (sub === "set-secret")  return cmdConfigSetSecret(rawArgs[2], rawArgs[3], flags);
}
```

---

## Phase 9 — Migrate Built-in Plugins

### Task 12: Update built-ins to declare config + use `ctx.secrets`

- [ ] **Step 1: `core-executor-anthropic`**

```typescript
config: {
  schema: {
    properties: {
      model:   { type: "string" },
      api_key: { type: "string" },
    },
    required: ["api_key"],
  },
  defaults: { model: "claude-opus-4-6" },
  secrets: ["api_key"],
},
```

Update `setup()`: `const key = await ctx.secrets.get("api_key");`. Remove
`api_key_env` indirection.

- [ ] **Step 2: `core-executor-openai`** — same pattern.

- [ ] **Step 3: `core-cli`** — declare config for `clis`, `allow_destructive`,
      `subprocess_timeout_ms` (no secrets).

- [ ] **Step 4: Audit remaining built-ins** — add declarations wherever
      `ctx.config[...]` is currently read.

- [ ] **Step 5: Migration note in `docs/plugin-api.md`** — before/after examples
      covering schema, secrets, and `ctx.secrets.get`.

---

## Phase 10 — Integration Tests & Docs

### Task 13: Integration tests

- [ ] **Step 1: Install-time shape validation** — create fixture plugin with
      missing required key; assert `kaizen install` fails with correct message.

- [ ] **Step 2: Install-time does NOT check secret value availability** — fixture
      plugin with required secret; run `kaizen install` in environment with no
      keychain entry; assert install succeeds.

- [ ] **Step 3: Load-time provider existence** — remove `core-secrets` (simulate)
      and load a plugin with declared secrets; assert fatal with clear message.

- [ ] **Step 4: Secret resolution end-to-end (file backend)** —
      `KAIZEN_SECRETS_BACKEND=file`; `kaizen config set-secret foo api_key`
      (scripted); assert `ctx.secrets.get("api_key")` returns the value.

- [ ] **Step 5: Env override beats harness** — set
      `KAIZEN_STRIPE_BILLING_TIMEOUT_MS=999`; assert
      `ctx.config.timeout_ms === 999` even with harness set to 3000.

- [ ] **Step 6: `envOverride` escape hatch** — harness `{ envOverride:
      "STRIPE_KEY" }`; set `STRIPE_KEY=abc`; assert resolved value is `abc`.

- [ ] **Step 7: Undeclared secret via default provider** — plugin calls
      `ctx.secrets.get("random")` without declaring it; assert default provider
      is queried.

- [ ] **Step 8: `refresh` bypasses cache** — prime cache, change file-backend
      value, assert `refresh` returns new value while `get` returns cached.

- [ ] **Step 9: Shallow merge documentation** — harness replaces nested `retry`
      object; `kaizen config show` surfaces the footnote.

### Task 14: Documentation

- [ ] **Step 1:** Update `docs/plugin-api.md` — "Plugin Config & Secrets" section:
  - `config` declaration reference.
  - Secret ref shape + env override convention.
  - `ctx.config` vs `ctx.secrets.get` distinction.
  - Shallow-merge caveat with a concrete example.
  - Deprecation of `api_key_env` pattern.

- [ ] **Step 2:** Update `README.md` — add `kaizen config` commands to reference
      table; mention OS-keychain default and Doppler/Vault extension point.

- [ ] **Step 3:** Add `docs/plugin-secrets.md` (new) — provider-author guide:
      how to write a `core-secrets:provider` plugin (Doppler / Vault worked
      examples).

---

## Rollout & Verification

- [ ] `bun test` passes across macOS + Linux CI. Windows keychain backend tested
      manually if no Windows CI available (note in PR).
- [ ] Built-in plugins boot with the new config declarations; existing harnesses
      continue to work (backward compat verified via fixture).
- [ ] `kaizen install` against a fixture plugin with bad schema rejects at
      install time.
- [ ] `kaizen config set-secret` round-trips through each available OS backend.
- [ ] `docs/plugin-api.md` and `docs/plugin-secrets.md` reviewed; migration guide
      lands with the feature branch.
