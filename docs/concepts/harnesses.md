# Harnesses

*Read when: you want to share a pre-configured kaizen setup, or use one someone shared.*

A **harness** is a `kaizen.json` — a plugin list plus default config for each plugin.
Harnesses are distributed through **marketplaces** alongside plugins. A harness
entry in a marketplace catalog points at a versioned directory containing a
`kaizen.json`.

## Using a harness

### Marketplace ref (primary)

```bash
kaizen --harness official/core-anthropic@0.1.0
```

The ref format is `<marketplace-id>/<name>@<version>`. kaizen materializes the
harness into `~/.kaizen/marketplaces/<id>/harnesses/<name>/kaizen.json` on first
use, then loads it. Any marketplaces and plugins the harness references are
bootstrapped automatically (with consent prompts unless `--non-interactive` /
`--trust-lockfile` is set).

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
(`<marketplace-id>/<name>@<version>`), either via `--harness` or via `extends`.

### URL harnesses are not supported

```bash
kaizen --harness https://example.com/kaizen.json   # ERROR
```

Raw URL harnesses are rejected. Publish the harness in a marketplace and
reference it by ref instead.

### Extending in kaizen.json

```json
{
  "extends": "official/core-anthropic@0.1.0",
  "core-lifecycle": {
    "systemPrompt": "You are a coding assistant."
  }
}
```

`extends` accepts the same forms as `--harness`:

- A marketplace ref (`<marketplace-id>/<name>@<version>`) — materialized into
  `~/.kaizen/marketplaces/<id>/harnesses/<name>/` on first run.
- A bare name present in `.kaizen/harnesses/<name>/` or
  `~/.kaizen/harnesses/<name>/`.
- A local path (`./path/to/kaizen.json` or `./path/to/harness-dir/`).

Raw URLs are rejected.

The harness provides the base plugin list and config; your local `kaizen.json`
overlays it.

## Config merge rules

| Key | Behavior |
|-----|----------|
| `plugins` | Local replaces harness entirely (if present) |
| Plugin config objects | Shallow merge — local wins on key conflicts |
| `extends` | Consumed during resolution, stripped from final config |

If local `kaizen.json` omits `plugins`, it inherits the harness plugin stack.
Add `plugins` to replace the stack entirely.

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
    "official/core-lifecycle@0.1.0"
  ],
  "core-executor-anthropic": {
    "model": "claude-opus-4-6",
    "api_key_env": "ANTHROPIC_API_KEY"
  },
  "core-cli": {
    "clis": ["gh", "kubectl"]
  },
  "core-lifecycle": {
    "systemPrompt": "You are a DevOps assistant."
  }
}
```

Plugin entries must be full marketplace refs (`<marketplace>/<name>@<version>`)
for the harness to be portable. Bare short names only resolve against locally
installed plugins and won't work for others.

## Sharing a harness

Publish the harness in a marketplace. See the marketplace docs for catalog
schema; the relevant part is a `harnesses` entry pointing at your harness
directory.

Consumers then use:

```bash
kaizen marketplace add <your-marketplace-url>
kaizen --harness <your-marketplace-id>/<harness-name>@<version>
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

**A named harness is required.** `kaizen` without `--harness` and without an
`extends` entry in `.kaizen/kaizen.json` is an error. Use one of the three
entry-point forms above.

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
    "official/core-lifecycle@0.1.0"
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

`kaizen-plugin-autonomous` provides the `lifecycle` capability and runs
headless — no `core-ui-terminal` needed.

### Extending an installed harness with local overrides

```json
{
  "extends": "./base-harness/kaizen.json",
  "core-lifecycle": {
    "systemPrompt": "Focus on the payments service."
  },
  "core-cli": {
    "clis": ["stripe", "gh"]
  }
}
```

`extends` takes a local path or a bare name under `.kaizen/harnesses/` or
`~/.kaizen/harnesses/`. For a marketplace harness, use `--harness
<marketplace>/<name>@<version>` at the CLI.
