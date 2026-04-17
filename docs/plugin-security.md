# Plugin Security Model

*Read when: writing a plugin or reviewing someone else's.*

Kaizen runs plugins in-process, so they can reach everything Node can — unless
they declare what they need. Every plugin must pick a tier and, if SCOPED, list
its grants. The enforcer checks every external op at runtime.

## Pick a tier

| Tier | Use when | Install UX |
|------|----------|------------|
| **trusted** | Plugin only uses `ctx.*` — no fs/net/env/exec, no events from other plugins | Silent |
| **scoped** | Plugin touches external resources; you can enumerate exactly what | UAC shows grant list |
| **unscoped** | Plugin needs raw Node (runs user shell, dynamic spawn) | Typed confirmation required |

Default to TRUSTED. Escalate only when you hit a real need.

## Declare permissions

Permissions live on the plugin's default export, alongside (but orthogonal to)
the plugin's `capabilities` declaration — see
[`plugin-migration-capability-registry.md`](./plugin-migration-capability-registry.md)
for the capability model.

```typescript
const plugin: KaizenPlugin = {
  name: "my-plugin",
  apiVersion: "2.0.0",
  capabilities: { consumes: ["core-events:service"] },  // what this plugin wires into
  permissions: { tier: "trusted" },                     // what external I/O it's allowed
  async setup(ctx) { /* ... */ },
};
```

### SCOPED grants

Any grant you omit is denied. Lists are exact-match with glob support (`*`, `**`).

```typescript
permissions: {
  tier: "scoped",
  fs:     { read: ["./workspace/**"], write: ["./workspace/out/**"] },
  net:    { connect: ["api.example.com:443", "*.internal:*"] },
  env:    ["MY_API_KEY"],
  exec:   { binaries: ["git", "rg"] },
  events: { subscribe: ["core-lifecycle:*", "session:user_message"] },
},
```

### UNSCOPED

```typescript
permissions: {
  tier: "unscoped",
  exec: { binaries: ["*"] },  // informational; nothing enforced at this tier
},
```

## Use `ctx.*`, not raw Node

Non-UNSCOPED plugins can't `require("node:fs")`, `require("node:child_process")`,
etc. — the require patch refuses. Use the context surface instead:

| Raw Node | `ctx` equivalent |
|----------|-----------------|
| `fs.readFileSync(path)` | `await ctx.fs.readText(path)` |
| `fs.writeFileSync(path, data)` | `await ctx.fs.writeText(path, data)` |
| `fetch(url)` | `await ctx.net.fetch(url)` (global `fetch` also intercepted) |
| `process.env.X` | `ctx.secrets.get("X")` (env proxy also works, but explicit is clearer) |
| `execSync(cmd)` / `spawn(...)` | `await ctx.exec.run(binary, args, opts)` — returns `{exitCode, stdout, stderr}`, never throws on non-zero |
| `eventBus.on(...)` | `ctx.on(event, handler)` — checks `events.subscribe` grant |

Global `fetch` is also wrapped, so SDK code that calls fetch internally is still
checked against your `net.connect` grant — you don't need to port the SDK.

## Don't know what to declare? Use observe mode.

```bash
bun src/cli.ts plugin dev --observe --harness core-debug ./my-plugin
```

Runs your plugin inside the chosen harness with the enforcer in passive
recording mode. On exit (or Ctrl-C), writes:

- `./my-plugin/.kaizen/proposed-permissions.ts` — minimal synthesized manifest
- `./my-plugin/.kaizen/observe-<uuid>.jsonl` — raw record of every op

Review the proposed manifest, tighten globs by hand, paste into your plugin.

## Consent & lockfile

Installing a SCOPED plugin prints a UAC showing all grants; the user accepts or
rejects. Installing UNSCOPED requires typing the plugin name. Decisions persist
to `kaizen.permissions.lock` at the repo root — **commit this file**. Reviewers
see every plugin, its tier, and its declared grants.

Workflow:
- `kaizen install <plugin>` — resolve, read manifest, run consent, write lockfile
- `kaizen plugin review <plugin>` — diff declared manifest vs. lockfile
- `kaizen plugin consent <plugin>` — re-consent after a version bump
- `kaizen plugin audit` — list all lockfile entries; flag UNSCOPED

## Common pitfalls

**"My plugin subscribes to an event but nothing fires."** You need an
`events.subscribe` grant. Cross-plugin event subscription is enforced — declare
`events: { subscribe: ["other-plugin:*"] }` or the specific event name.

**"`process.env.X` returns `undefined` unexpectedly."** The env proxy hides
vars not in your grant. Add `X` to `env: [...]` or use `ctx.secrets.get("X")`.

**"SDK throws `net.connect` denial for a host I don't recognize."** The SDK
fetched somewhere you didn't declare. Look at the denial record
(`.kaizen/audit/*.jsonl`), add the host to `net.connect`. If the host is
dynamic, re-run observe mode to capture the real set.

**"I want to read/write stdin/stdout."** Not intercepted. TTY I/O stays
TRUSTED — the enforcer has no primitive for it. `core-ui-terminal` is the
reference case.

**"I need to `require('node:fs')` for a native module."** You don't, unless
you're UNSCOPED. If the module truly needs FFI or native addons, declare
UNSCOPED and accept the trust tradeoff.

## Escape hatch

Emergencies only:

```bash
KAIZEN_SANDBOX_MODE=log-only bun src/cli.ts --harness my-harness
```

Denials log to `.kaizen/audit/` but don't throw. Don't ship production code
that depends on this — fix the manifest.

## Threat model (honest limits)

See the "What's not enforced" section in [`../README.md`](../README.md) — in
short, this sandbox defeats honest-but-buggy and casually-malicious plugins,
not V8 JIT escapes, FFI, or supply-chain attacks. Lockfile hash verification
catches post-consent code swaps but does not verify npm resolution itself.

## Further reading

- [`plugin-api.md`](./plugin-api.md) — full plugin API reference
- [`plugin-migration-capability-registry.md`](./plugin-migration-capability-registry.md) — v1 → v2 capability model (orthogonal to permissions but required for loading)
- [`plugin-loading.md`](./plugin-loading.md) — load order, lifecycle, dependency resolution
- [`adversarial-review.md`](./adversarial-review.md) — known findings; numbered references appear in code comments
