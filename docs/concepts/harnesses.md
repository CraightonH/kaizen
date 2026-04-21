# Harnesses

*Read when: you want to share a pre-configured kaizen setup, or use one someone shared.*

A **harness** is a `kaizen.json` — a plugin list plus default config for each plugin.
The minimum harness is a single file. The unit of sharing is a URL or local path
pointing to a `kaizen.json` (or a folder containing one).

## Using a harness

### Built-in harness (short name)

```bash
kaizen --harness core-debug
kaizen --harness core-anthropic
```

kaizen ships built-in harnesses in `harnesses/<name>/kaizen.json`.

### Local path

```bash
kaizen --harness ./my-harness/kaizen.json
kaizen --harness ./my-harness/          # reads kaizen.json inside the folder
```

### URL

```bash
kaizen --harness https://example.com/my-harness/kaizen.json
kaizen --harness https://github.com/user/repo/raw/main/kaizen.json
```

kaizen fetches the file at startup and uses it as the harness config.

### Extending in kaizen.json

```json
{
  "extends": "core-debug",
  "core-lifecycle": {
    "systemPrompt": "You are a coding assistant."
  }
}
```

`extends` accepts any value that `--harness` accepts: a built-in short name, a
local path, or a URL. The harness provides the base plugin list and config; your
local `kaizen.json` overlays it.

## Config merge rules

| Key | Behavior |
|-----|----------|
| `plugins` | Local replaces harness entirely (if present) |
| Plugin config objects | Shallow merge — local wins on key conflicts |
| `extends` | Consumed during resolution, stripped from final config |

If local `kaizen.json` omits `plugins`, it inherits the harness plugin stack.
Add `plugins` to replace the stack entirely.

## Built-in harnesses

### `core-anthropic`
Full default stack: Anthropic LLM + terminal UI + CLI tools.

```bash
kaizen --harness core-anthropic
```

```json
{
  "plugins": ["core-events", "core-executor-anthropic", "core-ui-terminal",
              "core-cli", "core-lifecycle"],
  "core-executor-anthropic": {
    "model": "claude-opus-4-6",
    "api_key_env": "ANTHROPIC_API_KEY"
  },
  "core-cli": { "clis": [], "allow_destructive": false, "subprocess_timeout_ms": 30000 }
}
```

### `core-debug`
Debug executor: echoes messages and prints all lifecycle events. No API key needed.

```bash
kaizen --harness core-debug
```

### `core-shell`
Bash passthrough executor.

```bash
kaizen --harness core-shell
```

## Authoring a harness

The minimum harness is a single `kaizen.json`:

```json
{
  "plugins": [
    "core-events",
    "core-executor-anthropic",
    "core-ui-terminal",
    "core-cli",
    "core-lifecycle"
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

A folder harness can include companion files alongside `kaizen.json` (prompt
templates, tool scripts, README) — kaizen reads only `kaizen.json`:

```
my-devops-harness/
  kaizen.json          ← kaizen reads this
  system-prompt.txt    ← referenced by your plugin config
  README.md
```

## Sharing a harness

Share the `kaizen.json` directly — paste a URL, commit it to a repo, or put it
on a file host. The recipient uses it with:

```bash
kaizen --harness https://raw.githubusercontent.com/you/repo/main/kaizen.json
```

Or they save it locally and use a path:

```bash
kaizen --harness ./devops-harness/kaizen.json
```

## Discovery

There is no harness registry. Share harness URLs directly:
- GitHub/GitLab gists or repo raw URLs
- Any publicly accessible file host
- A README in your project or tool's docs

Plugins are still distributed via npm (`npm search kaizen-plugin`) since they
contain code. Harnesses are configuration only — a URL is sufficient.

## Example configs

### Local LLM (Ollama)

```json
{
  "plugins": ["core-events", "core-executor-openai", "core-ui-terminal",
              "core-cli", "core-lifecycle"],
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
  "plugins": ["core-events", "core-executor-anthropic", "core-cli",
              "kaizen-plugin-autonomous"],
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

`kaizen-plugin-autonomous` provides `["lifecycle"]` and runs headless — no
`core-ui-terminal` needed.

### Extending a shared harness with local overrides

```json
{
  "extends": "https://raw.githubusercontent.com/team/harnesses/main/backend.json",
  "core-lifecycle": {
    "systemPrompt": "Focus on the payments service."
  },
  "core-cli": {
    "clis": ["stripe", "gh"]
  }
}
```
