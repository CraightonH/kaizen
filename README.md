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

**Plugin management:**
- `kaizen install <plugin>` — resolve, read manifest, run consent flow, write lockfile.
- `kaizen plugin consent <plugin>` — re-run consent (after version bump or drift).
- `kaizen plugin review <plugin>` — diff declared manifest vs. lockfile entry.
- `kaizen plugin audit` — list lockfile entries; flag UNSCOPED.
- `kaizen plugin dev --observe <dir>` — record operations, generate proposed manifest.

**Config & secrets:**
- `kaizen config show [<plugin>]` — show merged config for all plugins or one.
- `kaizen config get <plugin> <path>` — get a config value.
- `kaizen config set <plugin> <path> <value>` — set a config value.
- `kaizen config set-secret <plugin> <key>` — store a secret in OS keychain.

### Marketplace & plugin management

```bash
# Marketplace management
kaizen marketplace add <url> [--id <id>]   # Register a git-backed marketplace
kaizen marketplace list                     # List registered marketplaces
kaizen marketplace remove <id>             # Remove a marketplace
kaizen marketplace update [<id>]           # Pull latest catalog from upstream
kaizen marketplace browse [<id>]           # Browse available plugins

# Plugin install / manage
kaizen install <ref>                        # Install a plugin by ref
kaizen uninstall <ref> [--purge]           # Remove from harness config (--purge clears bits + lockfile)
kaizen update [<ref>]                       # Update plugins (silent when permissions unchanged)

# Ref forms
#   official/timestamps@1.2.3              marketplace-qualified (recommended)
#   timestamps@1.2.3                       shorthand (errors if ambiguous)
#   timestamps                             shorthand, resolves latest
#
# Raw URLs are rejected — publish harnesses in a marketplace instead.

# Run with a marketplace harness
kaizen --harness official/anthropic-default@1.0.0
```

**Secrets storage:** Kaizen stores secrets in OS-native vaults (macOS Keychain,
Windows Credential Manager, Linux libsecret) with a file-based fallback for
headless environments.

### CLI flags

- `--trust-lockfile` — use the existing lockfile for consent; do not prompt.
- `--allow-unscoped` — permit non-interactive consent of UNSCOPED plugins.
- `--non-interactive` — refuse any consent that would require a prompt.
- `KAIZEN_SANDBOX_MODE=log-only` — run the enforcer in log-only mode (records
  denials to the audit log but does not throw). Escape hatch; not for
  production.
