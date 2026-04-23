# Non-interactive `kaizen plugin create` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every scaffold input for `kaizen plugin create` settable via CLI flag, auto-detect non-interactive environments, and add first-class support for scaffolding session drivers (#38, #41).

**Architecture:** Add a `PluginCreateOpts.flags` field that `runPluginCreate` prefers over prompts. Parse flags in `src/cli.ts` via `node:util`'s `parseArgs` (zero deps). Add a `buildConfigFromFlags()` helper that validates + fills defaults. Mode selection is automatic: `--defaults` → defaults path; TTY + no scaffold flags → interactive; otherwise → non-interactive. Add `driver: boolean` to `PluginScaffoldConfig` and update the generators + interactive prompt.

**Tech Stack:** TypeScript, Bun, `node:util` `parseArgs`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-04-23-plugin-create-non-interactive-design.md`

**Branch:** `feat/plugin-create-non-interactive-38` (already created; spec committed)

---

## File Structure

- **Modify** `src/commands/plugin-create.ts` — add `driver` field; generator updates; `buildConfigFromFlags()`; mode-selection in `runPluginCreate`; interactive driver prompt.
- **Modify** `src/cli.ts` — `parseArgs` for `plugin create`; build `opts` from parsed flags.
- **Modify** `src/commands/plugin-create.test.ts` — unit tests for generator changes, `buildConfigFromFlags`, end-to-end non-interactive flows.
- **Modify** `docs/guides/plugin-authoring.md` — document non-interactive usage.

---

## Task 1: Add `driver` field to scaffold config + default path

**Files:**
- Modify: `src/commands/plugin-create.ts`
- Test: `src/commands/plugin-create.test.ts`

- [ ] **Step 1: Add test for `driver: false` in defaults mode**

Append to the `describe("defaults mode", ...)` block in `src/commands/plugin-create.test.ts`:

```ts
    it("defaults do not produce a driver manifest", async () => {
      await runPluginCreate(targetPath, { defaults: true });
      const src = readFileSync(join(targetPath, "index.ts"), "utf8");
      expect(src).not.toContain("driver: true");
      expect(src).not.toContain("async start(ctx)");
    });
```

- [ ] **Step 2: Run test, expect PASS (baseline — current output already has no driver)**

Run: `bun test src/commands/plugin-create.test.ts -t "defaults do not produce a driver manifest"`
Expected: PASS

- [ ] **Step 3: Add `driver` to `PluginScaffoldConfig` and defaults init**

In `src/commands/plugin-create.ts`, update the interface (around lines 16-25):

```ts
export interface PluginScaffoldConfig {
  name: string;
  description: string;
  tier: "trusted" | "scoped" | "unscoped";
  grants: Array<"fs" | "net" | "env" | "exec" | "events">;
  provides: string[];
  consumes: string[];
  hasConfig: boolean;
  configKeys: ConfigKey[];
  driver: boolean;
}
```

Update the `--defaults` path in `runPluginCreate` (around line 398-409):

```ts
  if (opts.defaults) {
    cfg = {
      name: basename(targetPath),
      description: "",
      tier: "trusted",
      grants: [],
      provides: [],
      consumes: [],
      hasConfig: false,
      configKeys: [],
      driver: false,
    };
  } else {
```

Update the `promptConfig` return (end of function, around line 379) to include `driver: false` for now (Task 3 adds the prompt):

```ts
  return { name, description, tier, grants, provides, consumes, hasConfig, configKeys, driver: false };
```

- [ ] **Step 4: Run typecheck and full test suite**

Run: `bun run typecheck && bun test src/commands/plugin-create.test.ts`
Expected: typecheck clean; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/plugin-create.ts src/commands/plugin-create.test.ts
git commit -m "feat(plugin-create): add driver field to scaffold config"
```

---

## Task 2: Generator support for `driver: true`

**Files:**
- Modify: `src/commands/plugin-create.ts`
- Test: `src/commands/plugin-create.test.ts`

- [ ] **Step 1: Write failing tests for driver generator output**

Append to `src/commands/plugin-create.test.ts` (new `describe` block at end of file, before the closing):

```ts
describe("driver generator", () => {
  let tmpBase: string;
  let targetPath: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "kaizen-create-"));
    targetPath = join(tmpBase, "my-driver");
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("emits driver: true and start(ctx) in index.ts when driver flag is set", async () => {
    const { generateIndexTs } = await import("./plugin-create.js");
    const src = generateIndexTs({
      name: "my-driver",
      description: "",
      tier: "trusted",
      grants: [],
      provides: [],
      consumes: [],
      hasConfig: false,
      configKeys: [],
      driver: true,
    });
    expect(src).toContain("driver: true,");
    expect(src).toContain("async start(ctx)");
    expect(src).toContain(`ctx.log("driver started")`);
  });

  it("generated test asserts driver: true when driver flag is set", async () => {
    const { generateIndexTestTs } = await import("./plugin-create.js");
    const src = generateIndexTestTs({
      name: "my-driver",
      description: "",
      tier: "trusted",
      grants: [],
      provides: [],
      consumes: [],
      hasConfig: false,
      configKeys: [],
      driver: true,
    });
    expect(src).toContain(`expect(plugin.driver).toBe(true)`);
  });

  it("non-driver generation is unchanged", async () => {
    const { generateIndexTs, generateIndexTestTs } = await import("./plugin-create.js");
    const cfg = {
      name: "p",
      description: "",
      tier: "trusted" as const,
      grants: [],
      provides: [],
      consumes: [],
      hasConfig: false,
      configKeys: [],
      driver: false,
    };
    expect(generateIndexTs(cfg)).not.toContain("driver:");
    expect(generateIndexTs(cfg)).not.toContain("async start(ctx)");
    expect(generateIndexTestTs(cfg)).not.toContain("plugin.driver");
  });
});
```

Also make sure the existing `generateIndexTs` / `generateIndexTestTs` are exported. Check `src/commands/plugin-create.ts` — these are already `export function`. If not exported, add `export` keyword.

- [ ] **Step 2: Run tests, expect FAIL**

Run: `bun test src/commands/plugin-create.test.ts -t "driver generator"`
Expected: FAIL — current generator does not emit `driver:` or `start(ctx)`.

- [ ] **Step 3: Update `generateIndexTs` to emit driver manifest + start method**

In `src/commands/plugin-create.ts`, in `generateIndexTs` (around line 144-171), change the `lines` construction so that:

1. If `cfg.driver` is true, insert `  driver: true,` right after the `name:` / `apiVersion:` lines and before `permissions:`.
2. If `cfg.driver` is true, append a `start(ctx)` method after the `setup` method.

Replace the `lines` construction (the block starting `const lines: string[] = [`) with:

```ts
  const lines: string[] = [
    `import type { KaizenPlugin } from "kaizen/types";`,
    ``,
    `const plugin: KaizenPlugin = {`,
    `  name: "${cfg.name}",`,
    `  apiVersion: "2.0.0",`,
  ];

  if (cfg.driver) {
    lines.push(`  driver: true,`);
  }

  lines.push(
    `  permissions: {`,
    ...permissionsLines,
    `  },`,
    `  services: {`,
    ...capsLines,
    `  },`,
  );

  if (configBlock) {
    lines.push(configBlock);
  }

  lines.push(
    ``,
    `  async setup(ctx) {`,
    ...setupLines,
    `  },`,
  );

  if (cfg.driver) {
    lines.push(
      ``,
      `  async start(ctx) {`,
      `    // TODO: implement session loop`,
      `    ctx.log("driver started");`,
      `  },`,
    );
  }

  lines.push(
    `};`,
    ``,
    `export default plugin;`,
    ``
  );

  return lines.join("\n");
```

- [ ] **Step 4: Update `generateIndexTestTs` to emit driver assertion**

In `src/commands/plugin-create.ts`, in `generateIndexTestTs` (around line 226-239), add a driver assertion block. Replace the closing `describe(...)` construction with:

```ts
    `describe("${cfg.name}", () => {`,
    `  it("has correct metadata", () => {`,
    `    expect(plugin.name).toBe("${cfg.name}");`,
    `    expect(plugin.apiVersion).toBe("2.0.0");`,
    `  });`,
    ``,
    ...(cfg.driver
      ? [
          `  it("declares driver: true", () => {`,
          `    expect(plugin.driver).toBe(true);`,
          `  });`,
          ``,
        ]
      : []),
    `  it("setup runs without error", async () => {`,
    `    const ctx = makeCtx();`,
    `    await plugin.setup(ctx);`,
    `    expect(ctx.log).toHaveBeenCalled();`,
    `  });`,
    `});`,
    ``,
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `bun test src/commands/plugin-create.test.ts && bun run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/commands/plugin-create.ts src/commands/plugin-create.test.ts
git commit -m "feat(plugin-create): generate driver:true + start(ctx) stub"
```

---

## Task 3: Interactive prompt for `driver`

**Files:**
- Modify: `src/commands/plugin-create.ts`

No new test: the interactive prompt path is not covered by existing tests; consistent with the current test surface, we add behavior here and rely on manual verification + the non-interactive tests in Task 6 for `driver` flag coverage.

- [ ] **Step 1: Add the driver prompt in `promptConfig`**

In `src/commands/plugin-create.ts`, in `promptConfig` (around line 356-358, between the `consumes` prompt and the `hasConfig` prompt), add:

```ts
  const driverInput = await prompt(rl, `Is this a session driver? (y/N) [N]: `);
  const driver = driverInput.toLowerCase() === "y";
```

- [ ] **Step 2: Update return statement**

Change the `promptConfig` return (bottom of function) from:

```ts
  return { name, description, tier, grants, provides, consumes, hasConfig, configKeys, driver: false };
```

to:

```ts
  return { name, description, tier, grants, provides, consumes, hasConfig, configKeys, driver };
```

- [ ] **Step 3: Manual smoke test**

Run: `bun run bin/kaizen plugin create /tmp/drv-smoke-$$`
Answer `y` to "Is this a session driver?"; defaults for everything else.
Then: `cat /tmp/drv-smoke-*/index.ts | grep -E "driver:|start\(ctx\)"`
Expected: both `driver: true,` and `async start(ctx) {` present.
Cleanup: `rm -rf /tmp/drv-smoke-*`

- [ ] **Step 4: Run typecheck + tests**

Run: `bun run typecheck && bun test src/commands/plugin-create.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/plugin-create.ts
git commit -m "feat(plugin-create): prompt for driver in interactive mode"
```

---

## Task 4: `buildConfigFromFlags` helper (TDD)

**Files:**
- Modify: `src/commands/plugin-create.ts`
- Test: `src/commands/plugin-create.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/commands/plugin-create.test.ts` (new describe at end of file):

```ts
describe("buildConfigFromFlags", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "kaizen-create-"));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("fills defaults for unset flags", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    const cfg = buildConfigFromFlags("/tmp/some-path/my-plug", {});
    expect(cfg).toEqual({
      name: "my-plug",
      description: "",
      tier: "trusted",
      grants: [],
      provides: [],
      consumes: [],
      hasConfig: false,
      configKeys: [],
      driver: false,
    });
  });

  it("applies all flags", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    const cfg = buildConfigFromFlags("/tmp/x/plug", {
      name: "custom-name",
      description: "desc",
      tier: "scoped",
      grants: ["fs", "net"],
      provides: ["svc:a"],
      consumes: ["svc:b"],
      driver: true,
    });
    expect(cfg.name).toBe("custom-name");
    expect(cfg.description).toBe("desc");
    expect(cfg.tier).toBe("scoped");
    expect(cfg.grants).toEqual(["fs", "net"]);
    expect(cfg.provides).toEqual(["svc:a"]);
    expect(cfg.consumes).toEqual(["svc:b"]);
    expect(cfg.driver).toBe(true);
  });

  it("rejects invalid tier", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    expect(() => buildConfigFromFlags("/tmp/p", { tier: "god-mode" as never }))
      .toThrow(/tier/);
  });

  it("rejects invalid grant", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    expect(() => buildConfigFromFlags("/tmp/p", { grants: ["bogus" as never] }))
      .toThrow(/grant/);
  });

  it("parses --config-keys-json inline", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    const json = JSON.stringify([
      { name: "api_key", type: "string", required: true, secret: true },
    ]);
    const cfg = buildConfigFromFlags("/tmp/p", { configKeysJson: json });
    expect(cfg.hasConfig).toBe(true);
    expect(cfg.configKeys).toEqual([
      { name: "api_key", type: "string", required: true, secret: true },
    ]);
  });

  it("parses --config-keys-file", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    const file = join(tmpBase, "keys.json");
    writeFileSync(file, JSON.stringify([
      { name: "port", type: "number", required: false, secret: false },
    ]));
    const cfg = buildConfigFromFlags("/tmp/p", { configKeysFile: file });
    expect(cfg.hasConfig).toBe(true);
    expect(cfg.configKeys[0]?.name).toBe("port");
  });

  it("rejects both --config-keys-json and --config-keys-file", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    expect(() => buildConfigFromFlags("/tmp/p", {
      configKeysJson: "[]",
      configKeysFile: "/tmp/x.json",
    })).toThrow(/mutually exclusive/);
  });

  it("rejects malformed config-keys JSON (not array)", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    expect(() => buildConfigFromFlags("/tmp/p", { configKeysJson: "{}" }))
      .toThrow(/array/);
  });

  it("rejects malformed config-keys entry (missing name)", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    const json = JSON.stringify([{ type: "string", required: false, secret: false }]);
    expect(() => buildConfigFromFlags("/tmp/p", { configKeysJson: json }))
      .toThrow(/name/);
  });

  it("rejects malformed config-keys entry (bad type)", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    const json = JSON.stringify([{ name: "x", type: "enum", required: false, secret: false }]);
    expect(() => buildConfigFromFlags("/tmp/p", { configKeysJson: json }))
      .toThrow(/type/);
  });
});
```

Add `writeFileSync` to the imports at the top of the test file if not already present (check existing imports; it's already imported alongside `readFileSync`? The current file uses `readFileSync`. Add `writeFileSync`):

```ts
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
```

- [ ] **Step 2: Run tests, expect FAIL (function doesn't exist)**

Run: `bun test src/commands/plugin-create.test.ts -t "buildConfigFromFlags"`
Expected: FAIL with "buildConfigFromFlags is not a function" (or import error).

- [ ] **Step 3: Define the flags type**

In `src/commands/plugin-create.ts`, add after `PluginScaffoldConfig` (around line 26):

```ts
export interface PluginCreateFlags {
  name?: string;
  description?: string;
  tier?: "trusted" | "scoped" | "unscoped";
  grants?: Array<"fs" | "net" | "env" | "exec" | "events">;
  provides?: string[];
  consumes?: string[];
  driver?: boolean;
  configKeysJson?: string;
  configKeysFile?: string;
}
```

- [ ] **Step 4: Implement `buildConfigFromFlags`**

Add to `src/commands/plugin-create.ts`, before the `runPluginCreate` function (around line 382). Also add `readFileSync` to the top-level imports:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
```

Then:

```ts
const VALID_TIERS = ["trusted", "scoped", "unscoped"] as const;
const VALID_GRANTS = ["fs", "net", "env", "exec", "events"] as const;
const VALID_CONFIG_TYPES = ["string", "number"] as const;

export function buildConfigFromFlags(
  targetPath: string,
  flags: PluginCreateFlags
): PluginScaffoldConfig {
  if (flags.tier && !VALID_TIERS.includes(flags.tier)) {
    throw new Error(
      `Invalid --tier "${flags.tier}"; must be one of ${VALID_TIERS.join(", ")}`
    );
  }

  if (flags.grants) {
    for (const g of flags.grants) {
      if (!VALID_GRANTS.includes(g)) {
        throw new Error(
          `Invalid --grant "${g}"; must be one of ${VALID_GRANTS.join(", ")}`
        );
      }
    }
  }

  if (flags.configKeysJson && flags.configKeysFile) {
    throw new Error(
      "--config-keys-json and --config-keys-file are mutually exclusive"
    );
  }

  let configKeys: ConfigKey[] = [];
  let hasConfig = false;
  const rawJson =
    flags.configKeysJson
      ?? (flags.configKeysFile ? readFileSync(flags.configKeysFile, "utf8") : undefined);

  if (rawJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (e) {
      throw new Error(`config keys input is not valid JSON: ${String(e)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("config keys input must be a JSON array");
    }
    configKeys = parsed.map((entry, i) => validateConfigKey(entry, i));
    hasConfig = true;
  }

  return {
    name: flags.name ?? basename(targetPath),
    description: flags.description ?? "",
    tier: flags.tier ?? "trusted",
    grants: flags.grants ?? [],
    provides: flags.provides ?? [],
    consumes: flags.consumes ?? [],
    hasConfig,
    configKeys,
    driver: flags.driver ?? false,
  };
}

function validateConfigKey(entry: unknown, index: number): ConfigKey {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`config keys[${index}] must be an object`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.name !== "string" || e.name.length === 0) {
    throw new Error(`config keys[${index}] missing required string "name"`);
  }
  if (typeof e.type !== "string" || !VALID_CONFIG_TYPES.includes(e.type as never)) {
    throw new Error(
      `config keys[${index}].type must be one of ${VALID_CONFIG_TYPES.join(", ")}`
    );
  }
  if (typeof e.required !== "boolean") {
    throw new Error(`config keys[${index}].required must be a boolean`);
  }
  if (typeof e.secret !== "boolean") {
    throw new Error(`config keys[${index}].secret must be a boolean`);
  }
  return { name: e.name, type: e.type, required: e.required, secret: e.secret };
}
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `bun test src/commands/plugin-create.test.ts -t "buildConfigFromFlags" && bun run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/commands/plugin-create.ts src/commands/plugin-create.test.ts
git commit -m "feat(plugin-create): buildConfigFromFlags helper with validation"
```

---

## Task 5: Mode selection in `runPluginCreate`

**Files:**
- Modify: `src/commands/plugin-create.ts`
- Test: `src/commands/plugin-create.test.ts`

- [ ] **Step 1: Write failing tests for non-interactive mode**

Append to `src/commands/plugin-create.test.ts` (new describe at end):

```ts
describe("non-interactive mode", () => {
  let tmpBase: string;
  let targetPath: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "kaizen-create-"));
    targetPath = join(tmpBase, "np");
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("runs non-interactively when flags are passed", async () => {
    const code = await runPluginCreate(targetPath, {
      flags: { name: "np", tier: "scoped", grants: ["fs"], driver: true },
    });
    expect(code).toBe(0);
    const src = readFileSync(join(targetPath, "index.ts"), "utf8");
    expect(src).toContain(`name: "np"`);
    expect(src).toContain(`tier: "scoped"`);
    expect(src).toContain(`fs:`);
    expect(src).toContain("driver: true,");
    expect(src).toContain("async start(ctx)");
  });

  it("non-interactive with no flags produces defaults-equivalent output", async () => {
    const code = await runPluginCreate(targetPath, { flags: {} });
    expect(code).toBe(0);
    const src = readFileSync(join(targetPath, "index.ts"), "utf8");
    expect(src).toContain(`name: "np"`);
    expect(src).toContain(`tier: "trusted"`);
    expect(src).not.toContain("driver:");
  });

  it("returns 1 on invalid tier", async () => {
    const code = await runPluginCreate(targetPath, {
      flags: { tier: "god-mode" as never },
    });
    expect(code).toBe(1);
    expect(existsSync(targetPath)).toBe(false);
  });

  it("returns 1 on invalid config-keys JSON", async () => {
    const code = await runPluginCreate(targetPath, {
      flags: { configKeysJson: "not json" },
    });
    expect(code).toBe(1);
    expect(existsSync(targetPath)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `bun test src/commands/plugin-create.test.ts -t "non-interactive mode"`
Expected: FAIL — the current signature doesn't accept `flags`.

- [ ] **Step 3: Update `runPluginCreate` signature and mode selection**

In `src/commands/plugin-create.ts`, replace the `runPluginCreate` function (around line 386-449) with:

```ts
export async function runPluginCreate(
  targetPath: string,
  opts: { defaults?: boolean; flags?: PluginCreateFlags } = {}
): Promise<number> {
  // 1. Check target does not exist
  if (existsSync(targetPath)) {
    console.error(`Error: target path already exists: ${targetPath}`);
    return 1;
  }

  let cfg: PluginScaffoldConfig;

  if (opts.defaults) {
    cfg = {
      name: basename(targetPath),
      description: "",
      tier: "trusted",
      grants: [],
      provides: [],
      consumes: [],
      hasConfig: false,
      configKeys: [],
      driver: false,
    };
  } else if (opts.flags !== undefined) {
    try {
      cfg = buildConfigFromFlags(targetPath, opts.flags);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      return 1;
    }
  } else {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      cfg = await promptConfig(rl, targetPath);
    } finally {
      rl.close();
    }
  }

  // Create directory and write files
  mkdirSync(targetPath, { recursive: true });
  writeFileSync(join(targetPath, "package.json"), generatePackageJson(cfg));
  writeFileSync(join(targetPath, "tsconfig.json"), generateTsConfig());
  writeFileSync(join(targetPath, "index.ts"), generateIndexTs(cfg));
  writeFileSync(join(targetPath, "index.test.ts"), generateIndexTestTs(cfg));
  writeFileSync(join(targetPath, "README.md"), generateReadme(cfg));
  mkdirSync(join(targetPath, ".kaizen"), { recursive: true });
  writeFileSync(join(targetPath, ".kaizen", ".gitkeep"), "");

  const displayPath = `./${basename(targetPath)}`;
  console.log(`Created plugin scaffold at ${displayPath}`);
  console.log(`Next steps:`);
  console.log(`  cd ${basename(targetPath)}`);
  console.log(`  bun install`);
  console.log(`  bun test`);
  console.log(`  kaizen plugin validate .`);

  return 0;
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `bun test src/commands/plugin-create.test.ts && bun run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/plugin-create.ts src/commands/plugin-create.test.ts
git commit -m "feat(plugin-create): non-interactive mode via opts.flags"
```

---

## Task 6: Wire CLI flags via `parseArgs`

**Files:**
- Modify: `src/cli.ts`
- Test: `src/commands/plugin-create.test.ts` (add end-to-end)

- [ ] **Step 1: Add end-to-end test exercising the CLI wiring contract**

We don't spawn the CLI binary in unit tests; instead, verify the behavior we expect the CLI to rely on: `opts.flags = {}` with a non-TTY context produces defaults, and that `--defaults` still works.

The test from Task 5 already covers the programmatic surface. For the CLI layer itself, add a targeted test that constructs the same inputs `cli.ts` would pass after `parseArgs`. Append to `src/commands/plugin-create.test.ts`:

```ts
describe("cli flag shapes", () => {
  let tmpBase: string;
  let targetPath: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "kaizen-create-"));
    targetPath = join(tmpBase, "svc");
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("accepts repeated + comma-separated grants merged", async () => {
    // Simulating what cli.ts will produce after normalizing
    // parseArgs output ("--grant fs,net --grant env" becomes ["fs","net","env"])
    const code = await runPluginCreate(targetPath, {
      flags: { grants: ["fs", "net", "env"] },
    });
    expect(code).toBe(0);
    const src = readFileSync(join(targetPath, "index.ts"), "utf8");
    expect(src).toContain("fs:");
    expect(src).toContain("net:");
    expect(src).toContain("env:");
  });
});
```

- [ ] **Step 2: Run tests, expect PASS (programmatic path already works from Task 5)**

Run: `bun test src/commands/plugin-create.test.ts -t "cli flag shapes"`
Expected: PASS.

- [ ] **Step 3: Replace CLI branch with `parseArgs`-based wiring**

In `src/cli.ts`, locate the `if (pluginSub === "create")` block (around lines 432-437) and replace with:

```ts
  if (pluginSub === "create") {
    const { runPluginCreate } = await import("./commands/plugin-create.js");
    const { parseArgs } = await import("node:util");

    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: {
          name:                { type: "string" },
          description:         { type: "string" },
          tier:                { type: "string" },
          grant:               { type: "string", multiple: true },
          provides:            { type: "string", multiple: true },
          consumes:            { type: "string", multiple: true },
          driver:              { type: "boolean" },
          "config-keys-json":  { type: "string" },
          "config-keys-file":  { type: "string" },
          defaults:            { type: "boolean" },
        },
      });
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    }

    const values = parsed.values as Record<string, string | boolean | string[] | undefined>;
    const targetPath = name ?? ".";

    const splitList = (xs: string[] | undefined): string[] =>
      (xs ?? []).flatMap((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

    const scaffoldFlagNames = [
      "name", "description", "tier", "grant", "provides",
      "consumes", "driver", "config-keys-json", "config-keys-file",
    ];
    const anyScaffoldFlag = scaffoldFlagNames.some((k) => values[k] !== undefined);

    if (values.defaults) {
      const code = await runPluginCreate(targetPath, { defaults: true });
      process.exit(code);
    }

    if (!process.stdin.isTTY || anyScaffoldFlag) {
      const flags = {
        name: values.name as string | undefined,
        description: values.description as string | undefined,
        tier: values.tier as "trusted" | "scoped" | "unscoped" | undefined,
        grants: splitList(values.grant as string[] | undefined) as Array<
          "fs" | "net" | "env" | "exec" | "events"
        >,
        provides: splitList(values.provides as string[] | undefined),
        consumes: splitList(values.consumes as string[] | undefined),
        driver: values.driver as boolean | undefined,
        configKeysJson: values["config-keys-json"] as string | undefined,
        configKeysFile: values["config-keys-file"] as string | undefined,
      };
      const code = await runPluginCreate(targetPath, { flags });
      process.exit(code);
    }

    const code = await runPluginCreate(targetPath, {});
    process.exit(code);
  }
```

- [ ] **Step 4: Smoke-test non-interactive via the built binary**

Run:
```bash
rm -rf /tmp/kc-smoke
bun run bin/kaizen plugin create /tmp/kc-smoke \
  --name kc-smoke --tier scoped --grant fs,net --driver
cat /tmp/kc-smoke/index.ts | grep -E "name:|tier:|fs:|net:|driver:|start\(ctx\)"
```

Expected output includes:
```
  name: "kc-smoke",
    tier: "scoped",
    fs: ["*"],
    net: ["*"],
  driver: true,
  async start(ctx) {
```

Cleanup: `rm -rf /tmp/kc-smoke`

- [ ] **Step 5: Smoke-test `--defaults` still works**

Run:
```bash
rm -rf /tmp/kc-def
bun run bin/kaizen plugin create /tmp/kc-def --defaults
test -f /tmp/kc-def/index.ts && echo OK
rm -rf /tmp/kc-def
```
Expected: `OK`.

- [ ] **Step 6: Smoke-test unknown flag rejection**

Run:
```bash
bun run bin/kaizen plugin create /tmp/kc-reject --bogus 2>&1 | head -2
test ! -d /tmp/kc-reject && echo OK
```
Expected: error message from parseArgs; directory not created; `OK` printed.

- [ ] **Step 7: Full typecheck + test suite**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/commands/plugin-create.test.ts
git commit -m "feat(plugin-create): parse CLI flags via parseArgs (#38, #41)"
```

---

## Task 7: Docs update

**Files:**
- Modify: `docs/guides/plugin-authoring.md`

- [ ] **Step 1: Update the Scaffold section**

In `docs/guides/plugin-authoring.md`, locate the `## Scaffold` section (around lines 25-62). Replace the block starting with "Add `--defaults` to skip prompts..." and ending just before "The generator writes:" with:

```markdown
Add `--defaults` to skip prompts and scaffold a minimal `trusted` plugin:

```sh
kaizen plugin create ./my-plugin --defaults
```

Every prompt also has a corresponding flag, so the command can run fully
non-interactively (for agents, CI, or bulk scaffolding). When stdin is not a
TTY, or any scaffold flag is passed, prompts are skipped entirely and unset
fields fall back to defaults:

```sh
kaizen plugin create ./my-plugin \
  --name my-plugin \
  --description "does a thing" \
  --tier scoped \
  --grant fs,net \
  --provides my-plugin:api \
  --driver
```

Flags:

| Flag                   | Purpose                                                    |
|------------------------|------------------------------------------------------------|
| `--name`               | Plugin name (default: basename of target path)             |
| `--description`        | Description text                                           |
| `--tier`               | `trusted` \| `scoped` \| `unscoped` (default `trusted`)     |
| `--grant`              | One or more of `fs,net,env,exec,events`. Repeatable and/or comma-separated. |
| `--provides`           | Service name; repeatable and/or comma-separated.           |
| `--consumes`           | Service name; repeatable and/or comma-separated.           |
| `--driver`             | Scaffold a session driver (adds `driver:true` and a `start(ctx)` stub). |
| `--config-keys-json`   | Inline JSON array of ConfigKey objects.                    |
| `--config-keys-file`   | Path to a JSON file with a ConfigKey array.                |
| `--defaults`           | Use defaults for all fields; skip prompts.                 |

ConfigKey shape (applies to both `--config-keys-json` and `--config-keys-file`):

```json
[
  { "name": "api_key", "type": "string", "required": true,  "secret": true },
  { "name": "port",    "type": "number", "required": false, "secret": false }
]
```

`type` must be `string` or `number`. Kaizen validates this structure but does
not validate the semantic correctness of the resulting config schema — that is
the plugin author's responsibility.
```

- [ ] **Step 2: Verify docs render**

Run: `grep -A2 "non-interactively" docs/guides/plugin-authoring.md`
Expected: the new block is present.

- [ ] **Step 3: Commit**

```bash
git add docs/guides/plugin-authoring.md
git commit -m "docs(plugin-authoring): non-interactive scaffold flags"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: all tests pass; no new failures.

- [ ] **Step 3: Inspect commit log**

Run: `git log --oneline master..HEAD`
Expected: commits from tasks 1-7 plus the spec commit.

- [ ] **Step 4: Run `kaizen:update-docs` skill**

Per project CLAUDE.md, before invoking `superpowers:finishing-a-development-branch`, run `kaizen:update-docs`.

Run: `/kaizen:update-docs` (or invoke the skill via the Skill tool).
Follow its output; it may propose additional doc edits to commit.

- [ ] **Step 5: Push branch**

```bash
git push -u origin feat/plugin-create-non-interactive-38
```

- [ ] **Step 6: Open PR**

```bash
gh pr create --title "feat: non-interactive flags for plugin create (#38, #41)" --body "$(cat <<'EOF'
## Summary
- Every scaffold input for \`kaizen plugin create\` is now settable via CLI flag
- Auto-detect non-interactive environments (non-TTY or any flag → no prompts)
- Add first-class support for scaffolding session drivers (\`--driver\`, interactive prompt, generator stubs)

Closes #38. Closes #41.

Spec: \`docs/superpowers/specs/2026-04-23-plugin-create-non-interactive-design.md\`

## Test plan
- [x] \`bun run typecheck\`
- [x] \`bun test\` (new tests for buildConfigFromFlags, non-interactive mode, generator driver support)
- [x] Smoke: \`kaizen plugin create /tmp/x --name x --tier scoped --grant fs,net --driver\` → generates driver+start
- [x] Smoke: \`kaizen plugin create /tmp/y --defaults\` still works
- [x] Smoke: unknown flag rejected with error
EOF
)"
```
