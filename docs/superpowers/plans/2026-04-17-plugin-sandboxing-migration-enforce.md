# Plugin Sandboxing — Plan 3: Observe Mode, Built-in Migration & Enforce Default

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `--observe` developer tool that generates permission manifests from observed plugin behavior (lever 3 from the design). Migrate all built-in plugins to declared permission tiers. Flip the enforcer default from `log-only` to `enforce`. Document the security model in the README (lever 5).

**Architecture:** `--observe` mode adds a new enforcer mode (`observe`) that records every permission check (including allows) to a dedicated JSONL observation log, then post-processes the log into a minimal proposed manifest. Each built-in plugin gets a declared `permissions` block and — where needed — its I/O ported from raw Node APIs to `ctx.*`. `core-executor-shell` ships UNSCOPED (this is the fix for Finding 7). Final task flips the enforcer default and smoke-tests the default harness end-to-end.

**Tech Stack:** TypeScript, Bun.

**Prerequisites:** Plans 1 and 2 must be complete and merged. Check both plans' Deviation Logs before starting — assumptions listed there may affect task details below.

**Spec deviation flagged up front:** the spec table lists `core-ui-terminal` as SCOPED with TTY permissions. Plan 1's enforcer does **not** intercept `process.stdin` / `process.stdout` — only `node:fs` via the require patch and `fetch` via the global wrapper. TTY read/write therefore bypasses enforcement regardless of declared tier. Plan 3 migrates `core-ui-terminal` as TRUSTED and documents the TTY limitation in the README security section. Revisit if a stdin/stdout enforcement primitive becomes important later.

**Related:**
- Spec: `docs/superpowers/specs/2026-04-17-plugin-sandboxing-design.md`
- Plan 1: `docs/superpowers/plans/2026-04-17-plugin-sandboxing-enforcer-core.md`
- Plan 2: `docs/superpowers/plans/2026-04-17-plugin-sandboxing-lockfile-consent.md`

---

## File Structure

**New files:**
- `src/core/observe-recorder.ts` — records every enforcer check (allow + deny) to JSONL
- `src/core/observe-recorder.test.ts`
- `src/core/manifest-synthesizer.ts` — collapses observation log into a minimal proposed manifest
- `src/core/manifest-synthesizer.test.ts`
- `src/commands/plugin-dev.ts` — `kaizen plugin dev --observe` handler
- `README.md` — security-model section (Finding 16 partial fix)

**Modified files:**
- `src/core/permission-enforcer.ts` — add `observe` mode (records both allow + deny to listener; never throws)
- Each built-in plugin's `index.ts` — add `permissions` block; port raw I/O to `ctx.*` where needed
- `src/core/index.ts` — flip enforcer default from `log-only` to `enforce`

---

## Phase 1 — Observe Mode

### Task 1: Enforcer `observe` mode + observation recorder

**Files:**
- Modify: `src/core/permission-enforcer.ts`
- Modify: `src/core/permission-enforcer.test.ts`
- Create: `src/core/observe-recorder.ts`
- Create: `src/core/observe-recorder.test.ts`

- [ ] **Step 1: Add `observe` mode to `EnforcerMode`**

Modify `src/core/permission-enforcer.ts`:

```typescript
export type EnforcerMode = "enforce" | "log-only" | "observe";
```

Add an `onCheck` listener slot alongside `onDenial`:

```typescript
export type CheckRecord = {
  ts: number; plugin: string; op: PermissionOp; allowed: boolean; reason?: string;
};
export type CheckListener = (record: CheckRecord) => void;

// inside class:
private readonly checkListeners: CheckListener[] = [];
onCheck(listener: CheckListener): void { this.checkListeners.push(listener); }
```

Modify `check()` to notify check listeners in `observe` mode:

```typescript
check(plugin: string, op: PermissionOp): void {
  const reason = this.evaluate(plugin, op);
  const allowed = reason === null;
  if (this.mode === "observe") {
    for (const l of this.checkListeners) l({ ts: Date.now(), plugin, op, allowed, reason: reason ?? undefined });
    return;  // observe never throws, always allows
  }
  if (allowed) return;
  const record: DenialRecord = { ts: Date.now(), plugin, op, reason: reason! };
  for (const l of this.listeners) l(record);
  if (this.mode === "enforce") throw new PermissionError(plugin, op.kind, reason!);
}
```

- [ ] **Step 2: Add tests for `observe` mode**

Append to `src/core/permission-enforcer.test.ts`:

```typescript
test("observe mode notifies onCheck for both allows and denies", () => {
  const e = new PermissionEnforcer({ mode: "observe" });
  e.register("p1", { tier: "scoped", env: ["OK"] });
  const checks: { allowed: boolean; op: string }[] = [];
  e.onCheck((r) => checks.push({ allowed: r.allowed, op: r.op.kind }));
  e.check("p1", { kind: "env.get", name: "OK" });       // allow
  e.check("p1", { kind: "env.get", name: "DENY" });     // deny
  expect(checks).toEqual([
    { allowed: true,  op: "env.get" },
    { allowed: false, op: "env.get" },
  ]);
});

test("observe mode never throws", () => {
  const e = new PermissionEnforcer({ mode: "observe" });
  e.register("p1", { tier: "trusted" });
  expect(() => e.check("p1", { kind: "fs.read", path: "x" })).not.toThrow();
});
```

Run: `bun test src/core/permission-enforcer.test.ts` — expect pass.

- [ ] **Step 3: Implement `observe-recorder.ts`**

Create `src/core/observe-recorder.ts`:

```typescript
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import type { CheckRecord } from "./permission-enforcer.js";

export class ObserveRecorder {
  private readonly path: string;
  private buffer: string[] = [];

  constructor(rootDir: string, sessionId: string) {
    mkdirSync(rootDir, { recursive: true });
    this.path = join(rootDir, `observe-${sessionId}.jsonl`);
  }

  record(r: CheckRecord): void {
    this.buffer.push(JSON.stringify(r));
    if (this.buffer.length >= 32) this.flushSync();
  }

  flushSync(): void {
    if (this.buffer.length === 0) return;
    appendFileSync(this.path, this.buffer.join("\n") + "\n");
    this.buffer = [];
  }

  path_(): string { return this.path; }
}
```

- [ ] **Step 4: Write tests**

Create `src/core/observe-recorder.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ObserveRecorder } from "./observe-recorder.js";

describe("ObserveRecorder", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("writes each record to JSONL", () => {
    dir = mkdtempSync(join(tmpdir(), "obs-"));
    const r = new ObserveRecorder(dir, "s1");
    r.record({ ts: 1, plugin: "p1", op: { kind: "fs.read", path: "a" }, allowed: true });
    r.record({ ts: 2, plugin: "p1", op: { kind: "env.get", name: "K" }, allowed: false, reason: "nope" });
    r.flushSync();
    const lines = readFileSync(r.path_(), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).allowed).toBe(true);
    expect(JSON.parse(lines[1]!).allowed).toBe(false);
  });
});
```

Run: `bun test src/core/observe-recorder.test.ts` — expect pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/permission-enforcer.ts src/core/permission-enforcer.test.ts src/core/observe-recorder.ts src/core/observe-recorder.test.ts
git commit -m "feat(core): observe mode + observation recorder"
```

---

### Task 2: Manifest synthesizer

**Files:**
- Create: `src/core/manifest-synthesizer.ts`
- Test: `src/core/manifest-synthesizer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/manifest-synthesizer.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { synthesizeManifest } from "./manifest-synthesizer.js";
import type { CheckRecord } from "./permission-enforcer.js";

function rec(plugin: string, op: CheckRecord["op"]): CheckRecord {
  return { ts: 0, plugin, op, allowed: true };
}

describe("synthesizeManifest", () => {
  test("trusted when no external ops observed", () => {
    const m = synthesizeManifest("p1", []);
    expect(m.tier).toBe("trusted");
  });

  test("scoped with net+env when ops observed", () => {
    const records: CheckRecord[] = [
      rec("p1", { kind: "net.connect", host: "api.example.com", port: 443 }),
      rec("p1", { kind: "env.get", name: "API_KEY" }),
    ];
    const m = synthesizeManifest("p1", records);
    expect(m.tier).toBe("scoped");
    expect(m.net?.connect).toContain("api.example.com:443");
    expect(m.env).toContain("API_KEY");
  });

  test("dedupes repeated ops", () => {
    const records: CheckRecord[] = [
      rec("p1", { kind: "env.get", name: "K" }),
      rec("p1", { kind: "env.get", name: "K" }),
    ];
    expect(synthesizeManifest("p1", records).env).toEqual(["K"]);
  });

  test("ignores other plugins' records", () => {
    const records: CheckRecord[] = [
      rec("other", { kind: "env.get", name: "K" }),
    ];
    expect(synthesizeManifest("p1", records).tier).toBe("trusted");
  });

  test("fs.read paths collected verbatim (not collapsed to globs)", () => {
    const records: CheckRecord[] = [
      rec("p1", { kind: "fs.read", path: "./workspace/a.txt" }),
      rec("p1", { kind: "fs.read", path: "./workspace/b.txt" }),
    ];
    const m = synthesizeManifest("p1", records);
    expect(m.fs?.read).toContain("./workspace/a.txt");
    expect(m.fs?.read).toContain("./workspace/b.txt");
  });

  test("exec binary collected by name", () => {
    const records: CheckRecord[] = [
      rec("p1", { kind: "exec.run", binary: "git" }),
      rec("p1", { kind: "exec.run", binary: "rg" }),
    ];
    expect(synthesizeManifest("p1", records).exec?.binaries).toEqual(["git", "rg"]);
  });

  test("events.subscribe collected", () => {
    const records: CheckRecord[] = [
      rec("p1", { kind: "events.subscribe", event: "core-lifecycle:tool:before" }),
    ];
    expect(synthesizeManifest("p1", records).events?.subscribe).toEqual(["core-lifecycle:tool:before"]);
  });
});
```

- [ ] **Step 2: Implement `manifest-synthesizer.ts`**

Create `src/core/manifest-synthesizer.ts`:

```typescript
import type { CheckRecord } from "./permission-enforcer.js";
import type { PluginPermissions } from "../types/plugin.js";

/**
 * Collapse a set of observed check records for one plugin into a minimal
 * permission manifest. Paths/hosts are listed verbatim — glob collapsing is
 * left to the author to do by hand (better signal than fuzzy heuristics).
 */
export function synthesizeManifest(pluginName: string, records: CheckRecord[]): PluginPermissions {
  const fsRead = new Set<string>();
  const fsWrite = new Set<string>();
  const netConnect = new Set<string>();
  const env = new Set<string>();
  const execBinaries = new Set<string>();
  const eventsSubscribe = new Set<string>();

  for (const r of records) {
    if (r.plugin !== pluginName) continue;
    switch (r.op.kind) {
      case "fs.read":          fsRead.add(r.op.path); break;
      case "fs.write":         fsWrite.add(r.op.path); break;
      case "net.connect":      netConnect.add(`${r.op.host}:${r.op.port}`); break;
      case "env.get":          env.add(r.op.name); break;
      case "exec.run":         execBinaries.add(r.op.binary); break;
      case "events.subscribe": eventsSubscribe.add(r.op.event); break;
      case "import":           /* imports are checked at load, not synthesized */ break;
    }
  }

  const anyExternal = fsRead.size || fsWrite.size || netConnect.size || env.size || execBinaries.size || eventsSubscribe.size;
  if (!anyExternal) return { tier: "trusted" };

  const result: PluginPermissions = { tier: "scoped" };
  if (fsRead.size || fsWrite.size) {
    result.fs = {};
    if (fsRead.size)  result.fs.read  = [...fsRead].sort();
    if (fsWrite.size) result.fs.write = [...fsWrite].sort();
  }
  if (netConnect.size)      result.net    = { connect: [...netConnect].sort() };
  if (env.size)             result.env    = [...env].sort();
  if (execBinaries.size)    result.exec   = { binaries: [...execBinaries].sort() };
  if (eventsSubscribe.size) result.events = { subscribe: [...eventsSubscribe].sort() };
  return result;
}
```

- [ ] **Step 3: Run tests**

Run: `bun test src/core/manifest-synthesizer.test.ts`

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/manifest-synthesizer.ts src/core/manifest-synthesizer.test.ts
git commit -m "feat(core): manifest synthesizer from observation records"
```

---

### Task 3: `kaizen plugin dev --observe` command

**Files:**
- Create: `src/commands/plugin-dev.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Implement `plugin-dev.ts`**

Create `src/commands/plugin-dev.ts`:

```typescript
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { PermissionEnforcer } from "../core/permission-enforcer.js";
import { initializeSandbox } from "../core/sandbox-bootstrap.js";
import { ObserveRecorder } from "../core/observe-recorder.js";
import { synthesizeManifest } from "../core/manifest-synthesizer.js";
import type { CheckRecord } from "../core/permission-enforcer.js";

/**
 * Run the default harness in observe mode, recording every enforcer check.
 * After the session exits, post-process the log into a proposed manifest.
 *
 * Caller chains this to the existing harness start: we need a programmatic
 * entry for bootstrap that takes a pre-built enforcer. If that entry doesn't
 * exist yet, add `createKaizenRuntime({ enforcer, auditLog, recorder })` in
 * `src/core/index.ts` and wire the harness through it.
 */
export async function runPluginDevObserve(args: {
  pluginName: string;
  pluginDir: string;
  outDir: string;
}): Promise<number> {
  const sessionId = randomUUID();
  const enforcer = new PermissionEnforcer({ mode: "observe" });
  initializeSandbox(enforcer);
  const recorder = new ObserveRecorder(args.outDir, sessionId);
  const all: CheckRecord[] = [];
  enforcer.onCheck((r) => { all.push(r); recorder.record(r); });

  // Hand off to the harness runner. Must accept an externally-constructed enforcer.
  // If this entry point doesn't exist yet, create it in src/core/index.ts:
  //    export async function runHarness(opts: { enforcer: PermissionEnforcer }): Promise<void>;
  const { runHarness } = await import("../core/index.js") as {
    runHarness: (opts: { enforcer: PermissionEnforcer }) => Promise<void>;
  };
  try {
    await runHarness({ enforcer });
  } finally {
    recorder.flushSync();
  }

  const proposed = synthesizeManifest(args.pluginName, all);
  const outPath = join(args.pluginDir, ".kaizen", "proposed-permissions.ts");
  writePluginPermissionsTs(outPath, args.pluginName, proposed);
  console.log(`kaizen plugin dev: proposed manifest written to ${outPath}`);
  console.log(`  records:    ${all.length}`);
  console.log(`  log file:   ${recorder.path_()}`);
  return 0;
}

function writePluginPermissionsTs(
  path: string, pluginName: string, manifest: unknown,
): void {
  const { mkdirSync } = require("fs") as typeof import("fs");
  const { dirname } = require("path") as typeof import("path");
  mkdirSync(dirname(path), { recursive: true });
  const content = [
    `// Proposed permissions manifest for plugin '${pluginName}'.`,
    `// Generated by 'kaizen plugin dev --observe'. Review and paste into`,
    `// your plugin's default export under the \`permissions\` field.`,
    ``,
    `export const permissions = ${JSON.stringify(manifest, null, 2)} as const;`,
    ``,
  ].join("\n");
  writeFileSync(path, content);
}
```

- [ ] **Step 2: Add `runHarness` entry point if it doesn't exist**

Open `src/core/index.ts`. If it already exposes a programmatic "run the harness with these dependencies" entry, good. If not, add one:

```typescript
export interface RunHarnessOpts {
  enforcer?: PermissionEnforcer;
}

export async function runHarness(opts: RunHarnessOpts = {}): Promise<void> {
  // Move the existing bootstrap body into here. If opts.enforcer is provided,
  // use it instead of instantiating a new one.
  // ...existing bootstrap body...
}
```

Leave the CLI entry (the `process.argv` dispatch) unchanged — just have it call `runHarness()`.

- [ ] **Step 3: Wire into `src/cli.ts`**

Add to the `plugin` subcommand dispatch:

```typescript
if (sub === "dev" && rest.includes("--observe")) {
  const name = rest.find((a) => !a.startsWith("--"));
  if (!name) { console.error("usage: kaizen plugin dev --observe <plugin-dir>"); process.exit(2); }
  const pluginDir = name.startsWith(".") || name.startsWith("/") ? name : join(process.cwd(), name);
  const pluginName = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")).name as string;
  const outDir = join(pluginDir, ".kaizen");
  const code = await runPluginDevObserve({ pluginName, pluginDir, outDir });
  process.exit(code);
}
```

- [ ] **Step 4: Smoke test**

Create a throwaway plugin dir with `package.json` + `index.ts` that does `const fs = require("node:fs"); const data = fs.readFileSync("./something")`. Run:

```
bun src/cli.ts plugin dev --observe ./throwaway-plugin
```

Expected: session runs (in observe, nothing throws); on exit, `.kaizen/proposed-permissions.ts` is written with `tier: "scoped"` + an `fs.read` entry for `./something`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/plugin-dev.ts src/cli.ts src/core/index.ts
git commit -m "feat(cli): kaizen plugin dev --observe + manifest generation"
```

---

## Phase 2 — Built-in migrations

> Pattern for every migration task:
> 1. Read the plugin's current code.
> 2. Add a `permissions` block to the default export.
> 3. If non-TRUSTED, port raw Node I/O to `ctx.*` (e.g. `fs.readFileSync` → `ctx.fs.readText`).
> 4. Run `bun run typecheck`, `bun test`, and a smoke session to confirm no regression.
> 5. Commit.

### Task 4: Migrate TRUSTED built-ins (core-events, core-plugin-manager, core-lifecycle, core-executor-debug, core-ui-terminal)

**Files:**
- Modify: `plugins/core-events/index.ts`
- Modify: `plugins/core-plugin-manager/index.ts`
- Modify: `plugins/core-lifecycle/index.ts`
- Modify: `plugins/core-executor-debug/index.ts`
- Modify: `plugins/core-ui-terminal/index.ts`

- [ ] **Step 1: Declare TRUSTED on each**

For each file above, add to the default export:

```typescript
permissions: { tier: "trusted" },
```

Example (`plugins/core-events/index.ts`):

```typescript
const plugin: KaizenPlugin = {
  name: "core-events",
  apiVersion: "1.0.0",
  permissions: { tier: "trusted" },
  async setup(/* ... */) { /* ... */ },
};
```

For `core-ui-terminal`: keep using `process.stdin` / `process.stdout` directly. The enforcer does not intercept TTY (spec deviation flagged at top of this plan). This is TRUSTED despite semantically touching external resources — the README section documents this limitation.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`

Expected: pass.

- [ ] **Step 3: Test**

Run: `bun test`

Expected: pass.

- [ ] **Step 4: Smoke test**

Run: `bun src/cli.ts --harness core-debug`

Expected: session runs; no regressions.

- [ ] **Step 5: Inspect audit log**

`ls ./.kaizen/audit/` — open newest JSONL. For TRUSTED plugins, there should be zero denials recorded during a normal session (since they declared TRUSTED and actually do nothing external). If denials appear, the plugin *does* touch external resources the permission model should capture — go back and reassess its tier.

- [ ] **Step 6: Commit**

```bash
git add plugins/core-events plugins/core-plugin-manager plugins/core-lifecycle plugins/core-executor-debug plugins/core-ui-terminal
git commit -m "feat(plugins): declare TRUSTED tier for core-events, plugin-manager, lifecycle, executor-debug, ui-terminal"
```

---

### Task 5: Migrate core-executor-anthropic (SCOPED)

**Files:**
- Modify: `plugins/core-executor-anthropic/index.ts`

- [ ] **Step 1: Inspect current code**

Read `plugins/core-executor-anthropic/index.ts`. Identify every raw I/O and env access: `process.env.ANTHROPIC_API_KEY`, `fetch(...)` calls, any `fs` or `child_process` usage.

- [ ] **Step 2: Port env access to `ctx.secrets`**

Replace `process.env["ANTHROPIC_API_KEY"]` → `ctx.secrets.get("ANTHROPIC_API_KEY")`.

- [ ] **Step 3: Port fetch to `ctx.net.fetch`**

Replace bare `fetch(...)` in the executor → `ctx.net.fetch(...)`. If the plugin uses `@ai-sdk/anthropic`, the SDK calls `fetch` internally. The global fetch wrapper installed by Plan 1 catches it, so no code change is required for SDK calls — but the plugin's manifest must still declare the host. Verify empirically: run a session in observe mode and confirm the `net.connect` record lists the real host the SDK uses (`api.anthropic.com:443`).

- [ ] **Step 4: Declare permissions**

```typescript
const plugin: KaizenPlugin = {
  name: "core-executor-anthropic",
  apiVersion: "1.0.0",
  permissions: {
    tier: "scoped",
    net: { connect: ["api.anthropic.com:443"] },
    env: ["ANTHROPIC_API_KEY"],
  },
  // ... setup
};
```

- [ ] **Step 5: Smoke test**

With an `ANTHROPIC_API_KEY` env set, run: `bun src/cli.ts --harness core-anthropic --non-interactive` (send input via stdin).

Expected: session works. No denial records in audit log for this plugin.

If denial records appear: the SDK reached out to a host not in the allowlist, or requested an env var not in the grant. Add to the manifest accordingly — this is the manifest-authoring feedback loop in action.

- [ ] **Step 6: Commit**

```bash
git add plugins/core-executor-anthropic
git commit -m "feat(core-executor-anthropic): SCOPED tier with net+env grants"
```

---

### Task 6: Migrate core-executor-openai (SCOPED)

**Files:**
- Modify: `plugins/core-executor-openai/index.ts`

- [ ] **Step 1: Apply the same pattern as Task 5**

```typescript
permissions: {
  tier: "scoped",
  net: { connect: ["api.openai.com:443"] },
  env: ["OPENAI_API_KEY"],
},
```

Port `process.env["OPENAI_API_KEY"]` → `ctx.secrets.get("OPENAI_API_KEY")`. The plugin is currently a throwing stub (Finding 20) — that's orthogonal; just migrate the manifest and any code path that already exists.

- [ ] **Step 2: Typecheck + commit**

```bash
bun run typecheck
git add plugins/core-executor-openai
git commit -m "feat(core-executor-openai): SCOPED tier with net+env grants"
```

---

### Task 7: Migrate kaizen-plugin-timestamps (SCOPED — events)

**Files:**
- Modify: `plugins/kaizen-plugin-timestamps/index.ts`

- [ ] **Step 1: Inspect current event subscriptions**

Read the plugin. It subscribes to other plugins' events to add timestamps. Enumerate the event names.

- [ ] **Step 2: Declare permissions**

```typescript
permissions: {
  tier: "scoped",
  events: { subscribe: ["core-lifecycle:*"] },  // adjust to the actual event names
},
```

If the plugin subscribes to multiple plugins' events, list all owner-prefixed patterns.

- [ ] **Step 3: Confirm event subscription permission hook**

The enforcer check for `events.subscribe` must be called when the plugin calls `ctx.on(event, handler)`. Verify by reading `src/core/event-bus.ts`: in the `on()` registration path, the bus needs to call `enforcer.check(plugin, { kind: "events.subscribe", event })` before recording the subscription. If that hook isn't wired yet (it may not be in Plan 1 — confirm by grepping for `events.subscribe` in the enforcer code-path), wire it now in `event-bus.ts`.

- [ ] **Step 4: Smoke test + commit**

```bash
bun test && bun src/cli.ts --harness core-debug
git add plugins/kaizen-plugin-timestamps src/core/event-bus.ts
git commit -m "feat(kaizen-plugin-timestamps): SCOPED tier with events grant"
```

---

### Task 8: Migrate core-cli (SCOPED — investigate actual usage)

**Files:**
- Modify: `plugins/core-cli/index.ts`

- [ ] **Step 1: Inspect current code**

Read the plugin. Identify every `spawn`/`execSync`/`child_process` call and every binary it invokes. Check for any `fs` or `process.env` access.

- [ ] **Step 2: Decide tier**

- If the plugin spawns arbitrary user-provided commands: UNSCOPED (same treatment as `core-executor-shell`).
- If it spawns a known, fixed set (e.g. invokes `kaizen` subcommands or a couple of named tools): SCOPED with `exec.binaries: [...]`.

- [ ] **Step 3: Port I/O to `ctx.exec` where feasible**

Replace `spawn(...)` / `execSync(...)` with `ctx.exec.run(binary, args, opts)`. For `execSync`, wrap with a `throw` path for non-zero exit — `ctx.exec.run` never throws on non-zero exit, it returns `exitCode`.

- [ ] **Step 4: Declare permissions + smoke test + commit**

```typescript
permissions: {
  tier: "scoped",
  exec: { binaries: ["kaizen"] },  // or whatever's actually used
},
```

```bash
bun test
git add plugins/core-cli
git commit -m "feat(core-cli): SCOPED tier with exec grants"
```

---

### Task 9: Migrate core-executor-shell (UNSCOPED)

**Files:**
- Modify: `plugins/core-executor-shell/index.ts`

- [ ] **Step 1: Declare UNSCOPED**

```typescript
const plugin: KaizenPlugin = {
  name: "core-executor-shell",
  apiVersion: "1.0.0",
  permissions: {
    tier: "unscoped",
    // Grant fields are recorded for audit but not enforced at UNSCOPED tier.
    exec: { binaries: ["*"] },
  },
  // ... existing setup unchanged; keeps using execSync
};
```

Do not port the existing `execSync` to `ctx.exec` — UNSCOPED is the whole point. This plugin *is* the shell; its sandbox disengagement is the design.

- [ ] **Step 2: Verify loud UAC on first install**

Delete any existing entry for this plugin from the lockfile (if present). Run:

```
bun src/cli.ts install core-executor-shell
```

Expected: modal UAC rendered, requires typing `core-executor-shell` to confirm. Other input → rejection.

- [ ] **Step 3: Commit**

```bash
git add plugins/core-executor-shell
git commit -m "feat(core-executor-shell): UNSCOPED tier (Finding 7 fix)"
```

---

## Phase 3 — Flip enforce default

### Task 10: Default mode = `enforce`

**Files:**
- Modify: `src/core/index.ts`

- [ ] **Step 1: Change the default**

In `src/core/index.ts`, change:

```typescript
const enforcer = new PermissionEnforcer({ mode: "log-only" });
```

to:

```typescript
const enforcer = new PermissionEnforcer({ mode: "enforce" });
```

Add a config override: if `process.env["KAIZEN_SANDBOX_MODE"]` is set, use that mode (`"enforce" | "log-only" | "observe"`). Useful for escape hatch if a user hits an unexpected denial in production.

```typescript
const mode = (process.env["KAIZEN_SANDBOX_MODE"] as EnforcerMode | undefined) ?? "enforce";
const enforcer = new PermissionEnforcer({ mode });
```

- [ ] **Step 2: Full test suite**

Run: `bun test`

Expected: all pass. If any plugin-manager test fails because a fixture plugin did not declare permissions, update the fixture to declare `tier: "trusted"` (or whatever's appropriate).

- [ ] **Step 3: Integration tests**

Run: `bun run test:core`

Expected: pass.

- [ ] **Step 4: Smoke test every built-in harness**

Run each harness that has built-in coverage:
- `bun src/cli.ts --harness core-debug`
- `bun src/cli.ts --harness core-anthropic` (requires `ANTHROPIC_API_KEY`)
- Any other harness in `harnesses/` directory

Expected: each runs. Inspect audit log — should be empty (zero denials) for a happy-path session. Any denial here means a plugin's declared manifest missed something real; fix the manifest.

- [ ] **Step 5: Smoke test UNSCOPED**

Run a shell-executor harness (if one exists, or construct temporarily):

```
bun src/cli.ts --harness core-shell  # if defined
```

Expected: prompts for typed consent on first run (UNSCOPED first-time install), then runs.

- [ ] **Step 6: Commit**

```bash
git add src/core/index.ts
git commit -m "feat(core): default enforcer mode = enforce"
```

---

## Phase 4 — Documentation (Finding 16 partial)

### Task 11: README security-model section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read current README**

The current README is empty (the adversarial review's Finding 16). This task writes a minimal but useful README focused on the security model. General project overview / quickstart can come in a separate effort.

- [ ] **Step 2: Write security section**

Add to `README.md` (or create it):

````markdown
# kaizen

Platform for LLM harnesses built from composable plugins.

## Security model

Kaizen plugins run in the same process as core but are constrained by a
permission manifest declared in each plugin's default export. Three tiers:

- **TRUSTED** — plugin stays inside kaizen's `ctx.*` capability surface. No
  filesystem, network, env, or subprocess access. Installs silently.
- **SCOPED** — plugin declares narrow grants (`fs`, `net`, `env`, `exec`,
  cross-plugin `events`). Kaizen enforces each grant at runtime. Install-time
  UAC shows the full grant list for user review.
- **UNSCOPED** — plugin declares no bounds; full Node.js access. Install-time
  UAC requires typed confirmation of the plugin name. Kaizen does not enforce
  any limits on UNSCOPED plugins — their trust is granted by user fiat.

### What's enforced

Runtime checks via `Module.prototype.require` patching, `AsyncLocalStorage`
plugin-scope tracking, a proxy over `process.env`, and a wrapped `globalThis.fetch`:
- `import` of forbidden Node stdlib modules (`node:fs`, `node:child_process`,
  `node:worker_threads`, `bun:ffi`, etc.) is denied in non-UNSCOPED tiers.
- `ctx.fs` / `ctx.net` / `ctx.secrets` / `ctx.exec` check declared grants before
  every call.
- `process.env[key]` returns `undefined` for variables not in the plugin's
  `env` grant.
- Global `fetch` checks declared hosts before dispatching.
- Cross-plugin event subscription (`ctx.on("<other-plugin>:event")`) requires a
  declared `events.subscribe` grant (Findings 4, 13 fix).

### What's not enforced (honest limits)

- Reading or writing `process.stdin` / `process.stdout` is not intercepted.
  `core-ui-terminal` uses these directly and runs as TRUSTED; other UI plugins
  with their own I/O channels may similarly not need SCOPED declarations.
- Native addons, FFI, and `bun:ffi` escape the sandbox at runtime. Non-UNSCOPED
  tiers refuse to load modules that import these; UNSCOPED tiers allow them.
- V8 JIT escape or a kernel exploit defeats the sandbox. Kaizen's enforcement
  is in-process; a determined attacker with such capability can escape. The
  threat model this sandbox defeats is honest-but-buggy and casual-malicious
  plugins, not nation-state adversaries.
- Supply-chain integrity (plugin signing, npm provenance) is **not yet
  verified**. An attacker who publishes a malicious patch release under a
  plugin name you already consented to can ship new code; the hash check in the
  lockfile will refuse to load it until you re-consent. But the npm resolution
  step that selects the package is not authenticated today. (Deferred: see
  Findings 5 and 9 in `docs/adversarial-review.md`.)

### Lockfile

Consent is persisted in `kaizen.permissions.lock` at the repo root. Commit this
file — reviewers see every plugin your harness runs, its tier, and its declared
grants.

### Developer workflow

Authoring a SCOPED plugin should not require hand-tracking every I/O call.
Run your plugin in observe mode during development:

```
kaizen plugin dev --observe ./my-plugin
```

This runs the plugin permissively, records every attempted operation, and
writes a minimal proposed manifest to `./my-plugin/.kaizen/proposed-permissions.ts`.
Review and paste into your plugin's default export.

### Commands reference

- `kaizen install <plugin>` — resolve, read manifest, run consent flow, write lockfile.
- `kaizen plugin consent <plugin>` — re-run consent (after version bump or drift).
- `kaizen plugin review <plugin>` — diff declared manifest vs. lockfile entry.
- `kaizen plugin audit` — list lockfile entries; flag UNSCOPED.
- `kaizen plugin dev --observe <dir>` — record operations, generate proposed manifest.

### CLI flags

- `--trust-lockfile` — use the existing lockfile for consent; do not prompt.
- `--allow-unscoped` — permit non-interactive consent of UNSCOPED plugins.
- `--non-interactive` — refuse any consent that would require a prompt.
- `KAIZEN_SANDBOX_MODE=log-only` — run the enforcer in log-only mode (records
  denials to the audit log but does not throw). Escape hatch; not for
  production.

### Adversarial review

This security model addresses findings 2, 3, 4, 7, 11, 13, and 17 (partial) from
[`docs/adversarial-review.md`](./docs/adversarial-review.md). Findings 5, 6, 8,
9, 10, 12, 14, 18, 19, and 20 are out of scope for this effort and tracked
separately.
````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: security model section in README (Finding 16 partial)"
```

---

## Phase 5 — End-to-end verification

### Task 12: Full verification

**Files:** none.

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`

Expected: zero errors.

- [ ] **Step 2: Full test suite**

Run: `bun test`

Expected: all pass.

- [ ] **Step 3: Integration tests**

Run: `bun run test:core`

Expected: all pass.

- [ ] **Step 4: Default harness, enforce mode**

Run: `rm -f kaizen.permissions.lock && bun src/cli.ts --harness core-debug`

Expected: session runs cleanly. Lockfile populated with entries for each built-in. No denial records in audit log.

- [ ] **Step 5: Anthropic harness (if API key available)**

Run: `bun src/cli.ts --harness core-anthropic`

Expected: session works end-to-end, LLM responds. No denial records.

- [ ] **Step 6: Lockfile audit**

Run: `bun src/cli.ts plugin audit`

Expected: table showing every built-in's tier. `core-executor-shell` (if loaded) shows `⚠  unscoped`.

- [ ] **Step 7: Manually introduce a violation**

Temporarily modify a TRUSTED built-in to try to `require("node:fs")` in its setup. Run the harness.

Expected: `PermissionError` thrown at plugin load time. Session still starts if the plugin is non-critical (log-only fallback); if the plugin is critical and fails load, session refuses to start with clear error message naming the plugin and the forbidden import.

Revert the change after testing.

- [ ] **Step 8: Checkpoint commit**

```bash
git commit --allow-empty -m "chore: plan 3 (migration + enforce + docs) — plugin sandboxing complete"
```

---

## Deviation Log

**Deviations observed during implementation:**

**Task 8 — core-cli exec.binaries: ["*"]**
The plan recommended reading `ctx.config["clis"]` at plugin setup time to build a precise
`exec.binaries` allowlist, or falling back to `["*"]` if that's impractical. The `permissions`
block is declared statically on the plugin object — before `setup()` runs and before
`ctx.config` is available. Duplicating the CLI list in both `kaizen.json` and the plugin
source would be brittle and error-prone. Decision: use `exec.binaries: ["*"]` (any binary
permitted for exec.run) with tier `"scoped"`. The enforcer still gates every `exec.run` call
through the permission check; the actual invocations are bounded to whatever the user put
in `clis` config. This is a breadth trade-off: the sandbox knows this plugin runs *something*,
just not exactly which binaries without config context. Future options: (a) a `setup()`-time
`ctx.permissions.refine(...)` API that narrows grants after reading config, or (b) a separate
config-declaration field that core reads before constructing the permission manifest.

---

## Notes for the Implementing Engineer

1. **Plans 1 and 2 must be complete before starting this plan.** Spot-check
   their Deviation Logs before beginning — if Plan 1 deviated from a type
   signature or API shape, tasks in this plan referencing those shapes need
   updating first.
2. **The spec said SCOPED for `core-ui-terminal`; this plan uses TRUSTED.**
   The reason (enforcer doesn't intercept TTY) is flagged at the top of this
   plan and in the README. If a future primitive for stdin/stdout is added,
   re-tier this plugin.
3. **Migration is iterative, not atomic.** Each plugin can migrate
   independently. If a migration task reveals something unexpected (plugin
   uses an API the DSL doesn't cover), either extend the DSL in a focused new
   task or escalate the plugin to UNSCOPED with a note. Don't get stuck
   perfecting one built-in's manifest.
4. **Observation-mode manifest generation is the safety net.** If Task 5/6/7/8
   starts to feel like guesswork ("what does this plugin actually touch?"),
   stop and run the plugin in observe mode. The generated manifest is the
   honest answer.
5. **Enforce-mode flip is the point of no return for this effort.** After
   Task 10, a missing permission in any built-in causes session startup
   failures. If Task 10 surfaces missing grants, fix them *before* merging —
   don't ship a partial flip.
6. **The `KAIZEN_SANDBOX_MODE` escape hatch is for emergencies.** If a user's
   plugin breaks in prod after an update, flipping to `log-only` gets them
   running while the real fix (add the missing permission) ships. Not a
   long-term workaround.
