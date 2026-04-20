# kaizen

**A platform for building LLM harnesses from composable plugins.**

> Code for what's deterministic. LLMs for what isn't.

Kaizen is not a harness. It's the **harness platform** — a plugin loader, event
bus, permissioned host API, and resolver. You compose a harness by declaring the
plugins you want; kaizen installs them, wires them together, and runs the
session loop one of them defines.

The binary ships with **zero plugins**. All first-party plugins and harnesses
live in [`kaizen-official-plugins`](https://github.com/CraightonH/kaizen-official-plugins).
The installer seeds the `official` marketplace and pre-installs a default
stack. From source, run `scripts/dev-setup.sh` against a sibling checkout — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Concepts

### Harnesses

A **harness** is a declarative set of plugins plus config. Publish one to a
marketplace and anyone can run your exact LLM workflow in a single command:

```bash
kaizen --harness example-marketplace/example-workflow@1.0.0
```

Kaizen handles resolution, installation, consent, and lockfile management for
every plugin the harness names — transitively.

### Plugins are first-class

Plugins are the unit of functionality. Core is intentionally minimal (loader +
event bus + tool primitives); everything else — the session loop, UI, executors,
tools, integrations — ships as plugins. The CLI has first-class scaffolding for
both sides:

```bash
kaizen plugin create <path>         # scaffold a new plugin
kaizen plugin validate [<path>]     # lint structure & manifest
kaizen marketplace create <path>    # scaffold a marketplace
kaizen marketplace validate [<path>]
```

### Two ways plugins interact

**1. Event bus.** Plugins subscribe to named events to pre/post-process work
done elsewhere. Any plugin can `defineEvent` new channels, and any other plugin
(with the right grant) can `on(...)` to observe or transform. This is how you
hook tool calls, inject prompts, log activity, or redact output without
touching the plugin that emits the event.

**2. Host API.** Plugins can *publish* their own typed API for other plugins to
call. Install a git plugin and every other plugin in the harness can do git
operations through it. Install a secrets plugin and the rest of the stack gets
vault access for free. The event bus is for reacting; the host API is for
**composing capabilities**.

## Security model

Plugins run in the same process as core but are constrained by a permission
manifest declared in each plugin's default export. Three tiers:

- **TRUSTED** — stays inside kaizen's `ctx.*` capability surface. No
  filesystem, network, env, or subprocess access. Installs silently.
- **SCOPED** — declares narrow grants (`fs`, `net`, `env`, `exec`, cross-plugin
  `events`). Kaizen enforces each grant at runtime. Install-time UAC shows the
  full grant list for user review.
- **UNSCOPED** — declares no bounds; full Node.js access. Install-time UAC
  requires typed confirmation of the plugin name. Trust granted by user fiat.

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
  declared `events.subscribe` grant.

### Honest limits

- `process.stdin` / `process.stdout` are not intercepted. `core-ui-terminal`
  uses these directly as TRUSTED.
- Native addons, FFI, and `bun:ffi` escape the sandbox at runtime. Non-UNSCOPED
  tiers refuse to load modules that import these.
- V8 JIT escape or a kernel exploit defeats the sandbox. The threat model is
  honest-but-buggy and casual-malicious plugins, not nation-state adversaries.
- Supply-chain integrity (plugin signing, npm provenance) is **not yet
  verified**. Hash-pinning in the lockfile catches post-consent tampering, but
  the initial npm resolution is not authenticated.

### Lockfile

Consent is persisted in `kaizen.permissions.lock` at the repo root. **Commit
this file** — reviewers see every plugin your harness runs, its tier, and its
declared grants.

### Authoring SCOPED plugins

Don't hand-track every I/O call. Run your plugin in observe mode:

```bash
kaizen plugin dev --observe ./my-plugin
```

Kaizen runs the plugin permissively, records every attempted operation, and
writes a minimal proposed manifest to
`./my-plugin/.kaizen/proposed-permissions.ts`.

## CLI reference

**Plugin authoring:**
- `kaizen plugin create <path>` — scaffold a plugin (interactive or `--defaults`).
- `kaizen plugin validate [<path>]` — lint package.json, manifest, test file, README.
- `kaizen plugin dev --observe <dir>` — record operations, generate proposed manifest.

**Plugin management:**
- `kaizen install <ref>` — resolve, read manifest, run consent flow, write lockfile.
- `kaizen uninstall <ref> [--purge]` — remove; `--purge` clears bits + lockfile.
- `kaizen update [<ref>]` — update plugins (silent when permissions unchanged).
- `kaizen plugin consent <plugin>` — re-run consent (after version bump or drift).
- `kaizen plugin review <plugin>` — diff declared manifest vs. lockfile.
- `kaizen plugin audit` — list lockfile entries; flag UNSCOPED.

**Marketplace:**
- `kaizen marketplace create <path>` — scaffold a marketplace.
- `kaizen marketplace validate [<path>]` — check structure.
- `kaizen marketplace add <url> [--id <id>]` — register a git-backed marketplace.
- `kaizen marketplace list | remove <id> | update [<id>] | browse [<id>]`

**Config & secrets:**
- `kaizen config show [<plugin>]` — merged config for all plugins or one.
- `kaizen config get <plugin> <path>` / `set <plugin> <path> <value>`
- `kaizen config set-secret <plugin> <key>` — store in OS keychain (macOS
  Keychain, Windows Credential Manager, Linux libsecret; file fallback for
  headless).

**Ref forms:**
```
official/timestamps@1.2.3    marketplace-qualified (recommended)
timestamps@1.2.3             shorthand (errors if ambiguous)
timestamps                   shorthand, resolves latest
```
Raw URLs are rejected — publish harnesses in a marketplace instead.

**Flags:**
- `--trust-lockfile` — use existing lockfile for consent; do not prompt.
- `--allow-unscoped` — permit non-interactive consent of UNSCOPED plugins.
- `--non-interactive` — refuse any consent that would require a prompt.
- `KAIZEN_SANDBOX_MODE=log-only` — enforcer logs denials but does not throw.
  Escape hatch; not for production.
