/**
 * Public plugin API — the contract between kaizen core and all plugins.
 * This file is the source of truth for plugin authors.
 *
 * Versioning: PLUGIN_API_VERSION is the semver major version of this interface.
 * Core warns (but still loads) if a plugin's apiVersion major differs.
 */

export const PLUGIN_API_VERSION = "1";

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
// Event bus
// ---------------------------------------------------------------------------

export type EventHandler = (payload?: unknown) => Promise<unknown | void>;

// ---------------------------------------------------------------------------
// Plugin context — passed to setup() and start()
// ---------------------------------------------------------------------------

export interface PluginContext {
  // --- Tool registration (INITIALIZING state only) -------------------------
  registerTool(tool: ToolDefinition): void;

  // --- Event bus (INITIALIZING state only) ---------------------------------
  // All three methods throw if called after setup() returns:
  //   "Cannot register event handlers after initialization."

  /** Declare a new event type. No-op with a warning if the name is already defined. */
  defineEvent(name: string): void;

  /** Subscribe to an event. May be called for events not yet defined; core warns on first emit. */
  on(event: string, handler: EventHandler): void;

  /**
   * Fire an event. Calls ALL registered handlers serially, in initialization order.
   * Returns an array of every handler's return value (including undefined).
   * Callers inspect the array to implement short-circuit logic — emit() never short-circuits itself.
   * If a handler throws, the error is logged and execution continues with the next handler.
   */
  emit(event: string, payload?: unknown): Promise<unknown[]>;

  // --- Config and logging --------------------------------------------------

  /** Plugin-specific config slice from kaizen.json, keyed by plugin.name. */
  config: Record<string, unknown>;

  /** Structured logger — output is prefixed with the plugin name. */
  log(msg: string): void;

  // --- Runtime primitives --------------------------------------------------
  // Convention: only the lifecycle plugin should drive the session loop via these.
  // Other plugins should interact with the session through events.

  runtime: {
    llm: {
      send(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse>;
      stream(messages: Message[], tools: ToolDefinition[]): AsyncIterable<LLMStreamChunk>;
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
  };
}

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

export interface KaizenPlugin {
  /** kebab-case. Must match the config namespace key in kaizen.json. */
  name: string;

  /** semver. Core warns if major != PLUGIN_API_VERSION. */
  apiVersion: string;

  /** Capability roles this plugin fulfills (e.g. 'lifecycle', 'ui'). */
  provides?: string[];

  /**
   * Capability roles or plugin names that must be initialized before this plugin.
   * Core enforces: exactly one loaded plugin must provide each required role.
   */
  depends?: string[];

  /**
   * Called once during INITIALIZING. Register tools, define events, subscribe to events.
   * Calling registerTool, defineEvent, on, or emit after setup() returns throws.
   *
   * If this plugin provides a required role and setup() throws: fatal startup error.
   * Otherwise: error is logged, plugin is skipped, startup continues.
   */
  setup(ctx: PluginContext): Promise<void>;

  /**
   * Called by core on the lifecycle role provider after all plugins have initialized.
   * Only the plugin providing role 'lifecycle' should implement this.
   * If the lifecycle provider does not export start(): fatal error.
   */
  start?(ctx: PluginContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Config schemas
// ---------------------------------------------------------------------------

export interface KaizenConfig {
  /** References a key in ~/.kaizen/config.json */
  provider: string;
  /** npm package names, load order = array order */
  plugins: string[];
  /** Plugin config namespaces — key must match plugin.name */
  [pluginName: string]: unknown;
}

export interface ProviderConfig {
  adapter: "anthropic" | "openai" | "google" | "mistral";
  model: string;
  /** Env var name holding the API key. Omit for local/keyless providers. */
  api_key_env?: string;
  /** Literal key — prefer api_key_env. */
  api_key?: string;
  /** Override the adapter's default endpoint. Enables local LLMs (Ollama, LM Studio, etc). */
  baseURL?: string;
}

export interface GlobalConfig {
  providers: Record<string, ProviderConfig>;
}

// ---------------------------------------------------------------------------
// Default lifecycle event payload types
// Exported here so plugin authors can import them for type-safe handlers.
// These are the payloads emitted by core-lifecycle — not enforced by core itself.
// ---------------------------------------------------------------------------

export interface SessionContext {
  sessionId: string;
  provider: string;
  config: KaizenConfig;
}

export interface ToolCallContext {
  tool: string;
  args: Record<string, unknown>;
  sessionId: string;
}

export interface ResponseContext {
  content: string;
  sessionId: string;
}

export interface LoopContext {
  response: LLMResponse;
  sessionId: string;
}

/** Returned by session:loop handlers to control the session loop. */
export type LoopSignal =
  | { type: "continue"; prompt: string }
  | { type: "yield" }
  | { type: "end" };
