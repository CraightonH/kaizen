# Design: Plugin & Marketplace Scaffolders + Coding Standards

Date: 2026-04-18
Status: APPROVED
Related:
- `docs/plugin-api.md` (the authoring reference this spec extends)
- `docs/superpowers/specs/2026-04-18-plugin-marketplace-design.md` (Spec 1 — marketplace format)
- `docs/superpowers/specs/2026-04-18-unified-plugin-config-design.md` (Spec 2 — config schema)

---

## Problem Statement

Authoring a kaizen plugin today is Wild West. There is no scaffolder, no enforced
structure, no standards document, no linter, and no test template. New authors read
`docs/plugin-api.md`, copy an existing plugin, and hope they don't miss something.
Common failure modes:

- Wrong `package.json` (missing `exports`, wrong `type`).
- Missing `apiVersion` or wrong format.
- No tests.
- No README.
- Permissions not declared (defaults to `trusted` silently when the plugin actually
  needs `scoped`).
- Config accessed raw without a schema declaration (pre-Spec 2).
- Publishing to npm without the `kaizen-plugin` keyword.

Marketplace authoring is even more undefined — there is no tooling to create or
validate a `.kaizen/marketplace.json`.

This design introduces:

1. **`kaizen plugin create <path>`** — interactive plugin scaffolder.
2. **`kaizen marketplace create <path>`** — marketplace scaffolder.
3. **`kaizen plugin validate [<path>]`** — lint + standards check for plugins.
4. **`kaizen marketplace validate [<path>]`** — validate a marketplace catalog.
5. **`docs/plugin-standards.md`** — the canonical coding standards document.

---

## Design Philosophy

- **Scaffolded output must pass `validate` immediately.** A freshly scaffolded plugin
  or marketplace runs `kaizen plugin validate` / `kaizen marketplace validate` with
  zero errors. It also runs `bun test` and passes.
- **`create` is opinionated, `validate` is the law.** The scaffolder picks sensible
  defaults; authors can deviate. The validator enforces what's actually required.
- **Standards are checkable.** Every rule in `docs/plugin-standards.md` maps to a
  `validate` check. If it can't be checked, it doesn't belong in standards; it
  belongs in guidelines.

---

## Scope

### In Scope

- `kaizen plugin create <path>` interactive scaffolder (TypeScript output).
- `kaizen marketplace create <path>` scaffolder.
- `kaizen plugin validate [<path>]` — static + structural checks.
- `kaizen marketplace validate [<path>]` — catalog schema + entry checks.
- `docs/plugin-standards.md` — coding standards.
- Test template using `bun:test`.
- README template.

### Out of Scope

- `kaizen plugin publish` — publishing workflow (future).
- `kaizen plugin build` — tarball packaging (future).
- JavaScript (non-TypeScript) scaffolding — TypeScript only for v1.
- IDE extension / language-server integration.
- Automatic migration of existing plugins to standards (manual with guidance).

---

## `kaizen plugin create <path>`

Interactive scaffolder that creates a new plugin directory at `<path>`.

### Prompts

```
Plugin name: (kebab-case, e.g. my-plugin)
Description: (one line)
Permission tier: [trusted / scoped / unscoped]  (default: trusted)
  (if scoped) Grant types needed: [fs / net / env / exec / events] (multi-select)
Capabilities provided: (space-separated, e.g. core-lifecycle:executor.send)
Capabilities consumed: (space-separated, e.g. core-events:service)
Declare config schema? [y/N]
  (if y) Config keys: (name:type pairs, e.g. api_key:string timeout_ms:number)
  (if y) Required keys: (subset of above)
  (if y) Secret keys: (subset of above, for env var resolution)
```

All prompts have defaults and can be skipped (enter = accept default). Non-interactive
mode (`--defaults`) accepts all defaults silently and uses `<path>` basename as name.

### Generated files

```
<path>/
├── package.json
├── tsconfig.json
├── index.ts
├── index.test.ts
├── README.md
└── .kaizen/
    └── .gitkeep
```

#### `package.json`
```json
{
  "name": "<name>",
  "version": "0.1.0",
  "description": "<description>",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```

Key rules enforced:
- `"type": "module"` — ESM required.
- `"exports": { ".": "./index.ts" }` — kaizen uses `exports`, not `main`.
- `"keywords": ["kaizen-plugin"]` — required for npm discovery.

#### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true
  }
}
```

#### `index.ts`

Generated from the prompt answers. Example for a scoped plugin with env grant:

```typescript
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "my-plugin",
  apiVersion: "2.0.0",
  permissions: {
    tier: "scoped",
    env: ["MY_API_KEY"],
  },
  capabilities: {
    consumes: ["core-events:service"],
  },
  config: {
    schema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "API key." },
      },
      required: ["api_key"],
    },
    defaults: {},
    secrets: ["api_key"],
  },

  async setup(ctx) {
    // TODO: register tools, subscribe to events.
    ctx.log("my-plugin setup complete");
  },
};

export default plugin;
```

#### `index.test.ts`

```typescript
import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.ts";

const makeCtx = () => ({
  log: mock(() => {}),
  config: {},
  registerTool: mock(() => {}),
  on: mock(() => {}),
  defineEvent: mock(() => {}),
  emit: mock(async () => []),
  secrets: { get: mock(() => undefined) },
  // Add other ctx fields as needed.
} as any);

describe("my-plugin", () => {
  it("has correct metadata", () => {
    expect(plugin.name).toBe("my-plugin");
    expect(plugin.apiVersion).toBe("2.0.0");
  });

  it("setup runs without error", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.log).toHaveBeenCalled();
  });
});
```

#### `README.md`

```markdown
# my-plugin

> One-line description.

A kaizen plugin that does X.

## Installation

\`\`\`bash
kaizen install my-plugin
\`\`\`

## Configuration

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| api_key | string | yes | API key (env var name). |

Add to your harness:

\`\`\`json
{
  "plugins": ["my-plugin"],
  "my-plugin": {
    "api_key": "MY_API_KEY_ENV_VAR"
  }
}
\`\`\`

## Permissions

Tier: **scoped** — requires `env: ["MY_API_KEY"]`.

## Development

\`\`\`bash
bun test
kaizen plugin validate .
kaizen plugin dev --observe --harness core-debug .
\`\`\`
```

---

## `kaizen marketplace create <path>`

Creates a new marketplace directory at `<path>`.

### Prompts

```
Marketplace name: (e.g. my-org-plugins)
Description: (one line)
Marketplace URL: (git URL or leave blank for local-only)
```

### Generated files

```
<path>/
├── .kaizen/
│   └── marketplace.json
├── plugins/
│   └── .gitkeep
├── harnesses/
│   └── .gitkeep
└── README.md
```

#### `.kaizen/marketplace.json`

```json
{
  "version": "1.0.0",
  "name": "my-org-plugins",
  "description": "Kaizen plugins for my-org.",
  "url": "https://github.com/my-org/kaizen-plugins.git",
  "plugins": [],
  "harnesses": []
}
```

#### `README.md`

Template explaining the marketplace structure, how to add plugins, and how users add
the marketplace with `kaizen marketplace add`.

---

## `kaizen plugin validate [<path>]`

Validates a plugin at `<path>` (defaults to current directory).

### Checks

**Structural (always run):**

| Rule | Check |
|------|-------|
| `package.json` exists | File present |
| `name` is kebab-case | Regex: `^[a-z][a-z0-9-]*$` |
| `"type": "module"` | Field equals `"module"` |
| `exports["."]` present | Field present |
| `"kaizen-plugin"` keyword | `keywords` array includes it |
| Default export exists | Can statically detect a default export |
| `plugin.name` matches `package.json` name | Loaded name equals package name |
| `plugin.apiVersion` present and semver | Matches semver pattern |
| `permissions.tier` declared | Field present |
| SCOPED: at least one grant | At least one grant key populated |
| `capabilities` field present | Field present |
| Tests present | `index.test.ts` (or `*.test.ts`) exists |
| README present | `README.md` exists |

**Schema checks (run if `config.schema` declared):**

| Rule | Check |
|------|-------|
| Schema is valid JSON Schema | ajv compile succeeds |
| `secrets` keys are in schema | Each secret key appears in `schema.properties` |
| `secrets` keys are in `permissions.env` | Cross-check with permissions |

**Import scan (static analysis):**

| Rule | Check |
|------|-------|
| TRUSTED/SCOPED: no `node:fs` direct import | AST scan for forbidden imports |
| TRUSTED/SCOPED: no `node:child_process` import | AST scan |
| TRUSTED/SCOPED: no `node:worker_threads` import | AST scan |

The import scan is best-effort (static only). The runtime enforcer is the
authoritative gate; validate is an early-warning signal.

**Output:**

```
kaizen plugin validate ./my-plugin

  ✓ package.json present
  ✓ name is kebab-case: my-plugin
  ✓ type: module
  ✓ exports["."] present
  ✓ keywords: kaizen-plugin present
  ✓ apiVersion: 2.0.0
  ✓ permissions.tier: scoped
  ✓ config.schema valid
  ✗ config secrets key "api_key" not in permissions.env
  ✓ tests present: index.test.ts
  ✓ README.md present

1 error found. Fix errors before publishing.
```

Exit 0 if no errors, exit 1 if errors, exit 0 with warnings if only warnings.

---

## `kaizen marketplace validate [<path>]`

Validates a marketplace directory at `<path>` (defaults to current directory).

### Checks

| Rule | Check |
|------|-------|
| `.kaizen/marketplace.json` exists | File present |
| Schema version is `"1.0.0"` | Field equals expected |
| `name` present | Non-empty string |
| `url` present | Non-empty string |
| `plugins` is array | Type check |
| `harnesses` is array | Type check |
| Each plugin entry has `name`, `description`, `versions[]` | Field checks |
| Each harness entry has `name`, `description`, `versions[]` | Field checks |
| `file` source paths exist relative to root | `existsSync` check |

---

## `docs/plugin-standards.md`

The canonical coding standards document. Every rule is checkable by `kaizen plugin
validate` unless explicitly marked `[guideline]`.

### Outline

```
# Kaizen Plugin Coding Standards

## 1. Package Structure
   - Required: package.json with type:module, exports["."], kaizen-plugin keyword
   - Required: index.ts (or index.js for compiled) as default export entrypoint
   - Required: tests (index.test.ts minimum)
   - Required: README.md
   - Guideline: CHANGELOG.md for published plugins

## 2. Plugin Manifest
   - Required: name (kebab-case, matches package.json)
   - Required: apiVersion "2.0.0" (or current major)
   - Required: permissions.tier declared
   - Required: capabilities field (empty object acceptable)
   - Guideline: config.schema for any configurable plugin

## 3. Permission Tier Selection
   - Default to trusted. Escalate only when you hit a real need.
   - Use observe mode to determine actual grants needed.
   - UNSCOPED requires justification in README.

## 4. Capability Naming
   - Format: <owner-plugin>:<local-name>
   - Use existing capabilities where possible (do not re-declare core-events:service)
   - Local names: dot-separated, kebab segments (e.g. ui.input, lifecycle.drive)

## 5. Configuration
   - Declare config.schema for any configurable behaviour
   - Use config.secrets for env var references (not api_key_env pattern)
   - Provide defaults for optional keys
   - Document all config keys in README

## 6. Testing
   - Each plugin must have at least one test that calls setup()
   - Use bun:test as the test framework
   - Mock ctx using the makeCtx() pattern from the scaffold template
   - Tests must pass with `bun test` from the plugin directory

## 7. Error Handling
   - setup() should not throw unless the plugin cannot function at all
   - Tool handlers should return { ok: false, error: "..." } rather than throw
   - Log warnings with ctx.log(); reserve throws for unrecoverable states

## 8. Event Handling
   - Define custom events with ctx.defineEvent() before emitting
   - Document emitted events in README
   - Declare events.subscribe grant for cross-plugin subscriptions

## 9. Publishing
   - Keyword kaizen-plugin required for npm discovery
   - README must include: installation, configuration table, permissions section
   - Pin or document minimum kaizen version if using recent API features
   - Marketplace submission: open a PR to the target marketplace repo adding an
     entry to .kaizen/marketplace.json

## 10. API Version Pinning
   - Set apiVersion to the current core API major: "2.0.0"
   - Core warns (but loads) if major version mismatches
   - Breaking changes in core increment the major; plugins must update
```

---

## Component Architecture

### New: `src/commands/plugin-create.ts`

Interactive scaffolder. Depends on `prompts` (or Bun's built-in readline) for
interactive input. Emits files via `fs.writeFileSync`.

### New: `src/commands/marketplace-create.ts`

Marketplace scaffolder. Same approach.

### New: `src/commands/plugin-validate.ts`

Static + structural validation. AST scanning via Bun's built-in `Bun.Transpiler`
or TypeScript compiler API. ajv for schema validation.

### New: `src/commands/marketplace-validate.ts`

Catalog validation.

### Modified: `src/cli.ts`

Wire new subcommands:
- `kaizen plugin create <path>`
- `kaizen plugin validate [<path>]`
- `kaizen marketplace create <path>`
- `kaizen marketplace validate [<path>]`

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| `<path>` already exists (create) | Error: "Directory already exists. Use an empty path." |
| Prompt input is invalid | Re-prompt with error message |
| `--defaults` mode, name conflicts with existing npm package | Warning only; author decides |
| `validate` path not found | Error: "No plugin found at <path>." |
| `validate` import scan parse error | Warning: "Could not parse <file> for import scan." (non-fatal) |

---

## Testing

| Area | Approach |
|------|----------|
| Scaffolder output | Scaffolded plugin: `bun test` passes, `kaizen plugin validate .` passes |
| Marketplace scaffolder | Scaffolded marketplace: `kaizen marketplace validate .` passes |
| `validate` rules | One test per rule: passing case + failing case |
| Import scan | Static scan detects `import fs from "node:fs"` in TRUSTED plugin |
| Non-interactive mode | `--defaults` generates valid plugin with no prompts |

---

## Future Work

- **`kaizen plugin build`** — package plugin into a distributable tarball (`.tgz`),
  optionally signed, ready for a marketplace `file` or `tarball` source entry.
- **`kaizen plugin publish`** — open a PR to a target marketplace adding the entry.
- **JavaScript scaffolding** — for authors who prefer not to use TypeScript.
- **Custom templates** — `kaizen plugin create --template <url>` for org-specific
  boilerplate.
- **IDE integration** — JSON Schema for `kaizen.json` harness files to enable
  autocompletion in VS Code and other editors.
