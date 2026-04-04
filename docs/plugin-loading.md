# Plugin Loading Internals

How kaizen resolves and loads plugins from a compiled Bun binary.
Relevant to anyone working on `src/core/` or debugging plugin load failures.

## The core problem

Inside a compiled Bun binary, `import.meta.url` resolves to `/$bunfs/root/<binary-name>` —
Bun's virtual filesystem. `createRequire(import.meta.url)` cannot traverse the real
filesystem from there, so `require.resolve()` fails for any installed package.

**Fix:** anchor `createRequire` to `process.execPath` (always a real on-disk path) and
pass explicit resolution paths derived from the known global/local roots.

```typescript
import { createRequire } from "module";

const require = createRequire(process.execPath);
const resolved = require.resolve("kaizen-plugin-foo", { paths: resolvePaths });
const plugin = await import(resolved); // import() with absolute path works fine
```

Validated in `src/spike/loader-probe.ts`.

## Resolution path order

```typescript
const resolvePaths = [
  getBunGlobalRoot(),    // ~/.bun/install/global/node_modules  (primary)
  getNpmGlobalRoot(),    // npm root -g                         (fallback)
  cwd + "/node_modules", // project-local install
];
```

`getBunGlobalRoot()` parses the first line of `bun pm ls --global`.
`getNpmGlobalRoot()` calls `npm root -g`. Both have a 5-second timeout; failures return `""`.

Plugins referenced by path (`./my-plugin`, `/absolute/path`) bypass this lookup —
`require.resolve()` is called directly on the path.

## How deps resolve at runtime

When kaizen calls `import(resolvedAbsolutePath)` and the plugin does its own imports
(`import foo from 'some-dep'`), Node/Bun resolves deps by walking up the directory tree
from the plugin file's location looking for `node_modules/`.

**Globally installed plugin** (`bun add --global kaizen-plugin-foo`):
- Plugin lands at `~/.bun/install/global/node_modules/kaizen-plugin-foo/index.js`
- Deps are colocated: `~/.bun/install/global/node_modules/some-dep/`
- Upward traversal from plugin file finds them immediately — works automatically

**Locally installed plugin** (`"plugins": ["./my-plugin"]` in kaizen.json):
- Plugin is loaded from its absolute path on disk
- Deps must be present in the plugin's own `node_modules/` (`bun install` inside the plugin dir)
- Upward traversal from plugin file finds `./my-plugin/node_modules/some-dep/` — works

## Plugin package requirements

A plugin package must:

```json
{
  "type": "module",
  "exports": { ".": "./index.js" }
}
```

- `"type": "module"` — kaizen plugins are ESM
- `"exports"` field — kaizen uses this for resolution; `"main"` alone is not sufficient
- Default export must satisfy the `KaizenPlugin` shape (`name`, `apiVersion`, `setup`)

No special build step required. Bun loads TypeScript directly during development;
published plugins should ship compiled JS.

## Development workflow for plugin authors

```
my-plugin/
  package.json   # type: module, exports, name matches plugin.name
  index.ts       # default export: KaizenPlugin
  node_modules/  # run `bun install` — required for dep resolution at runtime
```

Reference in `kaizen.json`:
```json
{
  "plugins": ["./my-plugin"]
}
```

The plugin is loaded from its absolute path. **`bun install` must have been run inside
the plugin directory** — deps will not be found otherwise (there is no parent
`node_modules/` to fall back to when loading a local-path plugin).

## Known limitation: `bun add --global <local-path>` installs symlinks

When you run `bun add --global ./my-plugin`, Bun installs symlinks into global
`node_modules/`, not copies. `require.resolve()` follows the symlink and returns
the real path, so dep resolution falls back to the plugin's source directory — same
behavior as the local-path case above. Run `bun install` inside the plugin directory.

This only affects local development. Published plugins installed from the npm registry
are always copied, not symlinked.

## Spike

`src/spike/loader-probe.ts` validates all of the above from an actual compiled binary.
Run it with:

```bash
bun add --global is-odd   # probe dependency
bun run spike
```

Expected output: 4 passed, 0 failed.
