# Plugin Coding Standards

*Read when: you are writing a kaizen plugin and need to understand required practices and guidelines.*

This document is the canonical reference for kaizen plugin authors. Every rule is marked as `[required]` (enforced by `kaizen plugin validate`) or `[guideline]` (informational, recommended).

---

## 1. Package Structure

### Files and directories

- [required] **`package.json`** with `"type": "module"` (ESM-only)
- [required] **`exports["."]: "./index.ts"`** or appropriate entry point
- [required] **`"kaizen-plugin"` keyword** in package.json
- [required] **`index.ts`** at the package root that exports the plugin (`export default const plugin: KaizenPlugin = { ... }`)
- [required] **Test suite** — at least one test file (e.g., `index.test.ts`) using `bun:test`
- [required] **`README.md`** at the package root documenting install, configuration, and permissions
- [guideline] **`CHANGELOG.md`** tracking version history and breaking changes

### Example package.json

```json
{
  "name": "kaizen-plugin-my-tool",
  "type": "module",
  "version": "1.0.0",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "devDependencies": { "bun": "latest", "@types/bun": "latest" }
}
```

---

## 2. Plugin Manifest

### Required fields

- [required] **`name`** in the KaizenPlugin: kebab-case, matches the package.json name (minus the `kaizen-plugin-` prefix) and the config key in `kaizen.json`
- [required] **`apiVersion`** set to `"2.0.0"` or appropriate major.minor.patch; core warns but loads if major version differs from PLUGIN_API_VERSION
- [required] **`permissions.tier`** explicitly declared (choose one: `"trusted"`, `"scoped"`, `"unscoped"`); defaults to `"trusted"` if omitted, but explicit declaration is required
- [required] **`capabilities`** field present in the manifest (may be empty object `{}` if the plugin declares no capabilities)

### Optional fields

- [guideline] **`config.schema`** — if your plugin is configurable, declare a JSON schema describing configuration keys
- [guideline] **`capabilities.consumes` includes `"core-secrets:provider"`** — if your plugin declares `config.secrets`, explicitly list this capability in `capabilities.consumes` to aid discoverability (it is implicitly required, but listing it makes the dependency explicit)

### Example manifest

```typescript
const plugin: KaizenPlugin = {
  name: "my-tool",
  apiVersion: "2.0.0",
  capabilities: {
    provides: ["my-tool:handler"],
    consumes: ["core-secrets:provider"]
  },
  permissions: {
    tier: "trusted"
  },
  config: {
    schema: {
      type: "object",
      properties: {
        apiKey: { type: "string" }
      }
    },
    secrets: ["apiKey"]
  },
  async setup(ctx) {
    // initialization
  }
};
```

---

## 3. Permission Tier Selection

### Tier guidelines

- [required] Choose one: `"trusted"`, `"scoped"`, or `"unscoped"`
- [guideline] Default to `"trusted"` — no filesystem, network, or env access unless declared
- [guideline] Use `"scoped"` when the plugin needs specific, auditable access (e.g., read from workspace `.kaizen/` directory, connect to a specific API)
- [guideline] Reserve `"unscoped"` for plugins that genuinely need unrestricted access; document justification in `README.md`

### Declaring scoped permissions

```typescript
permissions: {
  tier: "scoped",
  fs: {
    read: [".kaizen/config.json"],
    write: [".kaizen/state/**"]
  },
  net: {
    connect: ["api.example.com:443"]
  }
}
```

---

## 4. Capability Naming

### Format and conventions

- [required] Service names follow the format `<owner-plugin>:<local-name>`
- [required] `<owner-plugin>` is the kebab-case plugin name (e.g., `my-tool`, `core-driver`)
- [required] `<local-name>` uses dot-separated kebab-case for nested concepts (e.g., `tool.handler`, `events.before-turn`)
- [required] Use existing services from core or other plugins when available; do not duplicate
- [guideline] Document each provided service with a `defineService()` call that includes a human-readable description

### Example

```typescript
async setup(ctx) {
  ctx.defineService("my-tool:event-handler", {
    description: "Allows other plugins to hook into my-tool's event lifecycle"
  });

  // Declare consumption intent
  ctx.consumeService("core-events:service");
}
```

---

## 5. Configuration

### Schema and defaults

- [required] If your plugin is configurable, declare `config.schema` using JSON Schema (subset)
- [required] Use `config.schema` for validation; call `validateSchemaItself(schema)` in tests
- [required] Provide `config.defaults` for optional non-secret keys so users are not required to set them

### Secrets

- [required] For sensitive values (API keys, passwords, tokens), declare them in `config.secrets: ["key1", "key2"]`
- [required] Access secrets only via `await ctx.secrets.get("key")` — never use legacy `process.env` or `api_key_env`
- [required] Secrets must be listed in `config.secrets` array; they are not part of schema
- [required] Document all config keys (both schema and secrets) in your `README.md`, including whether each is a secret and its purpose

### Example

```typescript
config: {
  schema: {
    type: "object",
    properties: {
      endpoint: { type: "string" },
      timeout: { type: "number", default: 30000 }
    },
    required: ["endpoint"]
  },
  defaults: {
    timeout: 30000
  },
  secrets: ["apiToken"]
}
```

In `setup()`:

```typescript
async setup(ctx) {
  const endpoint = ctx.config.endpoint as string;
  const apiToken = await ctx.secrets.get("apiToken");
  
  if (!apiToken) {
    throw new Error("apiToken secret is required");
  }
}
```

---

## 6. Testing

### Test requirements

- [required] At least one test file using `bun:test`
- [required] Every test must call `setup(ctx)` and execute at least one meaningful action
- [required] Use the `makeCtx()` pattern (or equivalent) to create a mock `PluginContext` for testing
- [required] Tests pass with `bun test` with no failures

### Example test

```typescript
import { test, expect } from "bun:test";
import plugin from "./index";

function makeCtx() {
  return {
    config: {},
    log: (msg: string) => console.log(`[test] ${msg}`),
    secrets: { get: async () => undefined },
    defineService: () => {},
    provideService: () => {},
    consumeService: () => {},
    useService: () => { throw new Error("not provided"); },
    defineEvent: () => {},
    on: () => {},
    emit: async () => [],
    // ... other context methods as needed
  };
}

test("plugin initializes without error", async () => {
  const ctx = makeCtx();
  await expect(plugin.setup(ctx)).resolves.toBeUndefined();
});
```

---

## 7. Error Handling

### Setup phase

- [required] `setup()` should not throw unless the error is unrecoverable (missing required secret, invalid configuration, incompatible API version)
- [guideline] Use `ctx.log()` to warn about non-fatal issues (e.g., "Feature X disabled because secret Y is not set")

### Tool execution

- [required] Tool handlers (via `execute()`) must return `{ ok: false, error: "..." }` for errors instead of throwing
- [required] Core wraps tool exceptions; returning `ToolResult` with `ok: false` is the standard error path

### Event handlers

- [guideline] If an event handler throws, core logs the error and continues with the next handler; do not rely on exception propagation

### Example

```typescript
const tool: ToolDefinition = {
  name: "fetch-data",
  description: "Fetch data from API",
  parameters: { type: "object" },
  async execute(args) {
    try {
      const response = await fetch("https://api.example.com/data");
      if (!response.ok) {
        return { ok: false, error: `API error: ${response.statusText}` };
      }
      return { ok: true, data: await response.json() };
    } catch (err) {
      return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
};
```

---

## 8. Event Handling

### Event declaration and subscription

- [required] Call `ctx.defineEvent(name)` before emitting any event to declare its type
- [required] Document all events your plugin emits (in README and inline code comments)
- [required] For cross-plugin event subscriptions, declare `permissions.events.subscribe` with the event patterns you consume

### Example

```typescript
async setup(ctx) {
  // Declare events this plugin will emit
  ctx.defineEvent("my-tool:task-started");
  ctx.defineEvent("my-tool:task-completed");

  // Subscribe to events from other plugins
  ctx.on("core-driver:tool:before", async (payload) => {
    ctx.log(`Tool execution starting: ${payload?.name}`);
  });

  // Later, emit an event
  await ctx.emit("my-tool:task-started", { taskId: "123" });
}
```

### Permissions for subscriptions

```typescript
permissions: {
  tier: "scoped",
  events: {
    subscribe: ["core-driver:tool:before", "core-driver:tool:after"]
  }
}
```

---

## 9. Publishing

### Pre-publication checklist

- [required] **`kaizen-plugin` keyword** in package.json
- [required] **`README.md`** includes:
  - Installation instructions (how to add to `kaizen.json`)
  - Configuration section (all schema keys, all secrets)
  - Permissions section (list permission tier and any scoped grants)
  - Any required capabilities and what they do
- [required] Pin or document the **minimum kaizen version** (e.g., "Requires kaizen >= 2.0.0") in README or `package.json` (`minKaizenVersion` field if available)
- [guideline] Version your plugin following semver; document breaking changes in `CHANGELOG.md`

### Marketplace submission

To list your plugin in the marketplace:
- Create a PR to `.kaizen/marketplace.json` in the kaizen repository
- Include your plugin's metadata: name, description, version, source (npm package, tarball, or local path)
- Link to or provide the version's changelog

---

## 10. API Version Pinning

### Version field

- [required] Set `apiVersion` to the current major version (e.g., `"2.0.0"`)
- [guideline] Understand that core warns but still loads plugins if their `apiVersion` major version differs from `PLUGIN_API_VERSION`
- [guideline] Breaking changes in the core plugin API increment the major version; minor updates are backward-compatible within the same major

### Example

```typescript
const plugin: KaizenPlugin = {
  name: "my-tool",
  apiVersion: "2.0.0", // matches current PLUGIN_API_VERSION = "2"
  // ...
};
```

---

## Validation with `kaizen plugin validate`

Run `kaizen plugin validate <path-to-plugin>` to check:
- All `[required]` rules are met
- Plugin loads without errors
- Schema is valid (via `validateSchemaItself()`)
- Tests pass (`bun test`)
- Capabilities are properly formatted and declared

Guidelines are not enforced by validation but should be followed for consistency and maintainability.
