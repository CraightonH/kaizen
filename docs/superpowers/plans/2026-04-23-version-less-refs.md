# Version-less Harness and Plugin Refs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `@<version>` to be omitted from harness refs and plugin refs inside harness `kaizen.json` files; a version-less ref resolves to the latest in the marketplace catalog.

**Architecture:** The parser and resolver already handle version-less refs. The only code gate is in `bootstrap.ts`, which explicitly throws when `version` is absent. Removing that gate requires resolving the concrete version from the catalog first (to preserve the `isInstalled` short-circuit that prevents re-running the consent flow). Everything else is error-message and docs updates.

**Tech Stack:** TypeScript, Bun (test runner: `bun test`)

---

## Files

| File | Change |
|------|--------|
| `src/core/bootstrap.ts` | Remove version guard; add lazy catalog loading + `resolveRef` for version-less refs; update error message |
| `src/core/bootstrap.test.ts` | Add two tests for version-less plugin refs |
| `src/cli.ts` | Update 3 format strings |
| `src/core/config.ts` | Update 3 error messages |
| `src/core/plugin-manager.ts` | Update 1 comment, 1 error message |
| `src/types/plugin.ts` | Update 1 JSDoc comment |
| `docs/concepts/harnesses.md` | Update 4 ref format mentions |
| `docs/guides/marketplace-authoring.md` | Update 2 ref format mentions |

---

## Task 1: Write failing tests for version-less plugin refs

**Files:**
- Modify: `src/core/bootstrap.test.ts`

The existing test fixture already has a `demo` plugin at `1.0.0` in a local git-backed marketplace. A version-less ref `m/demo` will resolve to `1.0.0` from that catalog.

- [ ] **Step 1: Add the two new tests after the existing ones in `bootstrap.test.ts`**

Open `src/core/bootstrap.test.ts`. After the `"--trust-lockfile + --non-interactive fails fast..."` test (line 61), add:

```ts
  it("version-less ref resolves to latest and installs", async () => {
    const lockfilePath = join(home, "permissions.lock");
    const report = await bootstrapMissingPlugins(
      { plugins: ["m/demo"], marketplaces: [{ id: "m", url: upstream }] },
      { lockfilePath, trustLockfile: false, nonInteractive: true, allowUnscoped: true },
    );
    expect(report.pluginsInstalled).toContain("m/demo");
    expect(existsSync(pluginInstallDir("m", "demo", "1.0.0"))).toBe(true);
  });

  it("version-less ref skips reinstall when already installed", async () => {
    await addMarketplace(upstream, { id: "m", local: true });
    const lockfilePath = join(home, "permissions.lock");
    // First run installs it.
    await bootstrapMissingPlugins(
      { plugins: ["m/demo"], marketplaces: [] },
      { lockfilePath, trustLockfile: false, nonInteractive: true, allowUnscoped: true },
    );
    // Second run should not add to pluginsInstalled.
    const report = await bootstrapMissingPlugins(
      { plugins: ["m/demo"], marketplaces: [] },
      { lockfilePath, trustLockfile: false, nonInteractive: true, allowUnscoped: true },
    );
    expect(report.pluginsInstalled).toHaveLength(0);
  });
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
bun test src/core/bootstrap.test.ts
```

Expected: the two new tests fail with `harness plugin ref 'm/demo' must include an explicit version`.

---

## Task 2: Remove version guard and add lazy catalog resolution

**Files:**
- Modify: `src/core/bootstrap.ts`

The goal: when `version` is `undefined`, resolve it from the catalog before the `isInstalled` check.

- [ ] **Step 1: Add `readCatalog` and `resolveRef` imports and `MarketplaceCatalog` type**

At the top of `src/core/bootstrap.ts`, update the imports:

```ts
import type { KaizenConfig, MarketplaceRef, MarketplaceCatalog } from "../types/plugin.js";
import { loadKaizenGlobalConfig } from "./kaizen-config.js";
import { addMarketplace, readCatalog } from "./marketplace.js";
import { parseRef, resolveRef } from "./ref-resolver.js";
import { readLockfile } from "./lockfile.js";
import { runUnifiedInstall } from "../commands/install.js";
import { isInstalled } from "./plugin-manager.js";
```

- [ ] **Step 2: Replace the version guard block with lazy catalog resolution**

In `src/core/bootstrap.ts`, replace everything from the opening of the plugin loop (`// 2. Install missing plugins.`) through to (but not including) the `if (await isInstalled(...))` line with the following. The full replacement for lines 46–75:

```ts
  // 2. Install missing plugins.
  const lockfile = readLockfile(opts.lockfilePath);
  let catalogs: Record<string, MarketplaceCatalog> | undefined;

  for (const refStr of harness.plugins ?? []) {
    const parsed = parseRef(refStr);

    if (parsed.kind === "shorthand") {
      throw new Error(
        `harness plugin ref '${refStr}' is shorthand. ` +
        `Harness plugin refs must be canonical '<marketplace>/<name>[@<version>]'.`,
      );
    }

    let marketplaceId: string;
    let name: string;
    let version: string | undefined;
    if (parsed.kind === "marketplace") {
      marketplaceId = parsed.marketplaceId;
      name = parsed.name;
      version = parsed.version;
    } else {
      // legacy-npm
      marketplaceId = "official";
      name = parsed.name.replace(/^kaizen-plugin-/, "");
      version = undefined;
    }

    // Version-less ref: resolve against the catalog to get the concrete version
    // so we can use the isInstalled short-circuit below.
    if (!version) {
      if (!catalogs) {
        catalogs = {};
        const cfg = await loadKaizenGlobalConfig();
        for (const m of cfg.marketplaces ?? []) {
          try { catalogs[m.id] = await readCatalog(m.id); } catch { /* skip bad */ }
        }
      }
      version = resolveRef(parsed, catalogs).version;
    }

    if (await isInstalled(marketplaceId, name, version)) continue;
```

The rest of the function (trust-lockfile block, `runUnifiedInstall` call, report push) remains unchanged.

- [ ] **Step 3: Run the tests**

```bash
bun test src/core/bootstrap.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 4: Run the full test suite to check for regressions**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/bootstrap.ts src/core/bootstrap.test.ts
git commit -m "feat: allow version-less plugin refs in harness kaizen.json (#49)"
```

---

## Task 3: Update error messages in source files

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/plugin-manager.ts`
- Modify: `src/types/plugin.ts`

Change every `<marketplace>/<name>@<version>` format string (where `@<version>` is presented as required) to `<marketplace>/<name>[@<version>]`. These are strings that reach users as error messages, help text, or log output.

- [ ] **Step 1: Update `src/cli.ts` — 3 occurrences**

Line 100 (help text `--harness` flag description):
```
  --harness <ref>                       harness ref (marketplace/name[@version])
```

Line 517 (plugin list error):
```
      `  Install a plugin:   kaizen install <marketplace>/<name>[@<version>]\n` +
```

Line 518 (plugin list error):
```
      `  Uninstall a plugin: kaizen uninstall <marketplace>/<name>[@<version>]`,
```

Line 602 (URL harness fatal):
```
  fatal("raw URL harnesses are not supported — publish the harness in a marketplace and use --harness <id>/<name>[@<version>]");
```

- [ ] **Step 2: Update `src/core/config.ts` — 3 occurrences**

Line 65 (URL harness fatal):
```
      `Publish the harness in a marketplace and reference it as '<marketplace>/<name>[@<version>]'.`,
```

Line 71 (install hint in fatal):
```
    `  Marketplace:    kaizen install <marketplace>/${nameOrPath}[@<version>]\n` +
```

Line 131 (harness not found hint — this is the `resolveHarness` fatal):
```
      `  kaizen --harness <marketplace>/<name>[@<version>]\n` +
```

- [ ] **Step 3: Update `src/core/plugin-manager.ts` — 2 occurrences**

Line 139 (comment):
```
  // Canonical marketplace ref: "<id>/<name>[@<version>]" → marketplace install dir.
```

Line 160 (error message install hint):
```
    `  Install from marketplace: kaizen install <marketplace>/${name}[@<version>]\n` +
```

- [ ] **Step 4: Update `src/types/plugin.ts` — 1 occurrence**

Line 239 (JSDoc):
```
  /** Canonical refs (`<marketplace>/<name>[@<version>]`) or legacy bare npm names. */
```

- [ ] **Step 5: Run tests to verify nothing broke**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/core/config.ts src/core/plugin-manager.ts src/types/plugin.ts
git commit -m "fix: update ref format strings to show @version as optional (#49)"
```

---

## Task 4: Update documentation

**Files:**
- Modify: `docs/concepts/harnesses.md`
- Modify: `docs/guides/marketplace-authoring.md`

- [ ] **Step 1: Update `docs/concepts/harnesses.md`**

Line 22 — change:
```
The ref format is `<marketplace-id>/<name>@<version>`. kaizen materializes the
```
to:
```
The ref format is `<marketplace-id>/<name>[@<version>]`. kaizen materializes the
```

Line 56 — change:
```
(`<marketplace-id>/<name>@<version>`), either via `--harness` or via `extends`.
```
to:
```
(`<marketplace-id>/<name>[@<version>]`), either via `--harness` or via `extends`.
```

Line 102 — change:
```
Plugin entries must be full marketplace refs (`<marketplace>/<name>@<version>`)
```
to:
```
Plugin entries must be marketplace refs (`<marketplace>/<name>[@<version>]`)
```

Line 116 — change:
```
kaizen --harness <your-marketplace-id>/<harness-name>@<version>
```
to:
```
kaizen --harness <your-marketplace-id>/<harness-name>[@<version>]
```

- [ ] **Step 2: Update `docs/guides/marketplace-authoring.md`**

Line 19 — change:
```
When a user runs `kaizen install <marketplace-id>/<plugin>@<version>`, kaizen
```
to:
```
When a user runs `kaizen install <marketplace-id>/<plugin>[@<version>]`, kaizen
```

Line 111 — change:
```
`<marketplace>/<name>@<version>` form — bare names are rejected.
```
to:
```
`<marketplace>/<name>[@<version>]` form — bare names are rejected.
```

- [ ] **Step 3: Commit**

```bash
git add docs/concepts/harnesses.md docs/guides/marketplace-authoring.md
git commit -m "docs: update ref format to show @version as optional (#49)"
```

---

## Self-Review Notes

- Spec: harness refs already work — confirmed, no code change needed there. ✓
- Spec: plugin refs inside harness blocked by version guard — covered in Task 2. ✓
- Spec: shorthand still rejected — preserved and message updated. ✓
- Spec: auto-install (silent) — existing `runUnifiedInstall` path handles this. ✓
- Spec: no new auto-update behavior — no marketplace TTL changes. ✓
- Spec: lockfile unchanged — no lockfile changes in any task. ✓
- Spec: docs + ~10 error message locations — Tasks 3 and 4 cover all listed locations. ✓
- Type consistency: `MarketplaceCatalog` imported from `../types/plugin.js` in Task 2, used as `Record<string, MarketplaceCatalog>` — matches the same pattern as `install.ts`. ✓
- `resolveRef` imported already in bootstrap via `parseRef` import — need to add it explicitly (Task 2 step 1 does this). ✓
