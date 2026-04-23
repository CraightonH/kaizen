# Kaizen config simplification (fix #34)

**Status:** Draft
**Tracks:** [#34](https://github.com/CraightonH/kaizen/issues/34)
**Related:** [#48](https://github.com/CraightonH/kaizen/issues/48) (format question, out of scope)

## Problem

`kaizen --harness <ref>` run from a directory with `.kaizen/kaizen.json` silently lets the local config's `plugins` array replace the harness's plugin list (see `src/core/config.ts:168`). The user asked for a specific harness; kaizen ran a different plugin set without telling them.

The root cause is conceptual: `.kaizen/kaizen.json` was trying to be three things at once — a harness selector (`extends`), a per-plugin config overlay, and an inline plugin list. Those three roles have conflicting merge semantics and their interaction has never been cleanly specified. The #34 clobber is the most visible symptom; other merge-bug classes lurk behind it.

## North star

The one user need kaizen cannot punt: **an installed plugin must be configurable for the user's environment.** Concrete example: a `gitlab` plugin ships with `base_url: https://gitlab.com`. A user of a self-hosted GitLab needs to override `base_url`, set their `username`, and store a token as a secret. Without this, plugins are hardcoded to their defaults and useless outside them.

Every other "configuration" concern is out of scope for this change.

## Design

### Single config file

There is exactly one kaizen config file: `~/.kaizen/kaizen.json`. It holds exactly two things:

```json
{
  "default_harness": "official/core-shell@1.0.0",
  "plugin_config": {
    "gitlab":   { "base_url": "https://gitlab.mycompany.com", "username": "alice" },
    "core-cli": { "clis": ["docker", "kubectl"] }
  }
}
```

- **`default_harness`** (optional, string): the harness ref used when `--harness` is not passed on the CLI.
- **`plugin_config`** (optional, object): per-plugin config overrides. Keyed by plugin name. Values are plugin-specific objects.

Any other top-level key is a validation error. In particular:

- **`plugins` is rejected.** The plugin set is defined by the harness. Users cannot add, remove, or replace plugins via config.
- Unknown top-level keys fatal with a clear message listing the allowed keys.
- A top-level `extends` key (the pre-change name) fatals with a targeted message telling the user to rename it to `default_harness`.

### No project-level config

- `.kaizen/kaizen.json` (project overlay) is removed entirely.
- Legacy root `kaizen.json` support is removed.
- `findProjectConfig`, `PROJECT_CONFIG`, and `LEGACY_CONFIG` are deleted.
- `.kaizen/harnesses/<name>/kaizen.json` (project-scoped harnesses) continues to work unchanged — that's a harness definition, not a config.
- `.kaizen/marketplaces/` (project-scoped marketplaces) continues to work unchanged.

### Harness resolution

When kaizen starts, the active harness is selected by this precedence:

1. `--harness <ref>` flag on the CLI.
2. `default_harness` field in `~/.kaizen/kaizen.json`.
3. Fatal with guidance (same shape as today's error).

Harness files keep their current schema: `plugins` is an array of refs, and per-plugin config keys may appear at the top level as defaults.

### The one overlay rule

For each plugin `P` in the active harness:

```
effective_config(P) = { ...harness_defaults_for(P), ...user_global_config_for(P) }
```

Shallow merge, user wins on conflicts. Applied only to plugin config — nothing else merges. `harness_defaults_for(P)` comes from the top-level `P`-keyed object inside the harness's `kaizen.json`. `user_global_config_for(P)` comes from `plugin_config[P]` in `~/.kaizen/kaizen.json`.

This is the entire configuration system. There is no other merge, no other overlay, no other precedence rule.

### Code changes

- Delete `mergeConfigs` from `src/core/config.ts`.
- Delete `findProjectConfig`, `PROJECT_CONFIG`, `LEGACY_CONFIG`.
- Rewrite `resolveConfig`:
  ```
  1. Determine harness ref: opts.harness || global.default_harness || fatal.
  2. Load harness config.
  3. If ~/.kaizen/kaizen.json has plugin_config, apply the per-plugin shallow merge described above.
  4. Return the resulting effective config.
  ```
- Add a validator for `~/.kaizen/kaizen.json` that rejects any top-level key outside `{default_harness, plugin_config}`, rejects `plugins` and `extends` with targeted messages, and validates that `plugin_config` is an object of objects.
- Update `loadKaizenConfig` (or split into `loadUserConfig`) so the user-config validator is distinct from the harness validator. They have different schemas now.

### `kaizen init`

Simplified to global-only:

- `kaizen init --global [--harness <ref>]` writes `~/.kaizen/kaizen.json`. With `--harness`, the file is `{"default_harness": "<ref>"}`. Without it, the file is `{}` and the user is told they'll need `--harness` on each run or must add `default_harness` manually.
- `kaizen init` without `--global` prints an error pointing to `--global` (project-level init no longer exists).
- Existing no-clobber behavior preserved: if `~/.kaizen/kaizen.json` already exists, print a message and exit 0.

### Migration

Users who have existing `.kaizen/kaizen.json` files (including ones produced by `kaizen init` pre-change) will see them become inert — kaizen no longer looks there. To avoid silent surprise:

- On first run where `.kaizen/kaizen.json` exists and `~/.kaizen/kaizen.json` does not, print a prominent warning:
  > Found `.kaizen/kaizen.json`. Project-level config is no longer supported. Move `extends` to `~/.kaizen/kaizen.json` as `default_harness`, or pass `--harness` explicitly. See `docs/concepts/configuration.md`.
- Same warning for legacy root `kaizen.json`.
- The warning reads the deprecated file only to surface useful info in the message; it is not merged into config.

Users whose existing `.kaizen/kaizen.json` contains plugin config overrides must move those entries under `plugin_config` in `~/.kaizen/kaizen.json`. The warning references the docs update.

### Docs

- `docs/concepts/harnesses.md`: remove the "local config overrides harness" section; describe the single overlay rule.
- `docs/guides/plugin-authoring.md`: note that plugin authors should document each config key the plugin reads so users know what to put under `plugin_config.<plugin>`.
- Add `docs/concepts/configuration.md` (new, short): the `~/.kaizen/kaizen.json` schema and the one merge rule.

## What's explicitly out of scope

Each of these was discussed during brainstorming and deliberately deferred:

- **Per-project plugin config overrides.** The "different gitlab URL per project" use case is not supported in v1. Users fork a harness and tune defaults there, or live with one global config. Revisit once a consistent override architecture is designed.
- **Per-project default harness.** No pointer file, no `.kaizen/harness`, no project config. Use `--harness` explicitly, or rely on the global `default_harness`.
- **`kaizen harness fork`.** Deferred. When we revisit per-project configuration, fork ergonomics and lockfile-copy semantics become part of that design.
- **File format change (YAML/JSONC).** Tracked in [#48](https://github.com/CraightonH/kaizen/issues/48). Will be decided holistically across harnesses, marketplaces, and user config.
- **Secrets.** Already handled by `kaizen config set-secret` and the secret providers. No change.

## Consequences

### Resolved

- **#34** dissolves by construction: no file exists to clobber the harness's plugin list.
- Plugin authors can ship sensible defaults (via harness) and know users can override exactly the keys that matter via `plugin_config`.
- The mental model collapses to: one harness, one user config, one merge rule.

### Accepted trade-offs

- Users who relied on `.kaizen/kaizen.json` to scope behavior per-repo lose that ability until the override architecture is redesigned. The migration warning surfaces this; the docs point at alternatives (`--harness` per invocation, or fork a harness).
- `kaizen init` is less useful than before — it writes a nearly-empty file. Acceptable because the file it used to produce was misleading (DEFAULT_PLUGINS was inconsistent with the overlay semantics and contributed to #34).

### Reversibility

If a future override design requires project-level config, this simplification does not foreclose it — reintroducing a second layer is additive on top of the clean single-overlay rule. The change we're avoiding is trying to design that layer now without a clear use case.

## Implementation order

1. Add user-config validator (rejects `plugins`, unknown keys); drop `mergeConfigs` reliance on project config.
2. Delete `findProjectConfig` and the project/legacy config branches of `resolveConfig`.
3. Add the single-overlay `plugin_config` merge.
4. Rewrite `kaizen init` for `--global`-only.
5. Add the deprecation warning for existing `.kaizen/kaizen.json` / root `kaizen.json`.
6. Update docs.
7. Update fixtures and tests.
