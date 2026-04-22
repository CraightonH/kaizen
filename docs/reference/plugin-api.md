# Plugin API Reference

*Read when: you need exact type signatures, manifest field names, or method definitions.*

Authoritative source: [`src/types/plugin.ts`](../../src/types/plugin.ts). This
file is the reference layer — exact shapes and method signatures. For the
conceptual layer (plugin model, lifecycle, capability semantics), see
[`docs/concepts/plugin-model.md`](../concepts/plugin-model.md).

Current API version: `PLUGIN_API_VERSION = "2"`.

---

## KaizenPlugin manifest

A plugin is an object conforming to `KaizenPlugin`, exported as the default
export of an npm package (or workspace package).

```ts
export interface KaizenPlugin {
  name: string;
  apiVersion: string;
  lifecycle?: boolean;
  capabilities?: PluginCapabilities;
  aliases?: Record<string, string>;
  permissions?: PluginPermissions;
  config?: PluginConfigDeclaration;
  setup(ctx: PluginContext): Promise<void>;
  start?(ctx: PluginContext): Promise<void>;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | kebab-case. Must match the config namespace key in `kaizen.json`. |
| `apiVersion` | `string` | yes | semver. Core warns if major differs from `PLUGIN_API_VERSION`. |
| `driver` | `boolean` | no | If true, this plugin drives the session loop. Core calls `start()` on the one plugin with `driver=true` after bootstrap. Exactly one loaded plugin must declare this — zero or two+ is a fatal startup error. |
| `capabilities` | `PluginCapabilities` | no | `{ provides?: string[]; consumes?: string[] }`. Declares what this plugin provides and consumes in the capability registry. |
| `aliases` | `Record<string, string>` | no | Map short or alternative capability names to canonical owner-qualified names. e.g. `{ "ui.input": "core-driver:ui.input" }`. |
| `permissions` | `PluginPermissions` | no | Permission manifest. Defaults to `{ tier: "trusted" }`. See Permissions below. |
| `config` | `PluginConfigDeclaration` | no | Declares config schema, defaults, and which keys are secrets. |
| `setup` | `(ctx: PluginContext) => Promise<void>` | yes | Called once during `INITIALIZING`. Register services, declare capabilities, and subscribe to events here. |
| `start` | `(ctx: PluginContext) => Promise<void>` | no | Only implement if `driver=true`. Core calls this after all plugins initialize. |

### PluginCapabilities

```ts
export interface PluginCapabilities {
  provides?: string[];
  consumes?: string[];
}
```

### CapabilitySpec

Plugins can declare new capabilities (typically during `setup()`):

```ts
export type Cardinality = "one" | "many";

export interface CapabilitySpec {
  cardinality: Cardinality;   // "one": exactly one provider required when consumed
  schema?: JsonSchema;         // optional JSON Schema validated against providers
  version?: string;            // informational only
  description: string;         // shown by `kaizen capability show`
}
```

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

The `ctx` object passed to `setup()` (and to `start()` for lifecycle plugins).

```ts
export interface PluginContext {
  // --- Service registry ---
  registerService<T>(token: ServiceToken<T>, impl: T): void;  // INITIALIZING only
  getService<T>(token: ServiceToken<T>): T;                    // any state

  // --- Capability registry (INITIALIZING only) ---
  defineCapability(name: string, spec: CapabilitySpec): void;  // name must be plugin-prefixed

  // --- Event bus ---
  defineEvent(name: string): void;                             // advisory
  on(event: string, handler: EventHandler): void;
  emit(event: string, payload?: unknown): Promise<unknown[]>;  // serial, error-isolated

  // --- Config and logging ---
  config: Record<string, unknown>;                              // merged, non-secret
  log(msg: string): void;                                       // prefixed with plugin name
  pluginManager: PluginManagerPublicApi;                        // runtime load/unload

  // --- Permission-gated I/O surface ---
  fs: CtxFs;
  net: CtxNet;
  secrets: SecretsContext;
  exec: CtxExec;

  // --- Runtime primitives ---
  runtime: {
    pluginManager: PluginManagerLifecycleApi;                   // drainPendingReloads()
  };
}
```

Method semantics:

- `registerService` and `defineCapability` are valid only during `INITIALIZING`
  (inside `setup()`). Calling them from an event handler throws.
- `getService` is valid at any lifecycle state and throws with a named error
  when the token has no provider.
- `emit` calls all handlers serially in initialization order, returns every
  handler's return value (including `undefined`), and logs-and-continues on
  handler throw. Emitting an undefined event warns but never blocks.

### PluginManagerPublicApi / PluginManagerLifecycleApi

```ts
export interface PluginEntry {
  name: string;
  apiVersion: string;
  capabilities: PluginCapabilities;
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

## Tool definition

`ToolDefinition`, `ToolResult`, and `ToolCall` are part of the API surface used
by the `Executor` interface (LLM tool-calling round-trip). A tool-broker plugin
(`core-tools`) is planned for a future release and will define how plugins
register callable tools. Until then, core has no `registerTool` method and
does not manage a tool registry.

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  destructive?: boolean;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  output?: string;     // human-readable; sent to LLM when data is absent
  data?: unknown;      // structured JSON; sent to LLM instead of output when present
  error?: string;      // sent to LLM when ok=false
  exit_code?: number;  // for subprocess-based tools; informational only
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
```

### JsonSchema

The subset used for tool parameter definitions:

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

---

## Executor and UI types

These types are part of the plugin API surface. Executor and UI plugins use
`ctx.registerService(Token, impl)` plus `ctx.defineCapability(...)` to expose
their implementations. The driver plugin (e.g. `core-driver`) defines the
capability names and `ServiceToken` values it expects and documents them in its
own README. Core does not enshrine `kaizen.executor`, `kaizen.ui`, or any other
well-known name.

<!-- TODO: expand once core-driver publishes its tokens and capability names -->

### Executor

```ts
export interface Executor {
  send(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse>;
  stream(messages: Message[], tools: ToolDefinition[]): AsyncIterable<LLMStreamChunk>;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  tool_call_id?: string;   // role=tool only — links result to its call
  tool_calls?: ToolCall[]; // role=assistant only — when the LLM requested calls
}

export interface LLMResponse {
  content: string;
  tool_calls: ToolCall[];
  stop_reason: string;     // raw provider stop reason, e.g. "end_turn"
}

export interface LLMStreamChunk {
  type: "text" | "tool_call" | "done";
  text?: string;
  tool_call?: Partial<ToolCall>;
}
```

### UI

```ts
export type UserMessage =
  | { type: "text"; content: string };

export type AgentMessage =
  | { type: "text";        content: string }
  | { type: "text_delta";  content: string }
  | { type: "tool_call";   name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; output: string }
  | { type: "error";       message: string };

export interface UiChannel {
  readonly id: string;
  receive(): Promise<UserMessage>;  // blocks until user sends; throws when closed
  send(msg: AgentMessage): Promise<void>;
  close(): Promise<void>;
}

export interface UiProvider {
  /** Yields one UiChannel per session.
   *  Terminal: yields one channel then stops.
   *  Web: yields a new channel per connection, indefinitely. */
  accept(): AsyncIterable<UiChannel>;
}
```

---

## Events

```ts
export type EventHandler = (payload?: unknown) => Promise<unknown | void>;
```

kaizen core itself defines no event names — the event vocabulary is owned by
plugins. In practice, the `core-events` plugin exports the canonical event
names and payload types and registers a `CoreEventsServiceToken` that exposes
them. Import event names and payload types from `core-events`:

```ts
import { EVENTS } from "core-events";
import type {
  SessionContext,
  UserMessageContext,
  ResponseContext,
  ToolCallContext,
  ToolResultContext,
} from "core-events";
```

Conventional event names shipped by `core-events`:

| Event | Payload type | When it fires |
|-------|--------------|---------------|
| `session:start` | `SessionContext` | Once at session open |
| `session:end` | `{ sessionId }` | Once at session close |
| `session:user_message` | `UserMessageContext` | Each user turn |
| `session:response` | `ResponseContext` | Each assistant response |
| `tool:before` | `ToolCallContext` | Before `execute()` |
| `tool:after` | `ToolResultContext` | After `execute()` |

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

## KaizenConfig (kaizen.json shape)

```ts
export interface KaizenConfig {
  plugins: string[];           // canonical marketplace refs "<marketplace-id>/<name>@<version>"
  extends?: string;            // harness to extend: marketplace ref or local path
  marketplaces?: MarketplaceRef[];
  [pluginName: string]: unknown;  // per-plugin config slices
}

export interface KaizenGlobalConfig {
  marketplaces?: MarketplaceRef[];
  defaultHarness?: string;
  defaults?: Record<string, unknown>;
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
