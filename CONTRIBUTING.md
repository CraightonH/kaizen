# Contributing to kaizen

## Running kaizen from source

The kaizen binary ships with zero plugins. Every plugin reaches users through
the marketplace install path. To run from source, you need a local checkout of
the official plugins repo and a one-time seed of `~/.kaizen/`.

### 1. Clone both repos side by side

```sh
git clone https://github.com/CraightonH/kaizen.git
git clone https://github.com/CraightonH/kaizen-official-plugins.git
```

### 2. Install deps

```sh
cd kaizen && bun install
cd ../kaizen-official-plugins && bun install
```

### 3. Seed the dev marketplace and install the default set

```sh
cd ../kaizen
./scripts/dev-setup.sh
```

The script is idempotent. It adds the sibling checkout as a local marketplace
named `official`, then installs the default plugin set + the debug harness.

Override the sibling location with `KAIZEN_PLUGINS_DIR=/path/to/checkout`.

### 4. Run

```sh
bun src/cli.ts --harness official/core-debug@1.0.0 run "hello"
```

## Contributing a plugin or harness

Plugins and harnesses live in the
[kaizen-official-plugins](https://github.com/CraightonH/kaizen-official-plugins)
repo. See its README for the contribution flow.

## Plugin standards

See [`docs/plugin-standards.md`](docs/plugin-standards.md) for the authoritative
plugin requirements. Run `kaizen plugin validate <plugin-dir>` to check a plugin
against them.
