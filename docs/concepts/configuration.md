# Configuration

Kaizen has exactly one user-editable config file: `~/.kaizen/kaizen.json`.

## Schema

```json
{
  "defaults": {
    "harness": "official/core-shell@1.0.0",
    "plugin_config": {
      "gitlab":   { "base_url": "https://gitlab.mycompany.com", "username": "alice" },
      "core-cli": { "clis": ["docker", "kubectl"] }
    }
  },
  "marketplaces": [
    { "id": "official", "url": "https://github.com/CraightonH/kaizen-marketplace.git" }
  ]
}
```

### Fields

- **`defaults`** *(optional, object)* — what this user defaults to.
  - **`defaults.harness`** *(optional, string)* — harness ref used when `--harness` is not passed on the CLI.
  - **`defaults.plugin_config`** *(optional, object)* — per-plugin config overrides, keyed by plugin name.
- **`marketplaces`** *(optional, array)* — registered marketplaces. Managed by `kaizen marketplace add/remove`.
- **`marketplaceUpdateTTL`** *(optional, number)* — background marketplace refresh interval in seconds.

Any other top-level key is a validation error.

## Effective plugin config

For each plugin `P` in the active harness:

```
effective_config(P) = { ...plugin_declared_defaults, ...harness_defaults, ...user_plugin_config }
```

User `defaults.plugin_config[P]` wins over harness defaults. Harness defaults win over the plugin's own declared defaults.

## Choosing a harness

The active harness is selected by:

1. `--harness <ref>` on the CLI
2. `defaults.harness` in `~/.kaizen/kaizen.json`
3. Otherwise, kaizen refuses to start.

## What moved

Project-level kaizen config (`.kaizen/kaizen.json` overlay and root `kaizen.json`) is no longer supported. If you had one, move its `extends` value to `defaults.harness` in `~/.kaizen/kaizen.json`. If it had per-plugin config overrides, move those under `defaults.plugin_config` in the same file. Per-project config scoping will be revisited in a future release.
