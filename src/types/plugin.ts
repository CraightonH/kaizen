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

export const PLUGIN_API_VERSION = "3";


export type { CtxFs, CtxNet, CtxExec, CtxIo, ExecOpts, ExecResult } from "../core/plugin-ctx-io.js";
export type { SecretProvider } from "../core/secret-providers/types.js";

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
// Event bus
// ---------------------------------------------------------------------------

export type EventHandler = (payload?: unknown) => Promise<unknown | void>;

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface ServiceSpec {
  /** Optional JSON schema validated against provider payloads (informational in v1). */
  schema?: JsonSchema;
  /** Optional semver string — future-proofing; currently informational only. */
  version?: string;
  /** Human-readable; shown by `kaizen service show`. */
  description: string;
}

export interface PluginServices {
  provides?: string[];
  consumes?: string[];
}

// ---------------------------------------------------------------------------
// Plugin context — passed to setup() and start()
// ---------------------------------------------------------------------------

/**
 * Raw metadata about the harness a plugin is loaded under. Both fields are
 * individually optional. See `PluginContext.harness` for usage and absence
 * scenarios.
 */
export interface HarnessIdentity {
  /** Absolute path to the resolved harness JSON, if bootstrapped from a file. */
  jsonPath?: string;
  /** The ref the user passed (`--harness <ref>` or `defaults.harness`), if any. */
  ref?: string;
}

export interface PluginContext {
  /**
   * Raw metadata about the harness this plugin was loaded under. Both inner
   * fields may be absent (e.g. programmatic `runHarness()` without a file on
   * disk, or `kaizen` invoked from a directory containing `kaizen.json` with
   * no `--harness` ref). Kaizen does not derive a canonical `name`. Plugins
   * that need a stable namespacing key derive one from these inputs themselves
   * — typically by preferring `jsonPath` over `ref` and falling back to a
   * literal default when both are absent.
   */
  harness: HarnessIdentity;

  // --- Service registry ----------------------------------------------------

  /** Declare a service. Only valid during INITIALIZING (setup()). Service names are global; redefining a name another plugin already defined throws. Convention is `<owner>:<service>`, but any unique non-empty token (no whitespace) is accepted. */
  defineService(name: string, spec: ServiceSpec): void;

  /** Provide an implementation for a previously-defined service. Only valid during INITIALIZING. */
  provideService<T>(name: string, impl: T): void;

  /** Declare intent to consume a service. Only valid during INITIALIZING. */
  consumeService(name: string): void;

  /** Retrieve the provided implementation. Valid only after INITIALIZING. Throws if no provider. */
  useService<T>(name: string): T;

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
    /** Cross-plugin event subscription patterns, e.g. ["core-driver:tool:before"]. */
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

  /**
   * True if this plugin drives the session loop. Core calls start() on the
   * one plugin with driver=true after bootstrap. Exactly one loaded
   * plugin must declare this; zero or two+ is a fatal startup error.
   */
  driver?: boolean;

  /** What services this plugin provides and consumes. */
  services?: PluginServices;

  /**
   * Map short or alternative service names to canonical owner-qualified names.
   * Resolved when reading the `services` lists above.
   * e.g. { "ui.input": "core-driver:ui.input" }
   */
  aliases?: Record<string, string>;

  /** Permission manifest. Defaults to { tier: "trusted" }. */
  permissions?: PluginPermissions;

  config?: PluginConfigDeclaration;

  setup(ctx: PluginContext): Promise<void>;
  start?(ctx: PluginContext): Promise<void>;
  /**
   * Optional `RUNNING`-phase wiring hook. Called once per loaded plugin in
   * topological order after every `setup()` resolves and before
   * `driver.start()` is invoked. `useService()` is legal here; setup-only
   * APIs (`on`, `defineService`, `provideService`, `consumeService`,
   * `defineEvent`) are not. Throwing is fatal.
   *
   * Use this for non-driver plugins that need to call `useService()` against
   * a peer's service. The driver's `start()` retains its "session loop"
   * meaning and is unaffected.
   */
  onReady?(ctx: PluginContext): Promise<void> | void;
  /**
   * Called during unload, before events/services/permissions are deregistered.
   * Use to close resources opened in setup() or start() (readline interfaces,
   * network listeners, timers, file watchers). Errors are logged but do not
   * prevent deregistration.
   */
  stop?(ctx: PluginContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export interface KaizenConfig {
  /** Canonical refs (`<marketplace>/<name>[@<version>]`) or legacy bare npm names. */
  plugins: string[];
  /**
   * Name of a built-in or installed harness to extend.
   * The harness provides the base plugin stack; this config overlays it.
   * Built-ins: 'core-debug', 'core-anthropic'. Third-party: 'kaizen-harness-<name>'.
   */
  extends?: string;
  /** Informational marketplaces a harness expects; consumed by --harness bootstrap. */
  marketplaces?: MarketplaceRef[];
  /**
   * Per-harness env allow-list. Same syntax as KaizenDefaults.env_allowlist.
   * If present, takes precedence over the user-level value at runtime.
   */
  env_allowlist?: string[];
  [pluginName: string]: unknown;
}

// ---------------------------------------------------------------------------
// Plugin Manager API
// ---------------------------------------------------------------------------

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

export interface KaizenDefaults {
  /** Harness ref used when --harness is not passed on the CLI. */
  harness?: string;
  /** Per-plugin config overrides. Keyed by plugin name. Values are plugin-specific objects. */
  plugin_config?: Record<string, Record<string, unknown>>;
  /**
   * Env vars that bypass tier-based env.get gating, regardless of plugin tier.
   * Entries are exact names ("PATH") or trailing-* prefixes ("LC_*").
   * If absent, the built-in DEFAULT_ENV_ALLOWLIST is used. An explicit []
   * means "no allow-list; gate everything."
   */
  env_allowlist?: string[];
}

export interface KaizenGlobalConfig {
  marketplaces?: MarketplaceRef[];
  /** User-chosen defaults: default harness + per-plugin config overrides. */
  defaults?: KaizenDefaults;
  /** Seconds between background marketplace refreshes; 0 disables. Default 900. */
  marketplaceUpdateTTL?: number;
}
