/**
 * Public plugin API — the contract between kaizen core and all plugins.
 * This file is the source of truth for plugin authors.
 *
 * Versioning: PLUGIN_API_VERSION is the semver major version of this interface.
 * Core warns (but still loads) if a plugin's apiVersion major differs.
 *
 * Note: canonical event payload types (SessionContext, ToolCallContext, etc.)
 * live in the `core-events` plugin, not here. Import them from `core-events`.
 */

export const PLUGIN_API_VERSION = "2";

import { ServiceToken } from "../core/service-registry.js";
export { ServiceToken };

export type { CtxFs, CtxNet, CtxSecrets, CtxExec, CtxLog, CtxIo, ExecOpts, ExecResult } from "../core/plugin-ctx-io.js";

// ---------------------------------------------------------------------------
// JSON Schema (subset used for tool parameter definitions)
// ---------------------------------------------------------------------------

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: unknown[];
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Plugin configuration
// ---------------------------------------------------------------------------

export interface PluginConfigDeclaration {
  schema?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  secrets?: string[];
}

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

// ---------------------------------------------------------------------------
// LLM primitives
// ---------------------------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  /** Present on role=tool messages — identifies which tool call this is the result of. */
  tool_call_id?: string;
  /** Present on role=assistant messages when the LLM requested tool calls. */
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  tool_calls: ToolCall[];
  /** Raw stop reason from the provider (e.g. "end_turn", "tool_use"). */
  stop_reason: string;
}

export interface LLMStreamChunk {
  type: "text" | "tool_call" | "done";
  text?: string;
  tool_call?: Partial<ToolCall>;
}

export interface Executor {
  send(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse>;
  stream(messages: Message[], tools: ToolDefinition[]): AsyncIterable<LLMStreamChunk>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolResult {
  ok: boolean;
  /** Human-readable output. Sent to LLM when data is absent. */
  output?: string;
  /**
   * Structured output (JSON). Sent to LLM instead of output when both present.
   * output is then for human display only.
   */
  data?: unknown;
  /** Error message. Sent to LLM when ok=false. */
  error?: string;
  /** For subprocess-based tools. Informational only. */
  exit_code?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  /**
   * If true, core prints the call and prompts for confirmation before executing,
   * unless the session was started with --allow-destructive.
   */
  destructive?: boolean;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// UI channel — typed message transport between agent and user
// ---------------------------------------------------------------------------

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
  /** Block until the user sends a message. Throws if the channel is closed. */
  receive(): Promise<UserMessage>;
  /** Send a message to the user. */
  send(msg: AgentMessage): Promise<void>;
  /** Cleanly close the channel from the agent side. */
  close(): Promise<void>;
}

export interface UiProvider {
  /**
   * Yields one UiChannel per session.
   * Terminal: yields one channel then stops.
   * Web: yields a new channel per incoming connection, indefinitely.
   */
  accept(): AsyncIterable<UiChannel>;
}

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

export type EventHandler = (payload?: unknown) => Promise<unknown | void>;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type Cardinality = "one" | "many";

export interface CapabilitySpec {
  /** "one": exactly one provider required when consumed. "many": any count, including zero. */
  cardinality: Cardinality;
  /** Optional JSON schema validated against provider registrations. */
  schema?: JsonSchema;
  /** Optional semver string — future-proofing; currently informational only. */
  version?: string;
  /** Human-readable; shown by `kaizen capability show`. */
  description: string;
}

export interface PluginCapabilities {
  provides?: string[];
  consumes?: string[];
}

// ---------------------------------------------------------------------------
// Plugin context — passed to setup() and start()
// ---------------------------------------------------------------------------

export interface PluginContext {
  // --- Service registry ----------------------------------------------------

  /** Register a typed service. Only valid during INITIALIZING (setup()). */
  registerService<T>(token: ServiceToken<T>, impl: T): void;

  /** Retrieve a typed service. Valid at any lifecycle state. Throws if not registered. */
  getService<T>(token: ServiceToken<T>): T;

  // --- Tool registration (INITIALIZING state only) -------------------------
  registerTool(tool: ToolDefinition): void;

  // --- Executor registration (INITIALIZING state only) ---------------------
  /** Register the executor implementation. Exactly one plugin must call this. */
  registerExecutor(impl: Executor): void;

  // --- UI registration (INITIALIZING state only) ---------------------------
  /** Register the UI provider. Exactly one plugin must call this. */
  registerUi(impl: UiProvider): void;

  // --- Capability registry (INITIALIZING state only) -----------------------
  /** Declare a capability. Name must be prefixed with the calling plugin's name. */
  defineCapability(name: string, spec: CapabilitySpec): void;

  // --- Event bus -----------------------------------------------------------

  /** Declare a new event type. Advisory only — suppresses "unknown event" warnings. */
  defineEvent(name: string): void;

  /** Subscribe to an event. */
  on(event: string, handler: EventHandler): void;

  /**
   * Fire an event. Calls ALL registered handlers serially, in initialization order.
   * Returns an array of every handler's return value (including undefined).
   * If a handler throws, the error is logged and execution continues with the next handler.
   * Emitting an undefined event warns but never blocks.
   */
  emit(event: string, payload?: unknown): Promise<unknown[]>;

  // --- Config and logging --------------------------------------------------

  /** Plugin-specific config slice from kaizen.json, keyed by plugin.name. */
  config: Record<string, unknown>;

  /** Structured logger — output is prefixed with the plugin name. */
  log(msg: string): void;

  /** Access plugin loading/unloading at runtime. */
  pluginManager: PluginManagerPublicApi;

  // --- Permission-gated I/O surface ----------------------------------------
  fs: import("../core/plugin-ctx-io.js").CtxFs;
  net: import("../core/plugin-ctx-io.js").CtxNet;
  secrets: SecretsContext;
  exec: import("../core/plugin-ctx-io.js").CtxExec;

  // --- Runtime primitives --------------------------------------------------

  runtime: {
    /** All registered executors; routing mechanism deferred. */
    executors: {
      list(): Executor[];
      getFirst(): Executor;
    };
    /** First-registered executor — preserved for back-compat. Deprecated once routing lands. */
    executor: Executor;
    /** All registered UI providers, in registration order. */
    ui: {
      list(): UiProvider[];
      getFirst(): UiProvider;
    };
    tools: {
      /** Returns all registered tools at the time of the call. */
      list(): ToolDefinition[];
      /**
       * Execute a tool by name. Core validates args against the tool's JSON Schema
       * before calling execute(). If validation fails, returns { ok: false, error: ... }
       * without calling execute(). If execute() throws, core wraps it as { ok: false, error }.
       */
      execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
    };
    /** Call drainPendingReloads() between turns. Required for hot-reload support. */
    pluginManager: PluginManagerLifecycleApi;
  };
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type PermissionTier = "trusted" | "scoped" | "unscoped";

export interface PluginPermissions {
  /** Default: "trusted". TRUSTED = no external I/O; SCOPED = declared grants; UNSCOPED = full access. */
  tier?: PermissionTier;

  fs?: {
    /** Glob patterns. Relative paths resolve from workspace root. */
    read?: string[];
    write?: string[];
  };

  net?: {
    /** host:port allowlist. "*" means any host, any port. "*.example.com:443" ok. */
    connect?: string[];
  };

  /** Allowed environment variable names. */
  env?: string[];

  exec?: {
    /** Binary name allowlist. No argv-pattern allowlisting in v1. */
    binaries?: string[];
  };

  events?: {
    /** Cross-plugin event subscription patterns, e.g. ["core-lifecycle:tool:before"]. */
    subscribe?: string[];
  };
}

/** Operation passed to PermissionEnforcer.check(). */
export type PermissionOp =
  | { kind: "fs.read";  path: string }
  | { kind: "fs.write"; path: string }
  | { kind: "net.connect"; host: string; port: number }
  | { kind: "env.get";  name: string }
  | { kind: "exec.run"; binary: string }
  | { kind: "events.subscribe"; event: string }
  | { kind: "import";   module: string };

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

export interface KaizenPlugin {
  /** kebab-case. Must match the config namespace key in kaizen.json. */
  name: string;

  /** semver. Core warns if major != PLUGIN_API_VERSION. */
  apiVersion: string;

  /** What this plugin provides and consumes in the capability registry. */
  capabilities?: PluginCapabilities;

  /**
   * Map short or alternative capability names to canonical owner-qualified names.
   * Resolved when reading the `capabilities` lists above.
   * e.g. { "ui.input": "core-lifecycle:ui.input" }
   */
  aliases?: Record<string, string>;

  /** Permission manifest. Defaults to { tier: "trusted" }. */
  permissions?: PluginPermissions;

  config?: PluginConfigDeclaration;

  setup(ctx: PluginContext): Promise<void>;
  start?(ctx: PluginContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export interface KaizenConfig {
  /** Canonical refs (`<marketplace>/<name>@<version>`) or legacy bare npm names. */
  plugins: string[];
  /**
   * Name of a built-in or installed harness to extend.
   * The harness provides the base plugin stack; this config overlays it.
   * Built-ins: 'core-debug', 'core-anthropic'. Third-party: 'kaizen-harness-<name>'.
   */
  extends?: string;
  /** Informational marketplaces a harness expects; consumed by --harness bootstrap. */
  marketplaces?: MarketplaceRef[];
  [pluginName: string]: unknown;
}

// ---------------------------------------------------------------------------
// Plugin Manager API
// ---------------------------------------------------------------------------

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
  drainPendingReloads(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Marketplace types (Spec 1)
// ---------------------------------------------------------------------------

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
  /** Path to harness JSON, relative to marketplace repo root. */
  path: string;
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
  signature?: string;              // reserved; unused in v1
  entries: MarketplaceEntry[];
}

export interface MarketplaceRef {
  id: string;
  url: string;                     // git URL or absolute local dir
  updatedAt?: string;              // ISO-8601
}

export interface KaizenGlobalConfig {
  marketplaces?: MarketplaceRef[];
  defaultHarness?: string;
  defaults?: Record<string, unknown>;   // Spec 2 uses this
  /** Seconds between background marketplace refreshes; 0 disables. Default 900. */
  marketplaceUpdateTTL?: number;
}
