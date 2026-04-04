# Step 4 Implementation Plan: Executor-as-Plugin

Goal: refactor core to remove the LLM from bootstrap, add `registerExecutor()` +
`ctx.runtime.executor`, and ship `core-executor-anthropic` + scaffolded
`core-executor-openai`.

---

## 1. `src/types/plugin.ts`

**Add `Executor` interface** (after `LLMStreamChunk`):
```typescript
export interface Executor {
  send(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse>;
  stream(messages: Message[], tools: ToolDefinition[]): AsyncIterable<LLMStreamChunk>;
}
```

**Update `PluginContext`**:
- Add `registerExecutor(impl: Executor): void` (INITIALIZING only)
- Change `runtime.llm` → `runtime.executor: Executor`

**Update `KaizenConfig`**:
- Remove `provider: string` field (credentials owned by executor plugin now)

**Remove** `ProviderConfig`, `GlobalConfig` interfaces (move to `src/core/llm.ts` locally).

**Update `SessionContext`**:
- Remove `provider: string` field

---

## 2. New: `src/core/executor-registry.ts`

```typescript
import type { Executor } from "../types/plugin.js";
import { fatal } from "./errors.js";

export class ExecutorRegistry {
  private impl: Executor | null = null;
  private registeredBy: string | null = null;

  register(impl: Executor, pluginName: string): void {
    if (this.impl !== null) {
      fatal(`Two plugins registered an executor: '${this.registeredBy}' and '${pluginName}'. Remove one.`);
    }
    this.impl = impl;
    this.registeredBy = pluginName;
  }

  get(): Executor {
    if (!this.impl) fatal("No executor registered. Add an executor plugin to kaizen.json.");
    return this.impl;
  }

  isRegistered(): boolean { return this.impl !== null; }
}
```

---

## 3. `src/core/context.ts`

- Import `ExecutorRegistry` instead of `typeof createLLMRuntime`
- Swap `llmRuntime` param for `executorRegistry: ExecutorRegistry`
- Add `registerExecutor(impl)` method: calls `assertInitializing` + `executorRegistry.register(impl, pluginName)`
- Change `runtime.llm` → `runtime.executor` that proxies to `executorRegistry.get()`

---

## 4. `src/core/loader.ts`

- Remove `llmRuntime: ReturnType<typeof createLLMRuntime>` param from `loadPlugins`
- Add `executorRegistry: ExecutorRegistry` param
- Pass `executorRegistry` to every `createPluginContext()` call
- In `claimedKeys` (step 6 of init sequence): remove `"provider"` — it's no longer a reserved key
- Remove `import { createLLMRuntime }` line

---

## 5. `src/core/index.ts`

- Remove `import { loadGlobalConfig }` and `import { createLLMRuntime }`
- Remove `GlobalConfig` from imports
- Remove `const global = globalConfig ?? loadGlobalConfig()` and `providerConfig` lookup
- Remove `createLLMRuntime(providerConfig)` call
- Add `import { ExecutorRegistry } from "./executor-registry.js"`
- Create `const executorRegistry = new ExecutorRegistry()` and pass to `loadPlugins`
- Remove `globalConfig?: GlobalConfig` param from `bootstrap` signature

---

## 6. `src/core/config.ts`

- Remove `provider` required check from `loadKaizenConfig`
- Remove `loadGlobalConfig` function entirely
- Update `RESERVED_KEYS`: remove `"provider"` — set is now just `new Set(["plugins"])`
- Remove `GlobalConfig` from the `KaizenConfig` import (it's deleted from types)

---

## 7. `src/core/llm.ts`

- Remove `import type { ProviderConfig }` from `../types/plugin.js`
- Define `ProviderConfig` locally (it's an internal detail now, not part of the public API):
```typescript
interface ProviderConfig {
  adapter: "anthropic" | "openai" | "google" | "mistral";
  model: string;
  api_key_env?: string;
  api_key?: string;
  baseURL?: string;
}
```
- Everything else unchanged — `createLLMRuntime(config: ProviderConfig)` still works
- Executor plugins import this function via `../../src/core/llm.js`

---

## 8. New: `plugins/core-executor-anthropic/`

**`package.json`**:
```json
{
  "name": "core-executor-anthropic",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```
(ai + @ai-sdk/anthropic come from root workspace node_modules)

**`index.ts`**:
```typescript
import type { KaizenPlugin } from "../../src/types/plugin.js";
import { createLLMRuntime } from "../../src/core/llm.js";

const plugin: KaizenPlugin = {
  name: "core-executor-anthropic",
  apiVersion: "1.0.0",
  provides: ["executor"],
  depends: [],

  async setup(ctx) {
    const cfg = ctx.config as {
      model?: string;
      api_key_env?: string;
      api_key?: string;
      baseURL?: string;
    };

    if (!cfg.model) throw new Error("core-executor-anthropic: config.model is required");

    const executor = createLLMRuntime({
      adapter: "anthropic",
      model: cfg.model,
      api_key_env: cfg.api_key_env,
      api_key: cfg.api_key,
      baseURL: cfg.baseURL,
    });

    ctx.registerExecutor(executor);
  },
};

export default plugin;
```

**Register in root `package.json` dependencies** (workspace ref):
```json
"core-executor-anthropic": "workspace:*"
```

---

## 9. New: `plugins/core-executor-openai/` (scaffold)

Same structure as anthropic. `index.ts` throws `"core-executor-openai: not implemented"`.
Config shape is identical (adapter will be `"openai"`).

---

## 10. `scripts/test-core.ts`

- Remove `provider: "test"` from the config object passed to `bootstrap`
- Remove the third argument `globalConfig` from the `bootstrap` call
- Add a mock executor plugin to `builtins`:
```typescript
const mockExecutorPlugin: KaizenPlugin = {
  name: "mock-executor",
  apiVersion: "1.0.0",
  provides: ["executor"],
  depends: [],
  async setup(ctx) {
    ctx.registerExecutor({
      async send() { return { content: "mock", tool_calls: [], stop_reason: "end_turn" }; },
      async *stream() { yield { type: "done" }; },
    });
    results["executor_registered"] = true;
  },
};
```
- Add `"mock-executor"` to `plugins` array in config and to `builtins`
- Update `helloWorldPlugin` to `depends: ["executor"]`
- Add assertions: `executor_registered === true`, `ctx.runtime.executor` call works
- Call `ctx.runtime.executor.send([], [])` in `start()` and assert it returns the mock response

---

## 11. `DESIGN.md` progress table

Change Step 4 row from `🔄 In progress` to `✅ Done` with note:
`core-executor-anthropic + core-executor-openai (scaffold). registerExecutor() + ctx.runtime.executor. bun run test:core N/N.`

---

## Execution order

Each step depends on the previous type changes, so work top-to-bottom:
1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11

Steps 8 and 9 can be done in parallel with each other (independent files).
Step 10 can't start until steps 1–7 compile cleanly.
Run `bun run typecheck` after step 7 before touching the test.
