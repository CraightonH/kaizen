# Host API Type Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the unused `CtxSecrets` and `CtxLog` types (and their dead constructions in `createCtxIo`) so the host API has exactly one shape per field, matching what plugins actually receive at runtime.

**Architecture:** Pure deletion. No runtime behavior changes on any live code path. `ctx.secrets` stays as `SecretsContext` (from `createSecretsContext` in `src/core/secrets.ts`). `ctx.log` stays as the flat `(msg: string) => void` closure wired in `src/core/context.ts`. The deleted types were built by `createCtxIo` but never assigned onto `PluginContext`, so removing them is invisible to plugins.

**Tech Stack:** TypeScript, Bun test runner.

**Spec:** `docs/superpowers/specs/2026-04-21-host-api-type-cleanup-design.md`

---

## File Structure

**Modified files:**
- `src/core/plugin-ctx-io.ts` — delete `CtxSecrets`, `CtxLog`; drop `secrets`/`log` from `CtxIo` and `createCtxIo`
- `src/core/plugin-ctx-io.test.ts` — delete tests for `ctx.secrets.get` and `ctx.log.info`
- `src/types/plugin.ts` — drop `CtxSecrets`, `CtxLog` from line 21 re-export
- `src/host-api.ts` — drop `CtxSecrets`, `CtxLog` from line 71 re-export
- `docs/reference/host-api.md` — remove `CtxSecrets` and `CtxLog` sections; update `CtxIo` aggregate; rewrite `ctx.secrets` / `ctx.log` sections to reflect the real runtime shapes

**No new files. No deleted files.**

---

## Task 1: Remove `CtxSecrets` and `CtxLog` from core I/O module

**Files:**
- Modify: `src/core/plugin-ctx-io.ts`
- Modify: `src/core/plugin-ctx-io.test.ts`

- [ ] **Step 1: Delete the dead test cases**

The existing test file exercises `ctx.secrets.get` and `ctx.log.info` — both are built by `createCtxIo` but never wired into `PluginContext`. They go away with the code.

Delete these two test blocks from `src/core/plugin-ctx-io.test.ts`:

```typescript
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
```

and:

```typescript
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
```

The file keeps its fs/net/exec coverage.

- [ ] **Step 2: Run tests to confirm they still pass (nothing in Step 1 changed behavior, just removed coverage of unused code)**

Run: `bun test src/core/plugin-ctx-io.test.ts`
Expected: all remaining tests pass; test count drops by 2.

- [ ] **Step 3: Delete the `CtxSecrets` and `CtxLog` interfaces and drop them from `CtxIo` / `createCtxIo`**

Rewrite `src/core/plugin-ctx-io.ts` so the final content is:

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

export interface CtxIo {
  fs: CtxFs;
  net: CtxNet;
  exec: CtxExec;
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
  };
}
```

The file no longer exports `CtxSecrets` or `CtxLog`. `createCtxIo` no longer builds `secrets` or `log`.

- [ ] **Step 4: Run the module tests**

Run: `bun test src/core/plugin-ctx-io.test.ts`
Expected: all remaining tests pass.

- [ ] **Step 5: Do NOT commit yet** — the repo-wide re-exports still reference the deleted symbols. The full typecheck will fail until Task 2 lands. Proceed directly to Task 2.

---

## Task 2: Drop deleted symbols from the public re-exports

**Files:**
- Modify: `src/types/plugin.ts:21`
- Modify: `src/host-api.ts:70-72`

- [ ] **Step 1: Update `src/types/plugin.ts` re-export**

Find the line:

```typescript
export type { CtxFs, CtxNet, CtxSecrets, CtxExec, CtxLog, CtxIo, ExecOpts, ExecResult } from "../core/plugin-ctx-io.js";
```

Replace with:

```typescript
export type { CtxFs, CtxNet, CtxExec, CtxIo, ExecOpts, ExecResult } from "../core/plugin-ctx-io.js";
```

- [ ] **Step 2: Update `src/host-api.ts` re-export**

Find the block:

```typescript
export type {
  CtxFs, CtxNet, CtxSecrets, CtxExec, CtxLog, CtxIo, ExecOpts, ExecResult,
} from "./core/plugin-ctx-io.js";
```

Replace with:

```typescript
export type {
  CtxFs, CtxNet, CtxExec, CtxIo, ExecOpts, ExecResult,
} from "./core/plugin-ctx-io.js";
```

- [ ] **Step 3: Run the full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 4: Run the typechecker**

Run: `bun run typecheck` (or `bunx tsc --noEmit` if the project script differs — check `package.json` `scripts` first)
Expected: no type errors. If any in-repo code imported `CtxSecrets` or `CtxLog` as a type, the typecheck will surface it — investigate any hit and delete the import (do not re-add the type).

- [ ] **Step 5: Verify no stray references remain**

Run: `bun x rg -n 'CtxSecrets|CtxLog' src/`
Expected: zero matches.

- [ ] **Step 6: Commit**

```bash
git add src/core/plugin-ctx-io.ts src/core/plugin-ctx-io.test.ts src/types/plugin.ts src/host-api.ts
git commit -m "refactor(core): remove unused CtxSecrets and CtxLog types

Both types were built by createCtxIo but never wired into
PluginContext. ctx.secrets is SecretsContext (from
createSecretsContext); ctx.log is the flat (msg: string) => void
closure in context.ts. Resolves the host-API type divergence flagged
in #18 by deleting the dead parallel shapes.

Refs: #18"
```

---

## Task 3: Rewrite `docs/reference/host-api.md` to match the live surface

**Files:**
- Modify: `docs/reference/host-api.md` — lines 156-170 (`ctx.secrets`), 196-213 (`ctx.log`), 215-229 (`ctx.io`)

- [ ] **Step 1: Replace the `ctx.secrets` section**

Find the heading `### ` + `ctx.secrets` + ` (CtxSecrets)` and the block that follows (through the end of the "Returns `undefined`..." paragraph). Replace with:

```markdown
### `ctx.secrets` (SecretsContext)

```ts
interface SecretsContext {
  get(key: string): Promise<string | undefined>;
  refresh(key: string): Promise<string | undefined>;
}
```

The async secrets resolver. `get` reads through the resolution chain
(`envOverride` → `KAIZEN_<PLUGIN>_<KEY>` → cache → provider). `refresh`
bypasses the cache and re-resolves from the provider. Configured per
plugin via the `config.secrets` declaration; see
[`plugin-secrets.md`](./plugin-secrets.md) for the full provider contract
and ref shapes.
```

(The outer fenced block is a literal three-backtick code block — reproduce it as-is in the Markdown.)

- [ ] **Step 2: Replace the `ctx.log` section**

Find the heading `### ` + `ctx.log` + ` (CtxLog)` and the block through the end of the "`CtxLog` interface above is the full surface." paragraph. Replace with:

```markdown
### `ctx.log`

```ts
log(msg: string): void;
```

Single-string logger. Output is prefixed with the plugin name (e.g.
`[my-plugin] ready`). Not permission-gated. A richer structured logging
surface may land in a future release; when it does, it will be additive.
```

- [ ] **Step 3: Update the `CtxIo` aggregate section**

Find the `### ctx.io (CtxIo)` block. Replace with:

```markdown
### `ctx.io` (CtxIo)

```ts
interface CtxIo {
  fs: CtxFs;
  net: CtxNet;
  exec: CtxExec;
}
```

Aggregate container bundling the permission-gated I/O surfaces.
Constructed per plugin by `createCtxIo(plugin, enforcer)`; plugins
typically access `ctx.fs`/`ctx.net`/`ctx.exec` directly rather than the
composite. Note that `ctx.secrets` and `ctx.log` are **not** part of
`CtxIo` — they are wired onto `PluginContext` by a separate path
(`createSecretsContext` and the closure in `context.ts`).
```

- [ ] **Step 4: Scan the rest of the doc for stale references**

Run: `bun x rg -n 'CtxSecrets|CtxLog' docs/reference/host-api.md`
Expected: zero matches. If any survive (e.g. in a "Type-only exports" summary table), edit them out.

- [ ] **Step 5: Commit**

```bash
git add docs/reference/host-api.md
git commit -m "docs(host-api): document real runtime shapes for secrets and log

Removes CtxSecrets and CtxLog sections (types were deleted). Documents
ctx.secrets as SecretsContext and ctx.log as the flat (msg) => void
signature that plugins actually receive.

Refs: #18"
```

---

## Task 4: Verification and downstream docs refresh

- [ ] **Step 1: Re-run the full test suite**

Run: `bun test`
Expected: all tests pass. Note the test count is lower than before by 2 (Task 1 deletions).

- [ ] **Step 2: Re-run the typechecker**

Run: `bun run typecheck` (or the project equivalent)
Expected: no errors.

- [ ] **Step 3: Repo-wide grep for stale symbol references**

Run: `bun x rg -n 'CtxSecrets|CtxLog'`
Expected: zero matches anywhere in the repo — source, tests, or docs. If any doc under `docs/` still references them (e.g. `docs/guides/plugin-authoring.md`, `docs/concepts/*`), edit them out in this task and include in the verification commit.

- [ ] **Step 4: Run `kaizen:update-docs`**

Invoke the `kaizen:update-docs` skill to refresh any auto-generated or convention-tracked docs affected by the host-API surface change. Review and accept its edits.

- [ ] **Step 5: Commit any doc edits from Steps 3–4**

```bash
git add docs/
git commit -m "docs: sweep stale CtxSecrets/CtxLog references

Follow-up cleanup from host-API type deletion. Refs: #18"
```

(If `git status` is clean after Step 4, skip this commit.)

- [ ] **Step 6: Final verification**

Run: `bun test && bun run typecheck`
Expected: both green. Branch is ready to ship.

---

## Self-Review

**Spec coverage check:**
- Spec §3 "Changes → `src/core/plugin-ctx-io.ts`" → Task 1 Step 3 ✓
- Spec §3 "Changes → `src/types/plugin.ts`" → Task 2 Step 1 ✓
- Spec §3 "Changes → `src/host-api.ts`" → Task 2 Step 2 ✓
- Spec §3 "Changes → `src/core/plugin-ctx-io.test.ts`" → Task 1 Step 1 ✓
- Spec §3 "Changes → `docs/reference/host-api.md`" → Task 3 ✓
- Spec §3 "Downstream → run `kaizen:update-docs`" → Task 4 Step 4 ✓
- Spec §5 Testing (`bun test` green, no new tests) → Task 4 Steps 1–2 ✓
- Spec §6 Rollout (no cross-repo coordination) → no task needed; covered by branch scope

No gaps.
