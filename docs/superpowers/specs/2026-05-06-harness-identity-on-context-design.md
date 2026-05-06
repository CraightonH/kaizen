# Harness identity on PluginContext

## Context

Plugins have no way to know which harness they're loaded under. The bootstrap
code in `src/cli.ts:410-428` resolves the harness ref and the absolute path to
the harness JSON, but neither value flows into `PluginContext`
(`src/types/plugin.ts`, `src/core/context.ts`).

This matters for any plugin that persists state to disk and needs to partition
that state by harness — otherwise data captured under harness A (with plugins
X, Y, Z) can be silently loaded under harness B (with a different plugin set),
producing missing tools, mismatched message shapes, etc.

The motivating case is a forthcoming `llm-session-manager` plugin that owns
conversation persistence at `~/.kaizen/sessions/<harness>/<session-id>/...`.
Without a harness identifier exposed at runtime, it can't safely partition.

GitHub issue: <https://github.com/CraightonH/kaizen/issues/74>.

## Design principle

Kaizen exposes **raw bootstrap metadata only** — no canonical `name`, no
derived slug, no policy. Plugins manipulate the raw inputs to produce whatever
namespacing key they want (basename, hash, ref-without-version, content hash
of the JSON, etc.).

This is consistent with kaizen's stated stance of mechanism over policy:
the harness identity contract is "here is what we know," not "here is what
you should call it."

## API addition

A new `harness` field on `PluginContext`:

```ts
// src/types/plugin.ts (inside interface PluginContext)

/**
 * Raw metadata about the harness this plugin was loaded under. Both inner
 * fields may be absent (e.g. programmatic `runHarness()` without a file on
 * disk, or `kaizen` invoked from a directory containing `kaizen.json` with
 * no `--harness` ref).
 *
 * Kaizen does not derive a canonical `name`. Plugins that need a stable
 * namespacing key derive one from these inputs themselves — typically by
 * preferring `jsonPath` over `ref` and falling back to a literal default
 * when both are absent.
 */
harness: {
  /** Absolute path to the resolved harness JSON, if bootstrapped from a file. */
  jsonPath?: string;
  /** The ref the user passed (`--harness <ref>` or `defaults.harness`), if any. */
  ref?: string;
};
```

The outer `harness` field is **always present**. The inner fields are
individually optional. This keeps the common path (`ctx.harness.jsonPath`)
ceremony-free; plugins only have to deal with `undefined` on the leaves.

No permission gate. This is static metadata, parallel in spirit to
`ctx.config`.

## Plumbing

The harness metadata is threaded through the existing bootstrap path. No new
module-level state, no globals.

### Call graph

```
cli.ts (resolves harnessArg + resolvedHarnessJsonPath)
  └─> runHarness({ kaizenConfig, lockfilePath, harness })
        └─> initializePluginSystem(kaizenConfig, { lockfilePath, harness })
              └─> new PluginManager(..., harness)
                    └─> createPluginContext(..., harness)   // every call site
```

### Files to change

**`src/types/plugin.ts`**
- Add the `harness` field to `PluginContext` (see API above).

**`src/core/context.ts`**
- `createPluginContext()` gains a new parameter `harness: { jsonPath?: string; ref?: string }`.
- Spread `{ harness }` onto the returned object.

**`src/core/plugin-manager.ts`**
- Constructor (`:329`) gains a new parameter `harness: { jsonPath?: string; ref?: string }`, stored as `private readonly harness`.
- The single `createPluginContext()` call site at `:731` passes `this.harness`. (Reload paths route back through this same builder, so no other call sites need updating.)

**`src/core/index.ts`**
- `InitializePluginSystemOpts` gains `harness?: { jsonPath?: string; ref?: string }`.
- `RunHarnessOpts` gains `harness?: { jsonPath?: string; ref?: string }`.
- Default to `{}` when not provided.
- Pass through to `new PluginManager(...)` and to the driver's `createPluginContext(...)` call (`:97`).

**`src/cli.ts`**
- After computing `resolvedHarnessJsonPath` and `harnessArg` (`:410-428`),
  build `harness = { jsonPath: resolvedHarnessJsonPath, ref: harnessArg }`
  (omit fields that are empty/undefined).
- Forward `harness` into the `runHarness` / `initializePluginSystem` call.
- The plugin subcommand path (`consent`, `review`, `audit`) also resolves
  `resolvedHarnessJsonPath` (`cli.ts:434-435` and adjacent dispatch sites)
  but does not currently drive the plugin lifecycle through `runHarness`.
  No change needed there for this spec — but if any of those paths gain
  plugin-loading behavior later, they must thread `harness` through too.

### Behavior when nothing is known

- Programmatic `runHarness({ kaizenConfig, lockfilePath })` with no `harness`
  opt → `ctx.harness === {}`.
- `kaizen` invoked from a directory with `kaizen.json` and no `--harness` →
  `ctx.harness === { jsonPath: "<absolute path>" }` (no `ref`).
- `kaizen --harness official/openai-compatible@1.2.3` → both fields populated.

## Tests

**`src/core/context.test.ts`** (or new `harness-identity.test.ts`)
- `createPluginContext` with `harness: { jsonPath: "/x", ref: "y" }` exposes both.
- `createPluginContext` with `harness: {}` exposes `ctx.harness === {}`.

**`src/core/plugin-manager-harness.test.ts`** (new, modeled on `plugin-manager-onready.test.ts`)
- A plugin reads `ctx.harness.jsonPath` in `setup()`, `onReady()`, and (as the
  driver) `start()`; assert identical values across all three phases.
- A plugin loaded under no-harness conditions sees `ctx.harness === {}`.

**Bootstrap-level coverage** (`src/cli.test.ts` if it exists, otherwise the
nearest integration harness)
- Driving `kaizen` with `--harness <ref>` populates both fields.
- Driving `kaizen` from a cwd with `kaizen.json` and no `--harness` populates
  `jsonPath` only.

## Documentation

- Update the `PluginContext` doc comment in `src/types/plugin.ts` to mention
  `harness`.
- Add a short "Harness identity" section to `docs/guides/plugin-authoring.md`
  showing the canonical derivation pattern:

  ```ts
  const key =
    ctx.harness.jsonPath ??
    ctx.harness.ref ??
    "default";
  // namespacing key for on-disk state
  ```

  Be explicit that **both inner fields may be absent** and the plugin owns
  the fallback decision (refuse to persist, use a sentinel, etc.).

- Update `docs/concepts/architecture.md` if it enumerates `PluginContext`
  fields elsewhere.

## Out of scope

- Exposing the full resolved `KaizenConfig` (e.g. for plugins that want to
  namespace by `extends` chain). YAGNI; can be added later as a separate
  field if a real plugin needs it.
- Any "canonical name" derivation in core. Plugins do this themselves.
- Permission-gating `ctx.harness`. It is static metadata; no I/O.

## Verification

Run end to end:

1. `bun test src/core/context.test.ts src/core/plugin-manager-harness.test.ts` — unit + integration cover the field plumbing.
2. `bun run build` — type changes compile cleanly.
3. Manual: in a sample harness, add a plugin whose `setup()` logs
   `ctx.harness`. Run `kaizen --harness official/<x>@<v>`; confirm both
   fields are populated. Run `kaizen` from a directory with a local
   `kaizen.json`; confirm only `jsonPath` is populated.
