# Plugin Sandboxing — Plan 1: Enforcer Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the permission enforcer infrastructure in log-only mode — types, `PermissionEnforcer` class, AsyncLocalStorage-scoped `Module.prototype.require` patching, `ctx.*` I/O surface, `process.env` proxy, global `fetch` wrapper, AST entry-file import pre-check, wiring into PluginManager, and an audit trail writer. Built-ins keep working; no breaking changes visible to plugin authors.

**Architecture:** A new `src/core/permission-enforcer.ts` module owns per-plugin permission manifests and exposes `check(op, arg)` reading the current plugin from `AsyncLocalStorage`. A bootstrap module patches `Module.prototype.require` and installs the `process.env` proxy + `fetch` wrapper *before any plugin loads*. `plugin-manager.ts` wraps each plugin's `setup`/`start`/event-handler calls in `als.run(pluginScope, fn)`, building a `ctx.fs`/`ctx.net`/`ctx.secrets`/`ctx.exec` surface per plugin. In log-only mode the enforcer records violations to the audit trail but does not throw.

**Tech Stack:** TypeScript, Bun, Node `AsyncLocalStorage`, Node `Module` API, Bun-native APIs where available.

**Related:**
- Spec: `docs/superpowers/specs/2026-04-17-plugin-sandboxing-design.md`
- Capability registry plan: `docs/superpowers/plans/2026-04-17-capability-registry.md` (prerequisite — permissions compose with capabilities)

---

## File Structure

**New files:**
- `src/core/permission-enforcer.ts` — `PermissionEnforcer` class; manifest registry; `check()` method; mode switching (log-only / enforce)
- `src/core/permission-enforcer.test.ts` — unit tests
- `src/core/plugin-scope.ts` — `AsyncLocalStorage<PluginScope>` singleton + scope helpers
- `src/core/plugin-scope.test.ts` — unit tests
- `src/core/sandbox-bootstrap.ts` — one-time bootstrap: patches `Module.prototype.require`, installs `process.env` proxy, wraps global `fetch`
- `src/core/sandbox-bootstrap.test.ts` — unit tests
- `src/core/plugin-ctx-io.ts` — `createCtxIo(pluginName, manifest, enforcer)` builds `fs`/`net`/`secrets`/`exec`/`log` surface
- `src/core/plugin-ctx-io.test.ts` — unit tests
- `src/core/manifest-import-scan.ts` — AST import pre-check for plugin entry files
- `src/core/manifest-import-scan.test.ts` — unit tests
- `src/core/audit-log.ts` — audit-trail JSONL writer
- `src/core/audit-log.test.ts` — unit tests

**Modified files:**
- `src/types/plugin.ts` — add `PluginPermissions` type; add `permissions` field to `KaizenPlugin`; extend `PluginContext` with `fs`/`net`/`secrets`/`exec` surfaces (replacing some `runtime.*` primitives only where needed)
- `src/core/plugin-manager.ts` — thread enforcer through; wrap plugin calls in ALS; register manifest on load; deregister on unload
- `src/core/context.ts` — accept enforcer + build `ctx.*` I/O surface per plugin
- `src/core/index.ts` — call `initializeSandbox()` at bootstrap; instantiate and expose enforcer
- `src/core/errors.ts` — add `PermissionError` class

---

## Phase 1 — Types and Core Enforcer

### Task 1: Add permission types

**Files:**
- Modify: `src/types/plugin.ts`
- Modify: `src/core/errors.ts`

- [ ] **Step 1: Add `PluginPermissions` to `src/types/plugin.ts`**

Append to `src/types/plugin.ts` before the `KaizenPlugin` interface:

```typescript
// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type PermissionTier = "trusted" | "scoped" | "unscoped";

export interface PluginPermissions {
  /** Default: "trusted". TRUSTED = no external I/O; SCOPED = declared grants; UNSCOPED = full access. */
  tier?: PermissionTier;

  fs?: {
    /** Glob patterns. Relative paths resolve from workspace root. */
    read?: string[];
    write?: string[];
  };

  net?: {
    /** host:port allowlist. "*" means any host, any port. "*.example.com:443" ok. */
    connect?: string[];
  };

  /** Allowed environment variable names. */
  env?: string[];

  exec?: {
    /** Binary name allowlist. No argv-pattern allowlisting in v1. */
    binaries?: string[];
  };

  events?: {
    /** Cross-plugin event subscription patterns, e.g. ["core-lifecycle:tool:before"]. */
    subscribe?: string[];
  };
}

/** Operation passed to PermissionEnforcer.check(). */
export type PermissionOp =
  | { kind: "fs.read";  path: string }
  | { kind: "fs.write"; path: string }
  | { kind: "net.connect"; host: string; port: number }
  | { kind: "env.get";  name: string }
  | { kind: "exec.run"; binary: string }
  | { kind: "events.subscribe"; event: string }
  | { kind: "import";   module: string };
```

Add `permissions` to `KaizenPlugin`:

```typescript
export interface KaizenPlugin {
  name: string;
  apiVersion: string;
  provides?: string[];
  depends?: string[];
  /** Permission manifest. Defaults to { tier: "trusted" }. */
  permissions?: PluginPermissions;
  setup(ctx: PluginContext): Promise<void>;
  start?(ctx: PluginContext): Promise<void>;
}
```

- [ ] **Step 2: Add `PermissionError` to `src/core/errors.ts`**

Append:

```typescript
export class PermissionError extends KaizenError {
  constructor(
    public readonly pluginName: string,
    public readonly op: string,
    public readonly detail: string,
  ) {
    super(
      `Permission denied: plugin '${pluginName}' attempted ${op} (${detail}). ` +
      `Declare this in the plugin's permissions manifest, or escalate to a higher tier.`,
      false,
    );
    this.name = "PermissionError";
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`

Expected: zero new errors. Existing errors unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/types/plugin.ts src/core/errors.ts
git commit -m "feat(types): add PluginPermissions + PermissionError"
```

---

### Task 2: PermissionEnforcer class (tests first)

**Files:**
- Create: `src/core/permission-enforcer.ts`
- Test: `src/core/permission-enforcer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/permission-enforcer.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { PermissionError } from "./errors.js";

describe("PermissionEnforcer", () => {
  test("unregistered plugin denied", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    expect(() => e.check("p1", { kind: "fs.read", path: "x" })).toThrow(PermissionError);
  });

  test("trusted tier denies all external ops", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "trusted" });
    expect(() => e.check("p1", { kind: "fs.read", path: "x" })).toThrow(/fs.read/);
    expect(() => e.check("p1", { kind: "net.connect", host: "a", port: 1 })).toThrow();
    expect(() => e.check("p1", { kind: "env.get", name: "X" })).toThrow();
    expect(() => e.check("p1", { kind: "exec.run", binary: "git" })).toThrow();
  });

  test("unscoped tier allows everything", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "unscoped" });
    expect(() => e.check("p1", { kind: "fs.read",   path: "/etc/passwd" })).not.toThrow();
    expect(() => e.check("p1", { kind: "net.connect", host: "a", port: 1 })).not.toThrow();
    expect(() => e.check("p1", { kind: "import", module: "node:fs" })).not.toThrow();
  });

  test("scoped tier: fs.read glob allows matching path", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", fs: { read: ["./workspace/**"] } });
    expect(() => e.check("p1", { kind: "fs.read", path: "./workspace/a.txt" })).not.toThrow();
    expect(() => e.check("p1", { kind: "fs.read", path: "./workspace/sub/b.txt" })).not.toThrow();
    expect(() => e.check("p1", { kind: "fs.read", path: "./other/a.txt" })).toThrow();
  });

  test("scoped tier: fs.write disjoint from fs.read", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", fs: { read: ["./a/**"] } });
    expect(() => e.check("p1", { kind: "fs.write", path: "./a/b.txt" })).toThrow(/fs.write/);
  });

  test("scoped tier: net.connect exact host:port", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", net: { connect: ["api.example.com:443"] } });
    expect(() => e.check("p1", { kind: "net.connect", host: "api.example.com", port: 443 })).not.toThrow();
    expect(() => e.check("p1", { kind: "net.connect", host: "api.example.com", port: 80 })).toThrow();
    expect(() => e.check("p1", { kind: "net.connect", host: "evil.com", port: 443 })).toThrow();
  });

  test("scoped tier: net.connect subdomain wildcard", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", net: { connect: ["*.example.com:443"] } });
    expect(() => e.check("p1", { kind: "net.connect", host: "api.example.com", port: 443 })).not.toThrow();
    expect(() => e.check("p1", { kind: "net.connect", host: "deep.api.example.com", port: 443 })).not.toThrow();
    expect(() => e.check("p1", { kind: "net.connect", host: "example.com", port: 443 })).toThrow();
    expect(() => e.check("p1", { kind: "net.connect", host: "notexample.com", port: 443 })).toThrow();
  });

  test("scoped tier: net.connect full wildcard allows anything", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", net: { connect: ["*"] } });
    expect(() => e.check("p1", { kind: "net.connect", host: "anything.com", port: 12345 })).not.toThrow();
  });

  test("scoped tier: env allowlist exact match", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", env: ["FOO_KEY"] });
    expect(() => e.check("p1", { kind: "env.get", name: "FOO_KEY" })).not.toThrow();
    expect(() => e.check("p1", { kind: "env.get", name: "BAR_KEY" })).toThrow();
  });

  test("scoped tier: exec.binaries name match, * means any", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", exec: { binaries: ["git", "rg"] } });
    expect(() => e.check("p1", { kind: "exec.run", binary: "git" })).not.toThrow();
    expect(() => e.check("p1", { kind: "exec.run", binary: "rg" })).not.toThrow();
    expect(() => e.check("p1", { kind: "exec.run", binary: "bash" })).toThrow();

    const e2 = new PermissionEnforcer({ mode: "enforce" });
    e2.register("p2", { tier: "scoped", exec: { binaries: ["*"] } });
    expect(() => e2.check("p2", { kind: "exec.run", binary: "anything" })).not.toThrow();
  });

  test("scoped tier: events.subscribe patterns", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", events: { subscribe: ["core-lifecycle:tool:before", "other:*"] } });
    expect(() => e.check("p1", { kind: "events.subscribe", event: "core-lifecycle:tool:before" })).not.toThrow();
    expect(() => e.check("p1", { kind: "events.subscribe", event: "other:anything" })).not.toThrow();
    expect(() => e.check("p1", { kind: "events.subscribe", event: "third:event" })).toThrow();
  });

  test("non-unscoped tier: forbidden imports denied regardless of grants", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", fs: { read: ["/**"], write: ["/**"] } });
    expect(() => e.check("p1", { kind: "import", module: "node:fs" })).toThrow(/import/);
    expect(() => e.check("p1", { kind: "import", module: "node:child_process" })).toThrow();
    expect(() => e.check("p1", { kind: "import", module: "node:worker_threads" })).toThrow();
    expect(() => e.check("p1", { kind: "import", module: "bun:ffi" })).toThrow();
  });

  test("log-only mode records but does not throw", () => {
    const e = new PermissionEnforcer({ mode: "log-only" });
    e.register("p1", { tier: "trusted" });
    const records: unknown[] = [];
    e.onDenial((r) => records.push(r));
    expect(() => e.check("p1", { kind: "fs.read", path: "x" })).not.toThrow();
    expect(records.length).toBe(1);
  });

  test("deregister removes manifest", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "unscoped" });
    e.deregister("p1");
    expect(() => e.check("p1", { kind: "fs.read", path: "x" })).toThrow();
  });

  test("default tier is trusted when omitted", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", {});
    expect(() => e.check("p1", { kind: "fs.read", path: "x" })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests; expect failure**

Run: `bun test src/core/permission-enforcer.test.ts`

Expected: all fail — module does not exist.

- [ ] **Step 3: Implement `PermissionEnforcer`**

Create `src/core/permission-enforcer.ts`:

```typescript
import type { PluginPermissions, PermissionOp } from "../types/plugin.js";
import { PermissionError } from "./errors.js";

export type EnforcerMode = "enforce" | "log-only";

export interface DenialRecord {
  ts: number;
  plugin: string;
  op: PermissionOp;
  reason: string;
}

export type DenialListener = (record: DenialRecord) => void;

const FORBIDDEN_IMPORTS_NON_UNSCOPED = new Set<string>([
  "node:fs", "fs", "node:fs/promises", "fs/promises",
  "node:child_process", "child_process",
  "node:worker_threads", "worker_threads",
  "node:vm", "vm",
  "node:module", "module",
  "node:net", "net",
  "node:dgram", "dgram",
  "node:dns", "dns",
  "node:http", "http",
  "node:https", "https",
  "node:http2", "http2",
  "node:cluster", "cluster",
  "bun:ffi",
  "bun:sqlite",
]);

export class PermissionEnforcer {
  private mode: EnforcerMode;
  private readonly manifests = new Map<string, PluginPermissions>();
  private readonly listeners: DenialListener[] = [];

  constructor(opts: { mode: EnforcerMode }) {
    this.mode = opts.mode;
  }

  setMode(mode: EnforcerMode): void { this.mode = mode; }
  getMode(): EnforcerMode { return this.mode; }

  register(plugin: string, permissions: PluginPermissions): void {
    this.manifests.set(plugin, { tier: permissions.tier ?? "trusted", ...permissions });
  }

  deregister(plugin: string): void { this.manifests.delete(plugin); }

  onDenial(listener: DenialListener): void { this.listeners.push(listener); }

  check(plugin: string, op: PermissionOp): void {
    const reason = this.evaluate(plugin, op);
    if (!reason) return;
    const record: DenialRecord = { ts: Date.now(), plugin, op, reason };
    for (const l of this.listeners) l(record);
    if (this.mode === "enforce") {
      throw new PermissionError(plugin, op.kind, reason);
    }
  }

  /** Returns a denial reason string, or null if permitted. */
  private evaluate(plugin: string, op: PermissionOp): string | null {
    const m = this.manifests.get(plugin);
    if (!m) return `plugin '${plugin}' is not registered with the enforcer`;

    const tier = m.tier ?? "trusted";
    if (tier === "unscoped") return null;

    if (op.kind === "import") {
      return FORBIDDEN_IMPORTS_NON_UNSCOPED.has(op.module)
        ? `module '${op.module}' is forbidden in tier '${tier}'`
        : null;
    }

    if (tier === "trusted") return `tier 'trusted' permits no external ops (attempted ${op.kind})`;

    // tier === "scoped" — check grant lists
    switch (op.kind) {
      case "fs.read":  return matchesGlob(m.fs?.read  ?? [], op.path) ? null : `path '${op.path}' not in fs.read grants`;
      case "fs.write": return matchesGlob(m.fs?.write ?? [], op.path) ? null : `path '${op.path}' not in fs.write grants`;
      case "net.connect": {
        const target = `${op.host}:${op.port}`;
        return matchesNet(m.net?.connect ?? [], op.host, op.port)
          ? null : `host '${target}' not in net.connect grants`;
      }
      case "env.get":
        return (m.env ?? []).includes(op.name) ? null : `env var '${op.name}' not in env grants`;
      case "exec.run": {
        const binaries = m.exec?.binaries ?? [];
        if (binaries.includes("*") || binaries.includes(op.binary)) return null;
        return `binary '${op.binary}' not in exec.binaries grants`;
      }
      case "events.subscribe":
        return matchesEvent(m.events?.subscribe ?? [], op.event)
          ? null : `event '${op.event}' not in events.subscribe grants`;
    }
  }
}

// Glob match (minimal): supports **, *, ?; matches full string.
function matchesGlob(patterns: string[], path: string): boolean {
  if (patterns.length === 0) return false;
  for (const pat of patterns) {
    const rx = globToRegex(pat);
    if (rx.test(path)) return true;
  }
  return false;
}

function globToRegex(pat: string): RegExp {
  let rx = "^";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === "*" && pat[i + 1] === "*") {  // **
      rx += ".*"; i++;
    } else if (c === "*") {
      rx += "[^/]*";
    } else if (c === "?") {
      rx += "[^/]";
    } else if (/[.+^${}()|\\[\]]/.test(c)) {
      rx += "\\" + c;
    } else {
      rx += c;
    }
  }
  rx += "$";
  return new RegExp(rx);
}

function matchesNet(patterns: string[], host: string, port: number): boolean {
  for (const pat of patterns) {
    if (pat === "*") return true;
    const [patHost, patPort] = splitHostPort(pat);
    if (patPort !== "*" && Number(patPort) !== port) continue;
    if (patHost === "*") return true;
    if (patHost.startsWith("*.")) {
      const suffix = patHost.slice(2);
      if (host === suffix || host.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (patHost === host) return true;
  }
  return false;
}

function splitHostPort(pat: string): [string, string] {
  const idx = pat.lastIndexOf(":");
  if (idx < 0) return [pat, "*"];
  return [pat.slice(0, idx), pat.slice(idx + 1)];
}

function matchesEvent(patterns: string[], event: string): boolean {
  for (const pat of patterns) {
    if (pat === event) return true;
    if (pat.endsWith(":*")) {
      const prefix = pat.slice(0, -1);
      if (event.startsWith(prefix)) return true;
    }
    if (pat === "*" || pat === "*:*") return true;
  }
  return false;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/permission-enforcer.test.ts`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/permission-enforcer.ts src/core/permission-enforcer.test.ts
git commit -m "feat(core): PermissionEnforcer with tier+grant evaluation"
```

---

## Phase 2 — Per-plugin scope (AsyncLocalStorage)

### Task 3: Plugin scope module

**Files:**
- Create: `src/core/plugin-scope.ts`
- Test: `src/core/plugin-scope.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/plugin-scope.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { runInPluginScope, getCurrentPlugin, hasPluginScope } from "./plugin-scope.js";

describe("plugin-scope", () => {
  test("getCurrentPlugin outside scope returns undefined", () => {
    expect(getCurrentPlugin()).toBeUndefined();
    expect(hasPluginScope()).toBe(false);
  });

  test("runInPluginScope sets current plugin", async () => {
    await runInPluginScope("p1", async () => {
      expect(getCurrentPlugin()).toBe("p1");
      expect(hasPluginScope()).toBe(true);
    });
    expect(getCurrentPlugin()).toBeUndefined();
  });

  test("scope survives async boundaries", async () => {
    const seen: string[] = [];
    await runInPluginScope("p1", async () => {
      await new Promise((r) => setTimeout(r, 1));
      seen.push(getCurrentPlugin() ?? "none");
      await Promise.resolve();
      seen.push(getCurrentPlugin() ?? "none");
    });
    expect(seen).toEqual(["p1", "p1"]);
  });

  test("nested scopes override (inner wins)", async () => {
    const seen: string[] = [];
    await runInPluginScope("outer", async () => {
      seen.push(getCurrentPlugin() ?? "none");
      await runInPluginScope("inner", async () => {
        seen.push(getCurrentPlugin() ?? "none");
      });
      seen.push(getCurrentPlugin() ?? "none");
    });
    expect(seen).toEqual(["outer", "inner", "outer"]);
  });
});
```

- [ ] **Step 2: Run tests; expect failure**

Run: `bun test src/core/plugin-scope.test.ts`

- [ ] **Step 3: Implement `plugin-scope.ts`**

Create `src/core/plugin-scope.ts`:

```typescript
import { AsyncLocalStorage } from "async_hooks";

const als = new AsyncLocalStorage<string>();

/** Runs `fn` with `pluginName` as the current plugin in scope. */
export async function runInPluginScope<T>(pluginName: string, fn: () => Promise<T>): Promise<T> {
  return als.run(pluginName, fn);
}

/** Synchronous variant (for event handlers that return synchronously). */
export function runInPluginScopeSync<T>(pluginName: string, fn: () => T): T {
  return als.run(pluginName, fn);
}

/** Returns the plugin name in scope, or undefined if called outside any plugin scope. */
export function getCurrentPlugin(): string | undefined {
  return als.getStore();
}

export function hasPluginScope(): boolean {
  return als.getStore() !== undefined;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/plugin-scope.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-scope.ts src/core/plugin-scope.test.ts
git commit -m "feat(core): AsyncLocalStorage-based plugin scope"
```

---

## Phase 3 — Sandbox bootstrap (require patching, env proxy, fetch wrapper)

### Task 4: Sandbox bootstrap

**Files:**
- Create: `src/core/sandbox-bootstrap.ts`
- Test: `src/core/sandbox-bootstrap.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/sandbox-bootstrap.test.ts`:

```typescript
import { describe, test, expect, beforeAll } from "bun:test";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { initializeSandbox, resetSandboxForTesting } from "./sandbox-bootstrap.js";
import { runInPluginScope } from "./plugin-scope.js";

describe("sandbox-bootstrap", () => {
  test("require outside plugin scope is unchanged", () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    // Calling a normal require from outside ALS scope should not throw.
    const fs = require("node:fs");
    expect(typeof fs.readFileSync).toBe("function");
    resetSandboxForTesting();
  });

  test("require inside unscoped plugin scope permitted", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "unscoped" });
    await runInPluginScope("p1", async () => {
      const fs = require("node:fs");
      expect(typeof fs.readFileSync).toBe("function");
    });
    resetSandboxForTesting();
  });

  test("require inside trusted plugin scope denies node:fs (enforce mode)", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "trusted" });
    await runInPluginScope("p1", async () => {
      expect(() => require("node:fs")).toThrow(/Permission denied/);
    });
    resetSandboxForTesting();
  });

  test("require inside trusted plugin scope logs but allows in log-only mode", async () => {
    const enforcer = new PermissionEnforcer({ mode: "log-only" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "trusted" });
    const records: unknown[] = [];
    enforcer.onDenial((r) => records.push(r));
    await runInPluginScope("p1", async () => {
      expect(() => require("node:fs")).not.toThrow();
    });
    expect(records.length).toBeGreaterThan(0);
    resetSandboxForTesting();
  });

  test("process.env proxy inside scope returns undefined for ungranted keys", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "scoped", env: ["KAIZEN_TEST_ALLOWED"] });
    process.env["KAIZEN_TEST_ALLOWED"] = "yes";
    process.env["KAIZEN_TEST_DENIED"]  = "no";
    await runInPluginScope("p1", async () => {
      expect(process.env["KAIZEN_TEST_ALLOWED"]).toBe("yes");
      expect(process.env["KAIZEN_TEST_DENIED"]).toBeUndefined();
    });
    // outside scope, everything visible
    expect(process.env["KAIZEN_TEST_DENIED"]).toBe("no");
    resetSandboxForTesting();
  });

  test("global fetch checks net.connect grant", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "scoped", net: { connect: ["allowed.test:443"] } });
    await runInPluginScope("p1", async () => {
      await expect(fetch("https://denied.test/")).rejects.toThrow(/Permission denied/);
    });
    resetSandboxForTesting();
  });
});
```

- [ ] **Step 2: Run tests; expect failure**

Run: `bun test src/core/sandbox-bootstrap.test.ts`

- [ ] **Step 3: Implement `sandbox-bootstrap.ts`**

Create `src/core/sandbox-bootstrap.ts`:

```typescript
import { Module, createRequire } from "module";
import type { PermissionEnforcer } from "./permission-enforcer.js";
import { getCurrentPlugin } from "./plugin-scope.js";

let installed = false;
let originalRequire: typeof Module.prototype.require | null = null;
let originalFetch: typeof globalThis.fetch | null = null;
let envProxy: typeof process.env | null = null;
let originalEnv: typeof process.env | null = null;

/**
 * Install process-wide sandbox hooks. MUST be called before any plugin loads.
 * Safe to call multiple times (idempotent).
 */
export function initializeSandbox(enforcer: PermissionEnforcer): void {
  if (installed) return;
  installed = true;

  // --- Patch Module.prototype.require -------------------------------------
  originalRequire = Module.prototype.require;
  const origReq = originalRequire;
  Module.prototype.require = function patchedRequire(id: string) {
    const plugin = getCurrentPlugin();
    if (plugin) enforcer.check(plugin, { kind: "import", module: id });
    return origReq.call(this, id);
  } as typeof Module.prototype.require;

  // --- Patch global fetch -------------------------------------------------
  originalFetch = globalThis.fetch;
  const origFetch = originalFetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const plugin = getCurrentPlugin();
    if (plugin) {
      const url = typeof input === "string" ? new URL(input)
        : input instanceof URL ? input
        : new URL((input as Request).url);
      const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
      enforcer.check(plugin, { kind: "net.connect", host: url.hostname, port });
    }
    return origFetch(input, init);
  }) as typeof globalThis.fetch;

  // --- Proxy process.env --------------------------------------------------
  originalEnv = process.env;
  const origEnv = originalEnv;
  envProxy = new Proxy(origEnv, {
    get(target, prop: string | symbol) {
      if (typeof prop !== "string") return Reflect.get(target, prop);
      const plugin = getCurrentPlugin();
      if (!plugin) return target[prop];
      try {
        enforcer.check(plugin, { kind: "env.get", name: prop });
        return target[prop];
      } catch {
        return undefined;
      }
    },
    has(target, prop: string | symbol) {
      if (typeof prop !== "string") return Reflect.has(target, prop);
      const plugin = getCurrentPlugin();
      if (!plugin) return prop in target;
      try {
        enforcer.check(plugin, { kind: "env.get", name: prop });
        return prop in target;
      } catch {
        return false;
      }
    },
    ownKeys(target) {
      const plugin = getCurrentPlugin();
      if (!plugin) return Reflect.ownKeys(target);
      const keys = Reflect.ownKeys(target);
      return keys.filter((k) => {
        if (typeof k !== "string") return true;
        try { enforcer.check(plugin, { kind: "env.get", name: k }); return true; }
        catch { return false; }
      });
    },
  }) as typeof process.env;
  Object.defineProperty(process, "env", {
    configurable: true,
    get: () => envProxy!,
  });
}

/** Test-only: restore the unpatched runtime. Do NOT call from production code. */
export function resetSandboxForTesting(): void {
  if (!installed) return;
  if (originalRequire) Module.prototype.require = originalRequire;
  if (originalFetch) globalThis.fetch = originalFetch;
  if (originalEnv) {
    Object.defineProperty(process, "env", {
      configurable: true, writable: true, enumerable: true, value: originalEnv,
    });
  }
  installed = false;
  originalRequire = null;
  originalFetch = null;
  originalEnv = null;
  envProxy = null;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/sandbox-bootstrap.test.ts`

Expected: pass. If `fetch` test fails because Bun intercepts it differently than expected, the test harness may need `globalThis.fetch = originalFetch` directly; record the deviation.

- [ ] **Step 5: Commit**

```bash
git add src/core/sandbox-bootstrap.ts src/core/sandbox-bootstrap.test.ts
git commit -m "feat(core): sandbox bootstrap — require/fetch/env hooks"
```

---

## Phase 4 — ctx.* I/O surface

### Task 5: Plugin ctx.* I/O surface

**Files:**
- Create: `src/core/plugin-ctx-io.ts`
- Test: `src/core/plugin-ctx-io.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/plugin-ctx-io.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { createCtxIo } from "./plugin-ctx-io.js";
import { runInPluginScope } from "./plugin-scope.js";
import { initializeSandbox, resetSandboxForTesting } from "./sandbox-bootstrap.js";

describe("createCtxIo", () => {
  afterEach(() => resetSandboxForTesting());

  test("ctx.fs.readText reads within grant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaizen-ctx-"));
    writeFileSync(join(dir, "a.txt"), "hello");
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "scoped", fs: { read: [`${dir}/**`] } });
    const ctx = createCtxIo("p1", enforcer);
    await runInPluginScope("p1", async () => {
      expect(await ctx.fs.readText(join(dir, "a.txt"))).toBe("hello");
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("ctx.fs.readText throws outside grant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaizen-ctx-"));
    writeFileSync(join(dir, "a.txt"), "hello");
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "trusted" });
    const ctx = createCtxIo("p1", enforcer);
    await runInPluginScope("p1", async () => {
      await expect(ctx.fs.readText(join(dir, "a.txt"))).rejects.toThrow(/Permission denied/);
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("ctx.secrets.get honors env grant", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "scoped", env: ["KAIZEN_CTX_ALLOWED"] });
    process.env["KAIZEN_CTX_ALLOWED"] = "yes";
    process.env["KAIZEN_CTX_DENIED"]  = "no";
    const ctx = createCtxIo("p1", enforcer);
    await runInPluginScope("p1", async () => {
      expect(ctx.secrets.get("KAIZEN_CTX_ALLOWED")).toBe("yes");
      expect(ctx.secrets.get("KAIZEN_CTX_DENIED")).toBeUndefined();
    });
  });

  test("ctx.exec.run denied without grant", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "trusted" });
    const ctx = createCtxIo("p1", enforcer);
    await runInPluginScope("p1", async () => {
      await expect(ctx.exec.run("echo", ["hi"])).rejects.toThrow(/Permission denied/);
    });
  });

  test("ctx.exec.run permitted with grant", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "scoped", exec: { binaries: ["echo"] } });
    const ctx = createCtxIo("p1", enforcer);
    await runInPluginScope("p1", async () => {
      const result = await ctx.exec.run("echo", ["hello-world"]);
      expect(result.stdout.trim()).toBe("hello-world");
      expect(result.exitCode).toBe(0);
    });
  });

  test("ctx.log prefixes with plugin name", () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    enforcer.register("p1", { tier: "trusted" });
    const ctx = createCtxIo("p1", enforcer);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => { logs.push(args.join(" ")); };
    try {
      ctx.log.info("hello");
    } finally { console.log = origLog; }
    expect(logs[0]).toContain("[p1]");
    expect(logs[0]).toContain("hello");
  });
});
```

- [ ] **Step 2: Run tests; expect failure**

Run: `bun test src/core/plugin-ctx-io.test.ts`

- [ ] **Step 3: Implement `plugin-ctx-io.ts`**

Create `src/core/plugin-ctx-io.ts`:

```typescript
import { readFile, writeFile, readdir, stat } from "fs/promises";
import type { Stats } from "fs";
import { spawn } from "child_process";
import type { PermissionEnforcer } from "./permission-enforcer.js";

export interface CtxFs {
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  write(path: string, data: Uint8Array | string): Promise<void>;
  list(path: string): Promise<string[]>;
  stat(path: string): Promise<Stats>;
}

export interface CtxNet {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface CtxSecrets {
  get(name: string): string | undefined;
  has(name: string): boolean;
}

export interface ExecOpts {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CtxExec {
  run(binary: string, args: string[], opts?: ExecOpts): Promise<ExecResult>;
}

export interface CtxLog {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface CtxIo {
  fs: CtxFs;
  net: CtxNet;
  secrets: CtxSecrets;
  exec: CtxExec;
  log: CtxLog;
}

export function createCtxIo(plugin: string, enforcer: PermissionEnforcer): CtxIo {
  return {
    fs: {
      async read(path)     { enforcer.check(plugin, { kind: "fs.read",  path }); return new Uint8Array(await readFile(path)); },
      async readText(path) { enforcer.check(plugin, { kind: "fs.read",  path }); return await readFile(path, "utf8"); },
      async write(path, data) { enforcer.check(plugin, { kind: "fs.write", path }); await writeFile(path, data); },
      async list(path)     { enforcer.check(plugin, { kind: "fs.read",  path }); return await readdir(path); },
      async stat(path)     { enforcer.check(plugin, { kind: "fs.read",  path }); return await stat(path); },
    },

    net: {
      async fetch(url, init) {
        const u = new URL(url);
        const port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
        enforcer.check(plugin, { kind: "net.connect", host: u.hostname, port });
        return await fetch(url, init);
      },
    },

    secrets: {
      get(name)  { try { enforcer.check(plugin, { kind: "env.get", name }); return process.env[name]; } catch { return undefined; } },
      has(name)  { try { enforcer.check(plugin, { kind: "env.get", name }); return name in process.env; } catch { return false; } },
    },

    exec: {
      async run(binary, args, opts = {}) {
        enforcer.check(plugin, { kind: "exec.run", binary });
        return await new Promise<ExecResult>((resolve, reject) => {
          const proc = spawn(binary, args, { cwd: opts.cwd });
          let stdout = "", stderr = "";
          proc.stdout.on("data", (c) => { stdout += c.toString(); });
          proc.stderr.on("data", (c) => { stderr += c.toString(); });
          proc.on("error", reject);
          proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
          if (opts.input !== undefined) { proc.stdin.write(opts.input); proc.stdin.end(); }
          if (opts.timeoutMs) setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs);
        });
      },
    },

    log: {
      debug: (msg, meta) => console.log(`[${plugin}] debug: ${msg}`, meta ?? ""),
      info:  (msg, meta) => console.log(`[${plugin}] info: ${msg}`, meta ?? ""),
      warn:  (msg, meta) => console.error(`[${plugin}] warn: ${msg}`, meta ?? ""),
      error: (msg, meta) => console.error(`[${plugin}] error: ${msg}`, meta ?? ""),
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/plugin-ctx-io.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-ctx-io.ts src/core/plugin-ctx-io.test.ts
git commit -m "feat(core): ctx.{fs,net,secrets,exec,log} surface with permission checks"
```

---

## Phase 5 — AST entry-file import pre-check

### Task 6: Manifest import scanner

**Files:**
- Create: `src/core/manifest-import-scan.ts`
- Test: `src/core/manifest-import-scan.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/manifest-import-scan.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { scanPluginEntryImports } from "./manifest-import-scan.js";

function writeTmp(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kaizen-scan-"));
  const file = join(dir, "index.ts");
  writeFileSync(file, contents);
  return file;
}

describe("scanPluginEntryImports", () => {
  test("empty file has no imports", () => {
    const f = writeTmp("export const x = 1;");
    expect(scanPluginEntryImports(f)).toEqual([]);
  });

  test("detects ESM import specifiers", () => {
    const f = writeTmp(`
      import fs from "node:fs";
      import { join } from "path";
      import * as os from "os";
      export const x = fs;
    `);
    const imports = scanPluginEntryImports(f);
    expect(imports).toContain("node:fs");
    expect(imports).toContain("path");
    expect(imports).toContain("os");
  });

  test("detects require() calls", () => {
    const f = writeTmp(`
      const fs = require("node:fs");
      const cp = require("child_process");
    `);
    const imports = scanPluginEntryImports(f);
    expect(imports).toContain("node:fs");
    expect(imports).toContain("child_process");
  });

  test("ignores dynamic imports with computed strings", () => {
    const f = writeTmp(`
      const mod = "fs";
      const fs = require(mod);  // we can't resolve this statically
    `);
    // Should not crash; may or may not detect. At minimum must not throw.
    expect(() => scanPluginEntryImports(f)).not.toThrow();
  });

  test("returns deduped list", () => {
    const f = writeTmp(`
      import fs from "node:fs";
      import { x } from "node:fs";
    `);
    const imports = scanPluginEntryImports(f);
    expect(imports.filter((m) => m === "node:fs").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests; expect failure**

- [ ] **Step 3: Implement `manifest-import-scan.ts`**

Create `src/core/manifest-import-scan.ts`:

```typescript
import { readFileSync } from "fs";

/**
 * Regex-based import scan. Not a full AST parser — we're looking for escape hatches,
 * not doing semantic analysis. Obfuscated or dynamic imports are caught at runtime
 * by the require patch.
 */
export function scanPluginEntryImports(filePath: string): string[] {
  const src = readFileSync(filePath, "utf8");
  const found = new Set<string>();

  // ESM: import ... from "specifier";  /  import "specifier";
  const importRe = /\bimport\s+(?:[^'"]*?\bfrom\s+)?["']([^"']+)["']/g;
  for (const m of src.matchAll(importRe)) found.add(m[1]!);

  // ESM dynamic: import("specifier")
  const dynImportRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of src.matchAll(dynImportRe)) found.add(m[1]!);

  // CJS: require("specifier")
  const requireRe = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of src.matchAll(requireRe)) found.add(m[1]!);

  return Array.from(found);
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/manifest-import-scan.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/manifest-import-scan.ts src/core/manifest-import-scan.test.ts
git commit -m "feat(core): entry-file import scanner"
```

---

## Phase 6 — Audit trail

### Task 7: Audit log writer

**Files:**
- Create: `src/core/audit-log.ts`
- Test: `src/core/audit-log.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/audit-log.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AuditLog } from "./audit-log.js";

describe("AuditLog", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("writes JSONL record", async () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-audit-"));
    const log = new AuditLog({ rootDir: dir, sessionId: "abc" });
    log.record({ ts: 1, plugin: "p1", op: { kind: "fs.read", path: "x" }, reason: "nope" });
    await log.flush();
    const content = readFileSync(join(dir, "abc.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.plugin).toBe("p1");
    expect(parsed.reason).toBe("nope");
  });

  test("appends multiple records", async () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-audit-"));
    const log = new AuditLog({ rootDir: dir, sessionId: "abc" });
    log.record({ ts: 1, plugin: "p1", op: { kind: "fs.read", path: "x" }, reason: "a" });
    log.record({ ts: 2, plugin: "p2", op: { kind: "fs.read", path: "y" }, reason: "b" });
    await log.flush();
    const lines = readFileSync(join(dir, "abc.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
  });

  test("disabled mode writes nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-audit-"));
    const log = new AuditLog({ rootDir: dir, sessionId: "abc", enabled: false });
    log.record({ ts: 1, plugin: "p1", op: { kind: "fs.read", path: "x" }, reason: "nope" });
    await log.flush();
    expect(() => readFileSync(join(dir, "abc.jsonl"), "utf8")).toThrow();
  });
});
```

- [ ] **Step 2: Run tests; expect failure**

- [ ] **Step 3: Implement `audit-log.ts`**

Create `src/core/audit-log.ts`:

```typescript
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import type { DenialRecord } from "./permission-enforcer.js";

export interface AuditLogOpts {
  rootDir: string;           // e.g. "./.kaizen/audit"
  sessionId: string;
  enabled?: boolean;         // default true
}

export class AuditLog {
  private readonly path: string;
  private readonly enabled: boolean;
  private buffer: string[] = [];

  constructor(opts: AuditLogOpts) {
    this.enabled = opts.enabled !== false;
    if (this.enabled) mkdirSync(opts.rootDir, { recursive: true });
    this.path = join(opts.rootDir, `${opts.sessionId}.jsonl`);
  }

  record(r: DenialRecord): void {
    if (!this.enabled) return;
    this.buffer.push(JSON.stringify(r));
    if (this.buffer.length >= 32) this.flushSync();
  }

  flushSync(): void {
    if (!this.enabled || this.buffer.length === 0) return;
    appendFileSync(this.path, this.buffer.join("\n") + "\n");
    this.buffer = [];
  }

  async flush(): Promise<void> { this.flushSync(); }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/audit-log.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/audit-log.ts src/core/audit-log.test.ts
git commit -m "feat(core): audit log JSONL writer"
```

---

## Phase 7 — Wire into PluginManager (log-only mode)

### Task 8: Extend PluginContext + thread enforcer

**Files:**
- Modify: `src/types/plugin.ts`
- Modify: `src/core/context.ts`

- [ ] **Step 1: Add ctx I/O to PluginContext**

In `src/types/plugin.ts`, import the new types and extend `PluginContext`:

```typescript
// Near the top, alongside existing type exports:
export type { CtxFs, CtxNet, CtxSecrets, CtxExec, CtxLog, CtxIo, ExecOpts, ExecResult } from "../core/plugin-ctx-io.js";
```

Add fields to `PluginContext` (inside the interface, after the existing methods):

```typescript
  // --- Permission-gated I/O surface ---------------------------------------
  fs: import("../core/plugin-ctx-io.js").CtxFs;
  net: import("../core/plugin-ctx-io.js").CtxNet;
  secrets: import("../core/plugin-ctx-io.js").CtxSecrets;
  exec: import("../core/plugin-ctx-io.js").CtxExec;
```

(Keep existing `log(msg: string)` for back-compat; add structured `log` as new ctx surface later if needed.)

- [ ] **Step 2: Thread enforcer through `createPluginContext`**

In `src/core/context.ts`, add an `enforcer: PermissionEnforcer` parameter and build the ctx I/O:

```typescript
import type { PermissionEnforcer } from "./permission-enforcer.js";
import { createCtxIo } from "./plugin-ctx-io.js";
```

Add `enforcer` to the `createPluginContext` parameter list (just before `getState`). Inside the returned object, construct and spread the I/O surface:

```typescript
  const io = createCtxIo(pluginName, enforcer);
  return {
    // ... existing fields ...
    fs: io.fs,
    net: io.net,
    secrets: io.secrets,
    exec: io.exec,
    // ... existing runtime etc ...
  };
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`

Expected: `context.ts` and `plugin.ts` compile. `plugin-manager.ts` will fail because it calls `createPluginContext` without an enforcer — fixed in Task 9.

- [ ] **Step 4: Commit**

```bash
git add src/types/plugin.ts src/core/context.ts
git commit -m "feat(core): PluginContext gains fs/net/secrets/exec surface"
```

---

### Task 9: Thread enforcer through PluginManager; ALS-wrap plugin calls

**Files:**
- Modify: `src/core/plugin-manager.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 1: Add enforcer + audit-log constructor params**

In `src/core/plugin-manager.ts`, add to the `PluginManager` constructor parameters (alongside the other registries):

```typescript
import type { PermissionEnforcer } from "./permission-enforcer.js";
import type { AuditLog } from "./audit-log.js";
import { runInPluginScope } from "./plugin-scope.js";
import { scanPluginEntryImports } from "./manifest-import-scan.js";
```

Add `private readonly enforcer: PermissionEnforcer` and `private readonly auditLog: AuditLog` alongside the existing registries. Wire through constructor.

- [ ] **Step 2: Register/deregister manifest in load/unload paths**

In `PluginManager.initialize()` (and `load()`), after resolving the plugin but before calling `setup()`, register its manifest with the enforcer:

```typescript
this.enforcer.register(plugin.name, plugin.permissions ?? { tier: "trusted" });
```

Also, hook the enforcer's denial listener to the audit log once during bootstrap:

```typescript
this.enforcer.onDenial((r) => this.auditLog.record(r));
```

In `unload(name)`, add:

```typescript
this.enforcer.deregister(name);
```

- [ ] **Step 3: Wrap setup/start in ALS scope**

Change the `setupPlugin()` or equivalent invocation site so that `setup()` runs inside `runInPluginScope(plugin.name, ...)`. Example:

```typescript
// Before:
await plugin.setup(ctx);

// After:
await runInPluginScope(plugin.name, async () => plugin.setup(ctx));
```

Same for `start()` in the lifecycle-provider invocation path.

- [ ] **Step 4: Wrap event handler registration**

In `src/core/event-bus.ts` (or wherever handlers are registered), change handler registration to wrap the handler in `runInPluginScope(pluginName, handler)`. Read the file first to find the registration site; look for `this.handlers.push({ plugin, handler })` or similar. Wrap at *register time* so the wrapper is what gets called:

```typescript
const wrapped: EventHandler = (payload) => runInPluginScope(pluginName, () => handler(payload));
this.handlers.push({ plugin: pluginName, handler: wrapped });
```

- [ ] **Step 5: Add entry-file import scan (log-only)**

In `plugin-manager.ts`, after resolving the plugin's file path but before calling `setup()`, run:

```typescript
const imports = scanPluginEntryImports(resolvedPath);
for (const mod of imports) {
  this.enforcer.check(plugin.name, { kind: "import", module: mod });
}
```

In log-only mode this records violations to the audit log; in enforce mode (not yet the default) it throws.

- [ ] **Step 6: Instantiate enforcer + audit log in core bootstrap**

In `src/core/index.ts`, before creating `PluginManager`, add:

```typescript
import { PermissionEnforcer } from "./permission-enforcer.js";
import { AuditLog } from "./audit-log.js";
import { initializeSandbox } from "./sandbox-bootstrap.js";
import { randomUUID } from "crypto";

const enforcer = new PermissionEnforcer({ mode: "log-only" });
initializeSandbox(enforcer);
const auditLog = new AuditLog({
  rootDir: join(process.cwd(), ".kaizen", "audit"),
  sessionId: randomUUID(),
});
```

Pass `enforcer` and `auditLog` to `PluginManager`'s constructor. Pass `enforcer` to `createPluginContext` (via whatever factory call chain exists).

- [ ] **Step 7: Run core tests**

Run: `bun test src/core/`

Expected: existing tests pass; new tests pass; plugin-manager tests may need small updates to pass the enforcer to their test fixtures.

- [ ] **Step 8: Run full test suite**

Run: `bun test`

Expected: all pass. If a built-in plugin's event handler or setup registers imports that get logged as violations, that's *expected* — we're in log-only mode and this is the data we want. Check `./.kaizen/audit/<session>.jsonl` after running the default harness to verify denials are being captured.

- [ ] **Step 9: Run default harness end-to-end**

Run: `bun src/cli.ts --harness core-debug` (any harness with no external dependencies).

Expected: session runs normally. Inspect `./.kaizen/audit/<session>.jsonl`: should contain denial records for every built-in plugin's attempted `import`/`fs`/`env` calls that would violate a TRUSTED manifest (since none have declared permissions yet). This is the baseline "observed behavior" that will drive built-in migration in Plan 3.

- [ ] **Step 10: Commit**

```bash
git add src/core/plugin-manager.ts src/core/index.ts src/core/event-bus.ts
git commit -m "feat(core): wire enforcer into PluginManager in log-only mode"
```

---

## Phase 8 — End-to-end verification

### Task 10: Full verification + checkpoint

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`

Expected: zero errors.

- [ ] **Step 2: Full test suite**

Run: `bun test`

Expected: all pass.

- [ ] **Step 3: Integration tests**

Run: `bun run test:core`

Expected: all pass.

- [ ] **Step 4: Default harness**

Run: `bun src/cli.ts --harness core-debug`

Expected: session opens, accepts input, runs, exits cleanly.

- [ ] **Step 5: Inspect audit log**

Run: `ls ./.kaizen/audit/` — should show one JSONL file per session.

Open the most recent one. Expect JSONL records showing denials from built-ins (they have no declared permissions yet, so TRUSTED-default manifest denies everything they attempt). This is the input data for Plan 3 (built-in migration).

- [ ] **Step 6: Checkpoint commit**

```bash
git commit --allow-empty -m "chore: plan 1 (enforcer core) — end-to-end verified in log-only mode"
```

---

## Deferred to Plans 2 and 3

- **Plan 2:** lockfile format, hash computation, UAC rendering, `kaizen install` / `plugin consent` / `plugin review` commands, lockfile enforcement.
- **Plan 3:** `kaizen plugin dev --observe` mode, built-in plugin migration (10 plugins), flip enforcer default from `log-only` to `enforce`, README security-model section.

### Deviation log (update this during implementation)

Plans 2 and 3 are written against the assumptions below. **If an implementation
task diverges from any of these, append a note here so Plans 2 and 3 can be
updated before they run.**

Assumptions Plans 2/3 rely on:
- `PluginPermissions` shape as defined in Task 1 (tier + fs/net/env/exec/events).
- `PermissionEnforcer` public API: `register(plugin, manifest)`, `deregister(plugin)`,
  `check(plugin, op)`, `setMode("enforce" | "log-only")`, `onDenial(listener)`.
- `PermissionOp` discriminated union kinds: `fs.read`, `fs.write`, `net.connect`,
  `env.get`, `exec.run`, `events.subscribe`, `import`.
- `createCtxIo(plugin, enforcer)` returns the `CtxIo` shape with `fs`/`net`/`secrets`/`exec`/`log`.
- `runInPluginScope(pluginName, fn)` wraps plugin entry points.
- `AuditLog` constructor shape: `{ rootDir, sessionId, enabled? }` with `record(DenialRecord)` and `flushSync()`/`flush()`.
- Enforcer default mode after bootstrap: `log-only` (Plan 3 flips this).
- `DenialRecord` shape: `{ ts, plugin, op, reason }`.

**Deviations observed during implementation:**

- **Task 9 — `loadPluginFromPath` return type changed**: To enable import scanning with the resolved path, `loadPluginFromPath` and `resolvePlugin` now return `{ plugin, resolvedPath }` instead of `KaizenPlugin | null`. Callers in `initialize()` and `load()` destructure accordingly. No external API impact.

- **Task 9 — `setupPlugin` takes optional `resolvedPath`**: Import scan is performed inside `setupPlugin` (after `enforcer.register`) rather than inline in the call sites, so the plugin is registered before its imports are checked. Signature: `setupPlugin(plugin, resolvedPath = "")`.

- **Task 9 — Builtin plugins get empty `resolvedPath`**: Builtins are injected as in-memory objects; there is no file path to scan. `resolvePlugin` returns `resolvedPath: ""` for builtins, and scan is skipped when the string is empty. Real enforcement happens at runtime via the require patch.

- **Task 9 — Harness end-to-end skipped**: `src/cli.ts` references `core-plugin-manager` package which is not installed (pre-existing issue, also visible in typecheck output). No `.kaizen/audit/` output generated. The enforcer + audit plumbing is wired correctly; the harness failure is unrelated to Task 9.


---

## Notes for the Implementing Engineer

1. **Log-only mode is the safety valve.** Plan 1 must ship with `enforcer.setMode("log-only")` as the default. Enforce-mode becomes the default in Plan 3 after built-ins are migrated. This lets Plan 1 land without breaking anything.
2. **The require-patch is install-once.** Do not attempt to install it per-plugin or un-install between plugins. The interceptor reads the current plugin from ALS at call time; that's the per-plugin behavior.
3. **ALS wrapping happens at registration time for event handlers**, not at emit time. If you wrap at emit time, you lose the originating plugin's identity.
4. **Bun has `AsyncLocalStorage`** via `node:async_hooks`. It's compatible with Bun's async primitives. If a test fails because ALS context drops across an await, that's a legitimate bug — investigate before working around.
5. **The `fetch` patch replaces `globalThis.fetch`.** In Bun this is the same as Node 20+ — a single global reference. Third-party HTTP libraries that capture fetch at module-load time before the sandbox initializes will escape this patch; not a concern for Plan 1 since no plugin has done this today.
6. **Do not change plugin-author-visible behavior in Plan 1.** Existing plugins must keep working. All enforcement is log-only. All new ctx surfaces are additive.
7. **Audit-log filename is `<session-id>.jsonl`.** Session ID is generated at core bootstrap. Multiple processes running concurrently get distinct files.
