# Plugin Authoring Guide

*Read when: you are writing a kaizen plugin from scratch.*

This guide walks through scaffolding, implementing, testing, and validating a
kaizen plugin. For exact type signatures see
[`reference/plugin-api.md`](../reference/plugin-api.md); for the host API
surface (secrets, config, events, LLM runtime) see
[`reference/host-api.md`](../reference/host-api.md). For the rules validation
enforces, see [`reference/plugin-standards.md`](../reference/plugin-standards.md).

## Prerequisites

- **Bun 1.0+** (or **Node 18+** — kaizen targets Bun first, but plugins are
  plain TypeScript ESM and load under both runtimes).
- **kaizen** on your `$PATH`. If you're developing against a checkout, see
  [`guides/contributing.md`](./contributing.md) for the dev-setup flow.
- TypeScript familiarity — manifests are typed objects, not JSON.

Plugins live in their own repo or package; the kaizen binary ships zero
plugins. A marketplace (local directory or remote URL) is how users install
them. See [`guides/marketplace-authoring.md`](./marketplace-authoring.md) once
you're ready to publish.

## Scaffold {#scaffold}

```sh
kaizen plugin create <target-dir>
```

Interactive prompts cover: plugin name, description, permission tier
(`trusted` / `scoped` / `unscoped`), scoped grants (`fs`, `net`, `env`, `exec`,
`events`), `provides` / `consumes` capabilities, and optional config keys
(including which are secrets).

Add `--defaults` to skip prompts and scaffold a minimal `trusted` plugin:

```sh
kaizen plugin create ./my-plugin --defaults
```

The generator writes:

```
<target-dir>/
  package.json       # name, version, type:module, exports["."], keywords:["kaizen-plugin"]
  tsconfig.json
  index.ts           # KaizenPlugin default export
  index.test.ts      # bun:test skeleton calling setup() with a stub ctx
  README.md
  .kaizen/.gitkeep
```

Then:

```sh
cd my-plugin
bun install
bun test
kaizen plugin validate .
```

## Anatomy of a plugin

A plugin is a `KaizenPlugin` object (from `kaizen/types`) exported as the
package's default export.

```ts
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "my-plugin",            // kebab-case; matches config namespace in kaizen.json
  apiVersion: "2.0.0",          // semver; core warns on major mismatch with PLUGIN_API_VERSION
  permissions: { tier: "trusted" },
  capabilities: { provides: [], consumes: [] },

  async setup(ctx) {
    // Register services (ctx.registerService), declare capabilities
    // (ctx.defineCapability), and subscribe to events (ctx.on) here.
    // setup() runs once during INITIALIZING. Registration calls are only
    // valid from inside setup().
  },
};

export default plugin;
```

Required fields: `name`, `apiVersion`, `setup`. Optional: `lifecycle`,
`capabilities`, `aliases`, `permissions` (defaults to `{ tier: "trusted" }`),
`config`, `start` (only if `lifecycle: true`). Full field table in
[`reference/plugin-api.md`](../reference/plugin-api.md#kaizenplugin-manifest).

## Registering tools {#tools}

LLM tool-calling is not yet wired into core. A future `core-tools` broker
plugin will own tool registration and dispatch; when it lands it will define
the capability name and `ServiceToken` that tool-providing plugins use.

For now, `ToolDefinition` and `ToolResult` types exist in the API (they are
used by the `Executor` interface for the LLM round-trip), but there is no
`ctx.registerTool()` method and no core-managed tool registry.

<!-- TODO: expand this section once core-tools publishes its tokens and capability names -->

## Using the host API

The `ctx` object is your entire surface onto kaizen. It exposes:
`registerService` / `getService`, `defineCapability`, `defineEvent` / `on` /
`emit`, `config`, `log`, permission-gated `fs` / `net` / `secrets` / `exec`,
and `runtime.pluginManager` for hot-reload support.

Example — read a secret during `setup()`:

```ts
async setup(ctx) {
  const apiKey = await ctx.secrets.get("api_key");
  if (!apiKey) {
    ctx.log("api_key not set; disabling remote calls");
    return;
  }
  // ... use apiKey
}
```

For the full surface — `SecretsContext`, `CtxFs`, `CtxNet`, `CtxExec`,
`createLLMRuntime`, `ServiceToken`, `SecretsProviderToken`, event semantics —
see [`reference/host-api.md`](../reference/host-api.md).

## Testing {#testing}

Plugin tests use `bun:test` and construct a stub `ctx` by hand — there is no
harness test helper yet. The pattern `kaizen plugin create` generates is the
canonical one:

```ts
// index.test.ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.ts";

function makeCtx() {
  return {
    log: mock(() => {}),
    config: {},
    registerService: mock(() => {}),
    getService: mock(() => { throw new Error("not registered"); }),
    defineCapability: mock(() => {}),
    on: mock(() => {}),
    defineEvent: mock(() => {}),
    emit: mock(async () => []),
    secrets: {
      get: mock(async (_key: string): Promise<string | undefined> => undefined),
      refresh: mock(async (_key: string): Promise<string | undefined> => undefined),
    },
  } as any;
}

describe("my-plugin", () => {
  it("has correct metadata", () => {
    expect(plugin.name).toBe("my-plugin");
    expect(plugin.apiVersion).toBe("2.0.0");
  });

  it("setup completes without error", async () => {
    const ctx = makeCtx();
    await expect(plugin.setup(ctx)).resolves.toBeUndefined();
  });
});
```

Run with `bun test`. Cast to `any` keeps the stub minimal — only stub what
your `setup()` actually touches. If your plugin subscribes to events, capture
the `on` handlers and invoke them directly. If it consumes a service, stub
`getService` to return a test double.

`plugin-standards.md` requires at least one `*.test.ts` that exercises
metadata plus `setup()`; `kaizen plugin validate` checks for the file's
presence but not its contents.

## Validate {#validate}

```sh
kaizen plugin validate <plugin-dir>
```

Checks (see `src/commands/plugin-validate.ts` for the full list):

- `package.json` present, parseable, kebab-case `name`, `type: "module"`,
  `exports["."]` set, `keywords` includes `"kaizen-plugin"`, semver `version`.
- Plugin manifest loadable (dynamic `import()` of the entry module).
- `plugin.name` matches `package.json` `name`.
- `plugin.apiVersion` present and semver.
- `plugin.permissions` present; `tier` is `trusted` / `scoped` / `unscoped`;
  `scoped` tier has at least one grant populated.
- `plugin.capabilities` present (may be `{}`).
- `plugin.config.schema` is a valid JSON Schema; every `config.secrets` key
  appears in `config.schema.properties`.
- Warns if `config.secrets` is non-empty and `core-secrets:provider` is not in
  `capabilities.consumes`.
- Warns on imports of `node:fs`, `node:child_process`, `node:worker_threads`,
  `bun:ffi`, and their unprefixed forms — the runtime enforcer blocks these
  regardless.
- `*.test.ts` file present; `README.md` present.

Exit code is `0` on pass (possibly with warnings), `1` on any failure. Common
fixes:

| Error | Fix |
|-------|-----|
| `name "..." does not match ^[a-z][a-z0-9-]*$` | Rename to kebab-case. |
| `"type" must be "module"` | Add `"type": "module"` to `package.json`. |
| `keywords must include "kaizen-plugin"` | Add `"kaizen-plugin"` to the `keywords` array. |
| `plugin.name does not match package.json name` | Align the two. |
| `tier is "scoped" but no grant keys populated` | Add at least one of `fs` / `net` / `env` / `exec` / `events`, or drop to `trusted`. |
| `config secrets key "..." not declared in config.schema.properties` | Add the key to `config.schema.properties`. |
| `core-secrets:provider dependency is implicit` (warn) | List it in `capabilities.consumes` for discoverability. |

## Next steps

Once your plugin validates, publish it:
[Marketplace Authoring](./marketplace-authoring.md).
