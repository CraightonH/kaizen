/**
 * Curated host-API surface exposed to plugins via `import "kaizen/types"`.
 *
 * Runtime values live in `hostApi` and are served by the virtual module
 * registered in `src/core/host-api-register.ts`. Type-only exports are
 * re-exported from the modules that own them and are stripped at runtime.
 *
 * Adding to the plugin API = editing this file. This file is the
 * authoritative, reviewable contract between kaizen and all plugins.
 */

import { ServiceToken } from "./core/service-registry.js";
import { readStdinLine } from "./core/stdin.js";
import { SecretsProviderToken } from "./core/secrets.js";
import { createLLMRuntime } from "./core/llm.js";
import { PLUGIN_API_VERSION } from "./types/plugin.js";

/** Runtime values exposed to plugins via `import "kaizen/types"`. */
export const hostApi = {
  ServiceToken,
  createLLMRuntime,
  readStdinLine,
  SecretsProviderToken,
  PLUGIN_API_VERSION,
} as const;

/** Type-only exports — stripped at runtime, picked up by TypeScript. */
export type {
  KaizenPlugin,
  KaizenConfig,
  KaizenGlobalConfig,
  PluginContext,
  ToolDefinition,
  ToolResult,
  Executor,
  UiProvider,
  UiChannel,
  AgentMessage,
  UserMessage,
  Message,
  MessageRole,
  ToolCall,
  LLMResponse,
  LLMStreamChunk,
  PluginPermissions,
  PluginCapabilities,
  PluginConfigDeclaration,
  PermissionTier,
  PermissionOp,
  SecretRef,
  StructuredSecretRef,
  SecretsContext,
  MarketplaceCatalog,
  MarketplaceEntry,
  MarketplacePluginEntry,
  MarketplaceHarnessEntry,
  MarketplaceRef,
  PluginSource,
  PluginVersionEntry,
  HarnessVersionEntry,
  EventHandler,
  CapabilitySpec,
  Cardinality,
  PluginManagerPublicApi,
  PluginManagerLifecycleApi,
  PluginEntry,
  JsonSchema,
} from "./types/plugin.js";

export type {
  CtxFs, CtxNet, CtxExec, CtxLog, CtxIo, ExecOpts, ExecResult,
} from "./core/plugin-ctx-io.js";

export type { SecretProvider } from "./core/secret-providers/types.js";
