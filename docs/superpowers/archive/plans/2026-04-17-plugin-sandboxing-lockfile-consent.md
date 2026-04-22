# Plugin Sandboxing — Plan 2: Lockfile & Consent Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `kaizen.permissions.lock` consent persistence, plugin content hashing, UAC rendering (info-level for SCOPED, modal+typed for UNSCOPED), and `kaizen install` / `plugin consent` / `plugin review` / `plugin audit` commands. Enforce lockfile consent at plugin load time. Enforcer remains in log-only mode from Plan 1; enforce-mode is Plan 3.

**Architecture:** New `src/core/lockfile.ts` (YAML parser/writer, typed schema) and `src/core/plugin-hash.ts` (SHA-256 over plugin source files). New `src/commands/install.ts`, `src/commands/plugin.ts` (subcommands for `consent`, `review`, `audit`). UAC rendered by `src/core/uac-renderer.ts` — pure function from manifest to terminal-formatted prompt; I/O done by command handlers. PluginManager gains a pre-setup check: for each resolved plugin, compare `declared permissions + content hash` against lockfile; decide load/skip/refuse based on the flow matrix.

**Tech Stack:** TypeScript, Bun, `yaml` npm dep (new), Node `crypto` (SHA-256), `process.stdin` for typed confirmation.

**Prerequisites:** Plan 1 must be complete and merged. Assumes all Plan 1 assumptions listed in its Deviation Log remain valid.

**Related:**
- Spec: `docs/superpowers/specs/2026-04-17-plugin-sandboxing-design.md`
- Plan 1: `docs/superpowers/plans/2026-04-17-plugin-sandboxing-enforcer-core.md`

---

## File Structure

**New files:**
- `src/core/lockfile.ts` — typed `PermissionsLockfile` schema; YAML read/write; merge helpers
- `src/core/lockfile.test.ts` — unit tests
- `src/core/plugin-hash.ts` — compute SHA-256 over a resolved plugin's entry-related files
- `src/core/plugin-hash.test.ts` — unit tests
- `src/core/uac-renderer.ts` — pure functions: `renderScopedUAC(manifest)`, `renderUnscopedUAC(manifest)`
- `src/core/uac-renderer.test.ts` — snapshot-style string tests
- `src/core/consent-flow.ts` — interactive consent logic: reads stdin, writes lockfile, returns decision
- `src/core/consent-flow.test.ts` — unit tests with stubbed stdin
- `src/commands/install.ts` — `kaizen install <plugin>` handler
- `src/commands/plugin-consent.ts` — `kaizen plugin consent <plugin>` handler
- `src/commands/plugin-review.ts` — `kaizen plugin review <plugin>` handler
- `src/commands/plugin-audit.ts` — `kaizen plugin audit` handler (static mode only in Plan 2; live mode deferred)

**Modified files:**
- `package.json` — add `yaml` dep
- `src/cli.ts` — wire new subcommands
- `src/core/plugin-manager.ts` — consult lockfile during `initialize()` and `load()`; apply flow matrix
- `src/core/index.ts` — pass lockfile path + flags to PluginManager

---

## Phase 1 — Lockfile + hashing primitives

### Task 1: Add `yaml` dep and lockfile module

**Files:**
- Modify: `package.json`
- Create: `src/core/lockfile.ts`
- Test: `src/core/lockfile.test.ts`

- [ ] **Step 1: Install `yaml`**

Run: `bun add yaml`

Expected: `yaml` appears under `dependencies` in `package.json`.

- [ ] **Step 2: Write failing tests**

Create `src/core/lockfile.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readLockfile, writeLockfile, upsertPluginEntry } from "./lockfile.js";
import type { LockfileEntry } from "./lockfile.js";

describe("lockfile", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("read missing file returns empty lockfile", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-lock-"));
    const lf = readLockfile(join(dir, "kaizen.permissions.lock"));
    expect(lf.schemaVersion).toBe(1);
    expect(lf.plugins).toEqual({});
  });

  test("write then read roundtrips", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-lock-"));
    const path = join(dir, "lock.yaml");
    const entry: LockfileEntry = {
      version: "1.2.3",
      hash: "sha256:abc",
      tier: "scoped",
      consentedAt: "2026-04-17T00:00:00Z",
      consentedBy: "tester",
      permissions: { net: { connect: ["api.example.com:443"] }, env: ["FOO"] },
    };
    writeLockfile(path, { schemaVersion: 1, plugins: { "my-plugin": entry } });
    const lf = readLockfile(path);
    expect(lf.plugins["my-plugin"]).toEqual(entry);
  });

  test("upsertPluginEntry adds new", () => {
    const lf = { schemaVersion: 1, plugins: {} };
    const e: LockfileEntry = {
      version: "1.0", hash: "sha256:x", tier: "trusted",
      consentedAt: "t", consentedBy: "u",
    };
    const updated = upsertPluginEntry(lf, "p1", e);
    expect(updated.plugins["p1"]).toEqual(e);
  });

  test("upsertPluginEntry replaces existing", () => {
    const lf = {
      schemaVersion: 1,
      plugins: {
        p1: { version: "1.0", hash: "sha256:x", tier: "trusted" as const,
              consentedAt: "t", consentedBy: "u" },
      },
    };
    const e2: LockfileEntry = {
      version: "2.0", hash: "sha256:y", tier: "scoped",
      consentedAt: "t2", consentedBy: "u",
    };
    const updated = upsertPluginEntry(lf, "p1", e2);
    expect(updated.plugins["p1"]).toEqual(e2);
  });

  test("rejects invalid schema version", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-lock-"));
    const path = join(dir, "lock.yaml");
    writeFileSync(path, "schemaVersion: 999\nplugins: {}\n");
    expect(() => readLockfile(path)).toThrow(/schema version/i);
  });
});
```

- [ ] **Step 3: Run tests; expect failure**

Run: `bun test src/core/lockfile.test.ts`

- [ ] **Step 4: Implement `lockfile.ts`**

Create `src/core/lockfile.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync } from "fs";
import { parse, stringify } from "yaml";
import type { PluginPermissions, PermissionTier } from "../types/plugin.js";

export const LOCKFILE_SCHEMA_VERSION = 1;

export interface LockfileEntry {
  version: string;
  hash: string;
  tier: PermissionTier;
  consentedAt: string;
  consentedBy: string;
  consentMode?: "interactive" | "flag";
  permissions?: Omit<PluginPermissions, "tier">;
}

export interface PermissionsLockfile {
  schemaVersion: number;
  plugins: Record<string, LockfileEntry>;
}

export function readLockfile(path: string): PermissionsLockfile {
  if (!existsSync(path)) {
    return { schemaVersion: LOCKFILE_SCHEMA_VERSION, plugins: {} };
  }
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Lockfile '${path}' is not a valid YAML object.`);
  }
  const obj = parsed as PermissionsLockfile;
  if (obj.schemaVersion !== LOCKFILE_SCHEMA_VERSION) {
    throw new Error(
      `Lockfile '${path}' has unsupported schema version ${obj.schemaVersion}. Expected ${LOCKFILE_SCHEMA_VERSION}.`,
    );
  }
  if (!obj.plugins || typeof obj.plugins !== "object") {
    throw new Error(`Lockfile '${path}' missing or invalid 'plugins' field.`);
  }
  return obj;
}

export function writeLockfile(path: string, lf: PermissionsLockfile): void {
  const yaml = stringify(lf, { indent: 2, lineWidth: 100 });
  writeFileSync(path, yaml);
}

export function upsertPluginEntry(
  lf: PermissionsLockfile, pluginName: string, entry: LockfileEntry,
): PermissionsLockfile {
  return {
    ...lf,
    plugins: { ...lf.plugins, [pluginName]: entry },
  };
}

export function removePluginEntry(
  lf: PermissionsLockfile, pluginName: string,
): PermissionsLockfile {
  const { [pluginName]: _removed, ...rest } = lf.plugins;
  return { ...lf, plugins: rest };
}
```

- [ ] **Step 5: Run tests**

Run: `bun test src/core/lockfile.test.ts`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/core/lockfile.ts src/core/lockfile.test.ts
git commit -m "feat(core): lockfile schema + YAML read/write"
```

---

### Task 2: Plugin content hash

**Files:**
- Create: `src/core/plugin-hash.ts`
- Test: `src/core/plugin-hash.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/plugin-hash.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { computePluginHash } from "./plugin-hash.js";

describe("computePluginHash", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("hashes package.json + main", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-hash-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", main: "index.js" }));
    writeFileSync(join(dir, "index.js"), "module.exports = {};");
    const hash = computePluginHash(dir);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("hash changes when source changes", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-hash-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", main: "index.js" }));
    writeFileSync(join(dir, "index.js"), "module.exports = {};");
    const h1 = computePluginHash(dir);
    writeFileSync(join(dir, "index.js"), "module.exports = { x: 1 };");
    const h2 = computePluginHash(dir);
    expect(h1).not.toBe(h2);
  });

  test("hash is deterministic across runs", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-hash-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", main: "index.js" }));
    writeFileSync(join(dir, "index.js"), "module.exports = { x: 1 };");
    expect(computePluginHash(dir)).toBe(computePluginHash(dir));
  });

  test("does not hash node_modules", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-hash-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", main: "index.js" }));
    writeFileSync(join(dir, "index.js"), "module.exports = {};");
    const h1 = computePluginHash(dir);
    mkdirSync(join(dir, "node_modules", "foo"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "foo", "index.js"), "lots of data");
    const h2 = computePluginHash(dir);
    expect(h1).toBe(h2);
  });
});
```

- [ ] **Step 2: Run tests; expect failure**

- [ ] **Step 3: Implement `plugin-hash.ts`**

Create `src/core/plugin-hash.ts`:

```typescript
import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { join, relative, sep } from "path";
import { createHash } from "crypto";

/**
 * Hash a plugin package. Recursively walks the plugin directory, ignoring
 * node_modules and dotfiles, sorting paths for determinism. Returns
 * `sha256:<hex>`.
 */
export function computePluginHash(pluginDir: string): string {
  const files = collectFiles(pluginDir).sort();
  const hash = createHash("sha256");
  for (const absPath of files) {
    const rel = relative(pluginDir, absPath).split(sep).join("/");
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(absPath));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collectFiles(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/plugin-hash.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-hash.ts src/core/plugin-hash.test.ts
git commit -m "feat(core): SHA-256 plugin content hashing"
```

---

## Phase 2 — UAC rendering and consent flow

### Task 3: UAC renderer

**Files:**
- Create: `src/core/uac-renderer.ts`
- Test: `src/core/uac-renderer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/uac-renderer.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { renderScopedUAC, renderUnscopedUAC } from "./uac-renderer.js";

describe("renderScopedUAC", () => {
  test("shows all declared permissions", () => {
    const out = renderScopedUAC({
      pluginName: "cool-unknown-plugin",
      version: "1.2.3",
      source: "https://npm.im/cool-unknown-plugin",
      permissions: {
        tier: "scoped",
        net: { connect: ["api.example.com:443"] },
        env: ["EXAMPLE_API_KEY"],
        events: { subscribe: ["core-lifecycle:tool:before"] },
      },
    });
    expect(out).toContain("cool-unknown-plugin@1.2.3");
    expect(out).toContain("SCOPED");
    expect(out).toContain("api.example.com:443");
    expect(out).toContain("EXAMPLE_API_KEY");
    expect(out).toContain("core-lifecycle:tool:before");
  });

  test("empty grants render as '(none)'", () => {
    const out = renderScopedUAC({
      pluginName: "x", version: "1.0", source: "",
      permissions: { tier: "scoped" },
    });
    expect(out).toContain("(none)");
  });

  test("fs wildcards rendered verbatim", () => {
    const out = renderScopedUAC({
      pluginName: "x", version: "1.0", source: "",
      permissions: { tier: "scoped", fs: { read: ["/**"] } },
    });
    expect(out).toContain("/**");
  });
});

describe("renderUnscopedUAC", () => {
  test("calls out full access and no enforcement", () => {
    const out = renderUnscopedUAC({
      pluginName: "x", version: "1.0", source: "https://x",
      permissions: { tier: "unscoped" },
    });
    expect(out).toContain("UNSCOPED");
    expect(out).toMatch(/full system access/i);
    expect(out).toMatch(/cannot enforce/i);
    expect(out).toContain("Type the plugin name");
  });
});
```

- [ ] **Step 2: Run tests; expect failure**

- [ ] **Step 3: Implement `uac-renderer.ts`**

Create `src/core/uac-renderer.ts`:

```typescript
import type { PluginPermissions } from "../types/plugin.js";

export interface UacInput {
  pluginName: string;
  version: string;
  source: string;
  permissions: PluginPermissions;
}

export function renderScopedUAC(input: UacInput): string {
  const p = input.permissions;
  const lines: string[] = [];
  lines.push("┌────────────────────────────────────────────────────────────────────┐");
  lines.push(`│  Install: ${input.pluginName}@${input.version}`);
  lines.push("│");
  lines.push("│  Tier: SCOPED — kaizen will enforce the permissions below.");
  lines.push("│");
  lines.push("│  This plugin requests:");

  const sections: string[] = [];
  if (p.fs?.read?.length) sections.push(`Filesystem read:\n${listBullets(p.fs.read)}`);
  if (p.fs?.write?.length) sections.push(`Filesystem write:\n${listBullets(p.fs.write)}`);
  if (p.net?.connect?.length) sections.push(`Network access:\n${listBullets(p.net.connect)}`);
  if (p.env?.length) sections.push(`Environment variables:\n${listBullets(p.env)}`);
  if (p.exec?.binaries?.length) sections.push(`Command execution (binaries):\n${listBullets(p.exec.binaries)}`);
  if (p.events?.subscribe?.length) sections.push(`Event subscriptions (from other plugins):\n${listBullets(p.events.subscribe)}`);

  if (sections.length === 0) {
    lines.push("│    (none)");
  } else {
    for (const s of sections) {
      for (const line of s.split("\n")) lines.push(`│    ${line}`);
      lines.push("│");
    }
  }

  if (input.source) lines.push(`│  Source: ${input.source}`);
  lines.push(`│  Verify: kaizen plugin review ${input.pluginName}`);
  lines.push("│");
  lines.push("│  [a]ccept   [r]eject   [i]nspect source");
  lines.push("└────────────────────────────────────────────────────────────────────┘");
  return lines.join("\n");
}

export function renderUnscopedUAC(input: UacInput): string {
  const lines: string[] = [];
  lines.push("╔════════════════════════════════════════════════════════════════════╗");
  lines.push(`║  Install: ${input.pluginName}@${input.version}`);
  lines.push("║");
  lines.push("║  Tier: UNSCOPED — this plugin has NOT declared what it needs.");
  lines.push("║");
  lines.push("║  Accepting installs it with full system access:");
  lines.push("║    filesystem, network, environment variables, command execution,");
  lines.push("║    all other plugins' events, and anything else Node.js can reach.");
  lines.push("║");
  lines.push("║  Kaizen cannot enforce any limits on an UNSCOPED plugin.");
  lines.push("║");
  if (input.source) lines.push(`║  Source: ${input.source}`);
  lines.push(`║  Verify: kaizen plugin review ${input.pluginName}`);
  lines.push("║");
  lines.push("║  Type the plugin name to confirm: _");
  lines.push("╚════════════════════════════════════════════════════════════════════╝");
  return lines.join("\n");
}

function listBullets(items: string[]): string {
  return items.map((i) => `  • ${i}`).join("\n");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/uac-renderer.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/uac-renderer.ts src/core/uac-renderer.test.ts
git commit -m "feat(core): UAC renderer (scoped + unscoped)"
```

---

### Task 4: Consent flow

**Files:**
- Create: `src/core/consent-flow.ts`
- Test: `src/core/consent-flow.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/consent-flow.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { decideConsent } from "./consent-flow.js";
import type { LockfileEntry, PermissionsLockfile } from "./lockfile.js";

const BASE_MANIFEST = { tier: "scoped" as const, env: ["KEY"] };

describe("decideConsent", () => {
  test("plugin in lockfile with matching hash+perms: auto-accept", () => {
    const lf: PermissionsLockfile = {
      schemaVersion: 1,
      plugins: {
        p1: {
          version: "1.0", hash: "sha256:abc", tier: "scoped",
          consentedAt: "t", consentedBy: "u",
          permissions: { env: ["KEY"] },
        },
      },
    };
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: BASE_MANIFEST, lockfile: lf, interactive: false,
      allowUnscoped: false,
    });
    expect(decision.kind).toBe("accept");
  });

  test("plugin in lockfile, hash drift: refuse in non-interactive", () => {
    const lf: PermissionsLockfile = {
      schemaVersion: 1,
      plugins: {
        p1: {
          version: "1.0", hash: "sha256:old", tier: "scoped",
          consentedAt: "t", consentedBy: "u",
          permissions: { env: ["KEY"] },
        },
      },
    };
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:new",
      permissions: BASE_MANIFEST, lockfile: lf, interactive: false,
      allowUnscoped: false,
    });
    expect(decision.kind).toBe("refuse");
    expect(decision.reason).toMatch(/hash/i);
  });

  test("plugin in lockfile, manifest drift: refuse", () => {
    const lf: PermissionsLockfile = {
      schemaVersion: 1,
      plugins: {
        p1: {
          version: "1.0", hash: "sha256:abc", tier: "scoped",
          consentedAt: "t", consentedBy: "u",
          permissions: { env: ["OTHER_KEY"] },
        },
      },
    };
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: BASE_MANIFEST, lockfile: lf, interactive: false,
      allowUnscoped: false,
    });
    expect(decision.kind).toBe("refuse");
    expect(decision.reason).toMatch(/permission/i);
  });

  test("plugin not in lockfile, trusted: silent add", () => {
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: { tier: "trusted" },
      lockfile: { schemaVersion: 1, plugins: {} },
      interactive: false, allowUnscoped: false,
    });
    expect(decision.kind).toBe("accept-and-record");
  });

  test("plugin not in lockfile, scoped, non-interactive: refuse", () => {
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: BASE_MANIFEST,
      lockfile: { schemaVersion: 1, plugins: {} },
      interactive: false, allowUnscoped: false,
    });
    expect(decision.kind).toBe("refuse");
    expect(decision.reason).toMatch(/consent/i);
  });

  test("plugin not in lockfile, scoped, interactive: prompt", () => {
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: BASE_MANIFEST,
      lockfile: { schemaVersion: 1, plugins: {} },
      interactive: true, allowUnscoped: false,
    });
    expect(decision.kind).toBe("prompt-scoped");
  });

  test("plugin not in lockfile, unscoped, interactive: prompt-unscoped", () => {
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: { tier: "unscoped" },
      lockfile: { schemaVersion: 1, plugins: {} },
      interactive: true, allowUnscoped: true,
    });
    expect(decision.kind).toBe("prompt-unscoped");
  });

  test("plugin not in lockfile, unscoped, non-interactive, allowUnscoped=false: refuse", () => {
    const decision = decideConsent({
      pluginName: "p1", version: "1.0", hash: "sha256:abc",
      permissions: { tier: "unscoped" },
      lockfile: { schemaVersion: 1, plugins: {} },
      interactive: false, allowUnscoped: false,
    });
    expect(decision.kind).toBe("refuse");
    expect(decision.reason).toMatch(/unscoped/i);
  });
});
```

- [ ] **Step 2: Run tests; expect failure**

- [ ] **Step 3: Implement `consent-flow.ts`**

Create `src/core/consent-flow.ts`:

```typescript
import type { PluginPermissions } from "../types/plugin.js";
import type { PermissionsLockfile, LockfileEntry } from "./lockfile.js";

export interface ConsentInput {
  pluginName: string;
  version: string;
  hash: string;
  permissions: PluginPermissions;
  lockfile: PermissionsLockfile;
  interactive: boolean;
  allowUnscoped: boolean;
}

export type ConsentDecision =
  | { kind: "accept"; entry: LockfileEntry }          // already in lockfile, matches — proceed
  | { kind: "accept-and-record"; entry: LockfileEntry } // trusted tier, add to lockfile silently
  | { kind: "prompt-scoped" }                         // caller should render UAC and accept/reject
  | { kind: "prompt-unscoped" }                       // caller should render loud UAC + typed confirm
  | { kind: "refuse"; reason: string };

/** Pure decision function. Performs no I/O. */
export function decideConsent(input: ConsentInput): ConsentDecision {
  const existing = input.lockfile.plugins[input.pluginName];
  const tier = input.permissions.tier ?? "trusted";

  if (existing) {
    if (existing.hash !== input.hash) {
      return { kind: "refuse", reason: `plugin '${input.pluginName}' hash differs from lockfile (expected ${existing.hash}, got ${input.hash}). Run 'kaizen plugin consent ${input.pluginName}' to re-consent.` };
    }
    if (!permissionsEqual(existing.permissions, stripTier(input.permissions))) {
      return { kind: "refuse", reason: `plugin '${input.pluginName}' declared permissions differ from lockfile. Run 'kaizen plugin review ${input.pluginName}' to inspect diff.` };
    }
    if (existing.tier !== tier) {
      return { kind: "refuse", reason: `plugin '${input.pluginName}' tier differs from lockfile (expected ${existing.tier}, got ${tier}).` };
    }
    return { kind: "accept", entry: existing };
  }

  // Not in lockfile.
  const nowEntry: LockfileEntry = {
    version: input.version,
    hash: input.hash,
    tier,
    consentedAt: new Date().toISOString(),
    consentedBy: process.env["USER"] ?? "unknown",
    permissions: stripTier(input.permissions),
  };

  if (tier === "trusted") return { kind: "accept-and-record", entry: nowEntry };

  if (tier === "scoped") {
    return input.interactive
      ? { kind: "prompt-scoped" }
      : { kind: "refuse", reason: `plugin '${input.pluginName}' requires SCOPED-tier consent. Run interactively or pre-consent with 'kaizen plugin consent ${input.pluginName}'.` };
  }

  // tier === "unscoped"
  if (input.interactive) return { kind: "prompt-unscoped" };
  if (input.allowUnscoped) return { kind: "accept-and-record", entry: { ...nowEntry, consentMode: "flag" } };
  return { kind: "refuse", reason: `plugin '${input.pluginName}' is UNSCOPED; pass --allow-unscoped explicitly to consent from a non-interactive context.` };
}

function stripTier(p: PluginPermissions): Omit<PluginPermissions, "tier"> {
  const { tier: _tier, ...rest } = p;
  return rest;
}

function permissionsEqual(a?: Omit<PluginPermissions, "tier">, b?: Omit<PluginPermissions, "tier">): boolean {
  return JSON.stringify(normalizeSort(a ?? {})) === JSON.stringify(normalizeSort(b ?? {}));
}

function normalizeSort(p: Omit<PluginPermissions, "tier">): unknown {
  return {
    fs: p.fs ? { read: [...(p.fs.read ?? [])].sort(), write: [...(p.fs.write ?? [])].sort() } : undefined,
    net: p.net ? { connect: [...(p.net.connect ?? [])].sort() } : undefined,
    env: p.env ? [...p.env].sort() : undefined,
    exec: p.exec ? { binaries: [...(p.exec.binaries ?? [])].sort() } : undefined,
    events: p.events ? { subscribe: [...(p.events.subscribe ?? [])].sort() } : undefined,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/consent-flow.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/consent-flow.ts src/core/consent-flow.test.ts
git commit -m "feat(core): consent decision function"
```

---

## Phase 3 — Commands

### Task 5: `kaizen install` command

**Files:**
- Create: `src/commands/install.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Read current `src/cli.ts`**

Open `src/cli.ts` and identify how existing subcommands are dispatched. Match the pattern.

- [ ] **Step 2: Implement `install.ts`**

Create `src/commands/install.ts`:

```typescript
import { createRequire } from "module";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import { readLockfile, writeLockfile, upsertPluginEntry } from "../core/lockfile.js";
import { computePluginHash } from "../core/plugin-hash.js";
import { renderScopedUAC, renderUnscopedUAC } from "../core/uac-renderer.js";
import { decideConsent } from "../core/consent-flow.js";
import { readStdinLine } from "../core/stdin.js";
import type { KaizenPlugin } from "../types/plugin.js";

export interface InstallArgs {
  pluginName: string;
  lockfilePath: string;
  allowUnscoped: boolean;
  nonInteractive: boolean;
}

export async function runInstall(args: InstallArgs): Promise<number> {
  const pluginDir = resolvePluginDir(args.pluginName);
  if (!pluginDir) {
    console.error(`kaizen install: could not resolve plugin '${args.pluginName}'.`);
    return 1;
  }

  const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")) as { version?: string; main?: string };
  const version = pkg.version ?? "unknown";
  const hash = computePluginHash(pluginDir);

  const req = createRequire(process.execPath);
  const mod = req(pluginDir) as { default?: KaizenPlugin };
  const plugin = mod.default;
  if (!plugin || typeof plugin !== "object") {
    console.error(`kaizen install: plugin '${args.pluginName}' has no default export.`);
    return 1;
  }
  const permissions = plugin.permissions ?? { tier: "trusted" };

  const lockfile = readLockfile(args.lockfilePath);
  const decision = decideConsent({
    pluginName: args.pluginName, version, hash, permissions, lockfile,
    interactive: !args.nonInteractive && process.stdin.isTTY === true,
    allowUnscoped: args.allowUnscoped,
  });

  switch (decision.kind) {
    case "accept":
      console.log(`kaizen install: plugin '${args.pluginName}' already in lockfile (no changes).`);
      return 0;

    case "accept-and-record": {
      const updated = upsertPluginEntry(lockfile, args.pluginName, decision.entry);
      writeLockfile(args.lockfilePath, updated);
      console.log(`kaizen install: plugin '${args.pluginName}' recorded (tier: ${decision.entry.tier}).`);
      return 0;
    }

    case "prompt-scoped": {
      const source = `npm:${args.pluginName}@${version}`;
      process.stdout.write(renderScopedUAC({ pluginName: args.pluginName, version, source, permissions }) + "\n> ");
      const answer = (await readStdinLine()).trim().toLowerCase();
      if (answer === "a" || answer === "accept") {
        const entry = toEntry(version, hash, permissions);
        const updated = upsertPluginEntry(lockfile, args.pluginName, entry);
        writeLockfile(args.lockfilePath, updated);
        console.log(`kaizen install: plugin '${args.pluginName}' accepted and recorded.`);
        return 0;
      }
      console.log(`kaizen install: plugin '${args.pluginName}' rejected.`);
      return 1;
    }

    case "prompt-unscoped": {
      const source = `npm:${args.pluginName}@${version}`;
      process.stdout.write(renderUnscopedUAC({ pluginName: args.pluginName, version, source, permissions }) + "\n> ");
      const typed = (await readStdinLine()).trim();
      if (typed !== args.pluginName) {
        console.log(`kaizen install: plugin '${args.pluginName}' rejected (confirmation did not match).`);
        return 1;
      }
      const entry = { ...toEntry(version, hash, permissions), consentMode: "interactive" as const };
      const updated = upsertPluginEntry(lockfile, args.pluginName, entry);
      writeLockfile(args.lockfilePath, updated);
      console.log(`kaizen install: plugin '${args.pluginName}' accepted as UNSCOPED and recorded.`);
      return 0;
    }

    case "refuse":
      console.error(`kaizen install: refused. ${decision.reason}`);
      return 1;
  }
}

function toEntry(version: string, hash: string, permissions: { tier?: string }): import("../core/lockfile.js").LockfileEntry {
  const tier = (permissions.tier ?? "trusted") as "trusted" | "scoped" | "unscoped";
  return {
    version, hash, tier,
    consentedAt: new Date().toISOString(),
    consentedBy: process.env["USER"] ?? "unknown",
    permissions: stripTier(permissions as Record<string, unknown>),
  };
}

function stripTier(p: Record<string, unknown>): Record<string, unknown> {
  const { tier: _t, ...rest } = p;
  return rest;
}

function resolvePluginDir(name: string): string | null {
  const req = createRequire(process.execPath);
  try {
    const resolved = req.resolve(name);
    return dirname(resolved);
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Wire into `src/cli.ts`**

In `src/cli.ts`, add a branch for `install`:

```typescript
if (subcommand === "install") {
  const rest = argv.slice(1);
  const pluginName = rest.find((a) => !a.startsWith("--"));
  if (!pluginName) { console.error("usage: kaizen install <plugin>"); process.exit(2); }
  const allowUnscoped = rest.includes("--allow-unscoped");
  const nonInteractive = rest.includes("--non-interactive");
  const lockfilePath = join(process.cwd(), "kaizen.permissions.lock");
  const code = await runInstall({ pluginName, lockfilePath, allowUnscoped, nonInteractive });
  process.exit(code);
}
```

Also import `runInstall` and `join`.

- [ ] **Step 4: Manual smoke test**

Run: `bun src/cli.ts install core-executor-debug`

Expected: since `core-executor-debug` has no `permissions` field yet (Plan 3 migration), it's treated as TRUSTED → silent `accept-and-record`. Lockfile at `./kaizen.permissions.lock` now contains an entry for `core-executor-debug`.

Inspect: `cat ./kaizen.permissions.lock`. Expect valid YAML with `schemaVersion: 1`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/install.ts src/cli.ts
git commit -m "feat(cli): kaizen install <plugin> with UAC flow"
```

---

### Task 6: `kaizen plugin consent` / `review` / `audit` commands

**Files:**
- Create: `src/commands/plugin-consent.ts`
- Create: `src/commands/plugin-review.ts`
- Create: `src/commands/plugin-audit.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Implement `plugin-consent.ts`**

Create `src/commands/plugin-consent.ts`:

```typescript
import { runInstall, type InstallArgs } from "./install.js";
import { readLockfile, removePluginEntry, writeLockfile } from "../core/lockfile.js";

/**
 * Force re-consent for a plugin. Removes any existing lockfile entry, then
 * runs the install flow, which prompts the user (if interactive) or refuses
 * (if not and not TRUSTED).
 */
export async function runPluginConsent(args: InstallArgs): Promise<number> {
  const lf = readLockfile(args.lockfilePath);
  if (lf.plugins[args.pluginName]) {
    writeLockfile(args.lockfilePath, removePluginEntry(lf, args.pluginName));
  }
  return runInstall(args);
}
```

- [ ] **Step 2: Implement `plugin-review.ts`**

Create `src/commands/plugin-review.ts`:

```typescript
import { createRequire } from "module";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import { readLockfile } from "../core/lockfile.js";
import { computePluginHash } from "../core/plugin-hash.js";
import type { KaizenPlugin } from "../types/plugin.js";

export async function runPluginReview(args: { pluginName: string; lockfilePath: string }): Promise<number> {
  const lf = readLockfile(args.lockfilePath);
  const entry = lf.plugins[args.pluginName];

  const pluginDir = resolvePluginDir(args.pluginName);
  if (!pluginDir) {
    console.error(`plugin review: could not resolve plugin '${args.pluginName}'.`);
    return 1;
  }
  const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")) as { version?: string };
  const hash = computePluginHash(pluginDir);
  const req = createRequire(process.execPath);
  const plugin = (req(pluginDir) as { default?: KaizenPlugin }).default;
  const declared = plugin?.permissions ?? { tier: "trusted" };

  console.log(`Plugin: ${args.pluginName}`);
  console.log(`  Declared version:     ${pkg.version ?? "unknown"}`);
  console.log(`  Declared hash:        ${hash}`);
  console.log(`  Declared tier:        ${declared.tier ?? "trusted"}`);
  console.log(`  Declared permissions: ${JSON.stringify(declared)}`);
  console.log();
  if (!entry) {
    console.log("  Lockfile entry:       (none — not yet consented)");
    return 0;
  }
  console.log(`  Lockfile version:     ${entry.version}`);
  console.log(`  Lockfile hash:        ${entry.hash}`);
  console.log(`  Lockfile tier:        ${entry.tier}`);
  console.log(`  Lockfile permissions: ${JSON.stringify(entry.permissions ?? {})}`);
  console.log(`  Consented:            ${entry.consentedAt} by ${entry.consentedBy}`);
  console.log();
  const drift: string[] = [];
  if (entry.hash !== hash) drift.push("hash");
  if (entry.tier !== (declared.tier ?? "trusted")) drift.push("tier");
  if (JSON.stringify(entry.permissions ?? {}) !== JSON.stringify({ ...declared, tier: undefined })) drift.push("permissions");
  if (drift.length === 0) console.log("  Status: IN SYNC.");
  else console.log(`  Status: DRIFT in ${drift.join(", ")}. Run 'kaizen plugin consent ${args.pluginName}' to re-consent.`);
  return 0;
}

function resolvePluginDir(name: string): string | null {
  const req = createRequire(process.execPath);
  try { return dirname(req.resolve(name)); } catch { return null; }
}
```

- [ ] **Step 3: Implement `plugin-audit.ts` (static mode only)**

Create `src/commands/plugin-audit.ts`:

```typescript
import { readLockfile } from "../core/lockfile.js";

export async function runPluginAudit(args: { lockfilePath: string }): Promise<number> {
  const lf = readLockfile(args.lockfilePath);
  const entries = Object.entries(lf.plugins);
  if (entries.length === 0) {
    console.log("(no plugins in lockfile)");
    return 0;
  }
  console.log("Plugin                              Tier       Permissions");
  console.log("──────────────────────────────────────────────────────────");
  for (const [name, e] of entries) {
    const marker = e.tier === "unscoped" ? "⚠  " : "   ";
    const perms = summarize(e.permissions ?? {});
    console.log(`${marker}${name.padEnd(34)}${e.tier.padEnd(11)}${perms}`);
  }
  return 0;
}

function summarize(p: { fs?: unknown; net?: unknown; env?: string[]; exec?: unknown; events?: unknown }): string {
  const parts: string[] = [];
  if (p.fs) parts.push("fs");
  if (p.net) parts.push("net");
  if (p.env?.length) parts.push(`env[${p.env.length}]`);
  if (p.exec) parts.push("exec");
  if (p.events) parts.push("events");
  return parts.join(", ") || "(none)";
}
```

- [ ] **Step 4: Wire into `src/cli.ts`**

Add subcommand dispatch under `plugin`:

```typescript
if (subcommand === "plugin") {
  const sub = argv[1];
  const rest = argv.slice(2);
  const name = rest.find((a) => !a.startsWith("--"));
  const lockfilePath = join(process.cwd(), "kaizen.permissions.lock");

  if (sub === "consent" && name) {
    const code = await runPluginConsent({
      pluginName: name, lockfilePath,
      allowUnscoped: rest.includes("--allow-unscoped"),
      nonInteractive: rest.includes("--non-interactive"),
    });
    process.exit(code);
  }
  if (sub === "review" && name) {
    const code = await runPluginReview({ pluginName: name, lockfilePath });
    process.exit(code);
  }
  if (sub === "audit") {
    const code = await runPluginAudit({ lockfilePath });
    process.exit(code);
  }

  console.error("usage: kaizen plugin {consent|review|audit} [<name>]");
  process.exit(2);
}
```

Import `runPluginConsent`, `runPluginReview`, `runPluginAudit`.

- [ ] **Step 5: Smoke tests**

Run:
- `bun src/cli.ts plugin audit` — should print table or "(no plugins in lockfile)"
- `bun src/cli.ts plugin review core-executor-debug` — should print declared-vs-lockfile comparison

- [ ] **Step 6: Commit**

```bash
git add src/commands/plugin-consent.ts src/commands/plugin-review.ts src/commands/plugin-audit.ts src/cli.ts
git commit -m "feat(cli): kaizen plugin {consent,review,audit}"
```

---

## Phase 4 — Lockfile enforcement in PluginManager

### Task 7: Apply lockfile flow matrix at plugin load

**Files:**
- Modify: `src/core/plugin-manager.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 1: Add lockfile-consult helper to PluginManager**

In `plugin-manager.ts`, add imports:

```typescript
import { readLockfile, writeLockfile, upsertPluginEntry } from "./lockfile.js";
import { computePluginHash } from "./plugin-hash.js";
import { decideConsent } from "./consent-flow.js";
```

Add constructor params:
- `lockfilePath: string`
- `options: { trustLockfile: boolean; allowUnscoped: boolean; nonInteractive: boolean }`

Add a new private method `consultLockfile(plugin: KaizenPlugin, pluginDir: string | null): boolean` that returns `true` if the plugin should load, `false` if it should be skipped (refused). Behavior:

```typescript
private consultLockfile(plugin: KaizenPlugin, pluginDir: string | null): boolean {
  // Built-ins with no pluginDir: assume they ship with the core binary and are pre-trusted.
  if (!pluginDir) return true;

  const lf = readLockfile(this.lockfilePath);
  const pkgPath = join(pluginDir, "package.json");
  const version = existsSync(pkgPath)
    ? (JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "unknown")
    : "unknown";
  const hash = computePluginHash(pluginDir);
  const permissions = plugin.permissions ?? { tier: "trusted" };

  const decision = decideConsent({
    pluginName: plugin.name, version, hash, permissions, lockfile: lf,
    interactive: !this.options.nonInteractive && process.stdin.isTTY === true,
    allowUnscoped: this.options.allowUnscoped,
  });

  switch (decision.kind) {
    case "accept":
      return true;
    case "accept-and-record":
      writeLockfile(this.lockfilePath, upsertPluginEntry(lf, plugin.name, decision.entry));
      return true;
    case "prompt-scoped":
    case "prompt-unscoped":
      warn(`Plugin '${plugin.name}' requires consent. Run: kaizen plugin consent ${plugin.name}`);
      return false;
    case "refuse":
      warn(`Plugin '${plugin.name}' refused: ${decision.reason}`);
      return false;
  }
}
```

Import `existsSync`, `readFileSync`, `join` if not already imported.

- [ ] **Step 2: Call `consultLockfile` during `initialize()`**

After the plugin resolver returns a `KaizenPlugin`, before topo-sorting / setup, call `consultLockfile`. If it returns false, drop the plugin from the resolved list (log a warning; continue without it).

Structure:

```typescript
const resolved: KaizenPlugin[] = [];
for (const name of pluginNames) {
  const plugin = resolvePlugin(String(name), this.builtins);
  if (!plugin) continue;
  const pluginDir = resolvePluginDir(String(name));  // returns null for built-ins
  if (!this.consultLockfile(plugin, pluginDir)) continue;
  resolved.push(plugin);
}
```

You'll need a helper `resolvePluginDir` parallel to the existing `resolvePlugin`. Read the existing resolution logic; derive a directory path for non-builtin plugins. For built-ins, return null.

- [ ] **Step 3: Same for hot-reload `load()` path**

In `PluginManager.load(name)`, call `consultLockfile` before `setupPlugin`. Refuse path → `entry.status = "failed"`; warn and return.

- [ ] **Step 4: Bootstrap options**

In `src/core/index.ts`, read CLI flags and pass into PluginManager:

```typescript
const trustLockfile = process.argv.includes("--trust-lockfile");
const allowUnscoped = process.argv.includes("--allow-unscoped");
const nonInteractive = process.argv.includes("--non-interactive");
const lockfilePath = join(process.cwd(), "kaizen.permissions.lock");
```

Pass `lockfilePath` and `{ trustLockfile, allowUnscoped, nonInteractive }` into `PluginManager`.

- [ ] **Step 5: Run full test suite**

Run: `bun test`

Expected: pass. Plugin-manager tests may need a `lockfilePath` fixture — point them at `mkdtempSync()` locations so each test has a fresh lockfile.

- [ ] **Step 6: End-to-end smoke test**

Run: `bun src/cli.ts --harness core-debug`

Expected: plugins load (all TRUSTED by default since none have declared manifests yet → silent consent-and-record). Lockfile created with entries for each built-in at tier `trusted`.

Inspect: `cat ./kaizen.permissions.lock`. Expect entries for each built-in with `tier: trusted`.

- [ ] **Step 7: Commit**

```bash
git add src/core/plugin-manager.ts src/core/index.ts
git commit -m "feat(core): PluginManager consults lockfile at plugin load"
```

---

## Phase 5 — End-to-end verification

### Task 8: Verification + checkpoint

**Files:** none.

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`

Expected: zero errors.

- [ ] **Step 2: Full test suite**

Run: `bun test`

Expected: pass.

- [ ] **Step 3: Lockfile roundtrip**

Delete the lockfile and run again: `rm kaizen.permissions.lock && bun src/cli.ts --harness core-debug`.

Expected: lockfile regenerated with TRUSTED entries for each built-in. No UAC prompts (nothing is SCOPED yet — that's Plan 3).

- [ ] **Step 4: Simulate a SCOPED plugin refusal**

Create a test plugin manually: temporary directory with a `package.json` (`{ "name": "fake-scoped", "version": "0.0.1", "main": "index.js" }`) and `index.js` exporting `{ default: { name: "fake-scoped", apiVersion: "1", permissions: { tier: "scoped", env: ["FAKE"] }, async setup() {} } }`.

Run: `bun src/cli.ts install ./fake-scoped --non-interactive`

Expected: refused with message about running interactively or `kaizen plugin consent`.

Run: `bun src/cli.ts install ./fake-scoped` (interactive).

Expected: UAC prompt rendered with `env: [FAKE]`. Typing `a` + Enter accepts.

Inspect: lockfile contains `fake-scoped` at tier `scoped`.

- [ ] **Step 5: Simulate a UNSCOPED plugin**

Modify the fake plugin to use `tier: "unscoped"`. Re-install:

Run: `bun src/cli.ts plugin consent fake-scoped`

Expected: modal UAC rendered requiring typed confirmation. Typing the plugin name accepts; anything else rejects.

- [ ] **Step 6: Checkpoint commit**

```bash
git commit --allow-empty -m "chore: plan 2 (lockfile + consent) — end-to-end verified"
```

---

## Deviation Log (update during implementation)

Plan 3 relies on the following from Plan 2. **If any of these diverge during
implementation, append a note below so Plan 3 can be updated.**

Assumptions Plan 3 relies on:
- `readLockfile(path)` and `writeLockfile(path, lf)` public API shape.
- `decideConsent(input)` returns one of: `accept`, `accept-and-record`, `prompt-scoped`, `prompt-unscoped`, `refuse`.
- `computePluginHash(pluginDir)` returns `sha256:<hex>`.
- `renderScopedUAC` and `renderUnscopedUAC` accept `{ pluginName, version, source, permissions }`.
- `PluginManager` constructor accepts `lockfilePath` and `{ trustLockfile, allowUnscoped, nonInteractive }` options.
- `kaizen install <plugin>` and `kaizen plugin {consent,review,audit}` subcommands exist.
- Enforcer mode remains `log-only` (Plan 3 flips).

**Deviations observed during implementation:**

- **Task 4 (consent-flow tests):** Plan's verbatim listing has `expect(decision.reason).toMatch(...)` which fails TS narrowing (`reason` exists only on the `refuse` variant). Narrowed assertions behind `if (decision.kind === "refuse")` guards. Semantics identical. Does not affect public API.
- **Task 5 (install command):** Replaced the existing `kaizen install <harness>` subcommand (previously dispatched to `cmdInstall` in `src/commands/manage.ts`) with `kaizen install <plugin>`. The old `cmdInstall` export is now orphaned and should be removed in a follow-up. Plan did not address coexistence with the prior command; going with plan's new semantics since the consent flow is the canonical Plan 2 deliverable.
- **Task 5 smoke test:** Plan step 4 (`bun src/cli.ts install core-executor-debug`) fails because built-ins aren't resolvable via `createRequire(process.execPath).resolve(name)` — they're bundled imports with no directory on disk. The install command is npm-plugin-oriented; built-ins flow through PluginManager in Task 7, not through `runInstall`. Verified correctness via fake-plugin fixtures in Task 8 instead.
- **Task 7:** `trustLockfile` option is parsed from `--trust-lockfile` and passed into `PluginManager.options` but is never consumed by `consultLockfile` or `decideConsent`. Per plan's explicit instruction; reserved for a later phase (possibly Plan 3). Dead config surface until then.
- **Task 7 `pluginDir` derivation:** uses `dirname(resolvedPath)` where `resolvedPath` is the module entry file. For npm plugins whose entry lives in a subdir (e.g. `node_modules/foo/dist/index.js`), this resolves to the subdir, not the package root — meaning `computePluginHash` would hash only `dist/` and `package.json` lookup would miss. No real-world impact yet (Plan 2 has no external plugins; built-ins short-circuit). Flag for Plan 3 / external-plugin rollout.
- **Task 8 end-to-end:** Plan step 3 (`rm kaizen.permissions.lock && bun src/cli.ts --harness core-debug`) produces *no* regenerated lockfile because every plugin in the debug harness is built-in (all short-circuit in `consultLockfile`). Step 4 (interactive scoped prompt) could not be exercised from this shell — `process.stdin.isTTY` is false under a piped stdin so `decideConsent` correctly returns refuse in non-interactive mode. Non-interactive refuse path verified via fake-scoped fixture. Full interactive-prompt UAC verified manually via unit tests of `renderScopedUAC`/`renderUnscopedUAC` + `decideConsent` covering the prompt branches.
- **Task 8 substitute verification:** end-to-end lockfile write path verified with an UNSCOPED fake plugin + `--allow-unscoped --non-interactive` flags, which exercises `decideConsent → accept-and-record → writeLockfile` and then `plugin audit` / `plugin review` of the persisted entry (idempotent re-run prints "already in lockfile (no changes)"; `plugin review` reports "IN SYNC").

**Follow-ups flagged by final reviewer (for Plan 3 or a small bridging task):**

1. **Fix `pluginDir` resolution before Plan 3 flips enforce mode.** `dirname(resolvedPath)` is wrong for npm plugins with subpath entries (e.g. `node_modules/foo/dist/index.js` → `.../dist`, not the package root). Walk up to the nearest `package.json` instead. Blocker for any external-plugin under `enforce` mode.
2. **Runtime `consultLockfile` silently writes the lockfile on `accept-and-record`.** In read-only filesystems (CI, sealed container images) first load of a TRUSTED external plugin will fail. Consider demoting runtime `accept-and-record` to `accept` + debug-log, requiring explicit `kaizen install` / `plugin consent` to persist.
3. **Consolidate `LockfileEntry` construction.** `install.ts` currently re-derives an entry via `toEntry`/`stripTier` on the prompt branches, duplicating logic already inside `decideConsent`. Have `prompt-scoped` / `prompt-unscoped` decisions carry a pre-built `entry` that callers stamp with `consentMode` before writing.
4. **`plugin-review.ts` permission diff should use `normalizeSort`** (exported from `consent-flow.ts`) — otherwise declared-vs-lockfile reordering yields false "DRIFT" reports while `decideConsent` would accept.
5. **Remove orphan `cmdInstall` export in `src/commands/manage.ts`** (dead since Task 5 replaced the `install` subcommand).
6. **`trustLockfile` is dead surface.** Either implement or remove. If Plan 3 doesn't consume it, delete.
7. **TOCTOU note:** `computePluginHash` reads the plugin tree, then `createRequire` re-reads it — attacker with write access to the plugin dir between those ops could swap code. Worth documenting in code / Plan 3 threat-model section.
8. **Integration test gap:** no `plugin-manager.test.ts` case exercises `consultLockfile → refuse → plugin skipped at initialize`. Add one.

---

## Notes for the Implementing Engineer

1. **Lockfile placement is repo-root.** Tests should always pass an explicit `lockfilePath` to avoid clobbering the real one.
2. **`process.stdin.isTTY` may be `undefined` rather than `false`** in some environments. Always compare with `=== true` to be safe.
3. **Plugin directory resolution.** For npm plugins, `dirname(require.resolve(name))` works. For workspace plugins, `dirname` of the resolved `index.ts` points at the workspace root — that's still the plugin dir. For built-ins (pre-bundled into the binary), there's no directory; consult-lockfile should skip the check.
4. **`consentedBy`** reads from `$USER`. If the ALS-scoped `process.env` proxy from Plan 1 is active, the consent flow needs to run *outside* any plugin scope (which it does — install is a CLI command, not a plugin). Double-check by running `bun src/cli.ts install <name>` and confirming the `consentedBy` field is populated correctly, not `undefined`.
5. **YAML output ordering.** The `yaml` lib preserves insertion order. Consent entries should always write fields in the canonical order (`version, hash, tier, consentedAt, consentedBy, consentMode?, permissions?`) so lockfile diffs stay clean.
6. **Enforcer mode stays `log-only`.** Plan 3 flips to `enforce`. If a permission check denies a built-in during Plan 2 testing because it legitimately needs something its TRUSTED manifest doesn't allow, that's *expected* — the enforcer records it but doesn't throw. The audit log will tell Plan 3 what each built-in needs.
