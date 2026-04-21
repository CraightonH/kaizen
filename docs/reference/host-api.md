# Host API Reference

*Read when: writing a plugin that needs secrets, config, the event bus, or LLM access.*

Plugins import from `"kaizen/types"`. The module mixes runtime values and
type-only exports. Authoritative source:
[`src/host-api.ts`](../../src/host-api.ts) — "Adding to the plugin API =
editing this file. This file is the authoritative, reviewable contract
between kaizen and all plugins."

```ts
import {
  // Runtime values
  ServiceToken,
  createLLMRuntime,
  readStdinLine,
  SecretsProviderToken,
  PLUGIN_API_VERSION,
  // Types (erased at runtime)
  type KaizenPlugin,
  type PluginContext,
  type ToolDefinition,
} from "kaizen/types";
```

---

## Runtime values

These are real values — callable classes, constants, and functions.

### `ServiceToken`

```ts
class ServiceToken<T> {
  readonly label: string;
  constructor(label: string);
}
```

An unforgeable, typed key used with the plugin service registry. Each
`new ServiceToken(label)` produces a distinct key even if two tokens share the
same label string (tokens use internal `Symbol` identity).

Use it to expose one plugin's API to another. Convention: the token label
matches the service's TypeScript interface name.

```ts
export interface MyService { greet(name: string): string }
export const MyServiceToken = new ServiceToken<MyService>("MyService");
```

Paired with `ctx.registerService(token, impl)` in the provider and
`ctx.getService(token)` in the consumer. Consumers must list the provider in
`depends[]`/`consumes[]` so initialization order is enforced. See
[`src/core/service-registry.ts`](../../src/core/service-registry.ts).

### `SecretsProviderToken`

```ts
const SecretsProviderToken: ServiceToken<SecretProvider>;
```

The canonical token harness-authored secret providers register under. A
harness that adds a custom secret provider calls:

```ts
ctx.registerService(SecretsProviderToken, myProvider);
```

Defined in [`src/core/secrets.ts`](../../src/core/secrets.ts) as
`new ServiceToken<SecretProvider>("core-secrets:provider")`.

### `createLLMRuntime`

```ts
function createLLMRuntime(config: {
  adapter: "anthropic" | "openai" | "google" | "mistral";
  model: string;
  api_key_env?: string;
  api_key?: string;
  baseURL?: string;
}): {
  send(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse>;
  stream(messages: Message[], tools: ToolDefinition[]): AsyncIterable<LLMStreamChunk>;
};
```

Factory for an `Executor`-shaped object backed by the `ai` SDK. Used by
executor plugins to avoid reimplementing provider wiring. The return value
conforms to the [`Executor`](./plugin-api.md#executor) interface.

### `readStdinLine`

```ts
function readStdinLine(): Promise<string>;
```

Reads the next line from process stdin. Multiple callers each receive the
next available line in order — there is a single shared readline interface
for the whole process, so importing this everywhere is safe. Returns `""`
on stdin close.

Used by `core-ui-terminal` and `core-executor-debug` to share one queue
rather than fighting over separate readline instances.

### `PLUGIN_API_VERSION`

```ts
const PLUGIN_API_VERSION: string;  // current value: "2"
```

The semver major version of the plugin API. Core warns (but still loads) if a
plugin's `apiVersion` major differs. Defined in
[`src/types/plugin.ts`](../../src/types/plugin.ts).

---

## Context APIs (PluginContext)

`ctx.fs`, `ctx.net`, `ctx.secrets`, and `ctx.exec` go through the permission
enforcer — every call is checked against the plugin's declared
[permissions](./plugin-api.md#pluginpermissions). `ctx.log` is unguarded.
Types live in
[`src/core/plugin-ctx-io.ts`](../../src/core/plugin-ctx-io.ts).

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

### `ctx.secrets` (CtxSecrets)

```ts
interface CtxSecrets {
  get(name: string): string | undefined;
  has(name: string): boolean;
}
```

The I/O-surface `ctx.secrets` reads environment variables directly and is
gated by `permissions.env`. For the full-featured secrets resolver
(harness-authored providers, `KAIZEN_<PLUGIN>_<KEY>` overrides, caching),
see the `SecretsContext` interface on the plugin side of the contract and
[`plugin-secrets.md`](./plugin-secrets.md). Returns `undefined` (does not
throw) if permission is denied.

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

### `ctx.log` (CtxLog)

```ts
interface CtxLog {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
```

Output is prefixed with the plugin name and the level (e.g.
`[my-plugin] info: ready`). `warn`/`error` route to stderr; `debug`/`info` to
stdout. Not permission-gated.

Note: `PluginContext` also exposes a top-level `ctx.log(msg: string): void`
convenience method for single-string logging; the structured `CtxLog`
interface above is the full surface.

### `ctx.io` (CtxIo)

```ts
interface CtxIo {
  fs: CtxFs;
  net: CtxNet;
  secrets: CtxSecrets;
  exec: CtxExec;
  log: CtxLog;
}
```

Aggregate container that bundles all five I/O surfaces. Constructed per
plugin by `createCtxIo(plugin, enforcer)`; plugins typically access
`ctx.fs`/`ctx.net`/etc. directly rather than the composite.

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
- `PluginCapabilities` — `{ provides?; consumes? }`
- `CapabilitySpec` — capability declaration shape
- `Cardinality` — `"one" | "many"`
- `PluginConfigDeclaration` — `{ schema?; defaults?; secrets? }`
- `SecretRef` / `StructuredSecretRef` — `kaizen.json` secret ref shapes
- `SecretsContext` — `ctx.secrets` full-featured surface (`get`, `refresh`)
- `EventHandler` — `(payload?: unknown) => Promise<unknown | void>`
- `JsonSchema` — JSON Schema subset for tool `parameters`
- `PluginEntry` — plugin-manager listing entry
- `PluginManagerPublicApi` / `PluginManagerLifecycleApi` — runtime plugin control

### LLM / message types

- `Message` — `{ role; content; tool_call_id?; tool_calls? }`
- `MessageRole` — `"system" | "user" | "assistant" | "tool"`
- `AgentMessage` — tagged union sent via `UiChannel.send`
- `UserMessage` — tagged union returned by `UiChannel.receive`
- `ToolCall` — `{ id; name; args }`
- `LLMResponse` — `{ content; tool_calls; stop_reason }`
- `LLMStreamChunk` — streaming chunk shape
- `Executor` — `{ send; stream }`

### Tool types

- `ToolDefinition` — `{ name; description; parameters; destructive?; execute }`
- `ToolResult` — `{ ok; output?; data?; error?; exit_code? }`

### UI types

- `UiProvider` — `{ accept(): AsyncIterable<UiChannel> }`
- `UiChannel` — `{ id; receive; send; close }`

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
