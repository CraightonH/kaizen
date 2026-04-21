# Remove `builtins` plugin-injection seam

Tracks: [issue #25](https://github.com/CraightonH/kaizen/issues/25)

## Goal

Delete the `builtins: Record<string, KaizenPlugin>` parameter that is threaded through the plugin system purely as a test injection seam. The shipping CLI always passes `{}` — no real user can reach it. Its only live consumer is `src/core/integration/driver-capability-resolution.test.ts`. Replace that consumer with real fixtures installed from the existing `tests/fixtures/ci-marketplace` local marketplace, so the tests exercise the production resolution path.

## Why

- `builtins` makes `KaizenConfig.plugins` look like it accepts "bare builtin names," which is no longer true after #20 removed npm install.
- The seam lets tests short-circuit `resolvePlugin`, meaning the unit they cover no longer goes through the production loader.
- Deleting it simplifies the public and internal surface (`PluginManager`, `initializePluginSystem`, `runHarness`, `bootstrap`, `cmdPluginList`, `runPluginDevObserve`) and removes a ~30-LOC thread.

## Scope

### Production code — deletions only

Remove the `builtins` parameter and all references to it in:

- `src/core/plugin-manager.ts`
  - `PluginManager` constructor signature: drop `builtins: Builtins`.
  - `resolvePlugin`: drop `builtins` arg and the `if (builtins[name]) return …` short-circuit at line 138–139.
  - Call sites inside `PluginManager` that pass `this.builtins` (lines 343, 450).
  - Delete the `Builtins` type alias if it becomes unused.
- `src/core/index.ts`
  - `initializePluginSystem`, `runHarness`, `bootstrap`: drop `builtins: Builtins = {}` param and all forwarding.
- `src/commands/manage.ts`
  - `cmdPluginList(builtins)`: drop param; drop the `builtins` check in `statusFor`.
- `src/commands/plugin-dev.ts`
  - `runPluginDevObserve`: drop `builtins` from args.
- `src/cli.ts`
  - Delete `const builtins: Record<string, KaizenPlugin> = {}` (line 29).
  - Update all four call sites (`runPluginDevObserve`, `cmdPluginList`, `initializePluginSystem`, `bootstrap`) to stop passing it.
  - Remove the `KaizenPlugin` import if it becomes unused.

Compiler will drive the last mile — any straggler is a type error.

### Test code — rewrite `driver-capability-resolution.test.ts`

The current file (`src/core/integration/driver-capability-resolution.test.ts`, 100 LOC) has **2 tests** (the issue says six; outdated):

1. "resolves a provider by name via CapabilityRegistry when one plugin provides it"
2. "fails initialization when a cardinality-one capability has two providers"

Both build inline `KaizenPlugin` objects and pass them via `builtins`. Replace with real marketplace-installed fixture plugins.

#### New fixture plugins under `tests/fixtures/ci-marketplace/plugins/`

Each is a minimal `.mjs` + `package.json`, registered in `tests/fixtures/ci-marketplace/.kaizen/marketplace.json` at version `1.0.0`.

| Plugin | Role | `defineCapability` | `provides` | `consumes` | `lifecycle` |
|---|---|---|---|---|---|
| `cap-provider` | For test 1 | `cap:thing` (cardinality `one`) | `cap:thing` | — | false |
| `cap-driver` | For test 1 | — | — | `cap:thing` | true |
| `cap-owner` | For test 2 | `conflict:thing` (cardinality `one`) | — | — | false |
| `cap-dup-a` | For test 2 | — | `conflict:thing` | — | false |
| `cap-dup-b` | For test 2 | — | `conflict:thing` | — | false |
| `cap-driver-conflict` | For test 2 | — | — | `conflict:thing` | true |

Each plugin file is ~10 lines; the full set is ~60 LOC of fixtures. They are dedicated to capability-resolution tests and stay separate from the existing `fixture-*` plugins (which serve core orchestration tests) to keep each fixture single-purpose.

#### Test harness rewrite

Replace the inline `makeHarness(builtins, refs)` with a helper that goes through the full production install path:

```ts
// Per-test setup:
// 1. mkdtemp KAIZEN_HOME_OVERRIDE
// 2. addMarketplace(absolutePathToCiMarketplace, { id: "ci-marketplace", local: true })
// 3. For each fixture plugin needed:
//      await runUnifiedInstall({
//        ref: `ci-marketplace/<name>@1.0.0`,
//        lockfilePath, allowUnscoped: false, nonInteractive: true,
//      });
// 4. Build KaizenConfig with plugins: ["ci-marketplace/<name>@1.0.0", ...]
// 5. Construct PluginManager without `builtins`
// 6. await manager.initialize()
```

Cleanup: `rmSync(home, …)` and `delete process.env.KAIZEN_HOME_OVERRIDE` in `afterEach`, mirroring `tests/integration/marketplace.integration.test.ts`.

The helper lives inline in the test file (or in a small local file beside it) — no need to generalize prematurely. Two tests is a small surface.

#### Audit other test files

Grep for `builtins` across the test tree; the production-code removals will cause compile failures in any stragglers. Expected hits: only `driver-capability-resolution.test.ts`. Anything else gets the same treatment (marketplace fixture) or gets the param simply removed if it was passing `{}`.

## Out of scope

- `.kaizen/harnesses/` and `~/.kaizen/harnesses/` authored-harness dirs stay.
- No changes to `runUnifiedInstall`, marketplace loader, or capability registry semantics.
- No new generic "test plugin factory" abstraction — two tests does not warrant one.

## Risk

Low. Pure refactor; the compiler enforces completeness of the production-code deletions. The only real cost is the fixture authoring and test rewrite. Install-path overhead per test (~one `addMarketplace` symlink + two or four `runUnifiedInstall` calls) adds seconds, not minutes, and exercises the real resolver — which is the whole point of choosing full-fidelity over the copy-helper shortcut.

## Estimated effort

1–2 hours, matching the issue's estimate.
