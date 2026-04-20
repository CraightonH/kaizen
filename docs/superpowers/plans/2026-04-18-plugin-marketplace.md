# Plugin Marketplace, Kaizen-Level Config & Install Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement federated git-backed marketplaces, marketplace-scoped plugin refs,
a unified install tree under `~/.kaizen/marketplaces/<id>/`, portable harness
bootstrap, and a unified `kaizen install|uninstall|update|marketplace` CLI surface.
After this plan, `kaizen marketplace add <git-url>` registers a catalog,
`kaizen install official/timestamps@1.2.3` installs from it by absolute path (no
`node_modules` for third-party plugins), and `kaizen --harness <file|ref>`
auto-bootstraps missing marketplaces + plugins.

**Spec:** `docs/superpowers/specs/2026-04-18-plugin-marketplace-design.md`

**Architecture:** New `src/core/kaizen-config.ts` owns the whole `~/.kaizen/` tree
(paths + global config I/O). `src/core/marketplace.ts` owns git clone/pull +
catalog read/validate. `src/core/ref-resolver.ts` parses/resolves refs.
`src/core/plugin-installer.ts` materializes plugin bits into
`marketplaces/<id>/plugins/<name>@<ver>/`. `src/core/plugin-loader.ts` imports
marketplace plugins by absolute path. `src/core/bootstrap.ts` closes the loop
for `--harness`.

**Tech Stack:** TypeScript, Bun, Node `child_process` (`git`), Bun `$` shell,
existing `src/core/` infrastructure (lockfile, consent-flow, plugin-hash).

**Prerequisites:** None — this is the first-domino spec; Specs 2–4 depend on it.

---

## File Structure

**New files:**

- `src/core/kaizen-config.ts` — path helpers, `ensureKaizenHome()`,
  load/save of `~/.kaizen/kaizen.json`
- `src/core/kaizen-config.test.ts`
- `src/core/marketplace.ts` — `addMarketplace`, `pullMarketplace`,
  `readCatalog`, `validateCatalog`, background refresh helpers
- `src/core/marketplace.test.ts`
- `src/core/ref-resolver.ts` — `parseRef`, `resolveRef`
- `src/core/ref-resolver.test.ts`
- `src/core/plugin-installer.ts` — materializes plugin bits; dispatches by
  source type (`npm` / `tarball` / `file`); also installs harnesses
- `src/core/plugin-installer.test.ts`
- `src/core/plugin-loader.ts` — `loadPluginFromInstallDir` (absolute-path import)
- `src/core/plugin-loader.test.ts`
- `src/core/bootstrap.ts` — `bootstrapMissingPlugins`
- `src/core/bootstrap.test.ts`
- `src/commands/marketplace.ts` — `add|list|remove|update|browse`
- `src/commands/uninstall.ts`
- `src/commands/update.ts`
- `tests/integration/marketplace.integration.test.ts` — end-to-end with a
  real local git repo fixture

**Modified files:**

- `src/types/plugin.ts` — add marketplace/catalog/ref/global-config types;
  extend `KaizenConfig` harness schema with optional `marketplaces`
- `src/core/config.ts` — retire direct `KAIZEN_HOME*` use where superseded by
  `kaizen-config.ts`; keep `loadHarnessConfig` but route home-harness lookup
  through new path helper `harnessInstallDir`
- `src/core/plugin-hash.ts` — add `canonicalTierGrantHash(permissions, tier)`
- `src/core/plugin-manager.ts` — add `isInstalled(marketplaceId, name, version)`;
  include marketplace install dirs in the plugin import resolution path
- `src/commands/install.ts` — rework to unified `runUnifiedInstall(ref, opts)`
- `src/commands/manage.ts` — deprecation shims on `cmdPluginInstall` /
  `cmdPluginRemove`; legacy `kaizen-plugin-*` auto-resolves against `official`
- `src/cli.ts` — wire `marketplace`, `uninstall`, `update`; extend `--harness`
  to accept file-path or marketplace-ref (reject raw URLs); add
  `--trust-lockfile` and `--non-interactive`; background refresh on first invocation

---

## Conventions used throughout this plan

- **Commit cadence:** each task ends with a single commit. Commit message format:
  `feat(marketplace): <what>` or `test(marketplace): <what>` — no Co-Authored-By.
- **TDD:** write the failing test first, run it, write minimal code to pass,
  run again, commit. Plan steps below enforce this explicitly.
- **Imports:** all path math goes through `kaizen-config.ts` after Task 2 —
  never hardcode `~/.kaizen/...` or concatenate `"/plugins/"` manually.
- **Git subprocess:** use `Bun.spawn` (or the existing pattern used in
  `src/core/plugin-manager.ts` for `bun pm ls --global`) with a 60s timeout.
- **Fixtures:** tests that need a real marketplace create a temp-dir git repo
  with `git init -q && git add . && git commit -qm init`. Use `Bun.$`:
  ```ts
  import { $ } from "bun";
  await $`git init -q`.cwd(dir);
  await $`git add .`.cwd(dir);
  await $`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(dir);
  ```

---

## Phase 1 — Types, Global Config, Hash Helper

### Task 1: Marketplace / catalog / ref / global-config types

**Files:**
- Modify: `src/types/plugin.ts`

- [ ] **Step 1: Write failing test `src/types/plugin.test.ts`**

Create the file (new) that just type-checks usage of the new types. Kaizen
has no existing `plugin.test.ts`; this acts as a compile-time fixture.

```ts
import { describe, it, expect } from "bun:test";
import type {
  PluginSource, MarketplaceEntry, MarketplaceCatalog,
  MarketplaceRef, KaizenGlobalConfig, KaizenConfig,
} from "./plugin.js";

describe("marketplace types", () => {
  it("accepts a catalog with plugin + harness entries", () => {
    const cat: MarketplaceCatalog = {
      version: "1.0.0",
      name: "Official",
      url: "https://github.com/kaizen-sh/kaizen-plugins.git",
      entries: [
        {
          kind: "plugin",
          name: "timestamps",
          description: "time tools",
          versions: [{ version: "1.2.3", source: { type: "file", path: "plugins/timestamps" } }],
        },
        {
          kind: "harness",
          name: "anthropic-default",
          description: "default harness",
          versions: [{ version: "1.0.0", path: "harnesses/anthropic.json" }],
        },
      ],
    };
    expect(cat.entries.length).toBe(2);
  });

  it("accepts a global config with marketplaces", () => {
    const g: KaizenGlobalConfig = {
      marketplaces: [{ id: "official", url: "https://…", updatedAt: "2026-04-18T00:00:00Z" }],
      marketplaceUpdateTTL: 900,
    };
    expect(g.marketplaces?.[0]?.id).toBe("official");
  });

  it("accepts a harness config with marketplaces slice", () => {
    const h: KaizenConfig = {
      plugins: ["official/timestamps@1.2.3"],
      marketplaces: [{ id: "official", url: "https://…" }],
    };
    expect(h.plugins.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test — expect compile failures**

Run: `bun test src/types/plugin.test.ts`
Expected: type errors for `PluginSource`, `MarketplaceEntry`, `MarketplaceCatalog`,
`MarketplaceRef`, `KaizenGlobalConfig`, and `KaizenConfig.marketplaces`.

- [ ] **Step 3: Add types to `src/types/plugin.ts`**

Append at the bottom of the file (after `PluginManagerLifecycleApi`):

```ts
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
```

- [ ] **Step 4: Extend `KaizenConfig` (harness file type)**

Edit `src/types/plugin.ts` `KaizenConfig`:

```ts
export interface KaizenConfig {
  /** Canonical refs (`<marketplace>/<name>@<version>`) or legacy bare npm names. */
  plugins: string[];
  extends?: string;
  /** Informational marketplaces a harness expects; consumed by --harness bootstrap. */
  marketplaces?: MarketplaceRef[];
  [pluginName: string]: unknown;
}
```

- [ ] **Step 5: Run the test — verify pass**

Run: `bun test src/types/plugin.test.ts`
Expected: PASS.

- [ ] **Step 6: Run project typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS (no regressions). If new type usage in existing code breaks,
**do not fix cascading code yet** — note the file and address in the task that
owns it (paths in config.ts, plugin-manager, etc.).

- [ ] **Step 7: Commit**

```bash
git add src/types/plugin.ts src/types/plugin.test.ts
git commit -m "feat(marketplace): add catalog, ref, global-config, source types"
```

---

### Task 2: `src/core/kaizen-config.ts` — owns `~/.kaizen/` tree

**Files:**
- Create: `src/core/kaizen-config.ts`
- Create: `src/core/kaizen-config.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/core/kaizen-config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  kaizenHome, marketplacesDir, marketplaceDir, marketplaceRepoDir,
  pluginInstallDir, harnessInstallDir,
  ensureKaizenHome, loadKaizenGlobalConfig, saveKaizenGlobalConfig,
} from "./kaizen-config.js";

let home: string;
let origHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  origHome = process.env.KAIZEN_HOME_OVERRIDE;
  process.env.KAIZEN_HOME_OVERRIDE = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.KAIZEN_HOME_OVERRIDE;
  else process.env.KAIZEN_HOME_OVERRIDE = origHome;
});

describe("kaizen-config path helpers", () => {
  it("returns KAIZEN_HOME_OVERRIDE when set", () => {
    expect(kaizenHome()).toBe(home);
    expect(marketplacesDir()).toBe(join(home, "marketplaces"));
    expect(marketplaceDir("official")).toBe(join(home, "marketplaces", "official"));
    expect(marketplaceRepoDir("official")).toBe(join(home, "marketplaces", "official", "repo"));
    expect(pluginInstallDir("official", "timestamps", "1.2.3"))
      .toBe(join(home, "marketplaces", "official", "plugins", "timestamps@1.2.3"));
    expect(harnessInstallDir("official", "anthropic-default"))
      .toBe(join(home, "marketplaces", "official", "harnesses", "anthropic-default"));
  });
});

describe("ensureKaizenHome", () => {
  it("creates kaizen home and marketplaces dir, idempotent", async () => {
    await ensureKaizenHome();
    await ensureKaizenHome();
    expect(existsSync(join(home, "marketplaces"))).toBe(true);
  });
});

describe("load/saveKaizenGlobalConfig", () => {
  it("returns {} when file absent", async () => {
    const cfg = await loadKaizenGlobalConfig();
    expect(cfg).toEqual({});
  });

  it("round-trips a config atomically", async () => {
    await saveKaizenGlobalConfig({
      marketplaces: [{ id: "official", url: "https://x/y.git" }],
      marketplaceUpdateTTL: 900,
    });
    const cfg = await loadKaizenGlobalConfig();
    expect(cfg.marketplaces?.[0]?.id).toBe("official");
    expect(cfg.marketplaceUpdateTTL).toBe(900);
  });

  it("atomic write: no partial file if writer crashes mid-write", async () => {
    await saveKaizenGlobalConfig({ marketplaces: [] });
    const txt = readFileSync(join(home, "kaizen.json"), "utf8");
    expect(() => JSON.parse(txt)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `bun test src/core/kaizen-config.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/core/kaizen-config.ts`**

```ts
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import type { KaizenGlobalConfig } from "../types/plugin.js";

/** Test hook: KAIZEN_HOME_OVERRIDE redirects `~/.kaizen` for a single process. */
export function kaizenHome(): string {
  return process.env.KAIZEN_HOME_OVERRIDE ?? join(homedir(), ".kaizen");
}

export function kaizenHomeConfigPath(): string {
  return join(kaizenHome(), "kaizen.json");
}

export function marketplacesDir(): string {
  return join(kaizenHome(), "marketplaces");
}

export function marketplaceDir(id: string): string {
  return join(marketplacesDir(), id);
}

export function marketplaceRepoDir(id: string): string {
  return join(marketplaceDir(id), "repo");
}

export function pluginInstallDir(id: string, name: string, version: string): string {
  return join(marketplaceDir(id), "plugins", `${name}@${version}`);
}

export function harnessInstallDir(id: string, name: string): string {
  return join(marketplaceDir(id), "harnesses", name);
}

export async function ensureKaizenHome(): Promise<void> {
  mkdirSync(marketplacesDir(), { recursive: true });
}

export async function loadKaizenGlobalConfig(): Promise<KaizenGlobalConfig> {
  const path = kaizenHomeConfigPath();
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object.`);
  }
  return parsed as KaizenGlobalConfig;
}

/** Atomic: write to `kaizen.json.tmp` then rename. */
export async function saveKaizenGlobalConfig(cfg: KaizenGlobalConfig): Promise<void> {
  await ensureKaizenHome();
  const path = kaizenHomeConfigPath();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test src/core/kaizen-config.test.ts`
Expected: PASS all cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/kaizen-config.ts src/core/kaizen-config.test.ts
git commit -m "feat(core): add kaizen-config module owning ~/.kaizen tree"
```

---

### Task 3: `canonicalTierGrantHash` in `plugin-hash.ts`

**Files:**
- Modify: `src/core/plugin-hash.ts`
- Modify: `src/core/plugin-hash.test.ts`

- [ ] **Step 1: Write failing tests**

Append to existing `src/core/plugin-hash.test.ts`:

```ts
import { canonicalTierGrantHash } from "./plugin-hash.js";
import type { PluginPermissions } from "../types/plugin.js";

describe("canonicalTierGrantHash", () => {
  const base: PluginPermissions = {
    tier: "scoped",
    fs: { read: ["a", "b"], write: ["c"] },
    net: { connect: ["x:1", "y:2"] },
    env: ["HOME"],
    exec: { binaries: ["git"] },
    events: { subscribe: ["core-lifecycle:tool:before"] },
  };

  it("is stable under key reorder", () => {
    const reordered: PluginPermissions = {
      exec: { binaries: ["git"] },
      events: { subscribe: ["core-lifecycle:tool:before"] },
      env: ["HOME"],
      net: { connect: ["x:1", "y:2"] },
      fs: { write: ["c"], read: ["a", "b"] },
      tier: "scoped",
    };
    expect(canonicalTierGrantHash(reordered)).toBe(canonicalTierGrantHash(base));
  });

  it("is stable under array reorder", () => {
    const shuffled: PluginPermissions = {
      ...base,
      fs: { read: ["b", "a"], write: ["c"] },
      net: { connect: ["y:2", "x:1"] },
    };
    expect(canonicalTierGrantHash(shuffled)).toBe(canonicalTierGrantHash(base));
  });

  it("changes when tier changes", () => {
    expect(canonicalTierGrantHash({ ...base, tier: "trusted" }))
      .not.toBe(canonicalTierGrantHash(base));
  });

  it("changes when a grant value changes", () => {
    expect(canonicalTierGrantHash({ ...base, env: ["HOME", "USER"] }))
      .not.toBe(canonicalTierGrantHash(base));
  });

  it("returns sha256:<64-hex>", () => {
    expect(canonicalTierGrantHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test src/core/plugin-hash.test.ts`
Expected: FAIL — `canonicalTierGrantHash` undefined.

- [ ] **Step 3: Implement `canonicalTierGrantHash`**

Append to `src/core/plugin-hash.ts`:

```ts
import type { PluginPermissions } from "../types/plugin.js";

/**
 * SHA-256 of a canonical serialization of `{ tier, permissions-minus-tier }`:
 * object keys sorted; arrays sorted. Any change (value, presence, tier) flips
 * the hash. Silent updates only apply when hash is byte-equal.
 */
export function canonicalTierGrantHash(perms: PluginPermissions): string {
  const canon = canonicalize({
    tier: perms.tier ?? "trusted",
    permissions: stripTier(perms),
  });
  return "sha256:" + createHash("sha256").update(canon).digest("hex");
}

function stripTier(p: PluginPermissions): Omit<PluginPermissions, "tier"> {
  const { tier: _tier, ...rest } = p;
  return rest;
}

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    const sorted = [...v].map(canonicalize).sort();
    return "[" + sorted.join(",") + "]";
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test src/core/plugin-hash.test.ts`
Expected: PASS — existing + new cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-hash.ts src/core/plugin-hash.test.ts
git commit -m "feat(core): add canonicalTierGrantHash for silent-update eligibility"
```

---

## Phase 2 — Ref Parser & Resolver

### Task 4: `src/core/ref-resolver.ts`

**Files:**
- Create: `src/core/ref-resolver.ts`
- Create: `src/core/ref-resolver.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/core/ref-resolver.test.ts
import { describe, it, expect } from "bun:test";
import { parseRef, resolveRef, RefConflictError,
         MarketplaceNotFoundError, PluginNotFoundError, RefParseError } from "./ref-resolver.js";
import type { MarketplaceCatalog } from "../types/plugin.js";

describe("parseRef", () => {
  it("parses marketplace-qualified with version", () => {
    expect(parseRef("official/timestamps@1.2.3"))
      .toEqual({ kind: "marketplace", marketplaceId: "official", name: "timestamps", version: "1.2.3" });
  });
  it("parses marketplace-qualified without version", () => {
    expect(parseRef("official/timestamps"))
      .toEqual({ kind: "marketplace", marketplaceId: "official", name: "timestamps" });
  });
  it("parses shorthand with version", () => {
    expect(parseRef("timestamps@1.2.3"))
      .toEqual({ kind: "shorthand", name: "timestamps", version: "1.2.3" });
  });
  it("parses shorthand bare", () => {
    expect(parseRef("timestamps"))
      .toEqual({ kind: "shorthand", name: "timestamps" });
  });
  it("parses legacy kaizen-plugin-* shim", () => {
    expect(parseRef("kaizen-plugin-timestamps"))
      .toEqual({ kind: "legacy-npm", name: "kaizen-plugin-timestamps" });
  });

  it.each([
    ["https://x/y.git"],
    ["http://x/y"],
    ["file:///x"],
    ["./local"],
    ["/abs/path"],
    ["../up"],
    ["@scope/pkg"],
    [""],
  ])("rejects %s", (r) => {
    expect(() => parseRef(r)).toThrow(RefParseError);
  });
});

describe("resolveRef", () => {
  const catTs: MarketplaceCatalog = {
    version: "1.0.0", name: "Official", url: "https://x.git",
    entries: [{
      kind: "plugin", name: "timestamps", description: "",
      versions: [
        { version: "1.0.0", source: { type: "file", path: "a" } },
        { version: "1.2.3", source: { type: "file", path: "a" } },
      ],
    }],
  };
  const catOther: MarketplaceCatalog = {
    version: "1.0.0", name: "Other", url: "https://o.git",
    entries: [{
      kind: "plugin", name: "timestamps", description: "",
      versions: [{ version: "1.0.0", source: { type: "file", path: "a" } }],
    }],
  };

  it("resolves marketplace-qualified to exact version", () => {
    const r = resolveRef(parseRef("official/timestamps@1.2.3"), { official: catTs });
    expect(r.marketplaceId).toBe("official");
    expect(r.version).toBe("1.2.3");
  });
  it("resolves marketplace-qualified to latest when no version", () => {
    const r = resolveRef(parseRef("official/timestamps"), { official: catTs });
    expect(r.version).toBe("1.2.3");
  });
  it("throws MarketplaceNotFoundError for unknown marketplace", () => {
    expect(() => resolveRef(parseRef("nope/x"), { official: catTs }))
      .toThrow(MarketplaceNotFoundError);
  });
  it("throws PluginNotFoundError for unknown name in marketplace", () => {
    expect(() => resolveRef(parseRef("official/missing"), { official: catTs }))
      .toThrow(PluginNotFoundError);
  });
  it("shorthand with single match auto-resolves", () => {
    const r = resolveRef(parseRef("timestamps@1.2.3"), { official: catTs });
    expect(r.marketplaceId).toBe("official");
  });
  it("shorthand ambiguous throws RefConflictError listing candidates", () => {
    expect(() => resolveRef(parseRef("timestamps"), { official: catTs, other: catOther }))
      .toThrow(RefConflictError);
  });
  it("legacy-npm resolves against 'official'", () => {
    const cat: MarketplaceCatalog = {
      version: "1.0.0", name: "Official", url: "https://x.git",
      entries: [{
        kind: "plugin", name: "timestamps", description: "",
        versions: [{ version: "1.0.0", source: { type: "npm", name: "kaizen-plugin-timestamps", version: "1.0.0" } }],
      }],
    };
    const r = resolveRef(parseRef("kaizen-plugin-timestamps"), { official: cat });
    expect(r.marketplaceId).toBe("official");
    expect(r.entry.name).toBe("timestamps");
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test src/core/ref-resolver.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/core/ref-resolver.ts`**

```ts
import type {
  MarketplaceCatalog, MarketplaceEntry, MarketplacePluginEntry,
  PluginVersionEntry,
} from "../types/plugin.js";

export type ParsedRef =
  | { kind: "marketplace"; marketplaceId: string; name: string; version?: string }
  | { kind: "shorthand";   name: string;          version?: string }
  | { kind: "legacy-npm";  name: string };           // kaizen-plugin-*

export interface ResolvedEntry {
  marketplaceId: string;
  entry: MarketplaceEntry;
  version: string;
  /** Present when entry.kind === "plugin". */
  pluginVersion?: PluginVersionEntry;
}

export class RefParseError extends Error { constructor(msg: string) { super(msg); this.name = "RefParseError"; } }
export class RefConflictError extends Error {
  constructor(public name: string, public candidates: string[]) {
    super(`ref '${name}' is ambiguous across marketplaces: ${candidates.join(", ")}. ` +
          `Use the marketplace-qualified form, e.g. ${candidates[0]}/${name}.`);
    this.name = "RefConflictError";
  }
}
export class MarketplaceNotFoundError extends Error {
  constructor(public marketplaceId: string) {
    super(`marketplace '${marketplaceId}' is not added. Run \`kaizen marketplace list\`.`);
    this.name = "MarketplaceNotFoundError";
  }
}
export class PluginNotFoundError extends Error {
  constructor(public name: string, marketplaceId?: string) {
    super(marketplaceId
      ? `plugin '${name}' not found in marketplace '${marketplaceId}'.`
      : `plugin '${name}' not found in any added marketplace.`);
    this.name = "PluginNotFoundError";
  }
}

const LEGACY_PREFIX = "kaizen-plugin-";

export function parseRef(ref: string): ParsedRef {
  if (!ref) throw new RefParseError("empty ref");

  // Rejections first — URL / local / scoped-npm.
  if (/^https?:\/\//i.test(ref) || ref.startsWith("file://")) {
    throw new RefParseError(rejectMsg(ref, "raw URL"));
  }
  if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/")) {
    throw new RefParseError(rejectMsg(ref, "local path"));
  }
  if (ref.startsWith("@")) {
    throw new RefParseError(rejectMsg(ref, "scoped npm package"));
  }

  // Legacy kaizen-plugin-* shim — no '/' or '@' allowed except the name itself.
  if (ref.startsWith(LEGACY_PREFIX) && !ref.includes("/")) {
    return { kind: "legacy-npm", name: splitAt(ref).name };
  }

  const slash = ref.indexOf("/");
  if (slash >= 0) {
    const id = ref.slice(0, slash);
    const tail = ref.slice(slash + 1);
    if (!id || !tail) throw new RefParseError(`invalid ref '${ref}'`);
    const { name, version } = splitAt(tail);
    return { kind: "marketplace", marketplaceId: id, name, ...(version !== undefined ? { version } : {}) };
  }

  const { name, version } = splitAt(ref);
  return { kind: "shorthand", name, ...(version !== undefined ? { version } : {}) };
}

function splitAt(s: string): { name: string; version?: string } {
  const at = s.indexOf("@");
  if (at < 0) return { name: s };
  return { name: s.slice(0, at), version: s.slice(at + 1) };
}

function rejectMsg(ref: string, what: string): string {
  return `ref '${ref}' rejected: ${what} is not a supported ref form. ` +
         `Refs must be marketplace-qualified (<id>/<name>[@<version>]) or shorthand (<name>[@<version>]). ` +
         `To ship a plugin, publish it in a marketplace (\`kaizen marketplace add <url>\`).`;
}

export function resolveRef(
  parsed: ParsedRef,
  catalogs: Record<string, MarketplaceCatalog>,
): ResolvedEntry {
  if (parsed.kind === "marketplace") {
    const cat = catalogs[parsed.marketplaceId];
    if (!cat) throw new MarketplaceNotFoundError(parsed.marketplaceId);
    return pickEntry(parsed.marketplaceId, cat, parsed.name, parsed.version);
  }

  if (parsed.kind === "legacy-npm") {
    const cat = catalogs["official"];
    if (!cat) throw new MarketplaceNotFoundError("official");
    // Strip the `kaizen-plugin-` prefix; match against the catalog name.
    const short = parsed.name.slice(LEGACY_PREFIX.length);
    return pickEntry("official", cat, short, undefined);
  }

  // shorthand — search every catalog.
  const hits: Array<{ id: string; resolved: ResolvedEntry }> = [];
  for (const [id, cat] of Object.entries(catalogs)) {
    try {
      hits.push({ id, resolved: pickEntry(id, cat, parsed.name, parsed.version) });
    } catch (e) {
      if (e instanceof PluginNotFoundError) continue;
      throw e;
    }
  }
  if (hits.length === 0) throw new PluginNotFoundError(parsed.name);
  if (hits.length > 1) throw new RefConflictError(parsed.name, hits.map((h) => h.id));
  return hits[0]!.resolved;
}

function pickEntry(
  id: string, cat: MarketplaceCatalog, name: string, version: string | undefined,
): ResolvedEntry {
  const entry = cat.entries.find((e) => e.name === name);
  if (!entry) throw new PluginNotFoundError(name, id);

  const versions = entry.kind === "plugin"
    ? (entry as MarketplacePluginEntry).versions.map((v) => v.version)
    : entry.versions.map((v) => v.version);

  const chosen = version ?? pickLatestSemver(versions);
  if (!versions.includes(chosen)) {
    throw new PluginNotFoundError(`${name}@${chosen}`, id);
  }

  const result: ResolvedEntry = { marketplaceId: id, entry, version: chosen };
  if (entry.kind === "plugin") {
    result.pluginVersion = entry.versions.find((v) => v.version === chosen)!;
  }
  return result;
}

/** Naive semver: split by '.', numeric compare. Good enough for v1. */
function pickLatestSemver(versions: string[]): string {
  return [...versions].sort((a, b) => cmpSemver(b, a))[0]!;
}
function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test src/core/ref-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/ref-resolver.ts src/core/ref-resolver.test.ts
git commit -m "feat(core): add ref parser + resolver (marketplace + shorthand + legacy shim)"
```

---

## Phase 3 — Marketplace Module (git + catalog)

### Task 5: `src/core/marketplace.ts`

**Files:**
- Create: `src/core/marketplace.ts`
- Create: `src/core/marketplace.test.ts`

This module is the **single entry point** used by `kaizen marketplace add`
and `--harness` bootstrap. It never hardcodes `~/.kaizen` paths — all disk
paths go through `kaizen-config.ts`.

- [ ] **Step 1: Write failing tests**

```ts
// src/core/marketplace.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import {
  addMarketplace, pullMarketplace, readCatalog, validateCatalog,
  shouldRefresh, MarketplaceCatalogInvalidError,
} from "./marketplace.js";
import { loadKaizenGlobalConfig, marketplaceRepoDir } from "./kaizen-config.js";
import type { MarketplaceCatalog } from "../types/plugin.js";

let home: string;
let upstream: string;

async function makeUpstream(catalog: MarketplaceCatalog): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kz-up-"));
  mkdirSync(join(dir, ".kaizen"), { recursive: true });
  writeFileSync(join(dir, ".kaizen", "marketplace.json"), JSON.stringify(catalog, null, 2));
  await $`git init -q`.cwd(dir);
  await $`git -c user.email=t@t -c user.name=t add .`.cwd(dir);
  await $`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(dir);
  return dir;
}

const sampleCatalog: MarketplaceCatalog = {
  version: "1.0.0", name: "Official", url: "local://upstream",
  entries: [{
    kind: "plugin", name: "timestamps", description: "ts",
    versions: [{ version: "1.0.0", source: { type: "file", path: "plugins/timestamps" } }],
  }],
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
  upstream = await makeUpstream(sampleCatalog);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(upstream, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("validateCatalog", () => {
  it("passes a valid catalog", () => {
    expect(() => validateCatalog(sampleCatalog)).not.toThrow();
  });
  it("rejects unknown kind", () => {
    const bad = { ...sampleCatalog, entries: [{ ...sampleCatalog.entries[0], kind: "bogus" }] } as unknown;
    expect(() => validateCatalog(bad as MarketplaceCatalog)).toThrow(MarketplaceCatalogInvalidError);
  });
  it("rejects duplicate names across kinds", () => {
    const dup: MarketplaceCatalog = {
      ...sampleCatalog,
      entries: [
        sampleCatalog.entries[0]!,
        { kind: "harness", name: "timestamps", description: "clash",
          versions: [{ version: "1.0.0", path: "h.json" }] },
      ],
    };
    expect(() => validateCatalog(dup)).toThrow(MarketplaceCatalogInvalidError);
  });
});

describe("addMarketplace — git clone", () => {
  it("clones upstream into <home>/marketplaces/<id>/repo, writes global config", async () => {
    await addMarketplace(upstream, { id: "official" });
    expect(existsSync(marketplaceRepoDir("official"))).toBe(true);
    const cat = await readCatalog("official");
    expect(cat.name).toBe("Official");
    const g = await loadKaizenGlobalConfig();
    expect(g.marketplaces?.[0]?.id).toBe("official");
    expect(g.marketplaces?.[0]?.url).toBe(upstream);
  });

  it("is idempotent — re-adding same id is a no-op", async () => {
    await addMarketplace(upstream, { id: "official" });
    await addMarketplace(upstream, { id: "official" });
    const g = await loadKaizenGlobalConfig();
    expect(g.marketplaces?.length).toBe(1);
  });

  it("derives id from URL basename when not supplied", async () => {
    await addMarketplace(upstream);
    const g = await loadKaizenGlobalConfig();
    expect(g.marketplaces?.[0]?.id).toBeDefined();
  });
});

describe("addMarketplace — local path (symlinked)", () => {
  it("symlinks repo dir when url is an absolute local path", async () => {
    await addMarketplace(upstream, { id: "local-dev", local: true });
    const repoPath = marketplaceRepoDir("local-dev");
    expect(existsSync(repoPath)).toBe(true);
    // Confirm it's a symlink by checking that editing upstream shows up.
    writeFileSync(join(upstream, "NEW"), "x");
    expect(existsSync(join(repoPath, "NEW"))).toBe(true);
  });
});

describe("pullMarketplace", () => {
  it("pulls a cloned marketplace (ff-only)", async () => {
    await addMarketplace(upstream, { id: "official" });
    writeFileSync(join(upstream, "README.md"), "hi");
    await $`git -c user.email=t@t -c user.name=t add README.md`.cwd(upstream);
    await $`git -c user.email=t@t -c user.name=t commit -qm r`.cwd(upstream);
    await pullMarketplace("official");
    expect(existsSync(join(marketplaceRepoDir("official"), "README.md"))).toBe(true);
  });
  it("is a no-op on symlinked marketplaces", async () => {
    await addMarketplace(upstream, { id: "local-dev", local: true });
    await pullMarketplace("local-dev"); // must not throw
  });
});

describe("shouldRefresh", () => {
  it("refreshes when no updatedAt", () => {
    expect(shouldRefresh({ id: "x", url: "" }, 900)).toBe(true);
  });
  it("does not refresh when within TTL", () => {
    expect(shouldRefresh({ id: "x", url: "", updatedAt: new Date().toISOString() }, 900)).toBe(false);
  });
  it("refreshes when older than TTL", () => {
    const old = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    expect(shouldRefresh({ id: "x", url: "", updatedAt: old }, 900)).toBe(true);
  });
  it("ttl=0 disables refresh", () => {
    expect(shouldRefresh({ id: "x", url: "" }, 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test src/core/marketplace.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/core/marketplace.ts`**

```ts
import { existsSync, mkdirSync, symlinkSync, readFileSync, rmSync, statSync, lstatSync } from "fs";
import { basename, join, isAbsolute } from "path";
import { $ } from "bun";
import type { MarketplaceCatalog, MarketplaceRef } from "../types/plugin.js";
import {
  ensureKaizenHome, loadKaizenGlobalConfig, saveKaizenGlobalConfig,
  marketplaceDir, marketplaceRepoDir,
} from "./kaizen-config.js";

export class MarketplaceCatalogInvalidError extends Error {
  constructor(msg: string) { super(msg); this.name = "MarketplaceCatalogInvalidError"; }
}

export interface AddMarketplaceOpts {
  id?: string;
  /** Treat `url` as an absolute local directory; symlink rather than clone. */
  local?: boolean;
}

export async function addMarketplace(url: string, opts: AddMarketplaceOpts = {}): Promise<void> {
  await ensureKaizenHome();
  const id = opts.id ?? deriveId(url);
  const mDir = marketplaceDir(id);
  const repoDir = marketplaceRepoDir(id);

  const cfg = await loadKaizenGlobalConfig();
  cfg.marketplaces ??= [];

  // Idempotency.
  if (cfg.marketplaces.some((m) => m.id === id)) return;

  mkdirSync(mDir, { recursive: true });
  if (opts.local || isAbsolute(url)) {
    if (!existsSync(url)) throw new Error(`local marketplace path not found: ${url}`);
    symlinkSync(url, repoDir, "dir");
  } else {
    await $`git clone --depth=1 ${url} ${repoDir}`.quiet();
  }

  const cat = await readCatalog(id);
  validateCatalog(cat);

  const ref: MarketplaceRef = { id, url, updatedAt: new Date().toISOString() };
  cfg.marketplaces.push(ref);
  await saveKaizenGlobalConfig(cfg);
}

export async function pullMarketplace(id: string): Promise<void> {
  const repoDir = marketplaceRepoDir(id);
  if (!existsSync(repoDir)) throw new Error(`marketplace '${id}' is not added`);
  if (lstatSync(repoDir).isSymbolicLink()) return; // no-op for local dev
  await $`git -C ${repoDir} pull --depth=1 --ff-only`.quiet();

  const cfg = await loadKaizenGlobalConfig();
  const ref = cfg.marketplaces?.find((m) => m.id === id);
  if (ref) {
    ref.updatedAt = new Date().toISOString();
    await saveKaizenGlobalConfig(cfg);
  }
}

export async function removeMarketplace(id: string): Promise<void> {
  const cfg = await loadKaizenGlobalConfig();
  cfg.marketplaces = (cfg.marketplaces ?? []).filter((m) => m.id !== id);
  await saveKaizenGlobalConfig(cfg);
  rmSync(marketplaceDir(id), { recursive: true, force: true });
}

export async function readCatalog(id: string): Promise<MarketplaceCatalog> {
  const path = join(marketplaceRepoDir(id), ".kaizen", "marketplace.json");
  if (!existsSync(path)) {
    throw new MarketplaceCatalogInvalidError(`catalog not found at ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const cat = raw as MarketplaceCatalog;
  validateCatalog(cat);
  return cat;
}

export function validateCatalog(cat: MarketplaceCatalog): void {
  if (!cat || typeof cat !== "object") throw new MarketplaceCatalogInvalidError("not an object");
  if (cat.version !== "1.0.0") throw new MarketplaceCatalogInvalidError(`unsupported version: ${cat.version}`);
  if (typeof cat.name !== "string") throw new MarketplaceCatalogInvalidError("missing name");
  if (typeof cat.url !== "string") throw new MarketplaceCatalogInvalidError("missing url");
  if (!Array.isArray(cat.entries)) throw new MarketplaceCatalogInvalidError("entries must be an array");

  const seen = new Set<string>();
  for (const e of cat.entries) {
    if (e.kind !== "plugin" && e.kind !== "harness") {
      throw new MarketplaceCatalogInvalidError(`unknown entry kind: ${(e as { kind: string }).kind}`);
    }
    if (typeof e.name !== "string" || !/^[a-z0-9-]+$/.test(e.name)) {
      throw new MarketplaceCatalogInvalidError(`invalid entry name: ${e.name}`);
    }
    if (seen.has(e.name)) {
      throw new MarketplaceCatalogInvalidError(`duplicate entry name: ${e.name}`);
    }
    seen.add(e.name);
    if (!Array.isArray(e.versions) || e.versions.length === 0) {
      throw new MarketplaceCatalogInvalidError(`entry '${e.name}' has no versions`);
    }
  }
}

export function shouldRefresh(ref: MarketplaceRef, ttlSeconds: number): boolean {
  if (ttlSeconds <= 0) return false;
  if (!ref.updatedAt) return true;
  const ageMs = Date.now() - new Date(ref.updatedAt).getTime();
  return ageMs > ttlSeconds * 1000;
}

/** Fire-and-forget background pull. Swallows errors (logs only). */
export function refreshInBackground(id: string, log?: (m: string) => void): void {
  pullMarketplace(id).catch((e) => log?.(`marketplace refresh '${id}' failed: ${String(e)}`));
}

function deriveId(url: string): string {
  const base = basename(url).replace(/\.git$/, "");
  return base || "marketplace";
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test src/core/marketplace.test.ts`
Expected: PASS. If a test is flaky on symlink-on-CI, adjust symlink type
argument (`"junction"` on windows not supported — this is mac/linux only).

- [ ] **Step 5: Commit**

```bash
git add src/core/marketplace.ts src/core/marketplace.test.ts
git commit -m "feat(core): marketplace module — git clone/pull, catalog validate, background refresh"
```

---

## Phase 4 — Plugin Installer & Loader

### Task 6: `src/core/plugin-installer.ts`

**Files:**
- Create: `src/core/plugin-installer.ts`
- Create: `src/core/plugin-installer.test.ts`

Materializes plugin bits at `pluginInstallDir(id, name, version)`. Three source
types: `file` (copy), `tarball` (download + verify + extract), `npm` (`npm pack`
+ extract; no global `node_modules` involvement). Harness install is a JSON
copy to `harnessInstallDir/kaizen.json`.

- [ ] **Step 1: Write failing tests**

```ts
// src/core/plugin-installer.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installPlugin, installHarness } from "./plugin-installer.js";
import { pluginInstallDir, harnessInstallDir, marketplaceRepoDir } from "./kaizen-config.js";

let home: string;
let upstream: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
  upstream = mkdtempSync(join(tmpdir(), "kz-up-"));
  // Simulate an "added" marketplace whose repo is the upstream dir (symlink).
  mkdirSync(join(home, "marketplaces", "m"), { recursive: true });
  symlinkSync(upstream, marketplaceRepoDir("m"), "dir");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(upstream, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("installPlugin — file source", () => {
  it("copies plugin contents into pluginInstallDir", async () => {
    const pluginSrc = join(upstream, "plugins", "demo");
    mkdirSync(pluginSrc, { recursive: true });
    writeFileSync(join(pluginSrc, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(pluginSrc, "index.js"), "export default { name: 'demo', apiVersion: '2', setup(){} };");

    await installPlugin("m", "demo", "1.0.0",
      { type: "file", path: "plugins/demo" });

    const target = pluginInstallDir("m", "demo", "1.0.0");
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "index.js"))).toBe(true);
  });
});

describe("installHarness", () => {
  it("copies the harness JSON into harnessInstallDir/kaizen.json", async () => {
    const hSrc = join(upstream, "harnesses", "anth.json");
    mkdirSync(join(upstream, "harnesses"), { recursive: true });
    const doc = { plugins: ["official/timestamps@1.0.0"] };
    writeFileSync(hSrc, JSON.stringify(doc));

    await installHarness("m", "anthropic-default", "harnesses/anth.json");

    const target = join(harnessInstallDir("m", "anthropic-default"), "kaizen.json");
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(doc);
  });
});
```

(The `tarball` and `npm` source cases are covered by the integration test in
Task 16; unit tests would require network or ship heavy fixtures, not worth the
weight.)

- [ ] **Step 2: Run test, expect failure**

Run: `bun test src/core/plugin-installer.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/core/plugin-installer.ts`**

```ts
import { cpSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { $ } from "bun";
import type { PluginSource } from "../types/plugin.js";
import { marketplaceRepoDir, pluginInstallDir, harnessInstallDir } from "./kaizen-config.js";

export async function installPlugin(
  marketplaceId: string, name: string, version: string, source: PluginSource,
): Promise<void> {
  const target = pluginInstallDir(marketplaceId, name, version);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  switch (source.type) {
    case "file": {
      const src = join(marketplaceRepoDir(marketplaceId), source.path);
      if (!existsSync(src)) throw new Error(`file source not found in marketplace: ${source.path}`);
      cpSync(src, target, { recursive: true });
      return;
    }
    case "tarball": {
      await installTarball(source.url, target, source.sha256);
      return;
    }
    case "npm": {
      await installNpm(source.name, source.version, target);
      return;
    }
  }
}

export async function installHarness(
  marketplaceId: string, name: string, pathInRepo: string,
): Promise<void> {
  const src = join(marketplaceRepoDir(marketplaceId), pathInRepo);
  if (!existsSync(src)) throw new Error(`harness source not found in marketplace: ${pathInRepo}`);
  const target = harnessInstallDir(marketplaceId, name);
  mkdirSync(target, { recursive: true });
  const raw = readFileSync(src);
  writeFileSync(join(target, "kaizen.json"), raw);
}

async function installTarball(url: string, target: string, sha256?: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tarball fetch failed: ${url} (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (sha256) {
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== sha256) throw new Error(`tarball sha256 mismatch: want ${sha256}, got ${got}`);
  }
  const tmpFile = join(target, "__tarball.tgz");
  writeFileSync(tmpFile, buf);
  // Most npm tarballs have a top-level `package/` prefix; strip it.
  await $`tar -xzf ${tmpFile} -C ${target} --strip-components=1`.quiet();
  rmSync(tmpFile, { force: true });
}

async function installNpm(pkgName: string, pkgVersion: string, target: string): Promise<void> {
  // `npm pack` downloads the tarball into cwd; we run it in a scratch dir and move.
  const scratch = join(target, "__pack");
  mkdirSync(scratch, { recursive: true });
  await $`npm pack ${pkgName}@${pkgVersion}`.cwd(scratch).quiet();
  const entries = await $`ls ${scratch}`.text();
  const tgz = entries.trim().split("\n").find((n) => n.endsWith(".tgz"));
  if (!tgz) throw new Error(`npm pack produced no tarball for ${pkgName}@${pkgVersion}`);
  await $`tar -xzf ${join(scratch, tgz)} -C ${target} --strip-components=1`.quiet();
  rmSync(scratch, { recursive: true, force: true });
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test src/core/plugin-installer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-installer.ts src/core/plugin-installer.test.ts
git commit -m "feat(core): plugin-installer — file/tarball/npm into marketplaces/<id>/plugins/<n>@<v>/"
```

---

### Task 7: `src/core/plugin-loader.ts` — absolute-path loader

**Files:**
- Create: `src/core/plugin-loader.ts`
- Create: `src/core/plugin-loader.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/core/plugin-loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPluginFromInstallDir } from "./plugin-loader.js";
import { pluginInstallDir } from "./kaizen-config.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("loadPluginFromInstallDir", () => {
  it("imports by absolute path from the install dir (no node_modules)", async () => {
    const dir = pluginInstallDir("m", "demo", "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", main: "index.mjs", type: "module" }));
    writeFileSync(join(dir, "index.mjs"),
      `export default { name: "demo", apiVersion: "2", async setup() {} };`);

    const plugin = await loadPluginFromInstallDir("m", "demo", "1.0.0");
    expect(plugin.name).toBe("demo");
    expect(plugin.apiVersion).toBe("2");
  });

  it("throws a clear error when install dir is missing", async () => {
    await expect(loadPluginFromInstallDir("m", "ghost", "9.9.9")).rejects.toThrow(/not installed/i);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test src/core/plugin-loader.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/core/plugin-loader.ts`**

```ts
import { existsSync, readFileSync } from "fs";
import { join, isAbsolute } from "path";
import type { KaizenPlugin } from "../types/plugin.js";
import { pluginInstallDir } from "./kaizen-config.js";

export async function loadPluginFromInstallDir(
  marketplaceId: string, name: string, version: string,
): Promise<KaizenPlugin> {
  const dir = pluginInstallDir(marketplaceId, name, version);
  if (!existsSync(dir)) {
    throw new Error(`plugin '${marketplaceId}/${name}@${version}' is not installed at ${dir}`);
  }
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) throw new Error(`no package.json at ${dir}`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { main?: string; module?: string };
  const entry = pkg.module ?? pkg.main ?? "index.js";
  const abs = isAbsolute(entry) ? entry : join(dir, entry);

  // Bun and node both accept absolute-path dynamic import.
  const mod = (await import(abs)) as { default?: KaizenPlugin };
  if (!mod.default || typeof mod.default !== "object") {
    throw new Error(`plugin '${name}' at ${abs} has no default export`);
  }
  return mod.default;
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test src/core/plugin-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-loader.ts src/core/plugin-loader.test.ts
git commit -m "feat(core): plugin-loader imports marketplace plugins by absolute path"
```

---

### Task 8: `plugin-manager.ts` — `isInstalled` + marketplace resolve path

**Files:**
- Modify: `src/core/plugin-manager.ts`
- Modify: `src/core/plugin-manager.test.ts`

The plugin manager currently resolves plugins via `createRequire` paths. We do
**not** need to rewrite all of that in this task — third-party plugin loading
moves to `plugin-loader.ts`. But the manager does need to answer "is this
plugin installed?" using the marketplace layout.

- [ ] **Step 1: Write failing test**

Append to `src/core/plugin-manager.test.ts`:

```ts
import { isInstalled } from "./plugin-manager.js";
import { pluginInstallDir } from "./kaizen-config.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("isInstalled(marketplaceId, name, version)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kz-home-"));
    process.env.KAIZEN_HOME_OVERRIDE = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.KAIZEN_HOME_OVERRIDE;
  });

  it("returns false when install dir absent", async () => {
    expect(await isInstalled("m", "demo", "1.0.0")).toBe(false);
  });
  it("returns true when install dir has package.json", async () => {
    const dir = pluginInstallDir("m", "demo", "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    expect(await isInstalled("m", "demo", "1.0.0")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test src/core/plugin-manager.test.ts`
Expected: FAIL — `isInstalled` not exported.

- [ ] **Step 3: Add `isInstalled` to `plugin-manager.ts`**

Append (after `findPackageRoot`):

```ts
import { pluginInstallDir } from "./kaizen-config.js";
import { existsSync } from "fs";

export async function isInstalled(
  marketplaceId: string, name: string, version: string,
): Promise<boolean> {
  return existsSync(join(pluginInstallDir(marketplaceId, name, version), "package.json"));
}
```

(Ensure the `join` / `existsSync` imports already present at top of file are
reused — do not double-import.)

- [ ] **Step 4: Run test, verify pass**

Run: `bun test src/core/plugin-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-manager.ts src/core/plugin-manager.test.ts
git commit -m "feat(core): plugin-manager.isInstalled against marketplace layout"
```

---

## Phase 5 — `kaizen marketplace` subcommands

### Task 9: `src/commands/marketplace.ts`

**Files:**
- Create: `src/commands/marketplace.ts`

Thin command layer over `src/core/marketplace.ts`. No new business logic —
only argv parsing + stdout formatting.

- [ ] **Step 1: Implement the command module**

```ts
// src/commands/marketplace.ts
import { rmSync } from "fs";
import {
  addMarketplace, pullMarketplace, readCatalog, removeMarketplace,
} from "../core/marketplace.js";
import { loadKaizenGlobalConfig } from "../core/kaizen-config.js";
import { marketplaceDir } from "../core/kaizen-config.js";

export async function cmdMarketplaceAdd(args: { url: string; id?: string; local?: boolean }): Promise<number> {
  try {
    await addMarketplace(args.url, { ...(args.id ? { id: args.id } : {}), ...(args.local ? { local: true } : {}) });
    const id = args.id ?? args.url;
    const cat = await readCatalog(args.id ?? id); // best-effort
    const plugins = cat.entries.filter((e) => e.kind === "plugin").length;
    const harnesses = cat.entries.filter((e) => e.kind === "harness").length;
    console.log(`Added marketplace '${id}' (${plugins} plugins, ${harnesses} harnesses).`);
    return 0;
  } catch (e) {
    console.error(`kaizen marketplace add: ${(e as Error).message}`);
    return 1;
  }
}

export async function cmdMarketplaceList(): Promise<number> {
  const cfg = await loadKaizenGlobalConfig();
  const refs = cfg.marketplaces ?? [];
  if (refs.length === 0) {
    console.log("No marketplaces added. Run `kaizen marketplace add <url>`.");
    return 0;
  }
  const rows = await Promise.all(refs.map(async (r) => {
    try {
      const cat = await readCatalog(r.id);
      const plugins = cat.entries.filter((e) => e.kind === "plugin").length;
      const harnesses = cat.entries.filter((e) => e.kind === "harness").length;
      return { id: r.id, plugins, harnesses, updated: r.updatedAt ?? "—", url: r.url };
    } catch {
      return { id: r.id, plugins: 0, harnesses: 0, updated: r.updatedAt ?? "—", url: r.url };
    }
  }));
  console.log("ID\tPLUGINS\tHARNESSES\tUPDATED\tURL");
  for (const row of rows) {
    console.log(`${row.id}\t${row.plugins}\t${row.harnesses}\t${row.updated}\t${row.url}`);
  }
  return 0;
}

export async function cmdMarketplaceRemove(args: { id: string; purgeLockfile?: boolean }): Promise<number> {
  try {
    await removeMarketplace(args.id);
    console.log(`Removed marketplace '${args.id}' (including installed plugins and harnesses).`);
    // --purge-lockfile handled by caller that has the lockfile path (cli.ts).
    return 0;
  } catch (e) {
    console.error(`kaizen marketplace remove: ${(e as Error).message}`);
    return 1;
  }
}

export async function cmdMarketplaceUpdate(args: { id?: string }): Promise<number> {
  const cfg = await loadKaizenGlobalConfig();
  const targets = args.id ? [args.id] : (cfg.marketplaces ?? []).map((m) => m.id);
  let rc = 0;
  for (const id of targets) {
    try {
      await pullMarketplace(id);
      console.log(`Updated '${id}'.`);
    } catch (e) {
      console.error(`update '${id}' failed: ${(e as Error).message}`);
      rc = 1;
    }
  }
  return rc;
}

export async function cmdMarketplaceBrowse(args: { id?: string }): Promise<number> {
  const cfg = await loadKaizenGlobalConfig();
  const refs = args.id
    ? (cfg.marketplaces ?? []).filter((m) => m.id === args.id)
    : (cfg.marketplaces ?? []);
  for (const r of refs) {
    const cat = await readCatalog(r.id);
    console.log(`\n# ${r.id} (${cat.name})`);
    console.log("KIND\tNAME\tVERSIONS\tDESCRIPTION");
    for (const e of cat.entries) {
      const vs = e.versions.map((v) => v.version).join(",");
      console.log(`${e.kind}\t${e.name}\t${vs}\t${e.description}`);
    }
  }
  return 0;
}
```

- [ ] **Step 2: Smoke-test via a throwaway integration test**

Add a `src/commands/marketplace.test.ts` that simply exercises the happy path
of `add` → `list` → `browse` → `remove` against a local fixture (use the same
git-init helper as Task 5). Test files are fixtures for engineers to reason
about — not a correctness moat (the core module has that coverage).

- [ ] **Step 3: Run tests**

Run: `bun test src/commands/marketplace.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/commands/marketplace.ts src/commands/marketplace.test.ts
git commit -m "feat(cli): kaizen marketplace {add,list,remove,update,browse}"
```

---

## Phase 6 — Unified install / uninstall / update

### Task 10: Rework `src/commands/install.ts`

**Files:**
- Modify: `src/commands/install.ts`

The existing `runInstall({ pluginName, ... })` resolves a plugin by
`createRequire`. Replace with `runUnifiedInstall(ref, opts)` that:

1. Parses `ref` via `parseRef`.
2. Loads all added-marketplace catalogs.
3. Resolves to a `ResolvedEntry`.
4. Dispatches by `entry.kind`:
   - `plugin`: `installPlugin(...)` into the install dir → read
     `package.json` version + `permissions` from plugin's default export →
     compute hash → run existing consent flow (unchanged) → write lockfile.
   - `harness`: `installHarness(...)`.
5. If a project `.kaizen/kaizen.json` exists and this was a plugin install:
   append the canonical `<id>/<name>@<version>` ref to its `plugins` array
   (dedupe by canonical form).

- [ ] **Step 1: Replace `install.ts` contents**

```ts
// src/commands/install.ts
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import type { KaizenPlugin, PluginPermissions, MarketplaceCatalog } from "../types/plugin.js";
import { parseRef, resolveRef } from "../core/ref-resolver.js";
import { loadKaizenGlobalConfig } from "../core/kaizen-config.js";
import { readCatalog } from "../core/marketplace.js";
import { installPlugin, installHarness } from "../core/plugin-installer.js";
import { loadPluginFromInstallDir } from "../core/plugin-loader.js";
import { pluginInstallDir } from "../core/kaizen-config.js";
import { readLockfile, writeLockfile, upsertPluginEntry, type LockfileEntry } from "../core/lockfile.js";
import { canonicalTierGrantHash } from "../core/plugin-hash.js";
import { renderScopedUAC, renderUnscopedUAC } from "../core/uac-renderer.js";
import { decideConsent } from "../core/consent-flow.js";
import { readStdinLine } from "../core/stdin.js";
import { PROJECT_CONFIG } from "../core/config.js";

export interface UnifiedInstallArgs {
  ref: string;
  lockfilePath: string;
  allowUnscoped: boolean;
  nonInteractive: boolean;
}

export async function runUnifiedInstall(args: UnifiedInstallArgs): Promise<number> {
  const parsed = parseRef(args.ref);
  const catalogs = await loadAllCatalogs();
  const resolved = resolveRef(parsed, catalogs);

  if (resolved.entry.kind === "harness") {
    const hv = resolved.entry.versions.find((v) => v.version === resolved.version)!;
    await installHarness(resolved.marketplaceId, resolved.entry.name, hv.path);
    console.log(`installed harness ${resolved.marketplaceId}/${resolved.entry.name}@${resolved.version}`);
    return 0;
  }

  // plugin
  const pv = resolved.pluginVersion!;
  await installPlugin(resolved.marketplaceId, resolved.entry.name, resolved.version, pv.source);

  const dir = pluginInstallDir(resolved.marketplaceId, resolved.entry.name, resolved.version);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
  const version = pkg.version ?? resolved.version;
  const plugin = await loadPluginFromInstallDir(resolved.marketplaceId, resolved.entry.name, resolved.version);
  const permissions: PluginPermissions = plugin.permissions ?? { tier: "trusted" };
  const hash = canonicalTierGrantHash(permissions);

  const lockfile = readLockfile(args.lockfilePath);
  const decision = decideConsent({
    pluginName: resolved.entry.name,
    version, hash, permissions, lockfile,
    interactive: !args.nonInteractive && process.stdin.isTTY === true,
    allowUnscoped: args.allowUnscoped,
  });

  const canonical = `${resolved.marketplaceId}/${resolved.entry.name}@${resolved.version}`;

  switch (decision.kind) {
    case "accept":
      console.log(`plugin '${resolved.entry.name}' already in lockfile (no changes).`);
      await maybeAppendProjectPlugin(canonical);
      return 0;

    case "accept-and-record": {
      writeLockfile(args.lockfilePath, upsertPluginEntry(lockfile, resolved.entry.name, decision.entry));
      await maybeAppendProjectPlugin(canonical);
      console.log(`plugin '${resolved.entry.name}' recorded (tier: ${decision.entry.tier}).`);
      return 0;
    }

    case "prompt-scoped": {
      const source = `${resolved.marketplaceId}:${resolved.entry.name}@${version}`;
      process.stdout.write(renderScopedUAC({ pluginName: resolved.entry.name, version, source, permissions }) + "\n> ");
      const answer = (await readStdinLine()).trim().toLowerCase();
      if (answer === "a" || answer === "accept") {
        writeLockfile(args.lockfilePath, upsertPluginEntry(lockfile, resolved.entry.name, decision.entry));
        await maybeAppendProjectPlugin(canonical);
        console.log(`plugin '${resolved.entry.name}' accepted and recorded.`);
        return 0;
      }
      console.log(`plugin '${resolved.entry.name}' rejected.`);
      return 1;
    }

    case "prompt-unscoped": {
      const source = `${resolved.marketplaceId}:${resolved.entry.name}@${version}`;
      process.stdout.write(renderUnscopedUAC({ pluginName: resolved.entry.name, version, source, permissions }) + "\n> ");
      const typed = (await readStdinLine()).trim();
      if (typed !== resolved.entry.name) {
        console.log(`plugin '${resolved.entry.name}' rejected (confirmation did not match).`);
        return 1;
      }
      const entry: LockfileEntry = { ...decision.entry, consentMode: "interactive" };
      writeLockfile(args.lockfilePath, upsertPluginEntry(lockfile, resolved.entry.name, entry));
      await maybeAppendProjectPlugin(canonical);
      console.log(`plugin '${resolved.entry.name}' accepted as UNSCOPED and recorded.`);
      return 0;
    }

    case "refuse":
      console.error(`install refused: ${decision.reason}`);
      return 1;
  }
}

async function loadAllCatalogs(): Promise<Record<string, MarketplaceCatalog>> {
  const cfg = await loadKaizenGlobalConfig();
  const out: Record<string, MarketplaceCatalog> = {};
  for (const ref of cfg.marketplaces ?? []) {
    try { out[ref.id] = await readCatalog(ref.id); } catch { /* skip bad */ }
  }
  return out;
}

async function maybeAppendProjectPlugin(canonicalRef: string): Promise<void> {
  if (!existsSync(PROJECT_CONFIG)) return;
  const cfg = JSON.parse(readFileSync(PROJECT_CONFIG, "utf8")) as { plugins?: string[] };
  cfg.plugins ??= [];
  if (!cfg.plugins.includes(canonicalRef)) {
    cfg.plugins.push(canonicalRef);
    writeFileSync(PROJECT_CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }
}
```

- [ ] **Step 2: Keep the old `runInstall` as a thin shim for one release**

At the bottom of the file, add:

```ts
/** @deprecated use runUnifiedInstall. Retained for one release for cli.ts callers. */
export async function runInstall(args: { pluginName: string; lockfilePath: string; allowUnscoped: boolean; nonInteractive: boolean }): Promise<number> {
  return runUnifiedInstall({
    ref: args.pluginName,
    lockfilePath: args.lockfilePath,
    allowUnscoped: args.allowUnscoped,
    nonInteractive: args.nonInteractive,
  });
}
```

- [ ] **Step 3: Run typecheck + all tests**

Run: `bun x tsc --noEmit && bun test`
Expected: PASS. Fix any type errors surfaced by the rewrite (e.g. imports).

- [ ] **Step 4: Commit**

```bash
git add src/commands/install.ts
git commit -m "feat(cli): unified 'kaizen install <ref>' via ref-resolver + installer"
```

---

### Task 11: `src/commands/uninstall.ts`

**Files:**
- Create: `src/commands/uninstall.ts`

- [ ] **Step 1: Implement**

```ts
// src/commands/uninstall.ts
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { PROJECT_CONFIG } from "../core/config.js";
import { readLockfile, writeLockfile, removePluginEntry } from "../core/lockfile.js";
import { loadKaizenGlobalConfig } from "../core/kaizen-config.js";
import { readCatalog } from "../core/marketplace.js";
import { parseRef, resolveRef } from "../core/ref-resolver.js";
import { pluginInstallDir } from "../core/kaizen-config.js";

export interface UninstallArgs {
  ref: string;
  lockfilePath: string;
  purge: boolean;
}

export async function runUninstall(args: UninstallArgs): Promise<number> {
  // Parse the ref so we can purge the correct install dir.
  const parsed = parseRef(args.ref);
  const cfg = await loadKaizenGlobalConfig();
  const catalogs: Record<string, import("../types/plugin.js").MarketplaceCatalog> = {};
  for (const m of cfg.marketplaces ?? []) {
    try { catalogs[m.id] = await readCatalog(m.id); } catch {}
  }

  // Resolve purely for the canonical name; fall back to the parsed name if unresolvable.
  let name: string = parsed.kind === "legacy-npm" ? parsed.name.replace(/^kaizen-plugin-/, "") : parsed.name;
  let canonicalPrefix: string | undefined;
  try {
    const r = resolveRef(parsed, catalogs);
    name = r.entry.name;
    canonicalPrefix = `${r.marketplaceId}/${r.entry.name}@`;

    if (args.purge) {
      rmSync(pluginInstallDir(r.marketplaceId, r.entry.name, r.version), { recursive: true, force: true });
    }
  } catch { /* uninstall still removes from harness + lockfile */ }

  // Remove from project harness.
  if (existsSync(PROJECT_CONFIG)) {
    const h = JSON.parse(readFileSync(PROJECT_CONFIG, "utf8")) as { plugins?: string[] };
    const before = h.plugins?.length ?? 0;
    h.plugins = (h.plugins ?? []).filter((p) =>
      p !== name && (canonicalPrefix ? !p.startsWith(canonicalPrefix) : true),
    );
    if ((h.plugins?.length ?? 0) !== before) {
      writeFileSync(PROJECT_CONFIG, JSON.stringify(h, null, 2) + "\n", "utf8");
    }
  }

  // Remove from lockfile when --purge.
  if (args.purge) {
    const lf = readLockfile(args.lockfilePath);
    writeLockfile(args.lockfilePath, removePluginEntry(lf, name));
  }

  console.log(`uninstalled ${name}${args.purge ? " (purged bits + lockfile)" : ""}`);
  return 0;
}
```

- [ ] **Step 2: Minimal test**

Create `src/commands/uninstall.test.ts` exercising: harness array dedupe by
canonical ref, lockfile removal on `--purge`, install-dir removal on `--purge`.

- [ ] **Step 3: Run test**

Run: `bun test src/commands/uninstall.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/commands/uninstall.ts src/commands/uninstall.test.ts
git commit -m "feat(cli): kaizen uninstall <ref> [--purge]"
```

---

### Task 12: `src/commands/update.ts` — silent vs prompting

**Files:**
- Create: `src/commands/update.ts`

- [ ] **Step 1: Implement**

```ts
// src/commands/update.ts
import { readFileSync } from "fs";
import { join } from "path";
import type { MarketplaceCatalog, PluginPermissions } from "../types/plugin.js";
import { parseRef, resolveRef } from "../core/ref-resolver.js";
import { loadKaizenGlobalConfig } from "../core/kaizen-config.js";
import { readCatalog } from "../core/marketplace.js";
import { installPlugin } from "../core/plugin-installer.js";
import { loadPluginFromInstallDir } from "../core/plugin-loader.js";
import { pluginInstallDir } from "../core/kaizen-config.js";
import { readLockfile, writeLockfile, upsertPluginEntry } from "../core/lockfile.js";
import { canonicalTierGrantHash } from "../core/plugin-hash.js";
import { runUnifiedInstall } from "./install.js";

export interface UpdateArgs {
  ref?: string;             // undefined = update all installed
  lockfilePath: string;
  allowUnscoped: boolean;
  nonInteractive: boolean;
}

export async function runUpdate(args: UpdateArgs): Promise<number> {
  const cfg = await loadKaizenGlobalConfig();
  const catalogs: Record<string, MarketplaceCatalog> = {};
  for (const m of cfg.marketplaces ?? []) {
    try { catalogs[m.id] = await readCatalog(m.id); } catch {}
  }

  const lockfile = readLockfile(args.lockfilePath);
  const targets = args.ref
    ? [parseRef(args.ref)]
    : Object.keys(lockfile.plugins).map((n) => parseRef(n));

  let rc = 0;
  for (const parsed of targets) {
    const resolved = resolveRef(parsed, catalogs);
    if (resolved.entry.kind !== "plugin") continue; // harnesses have no updater
    const name = resolved.entry.name;
    const latest = resolved.version;
    const lfEntry = lockfile.plugins[name];
    if (lfEntry && lfEntry.version === latest) continue; // already latest

    await installPlugin(resolved.marketplaceId, name, latest, resolved.pluginVersion!.source);
    const plugin = await loadPluginFromInstallDir(resolved.marketplaceId, name, latest);
    const permissions: PluginPermissions = plugin.permissions ?? { tier: "trusted" };
    const newHash = canonicalTierGrantHash(permissions);

    if (lfEntry && lfEntry.hash === newHash) {
      // Silent update.
      writeLockfile(args.lockfilePath, upsertPluginEntry(lockfile, name, {
        ...lfEntry, version: latest,
      }));
      console.log(`silently updated ${resolved.marketplaceId}/${name} → ${latest}`);
      continue;
    }

    // Hash differs — re-run consent via runUnifiedInstall with the canonical ref.
    const code = await runUnifiedInstall({
      ref: `${resolved.marketplaceId}/${name}@${latest}`,
      lockfilePath: args.lockfilePath,
      allowUnscoped: args.allowUnscoped,
      nonInteractive: args.nonInteractive,
    });
    if (code !== 0) rc = code;
  }
  return rc;
}
```

- [ ] **Step 2: Test silent vs re-prompt**

Create `src/commands/update.test.ts`:
- Fixture: local marketplace with plugin v1.0.0 (`tier: trusted`) and v1.0.1
  (identical permissions) → `runUpdate` silently bumps, no stdin.
- Fixture: v1.0.1 with a different `fs.read` grant → `runUpdate` dispatches
  to `runUnifiedInstall`, which prompts (test with `nonInteractive: true` +
  `--allow-unscoped` to avoid actual TTY).

- [ ] **Step 3: Run test**

Run: `bun test src/commands/update.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/commands/update.ts src/commands/update.test.ts
git commit -m "feat(cli): kaizen update [<ref>] with silent vs re-prompt by tier/grant hash"
```

---

## Phase 7 — Harness Bootstrap

### Task 13: `src/core/bootstrap.ts` — `bootstrapMissingPlugins`

**Files:**
- Create: `src/core/bootstrap.ts`
- Create: `src/core/bootstrap.test.ts`

Bootstrap takes a harness config + args and:
1. For each harness `marketplaces` entry not in `~/.kaizen/kaizen.json`:
   run `addMarketplace` (same code path as `kaizen marketplace add`).
   Failure is fatal if any plugin ref depends on that marketplace; otherwise warn.
2. For each plugin ref in `plugins`:
   - Must be canonical (`<id>/<name>@<version>`) in a harness file (spec
     requirement). Shorthand in the harness file is a **parse error** here.
     Legacy `kaizen-plugin-*` remains accepted for one release.
   - If `isInstalled(...)` returns false: run consent (skip if
     `--trust-lockfile` covers it via lockfile-entry existence) and install.

- [ ] **Step 1: Write failing test**

```ts
// src/core/bootstrap.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import { bootstrapMissingPlugins } from "./bootstrap.js";
import { loadKaizenGlobalConfig, pluginInstallDir } from "./kaizen-config.js";
import { addMarketplace } from "./marketplace.js";
import { existsSync } from "fs";

let home: string;
let upstream: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
  upstream = mkdtempSync(join(tmpdir(), "kz-up-"));
  mkdirSync(join(upstream, ".kaizen"), { recursive: true });
  mkdirSync(join(upstream, "plugins", "demo"), { recursive: true });
  writeFileSync(join(upstream, "plugins", "demo", "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", main: "index.mjs", type: "module" }));
  writeFileSync(join(upstream, "plugins", "demo", "index.mjs"),
    `export default { name: "demo", apiVersion: "2", async setup() {} };`);
  writeFileSync(join(upstream, ".kaizen", "marketplace.json"), JSON.stringify({
    version: "1.0.0", name: "M", url: upstream,
    entries: [{ kind: "plugin", name: "demo", description: "",
      versions: [{ version: "1.0.0", source: { type: "file", path: "plugins/demo" } }] }],
  }));
  await $`git init -q`.cwd(upstream);
  await $`git -c user.email=t@t -c user.name=t add .`.cwd(upstream);
  await $`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(upstream);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(upstream, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("bootstrapMissingPlugins", () => {
  it("adds missing marketplace from harness and installs missing plugin", async () => {
    const lockfilePath = join(home, "kaizen.permissions.lock");
    const report = await bootstrapMissingPlugins(
      { plugins: ["m/demo@1.0.0"], marketplaces: [{ id: "m", url: upstream }] },
      { lockfilePath, trustLockfile: false, nonInteractive: true, allowUnscoped: true },
    );
    expect(report.marketplacesAdded).toContain("m");
    expect(report.pluginsInstalled).toContain("m/demo@1.0.0");
    expect(existsSync(pluginInstallDir("m", "demo", "1.0.0"))).toBe(true);
    const cfg = await loadKaizenGlobalConfig();
    expect(cfg.marketplaces?.some((mk) => mk.id === "m")).toBe(true);
  });

  it("rejects shorthand refs in harness files", async () => {
    const lockfilePath = join(home, "kaizen.permissions.lock");
    await expect(bootstrapMissingPlugins(
      { plugins: ["demo"], marketplaces: [] },
      { lockfilePath, trustLockfile: false, nonInteractive: true, allowUnscoped: false },
    )).rejects.toThrow(/canonical/i);
  });

  it("--trust-lockfile + --non-interactive fails fast if lockfile missing a plugin", async () => {
    await addMarketplace(upstream, { id: "m", local: true });
    const lockfilePath = join(home, "kaizen.permissions.lock");
    await expect(bootstrapMissingPlugins(
      { plugins: ["m/demo@1.0.0"], marketplaces: [] },
      { lockfilePath, trustLockfile: true, nonInteractive: true, allowUnscoped: false },
    )).rejects.toThrow(/not in lockfile/i);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test src/core/bootstrap.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/core/bootstrap.ts`**

```ts
import type { KaizenConfig, MarketplaceRef } from "../types/plugin.js";
import { loadKaizenGlobalConfig } from "./kaizen-config.js";
import { addMarketplace } from "./marketplace.js";
import { parseRef } from "./ref-resolver.js";
import { readLockfile } from "./lockfile.js";
import { runUnifiedInstall } from "../commands/install.js";
import { isInstalled } from "./plugin-manager.js";

export interface BootstrapOpts {
  lockfilePath: string;
  trustLockfile: boolean;
  nonInteractive: boolean;
  allowUnscoped: boolean;
}

export interface BootstrapReport {
  marketplacesAdded: string[];
  pluginsInstalled: string[];
}

export async function bootstrapMissingPlugins(
  harness: KaizenConfig, opts: BootstrapOpts,
): Promise<BootstrapReport> {
  const report: BootstrapReport = { marketplacesAdded: [], pluginsInstalled: [] };

  // 1. Add any missing marketplaces listed in the harness.
  const global = await loadKaizenGlobalConfig();
  const knownIds = new Set((global.marketplaces ?? []).map((m) => m.id));
  const harnessMarkets: MarketplaceRef[] = harness.marketplaces ?? [];

  for (const m of harnessMarkets) {
    if (knownIds.has(m.id)) continue;
    try {
      console.log(`Adding marketplace ${m.id} from ${m.url}`);
      await addMarketplace(m.url, { id: m.id });
      report.marketplacesAdded.push(m.id);
    } catch (e) {
      // Fatal only if a plugin ref depends on this marketplace.
      const needed = (harness.plugins ?? []).some((p) => p.startsWith(`${m.id}/`));
      if (needed) {
        throw new Error(`cannot add marketplace ${m.id} from ${m.url}: ${(e as Error).message}`);
      }
      console.warn(`warning: marketplace ${m.id} could not be added: ${(e as Error).message}`);
    }
  }

  // 2. Install missing plugins.
  const lockfile = readLockfile(opts.lockfilePath);
  for (const refStr of harness.plugins ?? []) {
    const parsed = parseRef(refStr);

    if (parsed.kind === "shorthand") {
      throw new Error(
        `harness plugin ref '${refStr}' is shorthand. ` +
        `Harness plugin refs must be canonical '<marketplace>/<name>@<version>'.`,
      );
    }

    // Canonicalize the install-dir check.
    let marketplaceId: string;
    let name: string;
    let version: string | undefined;
    if (parsed.kind === "marketplace") {
      marketplaceId = parsed.marketplaceId;
      name = parsed.name;
      version = parsed.version;
    } else {
      // legacy-npm — strip prefix, pretend `official`.
      marketplaceId = "official";
      name = parsed.name.replace(/^kaizen-plugin-/, "");
      version = undefined;
    }
    if (!version) {
      throw new Error(`harness plugin ref '${refStr}' must include an explicit version`);
    }

    if (await isInstalled(marketplaceId, name, version)) continue;

    if (opts.trustLockfile) {
      if (!lockfile.plugins[name]) {
        throw new Error(`plugin '${name}' not in lockfile (trust-lockfile mode); run 'kaizen install ${refStr}' first`);
      }
    }

    const code = await runUnifiedInstall({
      ref: refStr,
      lockfilePath: opts.lockfilePath,
      allowUnscoped: opts.allowUnscoped,
      nonInteractive: opts.nonInteractive,
    });
    if (code !== 0) throw new Error(`bootstrap install failed for ${refStr}`);
    report.pluginsInstalled.push(refStr);
  }

  return report;
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test src/core/bootstrap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/bootstrap.ts src/core/bootstrap.test.ts
git commit -m "feat(core): bootstrap — add missing marketplaces + install missing plugins for --harness"
```

---

## Phase 8 — CLI wiring

### Task 14: `src/cli.ts` — wire new subcommands + flags + refresh

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Route `kaizen marketplace <sub>`**

Insert after the `kaizen apply` block and before the `kaizen install` block:

```ts
if (subcommand === "marketplace") {
  const {
    cmdMarketplaceAdd, cmdMarketplaceList, cmdMarketplaceRemove,
    cmdMarketplaceUpdate, cmdMarketplaceBrowse,
  } = await import("./commands/marketplace.js");
  const sub = rawArgs[1];
  const rest = rawArgs.slice(2);
  const idFlag = rest.indexOf("--id");
  const id = idFlag >= 0 ? rest[idFlag + 1] : undefined;

  let code = 0;
  switch (sub) {
    case "add": {
      const url = rest.find((a) => !a.startsWith("--") && a !== id);
      if (!url) { console.error("usage: kaizen marketplace add <url> [--id <id>]"); process.exit(2); }
      code = await cmdMarketplaceAdd({ url, ...(id ? { id } : {}) });
      break;
    }
    case "list":
      code = await cmdMarketplaceList();
      break;
    case "remove": {
      const target = rest.find((a) => !a.startsWith("--"));
      if (!target) { console.error("usage: kaizen marketplace remove <id>"); process.exit(2); }
      code = await cmdMarketplaceRemove({ id: target });
      break;
    }
    case "update": {
      const target = rest.find((a) => !a.startsWith("--"));
      code = await cmdMarketplaceUpdate(target ? { id: target } : {});
      break;
    }
    case "browse": {
      const target = rest.find((a) => !a.startsWith("--"));
      code = await cmdMarketplaceBrowse(target ? { id: target } : {});
      break;
    }
    default:
      console.error("Usage: kaizen marketplace {add|list|remove|update|browse} [args]");
      code = 2;
  }
  process.exit(code);
}
```

- [ ] **Step 2: Rework `kaizen install` to use unified installer**

Replace existing install block with:

```ts
if (subcommand === "install") {
  const rest = rawArgs.slice(1);
  const ref = rest.find((a) => !a.startsWith("--"));
  if (!ref) { console.error("usage: kaizen install <ref> [--allow-unscoped] [--non-interactive]"); process.exit(2); }
  const { runUnifiedInstall } = await import("./commands/install.js");
  const code = await runUnifiedInstall({
    ref,
    lockfilePath: join(process.cwd(), "kaizen.permissions.lock"),
    allowUnscoped: rest.includes("--allow-unscoped"),
    nonInteractive: rest.includes("--non-interactive"),
  });
  process.exit(code);
}
```

- [ ] **Step 3: Add `kaizen uninstall <ref>` routing**

Add after install block:

```ts
if (subcommand === "uninstall") {
  const rest = rawArgs.slice(1);
  const ref = rest.find((a) => !a.startsWith("--"));
  if (!ref) { console.error("usage: kaizen uninstall <ref> [--purge]"); process.exit(2); }
  const { runUninstall } = await import("./commands/uninstall.js");
  const code = await runUninstall({
    ref,
    lockfilePath: join(process.cwd(), "kaizen.permissions.lock"),
    purge: rest.includes("--purge"),
  });
  process.exit(code);
}
```

- [ ] **Step 4: Add `kaizen update [<ref>]` routing**

```ts
if (subcommand === "update") {
  const rest = rawArgs.slice(1);
  const ref = rest.find((a) => !a.startsWith("--"));
  const { runUpdate } = await import("./commands/update.js");
  const code = await runUpdate({
    ...(ref ? { ref } : {}),
    lockfilePath: join(process.cwd(), "kaizen.permissions.lock"),
    allowUnscoped: rest.includes("--allow-unscoped"),
    nonInteractive: rest.includes("--non-interactive"),
  });
  process.exit(code);
}
```

- [ ] **Step 5: Extend `--harness` parsing: reject raw URLs; dispatch marketplace refs**

In `parseRunArgs`, if `harness` is set and matches `/^https?:\/\//`, call
`fatal("raw URL harnesses are not supported — publish the harness in a marketplace and use --harness <id>/<name>@<version>")`.

Then, **before** `resolveConfig`, call new helper `materializeHarnessArg`:

```ts
function materializeHarnessArg(arg?: string): string | undefined {
  if (arg === undefined) return undefined;
  if (/^https?:\/\//i.test(arg)) fatal("raw URL harnesses are not supported (see --harness docs)");
  if (arg.startsWith("./") || arg.startsWith("/") || arg.startsWith("../")) return arg; // local path
  if (arg.includes("/")) {
    // Marketplace ref — dispatch to installHarness so the file lands at
    // ~/.kaizen/marketplaces/<id>/harnesses/<name>/kaizen.json, then return
    // that path for resolveConfig to read.
    // (Implementation: parseRef + resolveRef + installHarness + return absolute path.)
    // See helper below.
    return resolveMarketplaceHarnessSync(arg);
  }
  return arg; // bare name — existing built-in / project / home lookup via loadHarnessConfig
}
```

Because `materializeHarnessArg` needs async work (catalog read), move the
harness block to its own `await` path — see Step 6.

- [ ] **Step 6: Add bootstrap call before `bootstrap(kaizenConfig, builtins)`**

Replace the final block (starting at the `parseRunArgs` call) with:

```ts
const parsed = parseRunArgs(rawArgs);

if (parsed.harness !== undefined && /^https?:\/\//i.test(parsed.harness)) {
  fatal("raw URL harnesses are not supported — publish the harness in a marketplace and use --harness <id>/<name>@<version>");
}

const trustLockfile = rawArgs.includes("--trust-lockfile");
const nonInteractive = rawArgs.includes("--non-interactive");
const allowUnscopedFlag = rawArgs.includes("--allow-unscoped");

// Materialize marketplace-ref harnesses to a concrete path.
let harnessArg = parsed.harness;
if (harnessArg !== undefined && harnessArg.includes("/") &&
    !harnessArg.startsWith("./") && !harnessArg.startsWith("/") && !harnessArg.startsWith("../")) {
  const { parseRef, resolveRef } = await import("./core/ref-resolver.js");
  const { loadKaizenGlobalConfig, harnessInstallDir } = await import("./core/kaizen-config.js");
  const { readCatalog } = await import("./core/marketplace.js");
  const { installHarness } = await import("./core/plugin-installer.js");
  const cfg = await loadKaizenGlobalConfig();
  const catalogs: Record<string, import("./types/plugin.js").MarketplaceCatalog> = {};
  for (const m of cfg.marketplaces ?? []) {
    try { catalogs[m.id] = await readCatalog(m.id); } catch {}
  }
  const r = resolveRef(parseRef(harnessArg), catalogs);
  if (r.entry.kind !== "harness") fatal(`--harness ref '${harnessArg}' does not resolve to a harness entry`);
  const hv = r.entry.versions.find((v) => v.version === r.version)!;
  await installHarness(r.marketplaceId, r.entry.name, hv.path);
  harnessArg = join(harnessInstallDir(r.marketplaceId, r.entry.name), "kaizen.json");
}

const kaizenConfig = resolveConfig({
  ...(harnessArg !== undefined ? { harness: harnessArg } : {}),
  ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
});

// Bootstrap any missing marketplaces + plugins referenced by the harness.
if (kaizenConfig.marketplaces || (kaizenConfig.plugins ?? []).some((p) => p.includes("/"))) {
  const { bootstrapMissingPlugins } = await import("./core/bootstrap.js");
  await bootstrapMissingPlugins(kaizenConfig, {
    lockfilePath: join(process.cwd(), "kaizen.permissions.lock"),
    trustLockfile, nonInteractive, allowUnscoped: allowUnscopedFlag,
  });
}

if (parsed.allowDestructive) { /* … existing allow-destructive logic … */ }
if (parsed.prompt) { /* … existing prompt wiring … */ }

// Background marketplace refresh (non-blocking).
{
  const { loadKaizenGlobalConfig } = await import("./core/kaizen-config.js");
  const { shouldRefresh, refreshInBackground } = await import("./core/marketplace.js");
  const cfg = await loadKaizenGlobalConfig();
  const ttl = cfg.marketplaceUpdateTTL ?? 900;
  for (const m of cfg.marketplaces ?? []) {
    if (shouldRefresh(m, ttl)) refreshInBackground(m.id);
  }
}

await bootstrap(kaizenConfig, builtins);
```

(Trim the existing `allowDestructive` / `prompt` logic back in where the
comments indicate — do not duplicate.)

- [ ] **Step 7: Typecheck + test**

Run: `bun x tsc --noEmit && bun test`
Expected: PASS. Fix any fallout (particularly `FLAGS_WITH_VALUE` must still
include `--harness` + `--config`; `--trust-lockfile`, `--non-interactive`, and
`--allow-unscoped` are boolean).

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): wire marketplace, uninstall, update; --harness accepts marketplace refs; bootstrap + background refresh"
```

---

### Task 15: Deprecation shims & legacy resolver

**Files:**
- Modify: `src/commands/manage.ts`

- [ ] **Step 1: Add deprecation notices**

In `cmdPluginInstall(name)`, at the top:

```ts
console.warn("note: 'kaizen plugin install' is deprecated. Use 'kaizen install <ref>'.");
```

If `name` matches `/^kaizen-plugin-/`, console.warn with:
```
legacy plugin name '<name>' — auto-resolving against 'official' marketplace (deprecated, remove before v-next)
```
and delegate to `runUnifiedInstall({ ref: name, ... })` instead of the
existing install flow.

Same pattern for `cmdPluginRemove`.

- [ ] **Step 2: Commit**

```bash
git add src/commands/manage.ts
git commit -m "refactor(cli): deprecate 'kaizen plugin install/remove'; auto-resolve legacy kaizen-plugin-* against 'official'"
```

---

## Phase 9 — Integration

### Task 16: End-to-end integration test (local git marketplace)

**Files:**
- Create: `tests/integration/marketplace.integration.test.ts`

Covers the golden path: clone a real local git marketplace with a `file`-source
plugin, install, load, uninstall.

- [ ] **Step 1: Write the integration test**

```ts
// tests/integration/marketplace.integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import { addMarketplace } from "../../src/core/marketplace.js";
import { runUnifiedInstall } from "../../src/commands/install.js";
import { runUninstall } from "../../src/commands/uninstall.js";
import { pluginInstallDir } from "../../src/core/kaizen-config.js";

describe("integration: local git marketplace, file-source plugin", () => {
  let home: string; let upstream: string; let project: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "kz-home-"));
    upstream = mkdtempSync(join(tmpdir(), "kz-up-"));
    project = mkdtempSync(join(tmpdir(), "kz-proj-"));
    process.env.KAIZEN_HOME_OVERRIDE = home;

    mkdirSync(join(upstream, "plugins", "demo"), { recursive: true });
    writeFileSync(join(upstream, "plugins", "demo", "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", main: "index.mjs", type: "module" }));
    writeFileSync(join(upstream, "plugins", "demo", "index.mjs"),
      `export default { name: "demo", apiVersion: "2", async setup() {} };`);
    mkdirSync(join(upstream, ".kaizen"), { recursive: true });
    writeFileSync(join(upstream, ".kaizen", "marketplace.json"), JSON.stringify({
      version: "1.0.0", name: "Local", url: upstream,
      entries: [{ kind: "plugin", name: "demo", description: "",
        versions: [{ version: "1.0.0", source: { type: "file", path: "plugins/demo" } }] }],
    }));
    await $`git init -q`.cwd(upstream);
    await $`git -c user.email=t@t -c user.name=t add .`.cwd(upstream);
    await $`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(upstream);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(upstream, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    delete process.env.KAIZEN_HOME_OVERRIDE;
  });

  it("add → install → uninstall --purge", async () => {
    await addMarketplace(upstream, { id: "local" });
    const lock = join(project, "kaizen.permissions.lock");

    const code = await runUnifiedInstall({
      ref: "local/demo@1.0.0", lockfilePath: lock,
      allowUnscoped: false, nonInteractive: true,
    });
    expect(code).toBe(0);
    expect(existsSync(pluginInstallDir("local", "demo", "1.0.0"))).toBe(true);

    const code2 = await runUninstall({ ref: "local/demo@1.0.0", lockfilePath: lock, purge: true });
    expect(code2).toBe(0);
    expect(existsSync(pluginInstallDir("local", "demo", "1.0.0"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun test tests/integration/marketplace.integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Full test run**

Run: `bun test`
Expected: PASS across the whole suite.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/marketplace.integration.test.ts
git commit -m "test(integration): marketplace add → install → uninstall e2e"
```

---

## Phase 10 — Docs

### Task 17: Documentation updates

**Files:**
- Modify: `docs/architecture.md`
- Modify: `README.md`

- [ ] **Step 1: Update `docs/architecture.md`**

Add a new section **"Marketplaces & plugin resolution"** with:
- The install tree under `~/.kaizen/marketplaces/<id>/{repo,plugins/<n>@<v>,harnesses/<n>}`.
- The two ref forms (marketplace-qualified + shorthand) and the rejection list.
- The fact that third-party plugins are imported by absolute path — **not**
  via `node_modules`.
- Reference `src/core/kaizen-config.ts` as the owner of all `~/.kaizen/` paths.

- [ ] **Step 2: Update `README.md`**

Under "Commands", replace the existing install docs with:
```
kaizen marketplace add <url> [--id <id>]
kaizen marketplace list
kaizen marketplace remove <id>
kaizen marketplace update [<id>]
kaizen marketplace browse [<id>]
kaizen install <ref>                # <marketplace>/<name>[@<version>] or shorthand
kaizen uninstall <ref> [--purge]
kaizen update [<ref>]
kaizen --harness <file|ref>         # raw URLs rejected; publish harness in a marketplace
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md README.md
git commit -m "docs: marketplace resolution, unified install CLI, install tree"
```

---

## Self-review checklist (run after plan execution, before PR)

1. `bun x tsc --noEmit` → 0 errors.
2. `bun test` → all pass (unit + integration).
3. `rg "~\\/\\.kaizen" src/` → only appears in `src/core/kaizen-config.ts`
   and (transitionally) `src/core/config.ts` (legacy harness paths).
4. `rg "node_modules" src/commands src/core/plugin-installer.ts
     src/core/plugin-loader.ts` → no hits except intentional docstrings.
5. Every public function added has at least one unit test.
6. Every error message from the spec's error-handling table is emitted by the
   corresponding code path (grep for message fragments in the tests).
7. Deprecation notices print on legacy command paths.
