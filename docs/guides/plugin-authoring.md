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

### Setup-start closure pattern {#setup-start-closure}

`ctx.on()`, `ctx.defineService()`, `ctx.provideService()`, and
`ctx.consumeService()` are **`setup()`-only**. Calling any of them in
`start()` throws at runtime. This is a common surprise for driver plugins
that need to react to events emitted during the session loop — the natural
instinct is to register the handler next to the code that uses it, but
that code lives in `start()`.

The solution is a module-level (or closure-captured) mutable ref shared
between `setup()` and `start()`:

```ts
// Shared ref — lives outside both lifecycle methods.
const cancelController = { current: null as AbortController | null };

const plugin: KaizenPlugin = {
  name: "my-driver",
  driver: true,

  async setup(ctx) {
    // Register here, even though the AbortController doesn't exist yet.
    ctx.on("turn:cancel", () => cancelController.current?.abort());
  },

  async start(ctx) {
    // Create the controller and expose it via the shared ref.
    const ac = new AbortController();
    cancelController.current = ac;

    try {
      // ... session loop that uses ac.signal
    } finally {
      cancelController.current = null;
    }
  },
};
```

The same pattern applies to any state the handler needs from `start()`:
allocate a mutable container in module scope, populate it at the start of
`start()`, and clear it in a `finally` block.

### Non-driver `RUNNING`-phase wiring with `onReady` {#on-ready}

`useService()` is `RUNNING`-only — it throws if called from `setup()`. This is
straightforward for the driver (do it in `start()`) but used to be awkward for
non-driver plugins, since core only invokes `start()` on the driver. The
`onReady(ctx)` hook closes that gap.

`onReady` is an optional plugin method. Core invokes it once per loaded plugin,
in topological order (same edges as `setup()`), after every `setup()` resolves
and before `driver.start()` is invoked. Inside `onReady`, `useService()` is
legal; the same setup-only APIs that are forbidden in `start()` (`ctx.on`,
`provideService`, `consumeService`, `defineService`, `defineEvent`) are
forbidden here.

```ts
const plugin: KaizenPlugin = {
  name: "my-consumer",
  services: { consumes: ["peer:thing"] },

  async setup(ctx) {
    // setup-only wiring goes here
  },

  async onReady(ctx) {
    // RUNNING-phase wiring: legal to call useService now.
    const peer = ctx.useService<PeerThing>("peer:thing");
    peer.onSomething(() => {
      // …
    });
  },
};
```

A throw from `onReady` is fatal — the harness aborts with the same shape as a
`setup()` failure. `onReady` runs exactly once during the initial harness boot;
hot-reload (`PluginManager.reload`) does not re-invoke it.

The driver may also define `onReady` for the same purpose. `start()` retains
its "session loop" meaning and is unaffected.

#### When to still use the events pattern

`onReady` solves the "I need `useService()` legality" problem. Cross-plugin
coordination that depends on another plugin's *runtime* state — e.g. waiting
until the driver's session loop has actually started — still belongs in an
event handshake. Define a vocabulary event in a shared events plugin, have
the driver emit it during `start()`, and subscribe to it in `setup()` of any
plugin that needs to react.

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

> **What the sandbox enforces today:** The enforcer gates module imports,
> calls through `ctx.fs` / `ctx.net` / `ctx.exec`, and reads from
> `process.env`. A built-in allow-list of OS-infrastructure variables —
> `PATH`, `HOME`, `USER`, locale (`LC_*`, `LANG`), tmpdirs (`TMPDIR`,
> `TEMP`, `TMP`), and similar — passes through under any tier so that
> stdlib calls such as `child_process.spawn`, `os.homedir()`, and
> `os.tmpdir()` work without elevating tiers. Variables outside the
> allow-list follow tier rules: `unscoped` reads anything, `scoped` reads
> names declared in `env: [...]`, `trusted` reads only allow-listed
> names.
>
> Override the allow-list via `defaults.env_allowlist` in
> `~/.kaizen/kaizen.json` (user-level) or `env_allowlist` in a harness's
> `kaizen.json` (harness-level; takes precedence). An explicit `[]` means
> "gate everything; no passthrough." Entries are exact names (`"PATH"`)
> or trailing-`*` prefixes (`"LC_*"`).
>
> `process.cwd()`, `process.platform`, `os.platform()`, and similar
> non-env globals are not filtered.

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

## Runtime dependencies

If your plugin imports any runtime npm package (e.g., `react`, `ink`, `zod`),
declare it under `dependencies` in your `package.json`. Kaizen will resolve
those dependencies automatically when the plugin is installed by running
`bun install --production` in the install dir.

**Best practices:**

- **Commit your `bun.lock`** (or other lockfile) for reproducible installs.
  Without a lockfile, two users installing "the same plugin version" can get
  different transitive deps based on when they install.
- **Keep build-only tools in `devDependencies`.** TypeScript, bundlers,
  test runners, type packages — none of these need to land on user machines
  at plugin install time.
- **Postinstall lifecycle scripts are disabled by Bun by default.** If your
  plugin (or one of its deps) needs to run a postinstall script — e.g., a
  package with a native binding — declare the dep in `trustedDependencies`
  in your `package.json`. See [Bun's lifecycle scripts docs](https://bun.com/docs/cli/install#trusted-dependencies).
- **Prefer pure-JS or `optionalDependencies`-distributed native packages.**
  Modern packages (`esbuild`, `lightningcss`, recent `sharp`) ship platform
  binaries via `optionalDependencies` and install reliably without a build
  step.

If `package.json` has no `dependencies` field, no install step runs — your
plugin is copied into place and that's it.

## Bundling {#bundling}

After `bun install --production` completes, kaizen runs `bun build --target=bun`
to produce `<install-dir>/dist/index.js`. The plugin loader prefers this bundle
over the raw entry point. Once the build succeeds, `node_modules/` and any bun
lockfile are removed from the install directory — source files (`package.json`,
`README.md`, `index.tsx`, etc.) stay on disk for inspection.

**Why bundling is required.** The compiled `kaizen` binary cannot resolve
`node_modules/` at runtime or transform JSX/TypeScript at import time. A bundle
produces a self-contained ESM module that loads from the binary without further
resolution.

### Declaring externals (`kaizen.bundleExternals`) {#bundle-externals}

Some transitive dependencies conditionally import packages you don't want
bundled — for example, `ink`'s `devtools.js` pulls in `react-devtools-core`.
When bun encounters such an import it will try to bundle it, which fails if the
package is absent or incompatible.

Declare these externals in your `package.json` under a top-level `kaizen` key:

```json
{
  "name": "claude-tui",
  "version": "0.2.0",
  "type": "module",
  "main": "index.tsx",
  "dependencies": { "ink": "^7.0.1", "react": "^19.2.0" },
  "kaizen": {
    "bundleExternals": ["react-devtools-core"]
  }
}
```

`bundleExternals` is a `string[]`. Each entry is passed verbatim to
`bun build --external <entry>`. Kaizen does not curate or validate the list —
it is your responsibility to declare only what you need.

### Dynamic imports {#dynamic-imports}

Avoid eval'd or string-concatenated dynamic imports of bare specifiers.
`import("./foo.js")` and `import(varHoldingAbsolutePath)` survive bundling;
`` import(`some-pkg-${version}`) `` will not.

### Local-path plugins {#local-path-bundling}

Local-path plugins (`./path/to/plugin`) are **not** bundled. They load via the
raw entry, which only works under uncompiled `bun src/cli.ts`. Use local-path
plugins for development; publish to a marketplace for any other use.

### The `kaizen.*` namespace {#kaizen-namespace}

The `kaizen` key in `package.json` is reserved for plugin-side static metadata
that kaizen needs to read before importing the plugin entry. `bundleExternals`
is the first field in this namespace; additional fields may be added in future
releases.

### Upgrading from ≤ 0.3.2 {#upgrading}

Plugins installed under kaizen ≤ 0.3.2 do not have a `dist/index.js`. Run
`kaizen install <ref>` again to regenerate the bundle layout. `installPlugin`
is idempotent, so re-installing is safe.

## Next steps

Once your plugin validates, publish it:
[Marketplace Authoring](./marketplace-authoring.md).
