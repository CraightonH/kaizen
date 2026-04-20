# Plugin Loading

How kaizen resolves and loads plugins at session start.

Relevant to anyone working on `src/core/` or debugging plugin load failures.

## The model

kaizen ships with zero plugins. Every plugin — including the first-party core
stack — reaches a session through the **marketplace install path**. A plugin ref
in `kaizen.json` is either:

- **Canonical:** `<marketplace>/<name>@<version>` — the only form shipped
  harnesses use. Resolves against installed marketplaces only.
- **Legacy bare name:** resolved through fallback directories for authored
  plugins and npm installs.

## The core problem (compiled binary)

Inside a compiled Bun binary, `import.meta.url` resolves to
`/$bunfs/root/<binary-name>` — Bun's virtual filesystem.
`createRequire(import.meta.url)` cannot traverse the real filesystem from there,
so `require.resolve()` fails for any installed package.

**Fix:** anchor `createRequire` to `process.execPath` (always a real on-disk
path) and pass explicit resolution paths derived from the known global/local
roots. See `src/core/plugin-manager.ts::RESOLVE_PATHS`.

## Loader flow (canonical ref)

```
harness → <id>/<name>@<version>
   │
   ▼
ref-resolver.ts       parseRef + resolveRef against read catalogs
   │
   ▼
plugin-installer.ts   installPlugin(id, name, version, source)
                      → ~/.kaizen/marketplaces/<id>/plugins/<name>@<version>/
   │
   ▼
plugin-loader.ts      loadPluginFromInstallDir(id, name, version)
                      → await import(<install-dir>/index.ts)
                      → returns the default export (a KaizenPlugin)
```

## Plugin package requirements

```json
{
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "peerDependencies": { "kaizen": "*" }
}
```

- `"type": "module"` — kaizen plugins are ESM.
- `"exports"` field — kaizen uses this for resolution; `"main"` alone is not
  sufficient.
- Default export must satisfy the `KaizenPlugin` shape (`name`, `apiVersion`,
  `setup`).
- `"keywords": ["kaizen-plugin"]` — required by `kaizen plugin validate`.
- `peerDependencies.kaizen: "*"` — plugin imports its types from
  `kaizen/types`.

Authoritative rules live in `docs/plugin-standards.md`.

## Dep resolution at runtime

When kaizen calls `import(<install-dir>/index.ts)` and the plugin does its own
imports (`import foo from 'some-dep'`), Node/Bun resolves deps by walking up
the directory tree from the plugin file's location looking for `node_modules/`.

For a plugin installed from a `file:` source, `cpSync` copies the plugin
directory into the install tree. The plugin's own `node_modules/` must be
installed (the installer is responsible for this step when fetching from npm
or tarball sources; file sources rely on the marketplace checkout already
having deps present).

## Spike

`src/spike/loader-probe.ts` validates the compiled-binary resolution pipeline.
Run with `bun run spike`.
