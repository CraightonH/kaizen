# Unified Plugin Configuration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add declared config schema (`config.schema`), validated typed access via
`ctx.config`, secrets resolution, a merge pipeline with defined precedence, and a
`kaizen config` CLI. After this plan, a misconfigured plugin fails at startup with
a clear error, and the `api_key_env` indirection anti-pattern is eliminated.

**Spec:** `docs/superpowers/specs/2026-04-18-unified-plugin-config-design.md`

**Prerequisites:** Spec 1 (marketplace) may ship in parallel; this plan depends on
the kaizen-level config layer (`~/.kaizen/kaizen.json` `defaults` field) from Spec 1.
Can be implemented in parallel but integration tested after Spec 1 lands.

---

## File Structure

**New files:**
- `src/core/config-validator.ts` — ajv wrapper for plugin config schemas
- `src/core/config-validator.test.ts`
- `src/core/config-merge.ts` — merge pipeline: defaults → global → harness → env
- `src/core/config-merge.test.ts`
- `src/commands/config.ts` — `kaizen config show|get|set`

**Modified files:**
- `src/types/plugin.ts` — add `PluginConfigDeclaration` + `config` field to `KaizenPlugin`
- `src/core/loader.ts` — validate + merge config before `setup(ctx)`
- `src/core/context.ts` — pass merged config to `ctx.config`; resolve secrets
- `src/cli.ts` — wire `kaizen config` subcommand

---

## Phase 1 — Types

### Task 1: Add config declaration types

**File:** `src/types/plugin.ts`

- [ ] **Step 1: Add `PluginConfigDeclaration`**

```typescript
export interface PluginConfigDeclaration {
  /**
   * JSON Schema (draft-07) for the plugin's config namespace.
   * `type: "object"` is assumed at the root.
   */
  schema?: Record<string, unknown>;
  /**
   * Default values. Lowest-precedence layer in the merge pipeline.
   */
  defaults?: Record<string, unknown>;
  /**
   * Config keys whose values are environment variable NAMES.
   * Core resolves these to the actual env var value during merge.
   * Each key here should appear in `permissions.env`.
   */
  secrets?: string[];
}
```

- [ ] **Step 2: Add `config` field to `KaizenPlugin`**

```typescript
interface KaizenPlugin {
  // ... existing fields ...
  config?: PluginConfigDeclaration;
}
```

---

## Phase 2 — Config Validator

### Task 2: Implement `src/core/config-validator.ts`

- [ ] **Step 1: Create ajv instance (reuse pattern from `tool-registry.ts`)**

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
  try {
    ajv.compile(schema);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Write `src/core/config-validator.test.ts`**

Tests:
- Valid config against schema with required fields.
- Missing required field → error with correct path.
- Wrong type → error.
- Nested path error.
- Empty schema (no validation) → no errors.
- `validateSchemaItself`: valid schema, invalid schema.

---

## Phase 3 — Merge Pipeline

### Task 3: Implement `src/core/config-merge.ts`

- [ ] **Step 1: Implement `mergePluginConfig`**

```typescript
export function mergePluginConfig(
  pluginName: string,
  declaration: PluginConfigDeclaration | undefined,
  globalDefaults: Record<string, unknown>,    // from ~/.kaizen/kaizen.json defaults.<plugin>
  harnessConfig: Record<string, unknown>,     // from kaizen.json <plugin> namespace
): Record<string, unknown> {
  const base = { ...(declaration?.defaults ?? {}) };
  const withGlobal = { ...base, ...globalDefaults };
  const withHarness = { ...withGlobal, ...harnessConfig };
  return withHarness;
}
```

- [ ] **Step 2: Implement `resolveSecrets`**

```typescript
export function resolveSecrets(
  config: Record<string, unknown>,
  secrets: string[],
): { resolved: Record<string, unknown>; missing: string[] } {
  const resolved = { ...config };
  const missing: string[] = [];

  for (const key of secrets) {
    const envName = config[key] as string | undefined;
    if (!envName) {
      missing.push(key);
      continue;
    }
    const value = process.env[envName];
    if (value !== undefined) {
      resolved[key] = value;
    } else {
      resolved[key] = undefined;
      missing.push(key);
    }
  }

  return { resolved, missing };
}
```

- [ ] **Step 3: Write `src/core/config-merge.test.ts`**

Tests:
- Merge order: plugin defaults < global < harness (right wins at each step).
- Secrets resolved from env.
- Secrets env var missing → key is `undefined` in resolved.
- No declaration → returns raw harness config unchanged.
- Deep objects are shallow-merged (not deep-merged — document this explicitly).

---

## Phase 4 — Loader Integration

### Task 4: Validate and merge config in `src/core/loader.ts`

- [ ] **Step 1: Import `mergePluginConfig`, `resolveSecrets`, `validateConfig`**

- [ ] **Step 2: In `setupPlugin(plugin, ctx, harnessConfig, globalConfig)`:**

After resolving the plugin but before calling `plugin.setup(ctx)`:

```typescript
// 1. Merge config
const globalPluginDefaults =
  (globalConfig.defaults as Record<string, unknown> | undefined)?.[plugin.name] ?? {};
const harnessPluginConfig =
  (harnessConfig[plugin.name] as Record<string, unknown> | undefined) ?? {};
let mergedConfig = mergePluginConfig(
  plugin.name,
  plugin.config,
  globalPluginDefaults,
  harnessPluginConfig,
);

// 2. Resolve secrets
if (plugin.config?.secrets?.length) {
  const { resolved, missing } = resolveSecrets(mergedConfig, plugin.config.secrets);
  mergedConfig = resolved;

  // Check if any missing secrets are required by schema
  const requiredKeys = (plugin.config.schema as any)?.required ?? [];
  const missingRequired = missing.filter((k) => requiredKeys.includes(k));
  if (missingRequired.length > 0) {
    const envNames = missingRequired
      .map((k) => harnessPluginConfig[k] ?? k)
      .join(", ");
    fatal(`${plugin.name}: required secret(s) missing. Set env var(s): ${envNames}`);
  }
}

// 3. Validate
if (plugin.config?.schema) {
  if (!validateSchemaItself(plugin.config.schema)) {
    fatal(`${plugin.name}: config.schema is not a valid JSON Schema`);
  }
  const errors = validateConfig(plugin.config.schema, mergedConfig);
  if (errors.length > 0) {
    const detail = errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
    fatal(`${plugin.name} config invalid:\n${detail}`);
  }
}
```

- [ ] **Step 3: Pass `mergedConfig` to `createPluginContext`**

`createPluginContext` currently reads config from the raw harness. Change it to
accept a pre-merged config object.

---

## Phase 5 — Context Surface

### Task 5: Update `src/core/context.ts`

- [ ] **Step 1: Accept `mergedConfig` parameter**

`createPluginContext(plugin, mergedConfig, ...)` — replace the current direct
harness config lookup.

- [ ] **Step 2: Expose as `ctx.config`**

`ctx.config` returns `mergedConfig`. Type: `Record<string, unknown>` (unchanged at
the TypeScript level for v1).

- [ ] **Step 3: Secrets in `ctx.secrets.get(key)`**

`ctx.secrets.get(key)` should also work for config-declared secrets. Update the
secrets implementation to check `mergedConfig[key]` first (the resolved value), then
fall back to existing `process.env` lookup for permissions-declared env vars.

---

## Phase 6 — CLI Commands

### Task 6: Implement `src/commands/config.ts`

- [ ] **Step 1: `cmdConfigShow(pluginName?)`**

Load harness config + global config. For each plugin (or the named one):
1. Build merged config using `mergePluginConfig`.
2. Collect source annotations (which layer provided each value).
3. Print table (redact secrets — show `***`).
4. Print schema table if declared.

- [ ] **Step 2: `cmdConfigGet(pluginDotPath)`**

Parse `<plugin>.<path>` (supports dot-notation for nested keys).
Build merged config for that plugin.
Print the value. Redact if secret. Exit 1 if not found.

- [ ] **Step 3: `cmdConfigSet(pluginDotPath, value)`**

Parse `<plugin>.<path>`.
Load project harness config. Set the value at the path.
If plugin has a schema: validate the full plugin config after the set.
Write back to `.kaizen/kaizen.json`. Print confirmation.

- [ ] **Step 4: Wire in `src/cli.ts`**

```typescript
if (subcommand === "config") {
  const sub = rawArgs[1];
  if (sub === "show") { ... }
  if (sub === "get")  { ... }
  if (sub === "set")  { ... }
}
```

---

## Phase 7 — Migrate Built-in Plugins

### Task 7: Update built-in plugins to use config declaration

- [ ] **Step 1: `core-executor-anthropic/index.ts`**

Add `config` declaration:
```typescript
config: {
  schema: {
    properties: {
      model:       { type: "string" },
      api_key:     { type: "string" },
    },
    required: ["api_key"],
  },
  defaults: { model: "claude-opus-4-6" },
  secrets: ["api_key"],
},
```
Update `setup()` to use `ctx.config.api_key` directly (remove `api_key_env` lookup).

- [ ] **Step 2: `core-executor-openai/index.ts`**

Same pattern.

- [ ] **Step 3: `core-cli/index.ts`**

Add config declaration for `clis`, `allow_destructive`, `subprocess_timeout_ms`.

- [ ] **Step 4: Remaining built-ins**

Audit all built-ins for config access. Add declarations where config is read.

---

## Phase 8 — Tests & Docs

### Task 8: Integration tests

- [ ] **Step 1: Plugin with missing required config fails at startup**

Create a test plugin with `required: ["api_key"]`. Load it without providing the key.
Assert fatal error with correct message.

- [ ] **Step 2: Plugin with wrong type fails at startup**

Pass `timeout_ms: "5000"` (string) where `number` is required. Assert error.

- [ ] **Step 3: Secrets resolved correctly**

Set `process.env.TEST_KEY = "secret"`. Configure plugin with `api_key: "TEST_KEY"`.
Assert `ctx.config.api_key === "secret"`.

- [ ] **Step 4: Merge precedence**

Plugin defaults `timeout: 5000`. Harness sets `timeout: 3000`. Assert resolved is
`3000`.

### Task 9: Documentation

- [ ] Update `docs/plugin-api.md` — "Plugin config" section to show new `config`
  declaration pattern. Mark old `api_key_env` pattern as deprecated.
- [ ] Add `kaizen config` to `README.md` commands reference.
