# Harnesses

*Read when: you want to share a pre-configured kaizen setup, or use one someone shared.*

> **See also:** [`docs/concepts/configuration.md`](./configuration.md) — how user config in
> `~/.kaizen/kaizen.json` interacts with the active harness (default harness selection,
> per-plugin config overrides, and merge order).

A **harness** is a `kaizen.json` — a plugin list plus default config for each plugin.
Harnesses are distributed through **marketplaces** alongside plugins. A harness
entry in a marketplace catalog points at a versioned directory containing a
`kaizen.json`.

## Using a harness

### Marketplace ref (primary)

```bash
kaizen --harness official/core-anthropic@0.1.0
```

The ref format is `<marketplace-id>/<name>[@<version>]`. kaizen materializes the
harness into `~/.kaizen/marketplaces/<id>/harnesses/<name>/kaizen.json` on first
use, then loads it. Any marketplaces and plugins the harness references are
bootstrapped automatically (with consent prompts unless `--non-interactive` /
`--trust-lockfile` is set). For CI environments, run
`kaizen plugin consent --all --harness <ref>` once to pre-consent every plugin
in the harness before the first non-interactive run.

Add marketplaces with `kaizen marketplace add <url>` before referencing their
harnesses.

### Local path

```bash
kaizen --harness ./my-harness/kaizen.json
kaizen --harness ./my-harness/          # reads kaizen.json inside the folder
kaizen --harness /abs/path/to/kaizen.json
```

Paths must start with `./`, `../`, or `/`. Bare names are treated as scoped
lookups (see below), not relative paths.

### Project- and home-scoped directories

Bare names (no `/`, no path prefix) resolve against two well-known directories,
in order:

1. `.kaizen/harnesses/<name>/kaizen.json` (project)
2. `~/.kaizen/harnesses/<name>/kaizen.json` (user home)

```bash
kaizen --harness my-local-harness       # looks in .kaizen/harnesses/, then ~/.kaizen/harnesses/
```

Bare-name lookup does **not** scan `~/.kaizen/marketplaces/<id>/harnesses/`.
To use a marketplace harness, reference it by its full ref
(`<marketplace-id>/<name>[@<version>]`), either via `--harness` or via `extends`.

### URL harnesses are not supported

```bash
kaizen --harness https://example.com/kaizen.json   # ERROR
```

Raw URL harnesses are rejected. Publish the harness in a marketplace and
reference it by ref instead.

## Authoring a harness

A harness is a directory with a `kaizen.json` inside it:

```
my-devops-harness/
  kaizen.json          ← kaizen reads this
  system-prompt.txt    ← optional companion, referenced by plugin config
  README.md            ← optional
```

The `kaizen.json` lists plugins (by marketplace ref) and their config:

```json
{
  "plugins": [
    "official/core-events@0.1.0",
    "official/core-executor-anthropic@0.1.0",
    "official/core-ui-terminal@0.1.0",
    "official/core-cli@0.1.0",
    "official/core-driver@0.1.0"
  ],
  "core-executor-anthropic": {
    "model": "claude-opus-4-6",
    "api_key_env": "ANTHROPIC_API_KEY"
  },
  "core-cli": {
    "clis": ["gh", "kubectl"]
  },
  "core-driver": {
    "systemPrompt": "You are a DevOps assistant."
  }
}
```

Plugin entries may be marketplace refs (`<marketplace>/<name>[@<version>]`) or
local paths (`./`, `../`, `/`). Local paths are loaded directly by the plugin
manager and skipped during bootstrap install — useful for dev-time iteration on
first-party plugins. Use marketplace refs for portable harnesses you intend to
share.

## Sharing a harness

Publish the harness in a marketplace. See the marketplace docs for catalog
schema; the relevant part is a `harnesses` entry pointing at your harness
directory.

Consumers then use:

```bash
kaizen marketplace add <your-marketplace-url>
kaizen --harness <your-marketplace-id>/<harness-name>[@<version>]
```

For private or ad-hoc sharing, consumers can also drop the harness directory
into `.kaizen/harnesses/<name>/` (committed to the project) or
`~/.kaizen/harnesses/<name>/` (per-user). Both locations are resolved by bare
name.

## State files

Each harness carries its own `permissions.lock` sitting next to its `kaizen.json`:

- `.kaizen/harnesses/<name>/permissions.lock` (project)
- `~/.kaizen/harnesses/<name>/permissions.lock` (home)
- `~/.kaizen/marketplaces/<id>/harnesses/<name>/permissions.lock` (marketplace)

The lockfile records the consented tier and grants for each plugin in the harness.
Commit project-scoped lockfiles — they are the security record reviewed like code.

**Re-materialization preserves consent.** When a marketplace harness is re-fetched
(`kaizen marketplace update`), `permissions.lock` is preserved. If the re-fetched
`kaizen.json` changes a plugin's permissions, runtime re-prompts for consent on
next run because the tier-grant hash no longer matches.

**Multiple harnesses, one project.** Two harnesses in the same repo keep
independent consent records — consenting in one does not grant consent in the
other.

**A named harness is required.** `kaizen` without `--harness` and without
`defaults.harness` set in `~/.kaizen/kaizen.json` is an error. Use one of the
entry-point forms above, or set a default in your user config.

## Discovery

Harnesses live in the same marketplaces as plugins. Use:

```bash
kaizen marketplace list
kaizen marketplace browse <id>
```

to see what's available. There is no central registry beyond the marketplaces
you've added.

## Example configs

### Local LLM (Ollama)

```json
{
  "plugins": [
    "official/core-events@0.1.0",
    "official/core-executor-openai@0.1.0",
    "official/core-ui-terminal@0.1.0",
    "official/core-cli@0.1.0",
    "official/core-driver@0.1.0"
  ],
  "core-executor-openai": {
    "model": "llama3.2",
    "base_url": "http://localhost:11434/v1",
    "api_key": "ollama"
  }
}
```

### Autonomous agent (no UI)

```json
{
  "plugins": [
    "official/core-events@0.1.0",
    "official/core-executor-anthropic@0.1.0",
    "official/core-cli@0.1.0",
    "community/kaizen-plugin-autonomous@0.1.0"
  ],
  "kaizen-plugin-autonomous": {
    "max_steps": 50,
    "goal": "fix all failing tests"
  },
  "core-executor-anthropic": {
    "model": "claude-opus-4-6",
    "api_key_env": "ANTHROPIC_API_KEY"
  },
  "core-cli": { "clis": ["gh", "pytest"] }
}
```

`kaizen-plugin-autonomous` provides the `driver` capability and runs
headless — no `core-ui-terminal` needed.

