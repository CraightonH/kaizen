# Plugin Host-API Resolution — Design

**Status:** APPROVED
**Spec Date:** 2026-04-20
**Author:** Craighton Hancock + Claude

## Summary

Kaizen binaries must resolve `import "kaizen/types"` from plugin code at
runtime without relying on an external installer, a filesystem shim, or the
plugin being located near the kaizen source tree. The binary ships with
its own plugin namespace resolution — installing kaizen gives you everything
you need to load plugins, with no post-install steps.

## Motivation

Spec 4 (builtin plugins repo decoupling) moved all first-party plugins out
of the binary and into a marketplace install path
(`~/.kaizen/marketplaces/<id>/plugins/<name>@<version>/`). Plugins import
their API from `kaizen/types`. After install, bun resolves that import by
walking `node_modules/` upward from the install dir — and finds nothing,
because the compiled kaizen binary is a single executable, not a package on
disk.

Concretely: against a fresh `~/.kaizen/`, `kaizen marketplace add …` + `kaizen
install official/core-events@0.1.0` fails with:

```
Cannot find module 'kaizen/types' from
  ~/.kaizen/marketplaces/official/plugins/core-events@0.1.0/index.ts
```

Every plugin in the marketplace fails the same way. This must be fixed
before the embedding-removed release can ship.

### Non-goals

- Design-time type distribution for third-party plugin authors. Covered at
  the end as a migration follow-up, not the main fix.
- Plugin sandboxing or permission changes. Unaffected.
- Any change to `src/core/plugin-loader.ts` semantics. It still
  `await import(<abs-path>)`s a plugin entry file.

## Design

### Architecture — runtime resolver hook

At binary boot, before any plugin imports, kaizen registers a `Bun.plugin`
hook that declares `kaizen/types` as a virtual module whose exports come
from a curated host-API object:

```
 kaizen binary boots
        │
        ▼
 registerHostApi()  ──►  Bun.plugin({
                            setup(b) {
                              b.module("kaizen/types", () => ({
                                loader: "object",
                                exports: hostApi,
                              }));
                            },
                          });
        │
        ▼
 bootstrap(config) → dynamically imports each installed plugin
        │
        ▼
 Plugin does:  import { KaizenPlugin, createLLMRuntime } from "kaizen/types"
               │
               └─► bun's resolver hits the virtual-module hook
                   returns the live host-API object from the running binary
```

The plugin never touches disk for `kaizen/types`. The binary is
self-contained — no installer shim, no `~/.kaizen/node_modules/` seeding, no
drift risk. This matches the pattern VS Code uses for the `vscode` module
(and Obsidian for `obsidian`, Electron for `electron`).

### Rationale — virtual module over physical shim

Two approaches were considered:

1. **Physical shim:** installer drops `~/.kaizen/node_modules/kaizen/` with
   a types re-export. Simpler per-install code, but splits "kaizen works"
   across the binary and the installer — if an install step fails or an
   environment ships without the shim, the platform is broken in a way that
   isn't obvious until a plugin load fails. Breaks the "install kaizen, have
   a working platform" portability property.

2. **Resolver hook (chosen):** kaizen provides its own plugin namespace at
   runtime from inside the binary. Self-contained. Familiar pattern from VS
   Code. No external state to keep in sync.

### API surface — curated host-API (not `plugin.ts` mirror)

The virtual module exports come from a single curated module
(`src/host-api.ts`), not from whatever happens to be re-exported in
`src/types/plugin.ts`. This mirrors VS Code's deliberate treatment of the
`vscode` module as public API.

Adding a symbol to the plugin API = a reviewable edit to `host-api.ts`.
Changing internals doesn't accidentally leak out.

## Components

### New — `src/host-api.ts`

Single source of truth for the plugin-facing surface. Runtime values live in
an `as const` object; type-only symbols are re-exported with `export type`.

```typescript
// src/host-api.ts
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
  KaizenPlugin, KaizenConfig, PluginContext,
  ToolDefinition, ToolResult, Executor,
  UiProvider, UiChannel, AgentMessage, UserMessage,
  Message, LLMResponse, LLMStreamChunk,
  PluginPermissions, PluginCapabilities, PluginConfigDeclaration,
  SecretRef, StructuredSecretRef, SecretsContext,
  MarketplaceCatalog, MarketplaceEntry, MarketplaceRef, PluginSource,
  EventHandler, CapabilitySpec, Cardinality,
  PluginManagerPublicApi, PluginManagerLifecycleApi, PluginEntry,
} from "./types/plugin.js";

export type { CtxFs, CtxNet, CtxExec, CtxLog, CtxIo, ExecOpts, ExecResult }
  from "./core/plugin-ctx-io.js";
export type { SecretProvider } from "./core/secret-providers/types.js";
```

### New — `src/core/host-api-register.ts`

Installs the bun plugin hook. Idempotent — a second call warns and no-ops.

```typescript
import { hostApi } from "../host-api.js";
import { warn, fatal } from "./errors.js";

let registered = false;

export function registerHostApi(): void {
  if (registered) {
    warn("registerHostApi() called more than once; ignoring subsequent call");
    return;
  }
  if (typeof Bun === "undefined") {
    fatal("kaizen requires the bun runtime; Bun.plugin is unavailable");
  }
  Bun.plugin({
    name: "kaizen-host-api",
    setup(build) {
      build.module("kaizen/types", () => ({
        loader: "object",
        exports: hostApi,
      }));
    },
  });
  registered = true;
}
```

### Modified — `src/cli.ts`

Single new call at the top of the file, before any dynamic plugin import.
Must run before `bootstrap(...)`, before any `kaizen plugin dev --observe`,
and before any test-scoped plugin load path.

```typescript
import { registerHostApi } from "./core/host-api-register.js";
registerHostApi();
```

### Modified — `src/types/plugin.ts`

Shrinks to pure type declarations. Loses the runtime re-exports
(`ServiceToken`, `readStdinLine`, `SecretsProviderToken`, `createLLMRuntime`);
those now live in `host-api.ts`. Kaizen core still imports runtime symbols
from their real paths (`./core/secrets.js` etc.), not via `kaizen/types`.
Plugins continue to import from `"kaizen/types"` — code unchanged.

### Modified — `kaizen-official-plugins`

- Delete the manual `node_modules/kaizen` symlink workaround from each
  plugin's node_modules (and the root).
- Add `"kaizen": "file:../kaizen"` as a root devDependency so TypeScript
  finds types during authoring. `plugins/*` workspaces keep their
  `peerDependencies.kaizen` declaration — it's satisfied at design time by
  the root devDep and at runtime by the virtual module.

### New — `kaizen` npm package (design-time types)

Third-party plugin authors need types at TS compile time, independent of
having a kaizen checkout. Mirror VS Code's `@types/vscode` pattern: publish
`kaizen` to npm with:

- `types` / `exports["./types"]` pointing at a bundled `.d.ts` file
  generated from `src/host-api.ts`.
- A stub `main` that throws a clear error if required at runtime outside
  the host (`Error: kaizen/types is provided by the kaizen runtime; this
  module cannot be used outside a kaizen session`).
- No heavy runtime deps — publish only type declarations + the stub.

Plugin authors declare `"kaizen": "^x.y.z"` as a devDep. Published plugins
carry no runtime dep on kaizen. This can lag the rest of the migration;
first-party plugins work without it because they live in the workspace.

## Testing

Three required layers, plus one that was previously called optional but is
now part of the spec.

### Unit — `src/core/host-api-register.test.ts`

1. After `registerHostApi()`, a fresh `await import("kaizen/types")`
   returns an object whose runtime-value exports are identity-equal to
   those on `hostApi` (`mod.ServiceToken === hostApi.ServiceToken`, etc.).
2. Calling `registerHostApi()` twice emits one warn and does not throw.

Runs in-process under `bun test`. Catches regressions in the hook itself.

### Integration — `src/integration/host-api-plugin-load.test.ts`

Writes a tiny ad-hoc plugin to a temp dir (outside the kaizen source tree,
no ancestor `node_modules/kaizen/`), calls `registerHostApi()`, then loads
the plugin via the same `plugin-loader.ts` code path the binary uses.
Asserts the plugin's own `import { KaizenPlugin } from "kaizen/types"`
resolves and the plugin's default export is usable.

This is the test that would have caught the gap the current e2e test
missed — it forces resolution through the virtual module by choosing a path
where upward node_modules walks find nothing.

### E2E — rewrite `src/integration/plugins-repo-e2e.test.ts`

The current test passes only because bun resolves `kaizen/types` through
kaizen's own repo tree, not the virtual module. Replace with a version
that mirrors the real install flow:

- Fresh `KAIZEN_HOME_OVERRIDE` tmp dir.
- `addMarketplace(SIBLING, { local: true })`.
- `registerHostApi()` — same call the binary makes.
- `installPlugin(...)` for `core-events`.
- `loadPluginFromInstallDir(...)` — assert success and validate the plugin
  loaded through the virtual module.

The test must pass without the `node_modules/kaizen` symlink workaround in
the sibling repo (deleted per migration). Skips cleanly when the sibling
checkout is absent, same as today.

### Smoke — `scripts/smoke-install.sh`

A shell script that builds the binary, runs it against a fresh
`KAIZEN_HOME`, adds the official marketplace from its git URL, installs a
plugin, runs a one-shot session, and asserts no errors. This catches
divergence between `bun src/cli.ts` behavior and the compiled binary's
behavior — which is the exact gap that let the original bug reach the
previous PR.

Runs in CI on the kaizen-code repo, gates release tags. Skippable locally
via `SKIP_SMOKE=1` for development speed.

## Error Handling

| Condition | Behavior |
|---|---|
| `registerHostApi()` called twice | `warn(...)`; second call is a no-op. Bug surfaces in test output. |
| `registerHostApi()` called on non-bun runtime | `fatal(...)` — kaizen only ships as a bun binary. |
| Plugin imported before `registerHostApi()` | Bun falls through to filesystem resolution; `Cannot find module 'kaizen/types'` error. Correct failure; loud and unambiguous. |
| Plugin destructures a symbol not in `hostApi` | Standard `undefined` on the destructured binding. No special handling. |
| Plugin imports a type that isn't re-exported | TypeScript compile error at plugin build time (the virtual module is untyped at compile time; authors use the published `kaizen` npm package for types). |

## Migration Sequencing

Single branch, ordered commits. Each step keeps `bun test` and
`bun x tsc --noEmit` green.

1. **Add `src/host-api.ts`.** Nothing consumes it yet. Tests pass.
2. **Add `src/core/host-api-register.ts` + unit tests.** Still unused in
   production. Tests pass.
3. **Wire `registerHostApi()` into `src/cli.ts`.** First commit that changes
   user-visible behavior: every plugin now resolves `kaizen/types` through
   the virtual module.
4. **Trim `src/types/plugin.ts`** to pure type declarations; delete the
   runtime re-exports now that they live in `host-api.ts`. Update any
   internal kaizen consumers that relied on those re-exports to import
   from the real paths.
5. **Rewrite the e2e test, add the integration test, add the smoke
   harness.** At this point the original bug is covered by automation.
6. **Delete the `node_modules/kaizen` symlink workaround in
   `kaizen-official-plugins`.** Add the root-level devDep.
7. **(Follow-up)** Publish the `kaizen` npm package with types + stub.
   This unblocks third-party plugin authors. Can lag the rest — first-party
   plugins work without it.

**Rollback:** step 3 is the single commit that changes user-visible
behavior. Reverting that commit restores the pre-virtual-module state;
other steps are purely additive and can stay.

## Open Questions

None known. Implementation should confirm that `Bun.plugin` installed at
runtime affects subsequent `await import()` calls for dynamic plugin loads
— documented behavior, but the implementation plan should include an early
probe commit that verifies this in the target bun version before building
out the rest of the machinery.
