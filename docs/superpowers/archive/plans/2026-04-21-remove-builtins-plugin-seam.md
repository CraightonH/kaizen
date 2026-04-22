# Remove `builtins` Plugin-Injection Seam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the `builtins: Record<string, KaizenPlugin>` parameter that is threaded through the plugin system as a test-only injection seam, and rewrite its only live consumer (`driver-capability-resolution.test.ts`) to use real fixtures installed from the existing local `ci-marketplace`.

**Architecture:** Two workstreams. (1) Test-first: add new `cap-*` fixture plugins to `tests/fixtures/ci-marketplace/`, then rewrite `driver-capability-resolution.test.ts` to install them via `addMarketplace` + `runUnifiedInstall` (full-fidelity) before the old seam is removed — so the test exercises the real production path. (2) After the rewritten test is green, delete `builtins` from all production signatures in one compiler-enforced pass.

**Tech Stack:** TypeScript, Bun test runner, existing `tests/fixtures/ci-marketplace` local marketplace (symlinked via `addMarketplace({ local: true })`).

**Spec:** `docs/superpowers/specs/2026-04-21-remove-builtins-plugin-seam-design.md`

**Issue:** https://github.com/CraightonH/kaizen/issues/25

---

## File Structure

**New fixture plugins** (under `tests/fixtures/ci-marketplace/plugins/`):
- `cap-provider/{package.json,index.mjs}` — defines + provides `cap:thing` (cardinality one)
- `cap-driver/{package.json,index.mjs}` — lifecycle plugin, consumes `cap:thing`
- `cap-owner/{package.json,index.mjs}` — defines `conflict:thing` (cardinality one)
- `cap-dup-a/{package.json,index.mjs}` — provides `conflict:thing`
- `cap-dup-b/{package.json,index.mjs}` — provides `conflict:thing`
- `cap-driver-conflict/{package.json,index.mjs}` — lifecycle plugin, consumes `conflict:thing`

**Modified files:**
- `tests/fixtures/ci-marketplace/.kaizen/marketplace.json` — append 6 new entries
- `src/core/integration/driver-capability-resolution.test.ts` — full rewrite (inline install helper)
- `src/core/plugin-manager.ts` — drop `Builtins` type + `builtins` param from ctor and `resolvePlugin`
- `src/core/index.ts` — drop `builtins` from `initializePluginSystem`, `runHarness`, `bootstrap`; drop `Builtins` re-export
- `src/commands/manage.ts` — drop `builtins` param from `cmdPluginList` and `statusFor`
- `src/commands/plugin-dev.ts` — drop `builtins` from `runPluginDevObserve` args
- `src/cli.ts` — delete `const builtins = {}` (line 29) and all four pass-sites; remove `KaizenPlugin` import if unused

---

## Task 1: Add `cap-*` fixture plugins to ci-marketplace

**Files:**
- Create: `tests/fixtures/ci-marketplace/plugins/cap-provider/package.json`
- Create: `tests/fixtures/ci-marketplace/plugins/cap-provider/index.mjs`
- Create: `tests/fixtures/ci-marketplace/plugins/cap-driver/package.json`
- Create: `tests/fixtures/ci-marketplace/plugins/cap-driver/index.mjs`
- Create: `tests/fixtures/ci-marketplace/plugins/cap-owner/package.json`
- Create: `tests/fixtures/ci-marketplace/plugins/cap-owner/index.mjs`
- Create: `tests/fixtures/ci-marketplace/plugins/cap-dup-a/package.json`
- Create: `tests/fixtures/ci-marketplace/plugins/cap-dup-a/index.mjs`
- Create: `tests/fixtures/ci-marketplace/plugins/cap-dup-b/package.json`
- Create: `tests/fixtures/ci-marketplace/plugins/cap-dup-b/index.mjs`
- Create: `tests/fixtures/ci-marketplace/plugins/cap-driver-conflict/package.json`
- Create: `tests/fixtures/ci-marketplace/plugins/cap-driver-conflict/index.mjs`
- Modify: `tests/fixtures/ci-marketplace/.kaizen/marketplace.json`

- [ ] **Step 1: Create `cap-provider` plugin**

`tests/fixtures/ci-marketplace/plugins/cap-provider/package.json`:
```json
{
  "name": "cap-provider",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs"
}
```

`tests/fixtures/ci-marketplace/plugins/cap-provider/index.mjs`:
```js
export default {
  name: "cap-provider",
  apiVersion: "2",
  capabilities: { provides: ["cap:thing"] },
  async setup(ctx) {
    ctx.defineCapability("cap:thing", { cardinality: "one", description: "test" });
  },
};
```

- [ ] **Step 2: Create `cap-driver` plugin**

`tests/fixtures/ci-marketplace/plugins/cap-driver/package.json`:
```json
{
  "name": "cap-driver",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs"
}
```

`tests/fixtures/ci-marketplace/plugins/cap-driver/index.mjs`:
```js
export default {
  name: "cap-driver",
  apiVersion: "2",
  lifecycle: true,
  capabilities: { consumes: ["cap:thing"] },
  async setup() {},
  async start() {},
};
```

- [ ] **Step 3: Create `cap-owner` plugin**

`tests/fixtures/ci-marketplace/plugins/cap-owner/package.json`:
```json
{
  "name": "cap-owner",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs"
}
```

`tests/fixtures/ci-marketplace/plugins/cap-owner/index.mjs`:
```js
export default {
  name: "cap-owner",
  apiVersion: "2",
  async setup(ctx) {
    ctx.defineCapability("conflict:thing", { cardinality: "one", description: "test" });
  },
};
```

- [ ] **Step 4: Create `cap-dup-a` plugin**

`tests/fixtures/ci-marketplace/plugins/cap-dup-a/package.json`:
```json
{
  "name": "cap-dup-a",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs"
}
```

`tests/fixtures/ci-marketplace/plugins/cap-dup-a/index.mjs`:
```js
export default {
  name: "cap-dup-a",
  apiVersion: "2",
  capabilities: { provides: ["conflict:thing"] },
  async setup() {},
};
```

- [ ] **Step 5: Create `cap-dup-b` plugin**

`tests/fixtures/ci-marketplace/plugins/cap-dup-b/package.json`:
```json
{
  "name": "cap-dup-b",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs"
}
```

`tests/fixtures/ci-marketplace/plugins/cap-dup-b/index.mjs`:
```js
export default {
  name: "cap-dup-b",
  apiVersion: "2",
  capabilities: { provides: ["conflict:thing"] },
  async setup() {},
};
```

- [ ] **Step 6: Create `cap-driver-conflict` plugin**

`tests/fixtures/ci-marketplace/plugins/cap-driver-conflict/package.json`:
```json
{
  "name": "cap-driver-conflict",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs"
}
```

`tests/fixtures/ci-marketplace/plugins/cap-driver-conflict/index.mjs`:
```js
export default {
  name: "cap-driver-conflict",
  apiVersion: "2",
  lifecycle: true,
  capabilities: { consumes: ["conflict:thing"] },
  async setup() {},
  async start() {},
};
```

- [ ] **Step 7: Append new entries to marketplace catalog**

Modify `tests/fixtures/ci-marketplace/.kaizen/marketplace.json`. Append these six entries to the existing `entries` array (after `fixture-lifecycle`, preserving JSON array syntax — add a trailing comma after the prior last entry):

```json
    {
      "kind": "plugin",
      "name": "cap-provider",
      "description": "Capability-resolution test fixture: defines and provides cap:thing.",
      "versions": [
        { "version": "1.0.0", "source": { "type": "file", "path": "plugins/cap-provider" } }
      ]
    },
    {
      "kind": "plugin",
      "name": "cap-driver",
      "description": "Capability-resolution test fixture: lifecycle driver consuming cap:thing.",
      "versions": [
        { "version": "1.0.0", "source": { "type": "file", "path": "plugins/cap-driver" } }
      ]
    },
    {
      "kind": "plugin",
      "name": "cap-owner",
      "description": "Capability-resolution test fixture: defines conflict:thing.",
      "versions": [
        { "version": "1.0.0", "source": { "type": "file", "path": "plugins/cap-owner" } }
      ]
    },
    {
      "kind": "plugin",
      "name": "cap-dup-a",
      "description": "Capability-resolution test fixture: provides conflict:thing.",
      "versions": [
        { "version": "1.0.0", "source": { "type": "file", "path": "plugins/cap-dup-a" } }
      ]
    },
    {
      "kind": "plugin",
      "name": "cap-dup-b",
      "description": "Capability-resolution test fixture: provides conflict:thing.",
      "versions": [
        { "version": "1.0.0", "source": { "type": "file", "path": "plugins/cap-dup-b" } }
      ]
    },
    {
      "kind": "plugin",
      "name": "cap-driver-conflict",
      "description": "Capability-resolution test fixture: lifecycle driver consuming conflict:thing.",
      "versions": [
        { "version": "1.0.0", "source": { "type": "file", "path": "plugins/cap-driver-conflict" } }
      ]
    }
```

- [ ] **Step 8: Verify marketplace JSON parses**

Run: `bun -e 'JSON.parse(require("fs").readFileSync("tests/fixtures/ci-marketplace/.kaizen/marketplace.json","utf8")); console.log("ok")'`

Expected output: `ok`

- [ ] **Step 9: Commit**

```bash
git add tests/fixtures/ci-marketplace/
git commit -m "test(fixtures): add cap-* plugins to ci-marketplace for capability-resolution tests"
```

---

## Task 2: Rewrite `driver-capability-resolution.test.ts` to use installed fixtures

**Note:** This task does NOT yet remove `builtins` from `PluginManager`. The rewritten test still calls the current constructor passing `{}` for `builtins` (since the param is still there). After Task 2 is green, Task 3 removes the param and this call-site gets updated inline with the compiler failure.

**Files:**
- Modify: `src/core/integration/driver-capability-resolution.test.ts` (full rewrite, ~100 → ~140 LOC)

- [ ] **Step 1: Replace the test file**

Overwrite `src/core/integration/driver-capability-resolution.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { PluginManager } from "../plugin-manager.js";
import { EventBus } from "../event-bus.js";
import { ServiceRegistry } from "../service-registry.js";
import { CapabilityRegistry } from "../capability-registry.js";
import { PermissionEnforcer } from "../permission-enforcer.js";
import { AuditLog } from "../audit-log.js";
import { addMarketplace } from "../marketplace.js";
import { runUnifiedInstall } from "../../commands/install.js";
import type { KaizenConfig } from "../../types/plugin.js";

const CI_MARKETPLACE = resolve(__dirname, "../../../tests/fixtures/ci-marketplace");
const MARKETPLACE_ID = "ci-marketplace";

async function installFixtures(names: string[], lockfilePath: string): Promise<void> {
  await addMarketplace(CI_MARKETPLACE, { id: MARKETPLACE_ID, local: true });
  for (const name of names) {
    const code = await runUnifiedInstall({
      ref: `${MARKETPLACE_ID}/${name}@1.0.0`,
      lockfilePath,
      allowUnscoped: false,
      nonInteractive: true,
    });
    if (code !== 0) throw new Error(`install failed for ${name} (code ${code})`);
  }
}

function makeHarness(pluginRefs: string[], lockfilePath: string) {
  const eventBus = new EventBus();
  const capabilityRegistry = new CapabilityRegistry();
  const serviceRegistry = new ServiceRegistry();
  const enforcer = new PermissionEnforcer({ mode: "log-only" });
  const auditLog = new AuditLog({
    rootDir: mkdtempSync(join(tmpdir(), "kz-driver-cap-audit-")),
    sessionId: "test",
    enabled: false,
  });
  const options = { trustLockfile: false, allowUnscoped: false, nonInteractive: true };
  const config: KaizenConfig = { plugins: pluginRefs };

  const manager = new PluginManager(
    config, {},
    eventBus, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, options,
  );
  return { manager, capabilityRegistry };
}

describe("driver capability resolution (post-registry-refactor)", () => {
  let home: string;
  let lockfilePath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kz-driver-cap-home-"));
    process.env.KAIZEN_HOME_OVERRIDE = home;
    lockfilePath = join(mkdtempSync(join(tmpdir(), "kz-driver-cap-lock-")), "kaizen.permissions.lock");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.KAIZEN_HOME_OVERRIDE;
  });

  it("resolves a provider by name via CapabilityRegistry when one plugin provides it", async () => {
    await installFixtures(["cap-provider", "cap-driver"], lockfilePath);

    const { manager, capabilityRegistry } = makeHarness(
      [`${MARKETPLACE_ID}/cap-provider@1.0.0`, `${MARKETPLACE_ID}/cap-driver@1.0.0`],
      lockfilePath,
    );

    await manager.initialize();
    expect(capabilityRegistry.providersOf("cap:thing")).toContain("cap-provider");
  });

  it("fails initialization when a cardinality-one capability has two providers", async () => {
    await installFixtures(
      ["cap-owner", "cap-dup-a", "cap-dup-b", "cap-driver-conflict"],
      lockfilePath,
    );

    const { manager } = makeHarness(
      [
        `${MARKETPLACE_ID}/cap-owner@1.0.0`,
        `${MARKETPLACE_ID}/cap-dup-a@1.0.0`,
        `${MARKETPLACE_ID}/cap-dup-b@1.0.0`,
        `${MARKETPLACE_ID}/cap-driver-conflict@1.0.0`,
      ],
      lockfilePath,
    );

    await expect(manager.initialize()).rejects.toThrow(/Multiple plugins provide/);
  });
});
```

- [ ] **Step 2: Run the rewritten test**

Run: `bun test src/core/integration/driver-capability-resolution.test.ts`

Expected: both tests PASS. If they fail, investigate before proceeding — the rewrite must be green before removing `builtins`.

- [ ] **Step 3: Run the full test suite**

Run: `bun test`

Expected: all tests PASS (no regressions introduced by the marketplace additions).

- [ ] **Step 4: Commit**

```bash
git add src/core/integration/driver-capability-resolution.test.ts
git commit -m "test(integration): install driver-capability fixtures via runUnifiedInstall"
```

---

## Task 3: Remove `builtins` parameter from production code

**Files:**
- Modify: `src/core/plugin-manager.ts`
- Modify: `src/core/index.ts`
- Modify: `src/commands/manage.ts`
- Modify: `src/commands/plugin-dev.ts`
- Modify: `src/cli.ts`
- Modify: `src/core/integration/driver-capability-resolution.test.ts` (drop `{}` positional arg from ctor call)

- [ ] **Step 1: Remove `builtins` from `src/core/plugin-manager.ts`**

Three edits in `src/core/plugin-manager.ts`:

(a) Delete the `Builtins` type alias (line 59):
```ts
export type Builtins = Record<string, KaizenPlugin>;
```
Remove this line entirely. The `KaizenPlugin` import may become unused if not referenced elsewhere in the file — remove it from the import if so (compiler will flag unused imports).

(b) In `resolvePlugin` (line 138), change:
```ts
async function resolvePlugin(name: string, builtins: Builtins): Promise<LoadedPlugin | null> {
  if (builtins[name]) return { plugin: builtins[name]!, resolvedPath: null };

  const isPath = name.startsWith("./") || name.startsWith("/") || name.startsWith("../");
```
to:
```ts
async function resolvePlugin(name: string): Promise<LoadedPlugin | null> {
  const isPath = name.startsWith("./") || name.startsWith("/") || name.startsWith("../");
```

(c) In `PluginManager` constructor (line 262), delete the `private readonly builtins: Builtins,` line so the signature becomes:
```ts
  constructor(
    private readonly config: KaizenConfig,
    private readonly eventBus: EventBus,
    private readonly capabilityRegistry: CapabilityRegistry,
    private readonly serviceRegistry: ServiceRegistry,
    private readonly enforcer: PermissionEnforcer,
    private readonly auditLog: AuditLog,
    private readonly lockfilePath: string,
    private readonly options: { trustLockfile: boolean; allowUnscoped: boolean; nonInteractive: boolean },
    private readonly globalConfig?: KaizenGlobalConfig,
  ) {
```

(d) Update both call sites of `resolvePlugin`:
- Line 343: `const loaded = await resolvePlugin(String(name), this.builtins);` → `const loaded = await resolvePlugin(String(name));`
- Line 450: `const loaded = await resolvePlugin(name, this.builtins);` → `const loaded = await resolvePlugin(name);`

- [ ] **Step 2: Remove `builtins` from `src/core/index.ts`**

Edits in `src/core/index.ts`:

(a) Line 7: Change `import { PluginManager, type Builtins } from "./plugin-manager.js";` → `import { PluginManager } from "./plugin-manager.js";`

(b) Line 21: Delete the re-export line `export type { Builtins } from "./plugin-manager.js";`

(c) `initializePluginSystem` (lines 34-67): Remove the `builtins` parameter and the positional arg in the `PluginManager` ctor call:
```ts
export async function initializePluginSystem(
  kaizenConfig: KaizenConfig,
  injectedEnforcer?: PermissionEnforcer,
): Promise<InitializedSystem> {
  // ... unchanged body until PluginManager construction ...
  const manager = new PluginManager(
    kaizenConfig,
    eventBus, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, { trustLockfile, allowUnscoped, nonInteractive },
  );
```

(d) `RunHarnessOpts` interface (line 75): Remove the `builtins?: Builtins;` line.

(e) `runHarness` (line 81): Change to:
```ts
export async function runHarness(opts: RunHarnessOpts): Promise<void> {
  const { kaizenConfig, enforcer: injectedEnforcer } = opts;
  const {
    manager, eventBus, capabilityRegistry, serviceRegistry, enforcer, auditLog, lifecycleProvider,
  } = await initializePluginSystem(kaizenConfig, injectedEnforcer);
```

(f) `bootstrap` (line 110):
```ts
export async function bootstrap(kaizenConfig: KaizenConfig): Promise<void> {
  return runHarness({ kaizenConfig });
}
```

- [ ] **Step 3: Remove `builtins` from `src/commands/manage.ts`**

(a) In `statusFor` (line 43), change:
```ts
function statusFor(
  name: string,
  builtins: Record<string, KaizenPlugin>,
): InstallStatus {
  if (Object.prototype.hasOwnProperty.call(builtins, name)) {
    return { status: "built-in", version: "" };
  }

  try {
```
to:
```ts
function statusFor(name: string): InstallStatus {
  try {
```

(b) Remove the `InstallStatus` status variant `"built-in"` if it exists only to serve this branch. Check the type definition — if `status: "built-in" | "installed" | "NOT INSTALLED"` has three variants, drop `"built-in"`.

(c) In `cmdPluginList` (line 69), change:
```ts
export function cmdPluginList(builtins: Record<string, KaizenPlugin>): void {
```
to:
```ts
export function cmdPluginList(): void {
```

(d) Line 82: change `const s = statusFor(name, builtins);` → `const s = statusFor(name);`

(e) Line 84: Remove the `s.status === "built-in" ? "built-in" :` branch in the label ternary (if variant was dropped in (b)):
```ts
    const label =
      s.status === "NOT INSTALLED" ? (s.version ? `NOT INSTALLED (${s.version})` : "NOT INSTALLED")
      : s.version;
```

(f) Remove the `KaizenPlugin` import at the top of the file if it is now unused.

- [ ] **Step 4: Remove `builtins` from `src/commands/plugin-dev.ts`**

In `src/commands/plugin-dev.ts`:

(a) Line 11: Delete the import `import type { Builtins } from "../core/plugin-manager.js";`

(b) Line 14: Change `runPluginDevObserve` args:
```ts
export async function runPluginDevObserve(args: {
  pluginName: string;
  pluginDir: string;
  outDir: string;
  kaizenConfig: KaizenConfig;
}): Promise<number> {
```

(c) Line 46: change `await runHarness({ kaizenConfig: args.kaizenConfig, builtins: args.builtins, enforcer });` → `await runHarness({ kaizenConfig: args.kaizenConfig, enforcer });`

- [ ] **Step 5: Remove `builtins` from `src/cli.ts`**

In `src/cli.ts`:

(a) Line 29: Delete `const builtins: Record<string, KaizenPlugin> = {};`

(b) Line 21: Delete `import type { KaizenPlugin } from "./types/plugin.js";` if the type is no longer used anywhere in this file. (Search the file; if unused, remove.)

(c) Line 326: Change `await runPluginDevObserve({ pluginName, pluginDir, outDir, kaizenConfig: devConfig, builtins });` → `await runPluginDevObserve({ pluginName, pluginDir, outDir, kaizenConfig: devConfig });`

(d) Line 364: Change `cmdPluginList(builtins);` → `cmdPluginList();`

(e) Line 391: Change `const { capabilityRegistry } = await initializePluginSystem(cfg, builtins);` → `const { capabilityRegistry } = await initializePluginSystem(cfg);`

(f) Line 529: Change `await bootstrap(kaizenConfig, builtins);` → `await bootstrap(kaizenConfig);`

- [ ] **Step 6: Update the integration test's `PluginManager` construction**

In `src/core/integration/driver-capability-resolution.test.ts`, in `makeHarness`, remove the now-invalid second positional arg. Change:
```ts
  const manager = new PluginManager(
    config, {},
    eventBus, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, options,
  );
```
to:
```ts
  const manager = new PluginManager(
    config,
    eventBus, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, options,
  );
```

- [ ] **Step 7: Compile check**

Run: `bun run tsc --noEmit` (or the project's typecheck script — run `cat package.json | grep -E '"(typecheck|check|tsc)"'` to find it if unsure).

Expected: zero type errors. If any appear, they are stragglers passing `builtins` somewhere this plan missed — fix them inline by dropping the param (or the positional arg) at the indicated line.

- [ ] **Step 8: Run the full test suite**

Run: `bun test`

Expected: all tests PASS. If `driver-capability-resolution.test.ts` fails on the constructor-arg change, re-check Step 6.

- [ ] **Step 9: Grep for any leftover `builtins` references**

Run: `rg -n '\bbuiltins\b' src/ tests/ 2>/dev/null`

Expected: no matches in source or test code. (Matches in `docs/` or `node_modules/` are fine — docs get updated in the next task.)

If any remain in `src/` or `tests/`, remove them and re-run tests.

- [ ] **Step 10: Commit**

```bash
git add -A src/ tests/
git commit -m "refactor(core): remove builtins plugin-injection seam (#25)"
```

---

## Task 4: Update docs

**Files:**
- Modify: any doc that references `builtins` as a `KaizenConfig.plugins` concept or as a parameter.

- [ ] **Step 1: Find docs mentioning `builtins`**

Run: `rg -n '\bbuiltins\b' docs/ 2>/dev/null`

- [ ] **Step 2: Update or remove references**

For each match: if the doc describes `builtins` as a config-reachable concept ("bare builtin plugin names"), delete that text. If it describes `builtins` as a param of `PluginManager`/`initializePluginSystem`/`runHarness`/`bootstrap`, update the signature in the doc to reflect the new form. Do not add a migration/changelog note unless a CHANGELOG.md or release notes file already exists — this is an internal refactor.

If no matches exist, skip to Step 3.

- [ ] **Step 3: Run `kaizen:update-docs` skill check**

The project CLAUDE.md mandates running `kaizen:update-docs` before shipping any behavior/API-surface change. Invoke it now via the Skill tool and act on its output.

- [ ] **Step 4: Commit (if any doc changes)**

```bash
git add docs/
git commit -m "docs: drop builtins references after plugin-injection seam removal"
```

If no doc changes were needed, skip this step.

---

## Task 5: Final verification

- [ ] **Step 1: Full test suite**

Run: `bun test`

Expected: all PASS.

- [ ] **Step 2: Typecheck**

Run: `bun run tsc --noEmit` (or the project's typecheck script).

Expected: clean.

- [ ] **Step 3: Lint (if configured)**

Run: `cat package.json | grep -E '"(lint|check)"'` to find a lint script, then run it. If no lint script, skip.

- [ ] **Step 4: Final grep**

Run: `rg -n '\bbuiltins\b' src/ tests/ 2>/dev/null`

Expected: no output.

- [ ] **Step 5: Branch ready**

Report to the user:
- Confirm all three verifications (tests, typecheck, grep) passed.
- Mention that `superpowers:finishing-a-development-branch` is the next step (per project CLAUDE.md).
