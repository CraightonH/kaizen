# Design: Plugin Sandboxing & Permission Model (Addresses Adversarial Review Findings 2, 3)

Date: 2026-04-17
Status: DRAFT — awaiting user review
Supersedes: N/A
Related:
- `docs/adversarial-review.md` (findings 2, 3, and folded-in 4, 7, 11, 13, 17)
- `docs/superpowers/specs/2026-04-17-capability-registry-design.md` (prerequisite — permissions compose with capabilities)

## Problem Statement

The adversarial review identifies the missing security boundary as the platform's
most critical gap:

> There is no sandboxing, and this is catastrophic for a 3rd-party plugin platform.
> Every plugin runs in-process with full Node.js access: filesystem, process.env,
> child_process, network, and all other plugins' scopes. The current mitigation
> ("only install plugins you trust") is not a security model; it is a disclaimer.

Finding 3 compounds this: the `provides`/`depends` role system (and its successor,
the capability registry shipped in the companion spec) are *declarative inventory*,
not *enforced bounds*. A plugin can declare anything and do anything.

This design adds the enforcement layer. Declarations become runtime-enforced
grants. The trust boundary shifts from "install only code you already trust" to
"install code whose declared scope you're willing to accept, and know that kaizen
will enforce that declaration."

## Design Philosophy

1. **Best-effort informed consent.** The goal is to catch plugins doing things they
   didn't transparently say they were going to do. A plugin that truthfully declares
   "I want full system access" and a user who accepts that declaration have entered
   a consensual relationship that is no longer kaizen's concern. Kaizen's job is
   making declarations truthful and consent informed.
2. **Restrict by default.** The default tier is the most restrictive; authors opt
   in to elevated access explicitly.
3. **Secure should be easy.** Authoring a sandboxed or scoped plugin must not be
   harder than authoring an unsandboxed one. Drift-pain is solved by tooling
   (`--observe` mode), not by asking authors to handwrite manifests.
4. **Honest about limits.** M1 in-process enforcement is not a nation-state-grade
   sandbox. It defeats honest-but-buggy and casual-malicious plugins. It is not
   claimed to defeat a determined attacker with V8 escape capability. The docs
   will say this plainly.

## Scope

### In Scope

- Three-tier plugin trust model: **TRUSTED** / **SCOPED** / **UNSCOPED**.
- Permission DSL declared in the plugin's default export, covering filesystem,
  network, environment, subprocess, and cross-plugin event subscription.
- M1 in-process enforcement mechanism: patched `Module.prototype.require` +
  `AsyncLocalStorage` per-plugin scope + `ctx.*` I/O surface + `process.env` proxy
  + global `fetch` wrapper.
- Lockfile (`kaizen.permissions.lock`) recording consented tier, permissions, and
  content hash per plugin.
- Install-time UAC flow with asymmetric friction (silent / info / modal-typed).
- `kaizen plugin dev --observe` tool that generates a permission manifest from
  observed operations during development.
- `kaizen plugin audit` and `kaizen plugin review` introspection commands.
- Audit trail (`./.kaizen/audit/<session-id>.jsonl`) capturing permission checks,
  defaulting on.
- Migration of all existing built-in plugins to declared tiers.
- Security-model documentation in the repo root README.

### Out of Scope (deferred)

- Findings 5, 9: supply-chain / npm resolution order / version pinning.
- Finding 6: tool namespacing.
- Finding 8: harness extends chain validation.
- Finding 10: destructive-command regex in `core-cli` — becomes obsolete once
  `core-executor-shell` ships UNSCOPED.
- Finding 12: apiVersion mismatch hard failure.
- Finding 14: config shallow-merge.
- Finding 18: plugin SDK / scaffolding.
- Finding 19: RUNNING → CLOSED recovery.
- Finding 20: `core-executor-openai` stub.
- Argv-pattern allowlisting for `exec` (binary-only for v1).
- Plugin signing / npm provenance verification.
- M2 (worker-thread) or M3 (subprocess) upgrades — design keeps the `ctx.*` API
  shape stable so M1 → M2 is an internal substitution, not a breaking change.

## Architecture

Three cleanly-separated pieces:

### 1. Permission manifest (policy)

Declared per plugin, typed into the plugin's default export alongside
`capabilities`. Lists tier + explicit grants. Default tier is `trusted` with
empty grants.

### 2. Permission enforcer (mechanism, M1)

A per-plugin execution context that:

- Uses a patched `Module.prototype.require` + `AsyncLocalStorage` to refuse
  imports of forbidden Node modules per-plugin.
- Freezes relevant prototypes before any plugin loads.
- Bans `eval`, `Function` constructor, `process.binding`, and similar escape
  vectors in non-UNSCOPED tiers.
- Scrubs `process.env` access through a proxy that only returns declared keys.
- Exposes all I/O via `ctx.*` with per-call permission checks.

### 3. Consent + lockfile (trust)

`kaizen.permissions.lock` records each plugin's tier, grants, and content hash.
UAC prompts asymmetrically by tier. CI consumes the lockfile.

**Composition with capability registry:** capabilities remain the inventory
layer (who declares what role). Permissions are the enforcement layer (what a
plugin is actually allowed to touch). Where possible, capabilities propose
default permissions during manifest authoring — never automatic at runtime.

## Trust Tiers

| Tier | Name | Scope | Trust source | UAC on install |
|---|---|---|---|---|
| R0 | **TRUSTED** | Only `ctx.*` capability surface; own-plugin events only; no fs/net/env/exec | By *construction* — kaizen verified there's nothing external to audit | Silent |
| R1 | **SCOPED** | Declared narrow external needs; kaizen enforces every grant | By *contract* — user accepted the declared scope | Info-level prompt showing full permission list |
| R2 | **UNSCOPED** | Did not declare bounds — full Node access | By *fiat* — user explicitly granted trust despite no bounds | Modal prompt requiring typed confirmation |

Key symmetry: **TRUSTED** and **UNSCOPED** both have no runtime enforcement, for
opposite reasons — TRUSTED has nothing to enforce; UNSCOPED has nothing declared.
**SCOPED** is the only tier where the enforcer actively gates calls at runtime.

UI surfaces should render the short label alongside a first-mention explanation:
`TRUSTED (sandboxed by construction)`, `UNSCOPED (no sandbox, full system access)`.
Prevents readers from confusing TRUSTED's technical meaning with a social claim.

## Permission DSL

```typescript
export interface PluginPermissions {
  tier: "trusted" | "scoped" | "unscoped";  // default: "trusted"

  fs?: {
    read?: string[];   // glob patterns, relative to workspace root or absolute
    write?: string[];
  };

  net?: {
    connect?: string[];  // host:port, e.g. ["api.anthropic.com:443", "*.example.com:443"]
  };

  env?: string[];  // allowed env var names, e.g. ["ANTHROPIC_API_KEY"]

  exec?: {
    binaries?: string[];  // binary name allowlist, e.g. ["git", "rg"]
  };

  events?: {
    subscribe?: string[];  // cross-plugin event subscription patterns
                           // e.g. ["core-lifecycle:tool:before", "other-plugin:*"]
  };
}

export interface KaizenPlugin {
  name: string;
  apiVersion: string;
  capabilities?: PluginCapabilities;
  aliases?: Record<string, string>;
  permissions?: PluginPermissions;   // defaults to { tier: "trusted" }
  setup(ctx: PluginContext): Promise<void>;
  start?(ctx: PluginContext): Promise<void>;
}
```

### Always-free operations (any tier)

Timers (`setTimeout`, `setInterval`), `crypto` (pure-JS operations),
`os.platform`, `os.arch`, pure computation, structured logging via `ctx.log`,
tool registration, capability declaration, own-plugin event emit/subscribe.

### Always-denied operations in non-UNSCOPED tiers (no per-grant override)

`worker_threads`, `vm`, `node:module`, `process.binding`, FFI (`bun:ffi`), native
addons (any `.node` module), dynamic `eval` / `Function` constructor. These are
the escape vectors; there is no narrow permission that authorizes them. A plugin
that needs any of these is UNSCOPED.

### Tier → grants interaction

| Tier | Manifest behavior |
|---|---|
| `trusted` | All grant fields must be empty; otherwise validation error telling the author to escalate to `scoped`. |
| `scoped` | All grant fields allowed. Wildcards are permitted but rendered verbatim in UAC; a scoped plugin declaring `net.connect: ["*"]` is legal — the UAC just shows "any host, any port" and lets the user decide. |
| `unscoped` | Grant fields ignored by the enforcer at runtime (still recorded in the lockfile for audit). |

### Cross-plugin event subscription

`events.subscribe` gates Finding 4 (tool:before hijack) and Finding 13 (event
bus observation). Own-plugin events are always free. Subscribing to any other
plugin's event requires declaring the pattern and appearing in UAC.

### Wildcards

Wildcards are allowed at SCOPED tier. They are rendered literally in the UAC
("any host, any port" for `*`, "any file" for `/**`). There is no automatic
tier escalation for broad wildcards — instead, the UAC content does the work of
making broad declarations look broad, and the user decides whether to accept.

## Enforcement Mechanism (M1)

### Bootstrap (once, before any plugin loads)

1. **Patch `Module.prototype.require`** — wrap so every `require()` call reads
   the current plugin from `AsyncLocalStorage` and consults the enforcer before
   returning the cached module. Kaizen core's own requires happen before the
   patch and pre-capture their references.
2. **Freeze prototypes** — `Object.freeze(Module.prototype)`, `Object.freeze(Module)`,
   and the shim namespaces.
3. **Install the ALS** — single process-wide `AsyncLocalStorage<PluginScope>`.
4. **Register the `ctx.*` surface factory** — produces `ctx.fs`, `ctx.net`,
   `ctx.secrets`, `ctx.exec` bound to the calling plugin's grants.
5. **Install the global `fetch` wrapper** — reads ALS scope, checks
   `net.connect`, delegates.
6. **Install the `process.env` proxy** — returns only keys the current plugin's
   `env` grant allows; `undefined` for others.

### Per-plugin load (in `plugin-manager.load()`)

1. Read declared manifest from plugin's default export.
2. If tier is TRUSTED or SCOPED: build `ctx.*` surface bound to grants; register
   manifest with enforcer.
3. If tier is UNSCOPED: skip shim binding; register a "bypass" marker.
4. Wrap `setup(ctx)`, `start(ctx)`, and every event handler the plugin
   registers with `als.run({ plugin, manifest }, fn)`. All plugin code —
   including transitively-imported module code — executes inside that scope.
5. Perform AST-level import pre-check on the plugin's entry: refuse if it
   imports any forbidden module. Fast-fail for the common case; runtime
   require-trap catches transitive imports in npm deps.
6. `unload()` removes the plugin's manifest from the enforcer; ALS context
   disappears on its own when handlers finish.

### The `ctx.*` surface (TRUSTED + SCOPED tiers)

```typescript
ctx.fs.read(path: string): Promise<Uint8Array>
ctx.fs.readText(path: string): Promise<string>
ctx.fs.write(path: string, data: Uint8Array | string): Promise<void>
ctx.fs.list(path: string): Promise<string[]>
ctx.fs.stat(path: string): Promise<FileStat>

ctx.net.fetch(url: string, init?: RequestInit): Promise<Response>

ctx.secrets.get(name: string): string | undefined
ctx.secrets.has(name: string): boolean

ctx.exec.run(binary: string, args: string[], opts?: ExecOpts): Promise<ExecResult>

ctx.log.debug/info/warn/error(msg, meta?)
```

Every method runs the enforcer check against the current plugin's manifest.
Path normalization resolves against workspace root; absolute paths outside
declared globs → denied. TRUSTED plugins receive `ctx.*` but all grants are
empty, so any call fails — TRUSTED plugins shouldn't be calling these methods.

### Hot-reload compatibility

The interceptor is stateless. `unload()` clears the plugin's ALS context and
permission manifest; `load()` repopulates them. The existing `delete req.cache[resolved]`
cache invalidation works unchanged. No global loader-hook re-registration
needed.

### Honest failure modes

- A plugin captures `Module.prototype.require` *before* the patch → kaizen patches
  during bootstrap, before any plugin loads. Startup-time property.
- A plugin monkey-patches `Module.prototype.require` *after* the patch → frozen
  in non-UNSCOPED tiers; UNSCOPED tier can do what it wants by definition.
- Native addons, FFI, WASM with imported syscalls → non-UNSCOPED tiers refuse to
  load modules with `.node` extension or `bun:ffi` imports.
- Async boundaries that lose ALS context → Bun/Node's `AsyncLocalStorage` follows
  native async/await and timers; user-land Promise subclasses that don't preserve
  context are a theoretical escape but rare in practice.
- V8 JIT escape or kernel 0-day → out of M1's threat model. Documented as a
  known limit; M2 worker-thread upgrade is the next rung if this becomes a real
  threat.

### Runtime violation behavior

Permission check fails → enforcer throws `PermissionError` with plugin name,
attempted operation, declared grants, and a suggested fix. The plugin's current
call fails; the plugin remains loaded (no cascade-kill). Denial is logged to
the audit trail.

## Lockfile

`kaizen.permissions.lock` at repo root, committed, reviewed as code.

**Hash semantics:** the recorded `hash` is `sha256` over the concatenation of
(a) the plugin's resolved `package.json` and (b) every file referenced by its
`main`/`module`/`exports` entry points, traversed once. Transitive `node_modules`
contents are *not* hashed — supply-chain integrity is a separate concern
(Findings 5, 9, deferred). The hash changes when the plugin's own code or
declared permissions change; it does not change when the user upgrades an
unrelated dep.


```yaml
schemaVersion: 1
plugins:
  core-ui-terminal:
    version: workspace:*
    hash: sha256:abc123...
    tier: scoped
    consentedAt: 2026-04-17T15:23:00Z
    consentedBy: chancock@taxhawk.com
    permissions:
      fs:
        read: ["$TTY"]
        write: ["$TTY"]

  core-executor-anthropic:
    version: workspace:*
    hash: sha256:def456...
    tier: scoped
    consentedAt: 2026-04-17T15:23:00Z
    consentedBy: chancock@taxhawk.com
    permissions:
      net:
        connect: ["api.anthropic.com:443"]
      env: ["ANTHROPIC_API_KEY"]

  cool-unknown-plugin:
    version: 1.2.3
    hash: sha256:789xyz...
    tier: unscoped
    consentedAt: 2026-04-17T15:30:00Z
    consentedBy: chancock@taxhawk.com
    consentMode: interactive   # "interactive" | "flag:--allow-unscoped"
```

### Flow matrix

| Situation | Behavior |
|---|---|
| Plugin in lockfile, hash + manifest match | Load silently |
| Plugin in lockfile, manifest drift (permissions changed) | Fail: direct user to `kaizen plugin review X` |
| Plugin in lockfile, hash drift (code changed, manifest same) | Warn + require re-consent on next interactive run; CI refuses |
| Plugin not in lockfile, interactive, TRUSTED | Add silently, load |
| Plugin not in lockfile, interactive, SCOPED | Render UAC, accept → add to lockfile + load |
| Plugin not in lockfile, interactive, UNSCOPED | Render loud UAC, require typed confirmation |
| Plugin not in lockfile, non-interactive (CI), TRUSTED | Add to lockfile, continue (optional `--strict-lockfile` refuses) |
| Plugin not in lockfile, non-interactive, SCOPED | Refuse. Error tells user to run interactively or `kaizen plugin consent X` |
| Plugin not in lockfile, non-interactive, UNSCOPED | Refuse unless `--allow-unscoped` passed explicitly |

## UAC Rendering

### SCOPED (info-level prompt)

```
┌────────────────────────────────────────────────────────────────────┐
│  Install: cool-unknown-plugin@1.2.3                                │
│                                                                    │
│  Tier: SCOPED — kaizen will enforce the permissions below.         │
│                                                                    │
│  This plugin requests:                                             │
│    • Network access                                                │
│        api.example.com:443                                         │
│    • Environment variables                                         │
│        EXAMPLE_API_KEY                                             │
│    • Event subscriptions (from other plugins)                      │
│        core-lifecycle:tool:before   (observes all tool executions) │
│                                                                    │
│  Source: https://npm.im/cool-unknown-plugin                        │
│  Verify: kaizen plugin review cool-unknown-plugin                  │
│                                                                    │
│  [a]ccept   [r]eject   [i]nspect source                            │
└────────────────────────────────────────────────────────────────────┘
```

### UNSCOPED (loud prompt)

```
╔════════════════════════════════════════════════════════════════════╗
║  Install: cool-unknown-plugin@1.2.3                                ║
║                                                                    ║
║  Tier: UNSCOPED — this plugin has NOT declared what it needs.      ║
║                                                                    ║
║  Accepting installs it with full system access:                    ║
║    filesystem, network, environment variables, command execution,  ║
║    all other plugins' events, and anything else Node.js can reach. ║
║                                                                    ║
║  Kaizen cannot enforce any limits on an UNSCOPED plugin.           ║
║                                                                    ║
║  Source: https://npm.im/cool-unknown-plugin                        ║
║  Verify: kaizen plugin review cool-unknown-plugin                  ║
║                                                                    ║
║  Type the plugin name to confirm: _                                ║
╚════════════════════════════════════════════════════════════════════╝
```

The typed-confirmation requirement for UNSCOPED is deliberate — it converts a
reflexive "y" into a conscious decision.

## Commands

- `kaizen install <plugin>` — resolves package, reads manifest, runs appropriate
  consent flow, writes lockfile.
- `kaizen plugin consent <plugin>` — re-runs consent UX for a plugin already in
  the lockfile (version bumps, manifest drift, first-time population).
- `kaizen plugin review <plugin>` — prints diff between lockfile-recorded
  permissions and the plugin's current declared manifest. Read-only.
- `kaizen plugin audit` — two modes:
  - Static: table of every plugin + its tier + declared permissions. Flags
    UNSCOPED and wildcards.
  - Live (during/after a session): reports observed operations that exceed the
    declared manifest.
- `kaizen plugin dev --observe ./my-plugin` — runs the plugin in permissive
  mode, captures every attempted operation, post-processes into a minimal
  permission manifest written to `./my-plugin/.kaizen/proposed-permissions.ts`.
  Author reviews and pastes into their plugin. **This is the ergonomic
  mechanism that makes SCOPED-tier authoring easy.**

## Audit Trail

Enforcer emits structured records for every permission check:

```
{ ts, sessionId, plugin, tier, op, arg, result, reason? }
```

Written to `./.kaizen/audit/<session-id>.jsonl`. Default on; disable via config.
Cheap to fold in while the enforcer is being built; deferring means
re-instrumenting later when the hook points are gone. Partial satisfaction of
Finding 17.

## Built-in Plugin Retiering

| Plugin | Tier | Permissions | Notes |
|---|---|---|---|
| `core-events` | TRUSTED | — | Pure metadata |
| `core-plugin-manager` | TRUSTED | — | Uses kaizen's own APIs via `ctx` |
| `core-lifecycle` | TRUSTED | — | Session orchestration via `ctx.runtime.*` |
| `core-ui-terminal` | SCOPED | `fs.read: ["$TTY"]`, `fs.write: ["$TTY"]` | TTY access is external to kaizen. First-party SCOPED is fine — sets the norm |
| `core-executor-anthropic` | SCOPED | `net.connect: ["api.anthropic.com:443"]`, `env: ["ANTHROPIC_API_KEY"]` | |
| `core-executor-openai` | SCOPED | `net.connect: ["api.openai.com:443"]`, `env: ["OPENAI_API_KEY"]` | Stub-throw bug (Finding 20) is orthogonal |
| `core-executor-debug` | TRUSTED | — | Canned responses; no I/O |
| `core-executor-shell` | **UNSCOPED** | `exec.binaries: ["*"]` | Finding 7 — its existence as a tier-checked UNSCOPED plugin *is* the fix |
| `core-cli` | SCOPED (tentative) | TBD — inspect current subprocess usage during implementation | |
| `kaizen-plugin-timestamps` | SCOPED | `events.subscribe: ["core-lifecycle:*"]` | Observes cross-plugin events |

**Decision:** `ctx.tty` is not added in v1. First-party plugin ships SCOPED.
Defer `ctx.tty` until a second UI plugin (web/TUI/GUI) reveals the real API
shape. YAGNI.

## Incentive Structure (Levers Adopted)

### Lever 1 — install friction asymmetry

- SCOPED plugins: lockfile-acceptable in CI via `--trust-lockfile`.
- UNSCOPED plugins: lockfile authoring requires interactive `--allow-unscoped`
  on the machine where the lockfile is first written. CI inherits the decision
  but cannot silently add new UNSCOPED plugins.
- Operators see UNSCOPED additions as diffs in PRs reviewing the lockfile.

### Lever 3 — `--observe` manifest generation

- `kaizen plugin dev --observe` generates the manifest from observed behavior.
- Manifest drift becomes a generated artifact, not a handwritten liability.
- This is the load-bearing lever that makes SCOPED authoring ergonomic. Without
  it, authors default to UNSCOPED out of laziness.

### Lever 5 — honest documentation

- Plugin-author docs: "Choose UNSCOPED only when you genuinely cannot do the
  job within SCOPED. Most plugins can run in SCOPED."
- Security model documented in the repo README (Finding 16 partial fix).

## Migration Sequencing

1. Ship enforcer + `ctx.*` surface + permission DSL in core — enforcement
   *off* by default initially (log-only mode).
2. Migrate built-ins one at a time. Each PR: plugin migration + local assertion
   that it still works in log-only mode.
3. Flip enforcer from "log-only" to "enforce" via config flag; test with
   built-ins; make enforce the default.
4. Ship `kaizen plugin dev --observe` once the enforcer exists (same hook
   points, one flag).
5. Update README and write the threat-model doc.

## Out-of-Scope Findings (Explicit)

**Folded in:** 2, 3, 4, 7, 11, 13, 17 (partial), 16 (partial via README).

**Explicitly deferred:** 5, 6, 8, 9, 10 (obsoleted), 12, 14, 18, 19, 20.

## Open Questions for Implementation

1. **AST pre-check library.** Does Bun expose a stable AST API for the entry-file
   import scan, or do we use a small dedicated parser? Affects implementation
   complexity and maintenance burden.
2. **`core-cli` current behavior.** Inspect during implementation; tier
   assignment depends on what subprocesses it spawns today.
3. **Lockfile format YAML vs JSON.** YAML is human-editable (expert story 1);
   JSON is trivially machine-readable (CI story 3). Lean YAML with JSON as a
   stretch alternative. Revisit if YAML tooling is a dependency burden.
4. **TTY permission grammar.** `fs.read: ["$TTY"]` is suggestive but
   `core-ui-terminal` actually reads `process.stdin` / writes `process.stdout`.
   May need a dedicated `io: { stdin: true, stdout: true }` grant. Finalize
   during `core-ui-terminal` migration.
