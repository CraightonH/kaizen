# Host API Reference

*Read when: writing a plugin that needs secrets, config, the event bus, or LLM access.*

Plugins import from `"kaizen/types"`. The module mixes runtime values and
type-only exports. Authoritative source:
[`src/host-api.ts`](../../src/host-api.ts) — "Adding to the plugin API =
editing this file. This file is the authoritative, reviewable contract
between kaizen and all plugins."

```ts
import {
  // Runtime value (the only one)
  PLUGIN_API_VERSION,
  // Types (erased at runtime)
  type KaizenPlugin,
  type PluginContext,
} from "kaizen/types";
```

---

## Runtime values

**Core holds exactly one opinion:** one plugin must be the session driver
and receive `start()`. Everything else — LLM runtime, stdin reading, UI
shape, tool shape — is a plugin-to-plugin concern mediated by the
[service registry](../concepts/plugin-model.md#services). Accordingly, the
`kaizen/types` runtime surface exposes only `PLUGIN_API_VERSION`. Plugins
that need an LLM adapter or shared stdin obtain them by consuming services
published by other plugins.

### `PLUGIN_API_VERSION`

```ts
const PLUGIN_API_VERSION: string;  // current value: "3"
```

The semver major version of the plugin API. Core warns (but still loads) if a
plugin's `apiVersion` major differs. Defined in
[`src/types/plugin.ts`](../../src/types/plugin.ts).

---

## Context APIs (PluginContext)

`ctx.fs`, `ctx.net`, and `ctx.exec` go through the permission enforcer —
every call is checked against the plugin's declared
[permissions](./plugin-api.md#pluginpermissions). `ctx.secrets` is
access-scoped by the plugin's `config.secrets` declaration. `ctx.log` is
unguarded. I/O types live in
[`src/core/plugin-ctx-io.ts`](../../src/core/plugin-ctx-io.ts);
`SecretsContext` is defined in
[`src/types/plugin.ts`](../../src/types/plugin.ts).

### `ctx.fs` (CtxFs)

```ts
interface CtxFs {
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  write(path: string, data: Uint8Array | string): Promise<void>;
  list(path: string): Promise<string[]>;
  stat(path: string): Promise<Stats>;
}
```

Every call checks `fs.read` or `fs.write` against
`permissions.fs.{read,write}` globs. Plugins in the `trusted` tier have no
filesystem access.

### `ctx.net` (CtxNet)

```ts
interface CtxNet {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}
```

`fetch` parses the URL and checks `net.connect` against
`permissions.net.connect` (host:port allowlist; `"*"` matches anything;
patterns like `"*.example.com:443"` are allowed). Returns the global
`Response` type.

### `ctx.secrets` (SecretsContext)

```ts
interface SecretsContext {
  get(key: string): Promise<string | undefined>;
  refresh(key: string): Promise<string | undefined>;
}
```

The async secrets resolver. `get` reads through the resolution chain
(`envOverride` → `KAIZEN_<PLUGIN>_<KEY>` → cache → provider). `refresh`
bypasses the cache and re-resolves from the provider. Configured per
plugin via the `config.secrets` declaration; see
[`plugin-secrets.md`](./plugin-secrets.md) for the full provider contract
and ref shapes.

### `ctx.exec` (CtxExec)

```ts
interface ExecOpts {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CtxExec {
  run(binary: string, args: string[], opts?: ExecOpts): Promise<ExecResult>;
}
```

`run` checks `exec.run` against `permissions.exec.binaries` (binary-name
allowlist; argv is not pattern-matched in v1). `timeoutMs` triggers
`SIGKILL` if the child is still running.

### `ctx.log`

```ts
log(msg: string): void;
```

Single-string logger. Output is prefixed with the plugin name (e.g.
`[my-plugin] ready`). Not permission-gated. A richer structured logging
surface may land in a future release; when it does, it will be additive.

### `ctx.io` (CtxIo)

```ts
interface CtxIo {
  fs: CtxFs;
  net: CtxNet;
  exec: CtxExec;
}
```

Aggregate container bundling the permission-gated I/O surfaces.
Constructed per plugin by `createCtxIo(plugin, enforcer)`; plugins
typically access `ctx.fs`/`ctx.net`/`ctx.exec` directly rather than the
composite. Note that `ctx.secrets` and `ctx.log` are **not** part of
`CtxIo` — they are wired onto `PluginContext` by a separate path
(`createSecretsContext` and the closure in `context.ts`).

---

## Type-only exports

The following are TypeScript types only (stripped at runtime). Import them
for type annotations in your plugin source. Full shapes are in
[`plugin-api.md`](./plugin-api.md).

### Plugin types

- `KaizenPlugin` — the manifest/default-export shape
- `KaizenConfig` — the `kaizen.json` shape
- `KaizenGlobalConfig` — the global config shape (marketplaces, defaults)
- `PluginContext` — the `ctx` argument to `setup()` / `start()`
- `PluginPermissions` — permission manifest
- `PermissionTier` — `"trusted" | "scoped" | "unscoped"`
- `PermissionOp` — tagged union passed to `PermissionEnforcer.check()`
- `PluginServices` — `{ provides?; consumes? }`
- `ServiceSpec` — service declaration shape
- `PluginConfigDeclaration` — `{ schema?; defaults?; secrets? }`
- `SecretRef` / `StructuredSecretRef` — `kaizen.json` secret ref shapes
- `SecretsContext` — `ctx.secrets` full-featured surface (`get`, `refresh`)
- `EventHandler` — `(payload?: unknown) => Promise<unknown | void>`
- `JsonSchema` — JSON Schema subset for tool `parameters`
- `PluginEntry` — plugin-manager listing entry
- `PluginManagerPublicApi` / `PluginManagerLifecycleApi` — runtime plugin control

### Marketplace types

- `MarketplaceCatalog` — top-level catalog shape (version, entries, ...)
- `MarketplaceEntry` — `MarketplacePluginEntry | MarketplaceHarnessEntry`
- `MarketplacePluginEntry` / `MarketplaceHarnessEntry`
- `MarketplaceRef` — `{ id; url; updatedAt? }`
- `PluginSource` — `{ type: "npm" | "tarball" | "file"; ... }`
- `PluginVersionEntry` / `HarnessVersionEntry`

### Secret provider types

- `SecretProvider` — the interface a harness-authored secret provider
  implements. Shape: `{ name; get(ref); set?(ref, value); prefetch?(refs) }`.
  See [`plugin-secrets.md`](./plugin-secrets.md).
