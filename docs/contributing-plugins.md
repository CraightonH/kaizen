# Contributing a plugin or harness

First-party plugins and harnesses live in
[`kaizen-official-plugins`](https://github.com/CraightonH/kaizen-official-plugins).
This doc is the authoritative contribution flow. The kaizen-code repo owns the
standards — the plugins repo owns the source.

## Contributing a plugin

### 1. Scaffold

From inside a `kaizen-official-plugins` checkout:

```sh
kaizen plugin create plugins/<name>
```

This produces a working skeleton matching the standards in
[`docs/plugin-standards.md`](plugin-standards.md).

### 2. Implement

- Import types from `kaizen/types`, never from a relative path into kaizen.
- Declare permissions: `trusted`, `scoped` (with grants), or `unscoped`.
- Declare capabilities (`provides` / `consumes`).
- Declare `config.schema` + `config.secrets` if the plugin needs configuration.

### 3. Test and document

- At least one `*.test.ts` that exercises metadata + `setup()`.
- `README.md` documenting configuration, permissions, and capabilities.

### 4. Validate

```sh
kaizen plugin validate plugins/<name>
```

All errors must be fixed before publishing. Warnings are informational.

### 5. Add to the catalog

Edit `.kaizen/marketplace.json` and add a plugin entry:

```json
{
  "kind": "plugin",
  "name": "<name>",
  "description": "...",
  "categories": ["..."],
  "versions": [
    {
      "version": "0.1.0",
      "source": { "type": "file", "path": "plugins/<name>" },
      "minKaizenVersion": "<current-kaizen-version>"
    }
  ]
}
```

### 6. Validate the catalog

```sh
kaizen marketplace validate .
```

### 7. Open a PR

Against `kaizen-official-plugins`.

## Contributing a harness

Same shape. Harness files live under `harnesses/<name>.json`, and catalog
entries use `kind: "harness"`. Every plugin ref inside a harness must be the
canonical `<marketplace>/<name>@<version>` form — bare names are rejected.

```json
{
  "plugins": [
    "official/core-events@0.1.0",
    "official/core-lifecycle@0.1.0"
  ]
}
```

## Standards

See [`docs/plugin-standards.md`](plugin-standards.md) for the authoritative
rules that `kaizen plugin validate` enforces.
