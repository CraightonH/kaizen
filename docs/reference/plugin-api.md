# Plugin API Reference

*Read when: you need exact type signatures, manifest field names, or method definitions.*

Authoritative source: [`src/types/plugin.ts`](../../src/types/plugin.ts). This
file is the reference layer — exact shapes and method signatures. For the
conceptual layer (plugin model, lifecycle, service semantics), see
[`docs/concepts/plugin-model.md`](../concepts/plugin-model.md).

Current API version: `PLUGIN_API_VERSION = "3"`.

---

## KaizenPlugin manifest

A plugin is an object conforming to `KaizenPlugin`, exported as the default
export of an npm package (or workspace package).

```ts
export interface KaizenPlugin {
  name: string;
  apiVersion: string;
  driver?: boolean;
  services?: PluginServices;
  aliases?: Record<string, string>;
  permissions?: PluginPermissions;
  config?: PluginConfigDeclaration;
  setup(ctx: PluginContext): Promise<void>;
  start?(ctx: PluginContext): Promise<void>;
  stop?(ctx: PluginContext): Promise<void>;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | kebab-case. Must match the config namespace key in `kaizen.json`. |
| `apiVersion` | `string` | yes | semver. Core warns if major differs from `PLUGIN_API_VERSION`. |
| `driver` | `boolean` | no | If true, this plugin drives the session loop. Core calls `start()` on the one plugin with `driver=true` after bootstrap. Exactly one loaded plugin must declare this — zero or two+ is a fatal startup error. |
| `services` | `PluginServices` | no | `{ provides?: string[]; consumes?: string[] }`. Declares what this plugin provides and consumes in the service registry. |
| `aliases` | `Record<string, string>` | no | Map short or alternative service names to canonical owner-qualified names. e.g. `{ "ui.input": "core-driver:ui.input" }`. |
| `permissions` | `PluginPermissions` | no | Permission manifest. Defaults to `{ tier: "trusted" }`. See Permissions below. |
| `config` | `PluginConfigDeclaration` | no | Declares config schema, defaults, and which keys are secrets. |
| `setup` | `(ctx: PluginContext) => Promise<void>` | yes | Called once during `INITIALIZING`. Define and provide services, declare consumption intent, and subscribe to events here. |
| `start` | `(ctx: PluginContext) => Promise<void>` | no | Only implement if `driver=true`. Core calls this after all plugins initialize. |
| `stop` | `(ctx: PluginContext) => Promise<void>` | no | Called during unload before the plugin's events, services, and permissions are deregistered. Use to close resources opened in `setup`/`start` (readline interfaces, listeners, timers, file watchers). Runs inside `runInPluginScope`, so `ctx` permissions remain active. Errors are warned but do not block deregistration. `runHarness` calls `PluginManager.unloadAll()` in its `finally` block, invoking `stop` on every loaded plugin in reverse insertion order (consumers before providers). |

### PluginServices

```ts
export interface PluginServices {
  provides?: string[];
  consumes?: string[];
}
```

### ServiceSpec

Plugins can declare new services (during `setup()` via `ctx.defineService`):

```ts
export interface ServiceSpec {
  description?: string;
  schema?: JsonSchema;   // optional; informational in v1
  version?: string;      // optional; informational in v1
}
```

Every service is cardinality "one": exactly one provider permitted. A second
`provideService` call for the same name is a fatal error.

### PluginConfigDeclaration

```ts
export interface PluginConfigDeclaration {
  schema?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  secrets?: string[];  // keys within schema that are secrets
}
```

See [`plugin-secrets.md`](./plugin-secrets.md) for details on how secrets resolve.

### PluginPermissions

```ts
export type PermissionTier = "trusted" | "scoped" | "unscoped";

export interface PluginPermissions {
  tier?: PermissionTier;              // default "trusted"
  fs?:   { read?: string[]; write?: string[] };  // glob patterns
  net?:  { connect?: string[] };      // host:port allowlist; "*" = any
  env?:  string[];                    // allowed env var names
  exec?: { binaries?: string[] };     // binary name allowlist
  events?: { subscribe?: string[] };  // cross-plugin event subscription patterns
}
```

### PermissionOp

Operation shape checked by the permission enforcer:

```ts
export type PermissionOp =
  | { kind: "fs.read";  path: string }
  | { kind: "fs.write"; path: string }
  | { kind: "net.connect"; host: string; port: number }
  | { kind: "env.get";  name: string }
  | { kind: "exec.run"; binary: string }
  | { kind: "events.subscribe"; event: string }
  | { kind: "import";   module: string };
```

---

## PluginContext (setup argument)

The `ctx` object passed to `setup()` (and to `start()` for driver plugins).

```ts
export interface PluginContext {
  // --- Service registry ---
  defineService(name: string, spec: ServiceSpec): void;   // INITIALIZING only
  provideService<T>(name: string, impl: T): void;         // INITIALIZING only
  consumeService(name: string): void;                     // INITIALIZING only
  useService<T>(name: string): T;                         // RUNNING only

  // --- Event bus ---
  defineEvent(name: string): void;                        // INITIALIZING only; advisory
  on(event: string, handler: EventHandler): void;         // INITIALIZING only
  emit(event: string, payload?: unknown): Promise<unknown[]>;  // serial, error-isolated

  // --- Config and logging ---
  config: Record<string, unknown>;                        // merged, non-secret
  harness: HarnessIdentity;                               // raw harness metadata; inner fields optional
  log(msg: string): void;                                 // prefixed with plugin name
  pluginManager: PluginManagerPublicApi;                  // runtime load/unload

  // --- Permission-gated I/O surface ---
  fs: CtxFs;
  net: CtxNet;
  secrets: SecretsContext;
  exec: CtxExec;

  // --- Runtime primitives ---
  runtime: {
    pluginManager: PluginManagerLifecycleApi;             // drainPendingReloads()
  };
}
```

Method semantics:

- `defineService` — declares a new service owned by this plugin. Name must be
  `<this-plugin>:<symbol>`; calling with another plugin's prefix throws.
  Valid only during `INITIALIZING`.
- `provideService` — registers the implementation for a previously defined
  service. Throws if the service was not defined first, or if a provider is
  already registered (cardinality-one enforcement). Valid only during
  `INITIALIZING`.
- `consumeService` — records this plugin as a consumer of the named service.
  Required for topo-sort and post-init validation. Valid only during
  `INITIALIZING`.
- `useService` — returns the registered implementation by reference. Throws
  if the service has no provider. Valid only during `RUNNING` (not inside
  `setup()`; providers may not have registered yet).
- `on` — registers an event handler. **Must be called in `setup()`, not
  `start()`**; throws `Cannot register event handlers after initialization.`
  if called later. If a driver plugin needs to react to events during its
  session loop, register the handler in `setup()` and share state via a
  closure — see [the closure pattern](#setup-start-closure) in
  `plugin-authoring.md`.
- `emit` calls all handlers serially in initialization order, returns every
  handler's return value (including `undefined`), and logs-and-continues on
  handler throw. Emitting an undefined event warns but never blocks.
- `harness` — raw metadata about the harness this plugin was loaded under.
  The outer field is always present; both inner fields may be absent.
  Plugins that need to partition on-disk state by harness derive their own
  namespacing key from these inputs — kaizen does not pick a canonical name.
  See [`guides/plugin-authoring.md#harness-identity`](../guides/plugin-authoring.md#harness-identity)
  for the recommended fallback pattern.

```ts
export interface HarnessIdentity {
  jsonPath?: string;  // absolute path to the resolved harness JSON
  ref?: string;       // user's --harness ref or defaults.harness, if any
}
```

### PluginManagerPublicApi / PluginManagerLifecycleApi

```ts
export interface PluginEntry {
  name: string;
  apiVersion: string;
  services: PluginServices;
  status: "loaded" | "unloaded" | "failed";
}

export interface PluginManagerPublicApi {
  load(name: string): Promise<void>;
  unload(name: string): Promise<void>;
  reload(name: string): Promise<void>;
  queueLoad(name: string): void;
  queueUnload(name: string): void;
  queueReload(name: string): void;
  list(): PluginEntry[];
}

export interface PluginManagerLifecycleApi {
  drainPendingReloads(): Promise<void>;  // call between turns for hot-reload
}
```

---

## JsonSchema

```ts
export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: unknown[];
  [key: string]: unknown;
};
```

Exported for plugins that want to declare validated shapes (e.g. in
`ServiceSpec.schema` or `PluginConfigDeclaration.schema`). Core uses the
same subset internally.

> **Core holds exactly one opinion:** one plugin must be the session driver
> and receive `start()`. LLM shape, UI shape, tool shape, and stdin handling
> are plugin-to-plugin concerns mediated by the service registry — core does
> not define executor, UI-channel, or tool-definition types, nor any other
> runtime or message type beyond what appears in this file. Plugins that
> want to cooperate agree on service names and
> ship the types via `public.d.ts` (see
> [Publishing types](../guides/plugin-authoring.md#publishing-types)).

---

## Events

```ts
export type EventHandler = (payload?: unknown) => Promise<unknown | void>;
```

kaizen core itself defines no event names — the vocabulary is owned entirely
by plugins. A plugin that emits events should call `ctx.defineEvent` for each
name during `setup()`. When the `defineEvent` calls live in a separate
vocabulary plugin, emitters must declare a `consumes` dependency on that
plugin's service to guarantee it initializes first. See
[`guides/ecosystem-design.md`](../guides/ecosystem-design.md) for the full
pattern and worked examples.

`emit()` semantics:

- Handlers run serially in registration order.
- Every handler's return value is collected into the returned array
  (including `undefined`).
- If a handler throws, the error is logged and execution continues with the
  next handler.
- Emitting a name that was never registered via `defineEvent` emits a warning
  but still delivers to any subscribers.

### Defining custom events

```ts
ctx.defineEvent("my-plugin:custom-event");
ctx.emit("my-plugin:custom-event", { data: 42 });
```

Other plugins subscribe with `ctx.on("my-plugin:custom-event", handler)`.
Cross-plugin subscription may require an entry in
`permissions.events.subscribe`.

---

## Secrets and config types

```ts
export interface StructuredSecretRef {
  provider: string;
  ref: string;
  envOverride?: string;
}
export type SecretRef = string | StructuredSecretRef;

export interface SecretsContext {
  get(key: string): Promise<string | undefined>;
  refresh(key: string): Promise<string | undefined>;
}
```

See [`plugin-secrets.md`](./plugin-secrets.md) for resolution order and
harness-authored providers.

---

## KaizenConfig (harness kaizen.json shape)

`KaizenConfig` describes a **harness** `kaizen.json` — the file maintained by harness authors, not end users. End-user config lives exclusively in `~/.kaizen/kaizen.json`; see [`docs/concepts/configuration.md`](../concepts/configuration.md).

```ts
export interface KaizenConfig {
  plugins: string[];           // marketplace refs "<marketplace-id>/<name>[@<version>]" or local paths ("./", "../", "/")
  extends?: string;            // harness to extend: marketplace ref or local path
  marketplaces?: MarketplaceRef[];
  env_allowlist?: string[];    // per-harness env-var allow-list; takes precedence over user defaults.env_allowlist
  [pluginName: string]: unknown;  // per-plugin config slices
}
```

## KaizenGlobalConfig (~/.kaizen/kaizen.json shape)

```ts
export interface KaizenDefaults {
  harness?: string;                                    // default harness ref
  plugin_config?: Record<string, Record<string, unknown>>;  // per-plugin overrides
  env_allowlist?: string[];                            // env-var allow-list; entries are exact names ("PATH") or trailing-* prefixes ("LC_*")
}

export interface KaizenGlobalConfig {
  marketplaces?: MarketplaceRef[];
  defaults?: KaizenDefaults;
  marketplaceUpdateTTL?: number;   // seconds; 0 disables; default 900
}
```

---

## Marketplace types

```ts
export type PluginSource =
  | { type: "npm";     name: string;  version: string }
  | { type: "tarball"; url: string;   sha256?: string }
  | { type: "file";    path: string };  // relative to marketplace repo root

export interface PluginVersionEntry {
  version: string;
  source: PluginSource;
  changelog?: string;
  minKaizenVersion?: string;
}

export interface HarnessVersionEntry {
  version: string;
  path: string;         // relative to marketplace repo root
  changelog?: string;
}

export interface MarketplacePluginEntry {
  kind: "plugin";
  name: string;
  description: string;
  categories?: string[];
  versions: PluginVersionEntry[];
}

export interface MarketplaceHarnessEntry {
  kind: "harness";
  name: string;
  description: string;
  categories?: string[];
  versions: HarnessVersionEntry[];
}

export type MarketplaceEntry = MarketplacePluginEntry | MarketplaceHarnessEntry;

export interface MarketplaceCatalog {
  version: "1.0.0";
  name: string;
  description?: string;
  url: string;
  signature?: string;   // reserved; unused in v1
  entries: MarketplaceEntry[];
}

export interface MarketplaceRef {
  id: string;
  url: string;          // git URL or absolute local dir
  updatedAt?: string;   // ISO-8601
}
```
