# Plugin Authoring Guide

*Read when: you are writing a kaizen plugin from scratch.*

This guide walks through scaffolding, implementing, testing, and validating a
kaizen plugin. For exact type signatures see
[`reference/plugin-api.md`](../reference/plugin-api.md); for the host API
surface (secrets, config, events) see
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
`events`), `provides` / `consumes` services, whether the plugin is a session
driver, and optional config keys (including which are secrets).

Add `--defaults` to skip prompts and scaffold a minimal `trusted` plugin:

```sh
kaizen plugin create ./my-plugin --defaults
```

Every prompt also has a corresponding flag, so the command can run fully
non-interactively (for agents, CI, or bulk scaffolding). When stdin is not a
TTY, or any scaffold flag is passed, prompts are skipped entirely and unset
fields fall back to defaults:

```sh
kaizen plugin create ./my-plugin \
  --name my-plugin \
  --description "does a thing" \
  --tier scoped \
  --grant fs,net \
  --provides my-plugin:api \
  --driver
```

Flags:

| Flag                   | Purpose                                                    |
|------------------------|------------------------------------------------------------|
| `--name`               | Plugin name (default: basename of target path)             |
| `--description`        | Description text                                           |
| `--tier`               | `trusted` \| `scoped` \| `unscoped` (default `trusted`)     |
| `--grant`              | One or more of `fs,net,env,exec,events`. Repeatable and/or comma-separated. |
| `--provides`           | Service name; repeatable and/or comma-separated.           |
| `--consumes`           | Service name; repeatable and/or comma-separated.           |
| `--driver`             | Scaffold a session driver (adds `driver:true` and a `start(ctx)` stub). |
| `--config-keys-json`   | Inline JSON array of ConfigKey objects.                    |
| `--config-keys-file`   | Path to a JSON file with a ConfigKey array.                |
| `--defaults`           | Use defaults for all fields; skip prompts.                 |

ConfigKey shape (applies to both `--config-keys-json` and `--config-keys-file`):

```json
[
  { "name": "api_key", "type": "string", "required": true,  "secret": true },
  { "name": "port",    "type": "number", "required": false, "secret": false }
]
```

`type` must be `string` or `number`. Kaizen validates this structure but does
not validate the semantic correctness of the resulting config schema — that is
the plugin author's responsibility.

The generator writes:

```
<target-dir>/
  package.json       # name, version, type:module, exports["."], keywords:["kaizen-plugin"]
  tsconfig.json
  index.ts           # KaizenPlugin default export
  public.d.ts        # exported types for consumers (import type)
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
  apiVersion: "3.0.0",          // semver; core warns on major mismatch with PLUGIN_API_VERSION
  permissions: { tier: "trusted" },
  services: { provides: [], consumes: [] },

  async setup(ctx) {
    // Define and provide services (ctx.defineService, ctx.provideService),
    // declare consumption intent (ctx.consumeService), and subscribe to
    // events (ctx.on) here. setup() runs once during INITIALIZING.
    // Registration calls are only valid from inside setup().
  },
};

export default plugin;
```

Required fields: `name`, `apiVersion`, `setup`. Optional: `driver`,
`services`, `aliases`, `permissions` (defaults to `{ tier: "trusted" }`),
`config`, `start` (only if `driver: true`). Full field table in
[`reference/plugin-api.md`](../reference/plugin-api.md#kaizenplugin-manifest).

## Registering tools {#tools}

Core has no opinion on what a "tool" is — there is no `ctx.registerTool`
method, no core-managed tool registry, and no built-in tool-definition
type. Tool shape is a plugin-to-plugin contract: a tool-broker plugin
defines a service name (for example, `core-tools:registry`) and the shape
of the objects it accepts, and tool-providing plugins consume that service
during their `setup()`.

Until a stable first-party broker publishes its service name, pick a broker
from your marketplace (or write one) and follow the types it ships in its
`public.d.ts`.

## Using the host API

The `ctx` object is your entire surface onto kaizen. It exposes:
`defineService` / `provideService` / `consumeService` / `useService`,
`defineEvent` / `on` / `emit`, `config`, `log`, permission-gated
`fs` / `net` / `secrets` / `exec`, and `runtime.pluginManager` for hot-reload
support.

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
event semantics — see
[`reference/host-api.md`](../reference/host-api.md).

## Publishing types {#publishing-types}

When your plugin provides a service, consumers need your types at compile time
but must not import your runtime code. The `public.d.ts` pattern handles this.

**Provider side** — ship a `public.d.ts` alongside your plugin:

```ts
// public.d.ts — shipped alongside the plugin
export interface PathHelpers {
  resolveHome(): string;
  joinSafe(...segs: string[]): string;
}
```

Reference it in your own code via `import type`:

```ts
// index.ts
import type { PathHelpers } from "./public";

const plugin: KaizenPlugin = {
  name: "utils",
  setup(ctx) {
    ctx.defineService("utils:paths", { description: "path helpers" });
    ctx.provideService<PathHelpers>("utils:paths", {
      resolveHome: () => process.env.HOME ?? "/",
      joinSafe: (...segs) => join(...segs),
    });
  },
};
```

**Consumer side** — use `import type` against the marketplace path (erased at
build; no runtime coupling):

```ts
import type { PathHelpers } from "my-marketplace/utils/public";

const plugin: KaizenPlugin = {
  name: "github",
  setup(ctx) {
    ctx.consumeService("utils:paths");
  },
  start(ctx) {
    const paths = ctx.useService<PathHelpers>("utils:paths");
    paths.resolveHome();  // fully typed
  },
};
```

Keep `public.d.ts` in sync with your runtime implementation. A future
`kaizen plugin types` tool may auto-generate it; until then, update it
manually when service interfaces change.

## Consumer TypeScript setup {#consumer-typescript-setup}

`import type { X } from "my-marketplace/utils/public"` is a bare specifier without
a real package in `node_modules`. TypeScript needs help resolving it.

**Recommended — `tsconfig.json` `paths`** pointing at the installed plugin's
exact version directory:

```json
{
  "compilerOptions": {
    "paths": {
      "my-marketplace/utils/*": ["/Users/you/.kaizen/marketplaces/my-marketplace/plugins/utils@0.1.0/*"]
    }
  }
}
```

Paths are concrete (pinned to a specific version directory) because
TypeScript's `paths` mechanism does string substitution, not filesystem
globbing. `kaizen plugin create` scaffolds this with concrete version
directories for whichever plugins are installed at scaffold time. Re-run the
scaffolder (or manually update `paths`) after marketplace updates until
auto-sync lands.

**Fallback** — a declaration shim in `node_modules/@types/` for authors whose
build tool ignores `paths`. More invasive; opt-in only.

Runtime touches neither path — they are TypeScript-only.

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
    defineService: mock(() => {}),
    provideService: mock(() => {}),
    consumeService: mock(() => {}),
    useService: mock(() => { throw new Error("not provided"); }),
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
    expect(plugin.apiVersion).toBe("3.0.0");
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
`useService` to return a test double.

If your plugin emits events defined by a vocabulary plugin, the real harness
requires a `consumes` declaration for that vocabulary service (so init order
is pinned). In tests, stub `useService` to return the vocabulary object
directly — no services edge is needed in the test context.

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
- `plugin.services` present (may be `{}`).
- `plugin.config.schema` is a valid JSON Schema; every `config.secrets` key
  appears in `config.schema.properties`.
- Warns if `config.secrets` is non-empty and `core-secrets:provider` is not in
  `services.consumes`.
- Warns on imports of `node:fs`, `node:child_process`, `node:worker_threads`,
  `bun:ffi`, and their unprefixed forms — the runtime enforcer blocks these
  regardless. Skipped for `unscoped` tier (those plugins are exempt from import
  enforcement).
- `*.test.ts` file present; `README.md` present.

> **What the sandbox enforces today:** The enforcer gates module imports and
> calls made through `ctx.fs` / `ctx.net` / `ctx.exec`. It does **not** filter
> Node.js globals. `process.cwd()`, `process.env`, `process.platform`,
> `os.homedir()`, and similar ambient values are accessible to plugins of any
> tier. `tier` currently signals intent and controls which `ctx.*` grants are
> available — it is not a hard runtime cap on globals. A future release may
> tighten this; for now, treat global access as unrestricted.

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
| `core-secrets:provider dependency is implicit` (warn) | List it in `services.consumes` for discoverability. |

## Plugin config keys {#plugin-config-keys}

If your plugin reads config values at runtime, document the keys in your
`README.md` so users know what to put under `defaults.plugin_config.<your-plugin>`
in `~/.kaizen/kaizen.json`. For example, a plugin named `gitlab` that reads
`base_url` and `username` should include:

```md
### User config (`~/.kaizen/kaizen.json`)

```json
{
  "defaults": {
    "plugin_config": {
      "gitlab": {
        "base_url": "https://gitlab.mycompany.com",
        "username": "alice"
      }
    }
  }
}
```
```

Declare the same keys in `plugin.config.schema` (the JSON Schema block in your
manifest) so kaizen can validate user-supplied values. Secret keys additionally
go in `plugin.config.secrets`. See [`reference/plugin-api.md`](../reference/plugin-api.md)
for the full `config` field shape.

## Next steps

Once your plugin validates, publish it:
[Marketplace Authoring](./marketplace-authoring.md).
