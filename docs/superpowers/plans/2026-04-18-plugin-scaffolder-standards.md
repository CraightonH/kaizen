# Plugin & Marketplace Scaffolders + Coding Standards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `kaizen plugin create`, `kaizen marketplace create`, `kaizen plugin
validate`, `kaizen marketplace validate`, and `docs/plugin-standards.md`. After
this plan, a new plugin author has a fully standards-compliant scaffold in seconds,
and existing authors can check compliance with a single command.

**Spec:** `docs/superpowers/specs/2026-04-18-plugin-scaffolder-standards-design.md`

**Prerequisites:**
- Spec 1 (marketplace format) — `kaizen marketplace create` emits
  `.kaizen/marketplace.json` using the `entries[]` catalog shape with
  `kind: "plugin" | "harness"` tags and names unique across kinds.
- Spec 2 (unified config + secrets) — scaffolded plugins emit `config.schema`
  with `secrets: [...]` declarations, access secrets via `ctx.secrets.get()`,
  and (when any secret is declared) explicitly list
  `core-secrets:provider` in `capabilities.consumes`.

Both can be implemented in parallel; integrate templates after Specs 1+2 land.
This plan assumes Specs 1 and 2 are at least in draft with the current
revisions — templates here are written against those revisions.

---

## File Structure

**New files:**
- `src/commands/plugin-create.ts` — `kaizen plugin create` scaffolder
- `src/commands/plugin-create.test.ts`
- `src/commands/marketplace-create.ts` — `kaizen marketplace create` scaffolder
- `src/commands/marketplace-create.test.ts`
- `src/commands/plugin-validate.ts` — plugin validator
- `src/commands/plugin-validate.test.ts`
- `src/commands/marketplace-validate.ts` — marketplace catalog validator
- `src/commands/marketplace-validate.test.ts`
- `docs/plugin-standards.md` — coding standards document

**Modified files:**
- `src/cli.ts` — wire new subcommands

---

## Phase 1 — Standards Document

### Task 1: Write `docs/plugin-standards.md`

Write the full standards document first — it drives what the validator checks.

- [ ] **Step 1: Write `docs/plugin-standards.md`**

Content covers (see spec for full outline):
1. Package structure (required files, package.json fields)
2. Plugin manifest (required fields, apiVersion)
3. Permission tier selection
4. Capability naming
5. Configuration (config.schema, secrets pattern)
6. Testing (bun:test, makeCtx pattern, coverage expectations)
7. Error handling (return vs throw conventions)
8. Event handling
9. Publishing (keywords, README sections, marketplace submission)
10. API version pinning

Each rule is marked `[required]` (checked by `kaizen plugin validate`) or
`[guideline]` (informational only).

---

## Phase 2 — Plugin Validator

Implement the validator before the scaffolder — the scaffolder must produce output
that passes validation.

### Task 2: Implement `src/commands/plugin-validate.ts`

- [ ] **Step 1: Define `ValidationResult` type**

```typescript
export interface ValidationResult {
  rule: string;
  status: "pass" | "fail" | "warn";
  message?: string;
}
```

- [ ] **Step 2: Implement structural checks**

```typescript
async function checkPackageJson(dir: string): Promise<ValidationResult[]>
```

Checks (each returns a `ValidationResult`):
- `package.json` exists.
- `name` present and matches `^[a-z][a-z0-9-]*$`.
- `"type"` equals `"module"`.
- `exports["."]` present.
- `keywords` includes `"kaizen-plugin"`.
- `version` present and semver.

- [ ] **Step 3: Implement manifest checks**

Load the plugin's default export (dynamic import of the entry point from
`exports["."]`):
- `plugin.name` matches `package.json` name.
- `plugin.apiVersion` present and is semver string.
- `plugin.permissions` present.
- `plugin.permissions.tier` is `"trusted"` | `"scoped"` | `"unscoped"`.
- If `tier === "scoped"`: at least one grant key populated.
- `plugin.capabilities` field present (object, may be empty).

- [ ] **Step 4: Implement config schema checks**

If `plugin.config` declared:
- `plugin.config.schema` is a valid JSON Schema (use `validateSchemaItself` from
  Spec 2's `config-validator.ts`).
- Every key in `plugin.config.secrets` appears in `plugin.config.schema.properties`.
- If `plugin.config.secrets` is non-empty and `capabilities.consumes` does NOT
  include `"core-secrets:provider"`: emit a `warn`-level `ValidationResult`
  with message "core-secrets:provider dependency is implicit per Spec 2; list
  it explicitly for discoverability." Never fail on this — the dep is
  implicit and the runtime enforcer treats it as declared.

**Not checked here (intentionally):** Provider-existence for
`StructuredSecretRef.provider` names. That requires a live harness and
provider registry; it is enforced at `kaizen install` and `kaizen run`, not
by static `plugin validate`. Do NOT cross-reference `config.secrets` against
`permissions.env` — Spec 2 decouples secrets from env grants.

- [ ] **Step 5: Implement import scan**

Static scan of the plugin entry file for forbidden imports. Use `Bun.Transpiler` to
extract imports:

```typescript
async function scanImports(filePath: string): Promise<string[]>
```

For TRUSTED and SCOPED plugins, flag any direct import of:
- `node:fs`, `node:child_process`, `node:worker_threads`, `bun:ffi`
- The bare equivalents without `node:` prefix where unambiguous.

Emit as `warn` (not `fail`) — the runtime enforcer is the authoritative gate;
the static scan is an early signal. Add comment in output:
`"Note: runtime enforcer will block this regardless of validate status."`

- [ ] **Step 6: Check for tests and README**

- `*.test.ts` file exists in the plugin directory.
- `README.md` exists.

- [ ] **Step 7: Implement `runPluginValidate(dir: string)`**

Collect all results, print pass/fail/warn per rule, print summary. Exit 0 if no
failures, exit 1 if any failures.

- [ ] **Step 8: Write `src/commands/plugin-validate.test.ts`**

For each rule: a passing fixture and a failing fixture. Keep fixtures minimal —
inline as temp dirs in tests, not checked-in fixtures.

---

## Phase 3 — Marketplace Validator

### Task 3: Implement `src/commands/marketplace-validate.ts`

- [ ] **Step 1: Implement `runMarketplaceValidate(dir: string)`**

Checks (against the Spec 1 `entries[]` catalog shape):
- `.kaizen/marketplace.json` exists.
- `version` equals `"1.0.0"`.
- `name` non-empty string.
- `url` non-empty string.
- `entries` is an array.
- **Legacy shape rejection.** If the catalog has top-level `plugins` or
  `harnesses` arrays (the pre-revision shape), fail with a migration error:
  "marketplace.json uses the legacy `{plugins, harnesses}` shape; convert to
  `entries[]` with `kind` tags per Spec 1."
- Each entry has `kind ∈ {"plugin", "harness"}`.
- Each entry `name` matches `^[a-z][a-z0-9-]*$`.
- Names unique across **all** entries (a plugin and harness cannot share a
  name).
- Each entry has `description` (non-empty), `versions` (array, non-empty).
- Each version entry: `version` (semver parse).
- **Plugin versions** require `source`; validate as a tagged union:
  - `source.type === "npm"`: `name` (non-empty), `version` (semver).
  - `source.type === "tarball"`: `url` (non-empty); optional `sha256`
    (hex, 64 chars).
  - `source.type === "file"`: `path` (non-empty);
    `existsSync(join(dir, source.path))`.
- **Harness versions** require `path` (non-empty);
  `existsSync(join(dir, version.path))`.
- Optional `minKaizenVersion`: if present, must be a valid semver range.

- [ ] **Step 2: Write `src/commands/marketplace-validate.test.ts`**

- Valid `entries[]` catalog (mixed plugin + harness).
- Legacy `{plugins, harnesses}` catalog → migration error.
- Cross-kind name collision → fatal.
- Each source-type variant (`npm`, `tarball`, `file`) — valid + malformed.
- Missing `file` source path on disk → fatal.
- Missing harness `path` on disk → fatal.
- Bad semver in `version` or `minKaizenVersion`.

---

## Phase 4 — Plugin Scaffolder

### Task 4: Implement `src/commands/plugin-create.ts`

- [ ] **Step 1: Implement `promptPluginConfig(): Promise<PluginScaffoldConfig>`**

Use readline (or `@inquirer/prompts` if added as a dev dep) for interactive prompts.

```typescript
interface PluginScaffoldConfig {
  name: string;
  description: string;
  tier: "trusted" | "scoped" | "unscoped";
  grants: Array<"fs" | "net" | "env" | "exec" | "events">;
  provides: string[];
  consumes: string[];
  hasConfig: boolean;
  configKeys: Array<{ name: string; type: string; required: boolean; secret: boolean }>;
}
```

`--defaults` flag: skip all prompts, use `<path>` basename as name, tier=trusted,
no grants, no capabilities, no config.

- [ ] **Step 2: Implement file generators**

```typescript
function generatePackageJson(cfg: PluginScaffoldConfig): string
function generateTsConfig(): string
function generateIndexTs(cfg: PluginScaffoldConfig): string
function generateIndexTestTs(cfg: PluginScaffoldConfig): string
function generateReadme(cfg: PluginScaffoldConfig): string
```

Each returns a string. Follow templates from the spec exactly. Key behaviours
the generators must implement:

- **`generateIndexTs`:**
  - Import type from `"kaizen/types"`. (In-tree scaffolding is not supported
    — see spec Future Work.)
  - If `cfg.configKeys` has any `secret: true` entry: include
    `"core-secrets:provider"` in `capabilities.consumes` alongside any
    user-specified consumes.
  - Do NOT add an `env:` grant for secret keys (secrets are decoupled from
    the permissions env surface).
  - `config.secrets` lists every secret key; `config.schema.properties`
    includes every config key (secret or not); `config.defaults` only for
    non-secret keys with reasonable defaults.
  - `setup()` body demonstrates `await ctx.secrets.get("<first-secret>")` if
    any secrets exist, and a `ctx.log` call.

- **`generateIndexTestTs`:**
  - `makeCtx()` helper exposes async `ctx.secrets.get/refresh` (returning
    `Promise<string | undefined>`) and a `ctx.config` object pre-populated
    from `config.defaults`.
  - One test asserts plugin metadata; one test calls `plugin.setup(ctx)`
    with a stubbed secret value and asserts `ctx.log` was called.

- **`generateReadme`:**
  - Install example uses a placeholder marketplace-qualified ref
    (`<marketplace>/<plugin-name>`), with a footnote explaining shorthand is
    accepted at the CLI and canonicalised into harness files.
  - Config table includes a `Secret` column (yes/no).
  - Harness snippet uses canonical `<marketplace>/<plugin-name>@<version>`
    for the plugin ref and a bare-string secret ref (default provider
    `kaizen`); shows the structured `{ provider, ref }` alternative
    immediately after.
  - Includes `kaizen config set-secret <plugin> <key>` as the recommended
    way to populate a secret.
  - Permissions section explicitly notes that secrets do NOT need an `env`
    grant.

- **`generatePackageJson`:** unchanged from prior draft — still emits
  `"type": "module"`, `exports["."]`, `"kaizen-plugin"` keyword, and
  `peerDependencies: { "kaizen": "*" }` (the peer dep is authoritative once
  Spec 4 ships `kaizen` as an npm package).

- [ ] **Step 3: Implement `runPluginCreate(targetPath: string, opts)`**

1. Check `targetPath` does not exist. If exists: error.
2. Run prompts (or use defaults).
3. `mkdirSync(targetPath, { recursive: true })`.
4. Write each file.
5. `mkdirSync(join(targetPath, ".kaizen"), { recursive: true })`.
6. `writeFileSync(join(targetPath, ".kaizen", ".gitkeep"), "")`.
7. Print:
   ```
   Created plugin scaffold at ./my-plugin
   Next steps:
     cd my-plugin
     bun install
     bun test
     kaizen plugin validate .
   ```

- [ ] **Step 4: Write `src/commands/plugin-create.test.ts`**

- Non-interactive (`--defaults`): generates all files, all files pass `kaizen plugin
  validate` (call the validator programmatically in the test).
- `bun test` passes on the scaffolded output (run as subprocess in test).
- Target path already exists → error.

---

## Phase 5 — Marketplace Scaffolder

### Task 5: Implement `src/commands/marketplace-create.ts`

- [ ] **Step 1: Implement `promptMarketplaceConfig()`**

Prompts: name, description, URL. `--defaults`: use `<path>` basename as name.

- [ ] **Step 2: Implement `runMarketplaceCreate(targetPath, opts)`**

1. Check `targetPath` does not exist.
2. Prompt.
3. Create:
   - `<path>/.kaizen/marketplace.json` — emit the Spec 1 `entries[]` shape
     (top-level `version`, `name`, `description`, `url`, `entries: []`). Do
     NOT emit legacy `plugins: []` / `harnesses: []` fields.
   - `<path>/plugins/.gitkeep`.
   - `<path>/harnesses/.gitkeep`.
   - `<path>/README.md` — include a short section showing how to add a
     plugin entry (with `kind: "plugin"`) and a harness entry (with
     `kind: "harness"`), referencing the tagged-union source shape.
4. Print next steps including `kaizen marketplace validate .`.

- [ ] **Step 3: Write `src/commands/marketplace-create.test.ts`**

Non-interactive: generates files, `kaizen marketplace validate .` passes.

---

## Phase 6 — Wire CLI

### Task 6: Update `src/cli.ts`

- [ ] **Step 1: Add `kaizen plugin create <path>` routing**

In the `if (subcommand === "plugin")` block:
```typescript
if (pluginSub === "create") {
  const { runPluginCreate } = await import("./commands/plugin-create.js");
  const targetPath = name ?? ".";
  const code = await runPluginCreate(targetPath, { defaults: rest.includes("--defaults") });
  process.exit(code);
}
```

- [ ] **Step 2: Add `kaizen plugin validate [<path>]` routing**

```typescript
if (pluginSub === "validate") {
  const { runPluginValidate } = await import("./commands/plugin-validate.js");
  const targetPath = name ?? ".";
  const code = await runPluginValidate(targetPath);
  process.exit(code);
}
```

- [ ] **Step 3: Add `kaizen marketplace create <path>` routing**

In the `if (subcommand === "marketplace")` block:
```typescript
if (sub === "create") {
  const { runMarketplaceCreate } = await import("./commands/marketplace-create.js");
  const targetPath = rawArgs[2] ?? ".";
  const code = await runMarketplaceCreate(targetPath, { defaults: rawArgs.includes("--defaults") });
  process.exit(code);
}
```

- [ ] **Step 4: Add `kaizen marketplace validate [<path>]` routing**

```typescript
if (sub === "validate") {
  const { runMarketplaceValidate } = await import("./commands/marketplace-validate.js");
  const targetPath = rawArgs[2] ?? ".";
  const code = await runMarketplaceValidate(targetPath);
  process.exit(code);
}
```

- [ ] **Step 5: Update help text for `kaizen plugin` and `kaizen marketplace`**

Add `create` and `validate` to the usage strings.

---

## Phase 7 — Integration & Docs

### Task 7: End-to-end integration test

- [ ] **Step 1: Full workflow test (default scaffold, no secrets)**

```
kaizen plugin create ./test-plugin --defaults
cd test-plugin && bun install && bun test
kaizen plugin validate ./test-plugin       # must exit 0
```
Run this as a subprocess-based integration test.

- [ ] **Step 1b: Workflow test (scaffold with secrets)**

Non-interactive variant that drives the prompts with a secret key selected.
Verify:
- Generated `index.ts` lists `core-secrets:provider` in `consumes`.
- Generated `config.secrets` includes the selected key and it appears in
  `config.schema.properties`.
- Generated `index.test.ts` `makeCtx()` exposes async
  `ctx.secrets.get/refresh`.
- `bun test` passes.
- `kaizen plugin validate .` exits 0 (no `permissions.env` grant required).

- [ ] **Step 2: Marketplace workflow test**

```
kaizen marketplace create ./test-market --defaults
kaizen marketplace validate ./test-market  # must exit 0
```

### Task 8: Documentation

- [ ] Update `README.md` commands reference: add `kaizen plugin create/validate` and
  `kaizen marketplace create/validate`.
- [ ] Update `docs/plugin-api.md`: add "Creating a plugin" section that links to
  `kaizen plugin create` and `docs/plugin-standards.md`.
- [ ] Verify `docs/plugin-standards.md` is complete and all `[required]` rules have
  corresponding validator checks.
