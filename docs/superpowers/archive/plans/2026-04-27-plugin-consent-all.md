# `kaizen plugin consent --all` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `kaizen plugin consent --all` — a non-interactive command that bulk pre-consents every plugin declared in a harness, printing a full summary.

**Architecture:** `allowScoped` is added to `ConsentInput` so scoped plugins can be consented without prompting. A new `runPluginConsentAll` command iterates `harnessConfig.plugins`, skips local-path refs, installs+consents each marketplace plugin, collects outcomes, and prints a summary table. The CLI routes `plugin consent --all` to this new command.

**Tech Stack:** TypeScript, Bun runtime, `bun:test`

---

## File Map

| File | Change |
|------|--------|
| `src/core/consent-flow.ts` | Add `allowScoped: boolean` to `ConsentInput`; update `decideConsent` scoped branch |
| `src/core/consent-flow.test.ts` | Add two new test cases for `allowScoped` |
| `src/commands/install.ts` | Add `allowScoped?: boolean` to `UnifiedInstallArgs`; pass to `decideConsent` |
| `src/commands/plugin-consent-all.ts` | New — harness walk, per-plugin consent, summary renderer |
| `src/commands/plugin-consent-all.test.ts` | New — unit tests for `formatSummary` + `decideConsent` integration |
| `src/cli.ts` | Capture `config` from `resolveHarnessOrFatal`; detect `--all`; call `runPluginConsentAll` |

---

## Task 1: Add `allowScoped` to `ConsentInput` and `decideConsent`

**Files:**
- Modify: `src/core/consent-flow.ts`
- Modify: `src/core/consent-flow.test.ts`

- [ ] **Step 1: Write two failing tests**

Append to `src/core/consent-flow.test.ts`:

```ts
test("scoped plugin, non-interactive, allowScoped: true → accept-and-record", () => {
  const lf: PermissionsLockfile = { schemaVersion: 1, plugins: {} };
  const decision = decideConsent({
    pluginName: "p1", version: "1.0", hash: "sha256:abc",
    permissions: { tier: "scoped", env: ["KEY"] },
    lockfile: lf, interactive: false,
    allowUnscoped: false, allowScoped: true,
  });
  expect(decision.kind).toBe("accept-and-record");
});

test("scoped plugin, non-interactive, allowScoped: false → refuse (regression guard)", () => {
  const lf: PermissionsLockfile = { schemaVersion: 1, plugins: {} };
  const decision = decideConsent({
    pluginName: "p1", version: "1.0", hash: "sha256:abc",
    permissions: { tier: "scoped", env: ["KEY"] },
    lockfile: lf, interactive: false,
    allowUnscoped: false, allowScoped: false,
  });
  expect(decision.kind).toBe("refuse");
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/core/consent-flow.test.ts 2>&1 | tail -10
```

Expected: 2 failures mentioning `allowScoped` is not a known property.

- [ ] **Step 3: Add `allowScoped` to `ConsentInput` and update `decideConsent`**

In `src/core/consent-flow.ts`, update `ConsentInput`:

```ts
export interface ConsentInput {
  pluginName: string;
  version: string;
  hash: string;
  permissions: PluginPermissions;
  lockfile: PermissionsLockfile;
  interactive: boolean;
  allowUnscoped: boolean;
  allowScoped: boolean;
}
```

Update the scoped branch in `decideConsent`:

```ts
if (tier === "scoped") {
  if (input.interactive) return { kind: "prompt-scoped", entry: nowEntry };
  if (input.allowScoped) return { kind: "accept-and-record", entry: { ...nowEntry, consentMode: "flag" } };
  return { kind: "refuse", reason: `plugin '${input.pluginName}' requires SCOPED-tier consent. Run interactively, or pre-consent with: kaizen plugin consent ${input.pluginName} --harness <harness-path>` };
}
```

- [ ] **Step 4: Fix the existing `decideConsent` call in `src/commands/install.ts`**

Find the `decideConsent({...})` call (around line 70) and add `allowScoped: false`:

```ts
const decision = decideConsent({
  pluginName: resolved.entry.name,
  version, hash, permissions, lockfile,
  interactive: !args.nonInteractive && process.stdin.isTTY === true,
  allowUnscoped: args.allowUnscoped,
  allowScoped: false,
});
```

- [ ] **Step 5: Run all tests to verify they pass**

```bash
bun test src/core/consent-flow.test.ts 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 6: Run full suite to check for regressions**

```bash
bun test 2>&1 | tail -5
```

Expected: same pass count as before (394 pass, 2 skip, 0 fail).

- [ ] **Step 7: Commit**

```bash
git add src/core/consent-flow.ts src/core/consent-flow.test.ts src/commands/install.ts
git commit -m "feat(consent): add allowScoped to ConsentInput; non-interactive scoped consent path"
```

---

## Task 2: Add `allowScoped` to `UnifiedInstallArgs`

**Files:**
- Modify: `src/commands/install.ts`

- [ ] **Step 1: Add `allowScoped` to `UnifiedInstallArgs`**

```ts
export interface UnifiedInstallArgs {
  ref: string;
  lockfilePath: string;
  allowUnscoped: boolean;
  allowScoped?: boolean;
  nonInteractive: boolean;
}
```

- [ ] **Step 2: Pass it to `decideConsent` in `runUnifiedInstall`**

Update the `decideConsent` call (the one you patched in Task 1, Step 4):

```ts
const decision = decideConsent({
  pluginName: resolved.entry.name,
  version, hash, permissions, lockfile,
  interactive: !args.nonInteractive && process.stdin.isTTY === true,
  allowUnscoped: args.allowUnscoped,
  allowScoped: args.allowScoped ?? false,
});
```

- [ ] **Step 3: Run tests**

```bash
bun test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/commands/install.ts
git commit -m "feat(install): thread allowScoped through UnifiedInstallArgs"
```

---

## Task 3: Create `plugin-consent-all.ts`

**Files:**
- Create: `src/commands/plugin-consent-all.ts`
- Create: `src/commands/plugin-consent-all.test.ts`

- [ ] **Step 1: Write tests for `formatSummary`**

Create `src/commands/plugin-consent-all.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { formatSummary } from "./plugin-consent-all.js";
import type { ConsentAllOutcome } from "./plugin-consent-all.js";

describe("formatSummary", () => {
  test("renders all outcome types and correct totals", () => {
    const outcomes: ConsentAllOutcome[] = [
      { status: "consented", ref: "mkt/session-driver@1.0.0", tier: "scoped" },
      { status: "consented", ref: "mkt/ui-plugin@0.4.1",      tier: "unscoped" },
      { status: "already",   ref: "mkt/secrets@2.0.0",        tier: "trusted" },
      { status: "skipped",   ref: "./local-plugin" },
      { status: "refused",   ref: "mkt/bad-plugin@0.1.0",     reason: "hash mismatch" },
    ];
    const out = formatSummary("./kaizen.json", outcomes);
    expect(out).toContain("✓ consented");
    expect(out).toContain("○ already");
    expect(out).toContain("- skipped");
    expect(out).toContain("✗ refused");
    expect(out).toContain("hash mismatch");
    expect(out).toContain("5 plugins");
    expect(out).toContain("2 consented");
    expect(out).toContain("1 already consented");
    expect(out).toContain("1 refused");
    expect(out).toContain("1 skipped");
  });

  test("omits zero-count categories from totals line", () => {
    const outcomes: ConsentAllOutcome[] = [
      { status: "consented", ref: "mkt/plugin@1.0.0", tier: "trusted" },
    ];
    const out = formatSummary("./kaizen.json", outcomes);
    expect(out).not.toContain("refused");
    expect(out).not.toContain("skipped");
    expect(out).toContain("1 plugins: 1 consented.");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/commands/plugin-consent-all.test.ts 2>&1 | tail -5
```

Expected: fail — module not found.

- [ ] **Step 3: Create `src/commands/plugin-consent-all.ts`**

```ts
import { readFileSync } from "fs";
import { join } from "path";
import type { KaizenConfig, MarketplaceCatalog } from "../types/plugin.js";
import { parseRef, resolveRef } from "../core/ref-resolver.js";
import { loadKaizenGlobalConfig } from "../core/kaizen-config.js";
import { readCatalog } from "../core/marketplace.js";
import { installPlugin } from "../core/plugin-installer.js";
import { loadPluginFromInstallDir } from "../core/plugin-loader.js";
import { pluginInstallDir } from "../core/kaizen-config.js";
import { isInstalled } from "../core/plugin-manager.js";
import { canonicalTierGrantHash } from "../core/plugin-hash.js";
import { decideConsent } from "../core/consent-flow.js";
import { readLockfile, writeLockfile, upsertPluginEntry } from "../core/lockfile.js";

export type ConsentAllOutcome =
  | { status: "consented"; ref: string; tier: string }
  | { status: "already";   ref: string; tier: string }
  | { status: "refused";   ref: string; reason: string }
  | { status: "skipped";   ref: string };

export async function runPluginConsentAll(args: {
  harnessConfig: KaizenConfig;
  harnessJsonPath: string;
  lockfilePath: string;
}): Promise<number> {
  const outcomes: ConsentAllOutcome[] = [];
  const catalogs = await loadCatalogs();

  for (const refStr of args.harnessConfig.plugins ?? []) {
    if (refStr.startsWith("./") || refStr.startsWith("../") || refStr.startsWith("/")) {
      outcomes.push({ status: "skipped", ref: refStr });
      continue;
    }

    try {
      const parsed = parseRef(refStr);
      const resolved = resolveRef(parsed, catalogs);

      if (resolved.entry.kind === "harness") {
        outcomes.push({ status: "skipped", ref: refStr });
        continue;
      }

      const { marketplaceId, version } = resolved;
      const name = resolved.entry.name;

      if (!(await isInstalled(marketplaceId, name, version))) {
        await installPlugin(marketplaceId, name, version, resolved.pluginVersion!.source);
      }

      const dir = pluginInstallDir(marketplaceId, name, version);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
      const pkgVersion = pkg.version ?? version;
      const plugin = await loadPluginFromInstallDir(marketplaceId, name, version);
      const permissions = plugin.permissions ?? { tier: "trusted" as const };
      const hash = canonicalTierGrantHash(permissions);
      const lockfile = readLockfile(args.lockfilePath);
      const tier = permissions.tier ?? "trusted";

      const decision = decideConsent({
        pluginName: name, version: pkgVersion, hash, permissions, lockfile,
        interactive: false, allowUnscoped: true, allowScoped: true,
      });

      if (decision.kind === "accept") {
        outcomes.push({ status: "already", ref: refStr, tier });
      } else if (decision.kind === "accept-and-record") {
        writeLockfile(args.lockfilePath, upsertPluginEntry(lockfile, name, decision.entry));
        outcomes.push({ status: "consented", ref: refStr, tier });
      } else {
        outcomes.push({ status: "refused", ref: refStr, reason: decision.reason });
      }
    } catch (e) {
      outcomes.push({ status: "refused", ref: refStr, reason: (e as Error).message });
    }
  }

  console.log(formatSummary(args.harnessJsonPath, outcomes));
  return outcomes.some((o) => o.status === "refused") ? 1 : 0;
}

export function formatSummary(harnessPath: string, outcomes: ConsentAllOutcome[]): string {
  const lines: string[] = [`\nplugin consent --all  (harness: ${harnessPath})\n`];

  for (const o of outcomes) {
    if (o.status === "consented") lines.push(`  ✓ consented   ${o.ref.padEnd(45)} (${o.tier})`);
    if (o.status === "already")   lines.push(`  ○ already     ${o.ref.padEnd(45)} (${o.tier})`);
    if (o.status === "skipped")   lines.push(`  - skipped     ${o.ref}`);
    if (o.status === "refused") {
      lines.push(`  ✗ refused     ${o.ref}`);
      lines.push(`    reason: ${o.reason}`);
    }
  }

  const consented = outcomes.filter((o) => o.status === "consented").length;
  const already   = outcomes.filter((o) => o.status === "already").length;
  const refused   = outcomes.filter((o) => o.status === "refused").length;
  const skipped   = outcomes.filter((o) => o.status === "skipped").length;

  const parts = [
    consented && `${consented} consented`,
    already   && `${already} already consented`,
    refused   && `${refused} refused`,
    skipped   && `${skipped} skipped`,
  ].filter(Boolean);

  lines.push(`\n${outcomes.length} plugins: ${parts.join(", ")}.`);
  return lines.join("\n");
}

async function loadCatalogs(): Promise<Record<string, MarketplaceCatalog>> {
  const cfg = await loadKaizenGlobalConfig();
  const out: Record<string, MarketplaceCatalog> = {};
  for (const ref of cfg.marketplaces ?? []) {
    try { out[ref.id] = await readCatalog(ref.id); } catch { /* skip bad */ }
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/commands/plugin-consent-all.test.ts 2>&1 | tail -5
```

Expected: 2 pass.

- [ ] **Step 5: Run full suite**

```bash
bun test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/plugin-consent-all.ts src/commands/plugin-consent-all.test.ts
git commit -m "feat: add runPluginConsentAll command with summary output"
```

---

## Task 4: Wire `--all` into the CLI

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Capture `config` from `resolveHarnessOrFatal` in the consent handler**

In `src/cli.ts`, find the `needsHarness` block (around line 407). It currently reads:

```ts
const { kaizenJsonPath } = resolveHarnessOrFatal(harnessArg !== undefined ? { harness: harnessArg } : {});
lockfilePath = deriveLockfilePath(kaizenJsonPath);
```

Change it to also capture `config` and the resolved path:

```ts
const { kaizenJsonPath, config: resolvedHarnessConfig } = resolveHarnessOrFatal(
  harnessArg !== undefined ? { harness: harnessArg } : {},
);
lockfilePath = deriveLockfilePath(kaizenJsonPath);
```

Also declare `resolvedHarnessConfig` and `resolvedHarnessJsonPath` in the outer scope so the `--all` branch below can use them. Change the `needsHarness` block to:

```ts
let lockfilePath = "";
let resolvedHarnessConfig: import("./types/plugin.js").KaizenConfig | undefined;
let resolvedHarnessJsonPath = "";
if (needsHarness) {
  const harnessIdx = rest.indexOf("--harness");
  let harnessArg = harnessIdx !== -1 ? rest[harnessIdx + 1] : undefined;
  if (!harnessArg) {
    const globalCfg = await loadKaizenGlobalConfig();
    harnessArg = globalCfg.defaults?.harness;
  }
  if (harnessArg) {
    const { looksLikeHarnessRef, materializeHarnessRef } = await import("./core/kaizen-config.js");
    if (looksLikeHarnessRef(harnessArg)) harnessArg = await materializeHarnessRef(harnessArg);
  }
  const { kaizenJsonPath, config } = resolveHarnessOrFatal(
    harnessArg !== undefined ? { harness: harnessArg } : {},
  );
  lockfilePath = deriveLockfilePath(kaizenJsonPath);
  resolvedHarnessConfig = config;
  resolvedHarnessJsonPath = kaizenJsonPath;
}
```

- [ ] **Step 2: Add the `--all` branch in the `plugin consent` handler**

Find the block:

```ts
if (pluginSub === "consent" && name) {
```

Add `--all` detection *before* it:

```ts
if (pluginSub === "consent" && rest.includes("--all")) {
  const { runPluginConsentAll } = await import("./commands/plugin-consent-all.js");
  const code = await runPluginConsentAll({
    harnessConfig: resolvedHarnessConfig!,
    harnessJsonPath: resolvedHarnessJsonPath,
    lockfilePath,
  });
  process.exit(code);
}

if (pluginSub === "consent" && name) {
```

- [ ] **Step 3: Update help text to document `--all`**

Find the help text line `plugin {list|consent|review|audit|dev|create|validate}`. Update the Notes section added in the previous fix to include `--all`:

```
Notes:
  'plugin consent|review|audit' require a harness to locate the lockfile.
  Pass --harness after the subcommand, or set defaults.harness in
  ~/.kaizen/kaizen.json to avoid passing it every time:
    kaizen plugin consent <name> --harness ./path/to/harness.json
    kaizen plugin consent --all  --harness ./path/to/harness.json
```

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck 2>&1
```

Expected: no errors.

- [ ] **Step 5: Run full test suite**

```bash
bun test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): wire kaizen plugin consent --all to runPluginConsentAll"
```

---

## Self-Review

**Spec coverage check:**
- ✓ CLI surface: `kaizen plugin consent --all [--harness <ref>]` — Task 4
- ✓ `allowScoped` added to `ConsentInput` + `decideConsent` — Task 1
- ✓ `--all` passes `allowScoped: true, allowUnscoped: true` — Task 3
- ✓ Local-path refs skipped — Task 3
- ✓ Already-consented plugins shown as `already` — Task 3
- ✓ Summary format with ✓/○/-/✗ rows and totals line — Task 3
- ✓ Exit `0` on all consented/already, `1` on any refused — Task 3
- ✓ `--harness` resolution (flag → defaults.harness) — Task 4 (reuses existing block)
- ✓ Tests: `allowScoped` unit cases — Task 1; `formatSummary` unit tests — Task 3

**Type consistency:** `ConsentAllOutcome` defined in Task 3 and exported; imported in test — consistent. `resolvedHarnessConfig` typed as `KaizenConfig | undefined`, non-null asserted at call site where `needsHarness` guarantees it was set.

**No placeholders found.**
