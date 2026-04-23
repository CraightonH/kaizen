import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";
import * as readline from "readline";

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface ConfigKey {
  name: string;
  type: string;
  required: boolean;
  secret: boolean;
}

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

// ---------------------------------------------------------------------------
// File generators
// ---------------------------------------------------------------------------

export function generatePackageJson(cfg: PluginScaffoldConfig): string {
  const pkg = {
    name: cfg.name,
    version: "0.1.0",
    description: cfg.description,
    type: "module",
    exports: { ".": "./index.ts" },
    keywords: ["kaizen-plugin"],
    devDependencies: {
      "@types/bun": "latest",
      typescript: "^5.4.0",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

export function generateTsConfig(): string {
  const tsconfig = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
    },
  };
  return JSON.stringify(tsconfig, null, 2) + "\n";
}

export function generateIndexTs(cfg: PluginScaffoldConfig): string {
  const secretKeys = cfg.configKeys.filter((k) => k.secret);
  const nonSecretKeys = cfg.configKeys.filter((k) => !k.secret);

  // Build consumes array — add core-secrets:provider if secrets exist
  const consumesArr = [...cfg.consumes];
  if (secretKeys.length > 0 && !consumesArr.includes("core-secrets:provider")) {
    consumesArr.push("core-secrets:provider");
  }

  // Build permissions block
  const permissionsLines: string[] = [`  tier: "${cfg.tier}",`];
  for (const grant of cfg.grants) {
    if (grant === "events") {
      permissionsLines.push(`  ${grant}: { subscribe: ["*"] },`);
    } else {
      permissionsLines.push(`  ${grant}: ["*"],`);
    }
  }

  // Build services block
  const capsLines: string[] = [];
  if (cfg.provides.length > 0) {
    const provStr = cfg.provides.map((p) => `"${p}"`).join(", ");
    capsLines.push(`    provides: [${provStr}],`);
  }
  if (consumesArr.length > 0) {
    const consStr = consumesArr.map((c) => `"${c}"`).join(", ");
    capsLines.push(`    consumes: [${consStr}],`);
  }

  // Build config block
  let configBlock = "";
  if (cfg.hasConfig && cfg.configKeys.length > 0) {
    const allRequired = cfg.configKeys.filter((k) => k.required).map((k) => k.name);
    const propLines = cfg.configKeys.map(
      (k) => `      ${k.name}: { type: "${k.type}", description: "${k.name} config value." },`
    );
    const defaultLines = nonSecretKeys
      .filter((k) => k.type === "number")
      .map((k) => `      ${k.name}: 0,`);

    const secretsLine =
      secretKeys.length > 0
        ? `    secrets: [${secretKeys.map((k) => `"${k.name}"`).join(", ")}],\n`
        : "";

    const requiredLine =
      allRequired.length > 0
        ? `      required: [${allRequired.map((r) => `"${r}"`).join(", ")}],\n`
        : "";

    configBlock =
      `\n  config: {\n` +
      `    schema: {\n` +
      `      type: "object",\n` +
      `      properties: {\n` +
      propLines.join("\n") +
      "\n" +
      `      },\n` +
      requiredLine +
      `    },\n` +
      (defaultLines.length > 0
        ? `    defaults: {\n` + defaultLines.join("\n") + `\n    },\n`
        : "") +
      secretsLine +
      `  },`;
  }

  // Build setup body
  const setupLines: string[] = [];
  if (secretKeys.length > 0) {
    const first = secretKeys[0]!;
    setupLines.push(`    const ${first.name} = await ctx.secrets.get("${first.name}");`);
  }
  for (const svc of cfg.provides) {
    setupLines.push(`    ctx.defineService("${svc}", { description: "TODO" });`);
    setupLines.push(`    ctx.provideService("${svc}", { /* TODO: implementation */ });`);
  }
  for (const svc of consumesArr) {
    setupLines.push(`    ctx.consumeService("${svc}");`);
  }
  setupLines.push("    ctx.log(`" + cfg.name + " setup complete`);");

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
}

export function generateIndexTestTs(cfg: PluginScaffoldConfig): string {
  const secretKeys = cfg.configKeys.filter((k) => k.secret);
  const nonSecretKeys = cfg.configKeys.filter((k) => !k.secret);

  // Build config defaults for context
  const configDefaults: string[] = [];
  for (const k of nonSecretKeys) {
    if (k.type === "number") {
      configDefaults.push(`    ${k.name}: 0,`);
    }
    // string non-secrets — skip (no default)
  }

  const configObj =
    configDefaults.length > 0
      ? `{\n${configDefaults.join("\n")}\n  }`
      : `{}`;

  // For secrets in setup test: mock the first secret
  let secretsMockGet: string;
  if (secretKeys.length > 0) {
    const first = secretKeys[0]!;
    secretsMockGet =
      `mock(async (_key: string): Promise<string | undefined> => ` +
      `_key === "${first.name}" ? "test-value" : undefined)`;
  } else {
    secretsMockGet = `mock(async (_key: string): Promise<string | undefined> => undefined)`;
  }

  return [
    `import { describe, it, expect, mock } from "bun:test";`,
    `import plugin from "./index.ts";`,
    ``,
    `function makeCtx() {`,
    `  return {`,
    `    log: mock(() => {}),`,
    `    config: ${configObj},`,
    `    on: mock(() => {}),`,
    `    defineEvent: mock(() => {}),`,
    `    emit: mock(async () => []),`,
    `    secrets: {`,
    `      get: ${secretsMockGet},`,
    `      refresh: mock(async (_key: string): Promise<string | undefined> => undefined),`,
    `    },`,
    `    defineService: mock(() => {}),`,
    `    provideService: mock(() => {}),`,
    `    consumeService: mock(() => {}),`,
    `    useService: mock(() => undefined),`,
    `  } as any;`,
    `}`,
    ``,
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
  ].join("\n");
}

export function generateReadme(cfg: PluginScaffoldConfig): string {
  const hasSecretKeys = cfg.configKeys.some((k) => k.secret);
  const hasConfigKeys = cfg.configKeys.length > 0;

  const configTable =
    hasConfigKeys
      ? [
          `| Key | Type | Required | Secret |`,
          `|-----|------|----------|--------|`,
          ...cfg.configKeys.map(
            (k) =>
              `| \`${k.name}\` | \`${k.type}\` | ${k.required ? "Yes" : "No"} | ${k.secret ? "Yes" : "No"} |`
          ),
        ].join("\n")
      : "_No configuration keys defined._";

  const secretsNote = hasSecretKeys
    ? [
        ``,
        `## Secrets`,
        ``,
        `The following keys are treated as secrets and must be set separately:`,
        ``,
        ...cfg.configKeys
          .filter((k) => k.secret)
          .map((k) => `\`\`\`sh\nkaizen config set-secret ${cfg.name} ${k.name}\n\`\`\``),
        ``,
        `> Note: Secrets do NOT require an \`env\` grant — they are accessed through the secrets context.`,
      ].join("\n")
    : "";

  const grantsList =
    cfg.grants.length > 0
      ? cfg.grants.map((g) => `- \`${g}\``).join("\n")
      : "_No additional grants required._";

  return [
    `# ${cfg.name}`,
    ``,
    cfg.description || "_No description provided._",
    ``,
    `## Installation`,
    ``,
    `\`\`\`sh`,
    `kaizen install <marketplace>/${cfg.name}@<version>`,
    `\`\`\``,
    ``,
    `## Configuration`,
    ``,
    configTable,
    secretsNote,
    ``,
    `## Harness`,
    ``,
    `Add to your \`kaizen.json\`:`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "plugins": ["<marketplace>/${cfg.name}@0.1.0"]`,
    `}`,
    `\`\`\``,
    ``,
    `## Permissions`,
    ``,
    `Tier: \`${cfg.tier}\``,
    ``,
    grantsList,
    ``,
    `## Development`,
    ``,
    `\`\`\`sh`,
    `bun install`,
    `bun test`,
    `kaizen plugin validate .`,
    `\`\`\``,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Interactive prompting
// ---------------------------------------------------------------------------

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function promptConfig(rl: readline.Interface, targetPath: string): Promise<PluginScaffoldConfig> {
  const defaultName = basename(targetPath);

  const name = (await prompt(rl, `Plugin name [${defaultName}]: `)) || defaultName;
  const description = await prompt(rl, `Description: `);
  const tierInput = await prompt(rl, `Tier (trusted/scoped/unscoped) [trusted]: `);
  const tier = (["trusted", "scoped", "unscoped"].includes(tierInput) ? tierInput : "trusted") as
    | "trusted"
    | "scoped"
    | "unscoped";

  const grantsInput = await prompt(rl, `Grants (comma-separated: fs,net,env,exec,events) [none]: `);
  const grants = grantsInput
    ? (grantsInput
        .split(",")
        .map((g) => g.trim())
        .filter((g) => ["fs", "net", "env", "exec", "events"].includes(g)) as Array<
        "fs" | "net" | "env" | "exec" | "events"
      >)
    : [];

  const providesInput = await prompt(rl, `Services provided (comma-separated) [none]: `);
  const provides = providesInput ? providesInput.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const consumesInput = await prompt(rl, `Services consumed (comma-separated) [none]: `);
  const consumes = consumesInput ? consumesInput.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const driverInput = await prompt(rl, `Is this a session driver? (y/N) [N]: `);
  const driver = driverInput.toLowerCase() === "y";

  const hasConfigInput = await prompt(rl, `Does this plugin have config? (y/N) [N]: `);
  const hasConfig = hasConfigInput.toLowerCase() === "y";

  const configKeys: ConfigKey[] = [];
  if (hasConfig) {
    const keysInput = await prompt(rl, `Config key names (comma-separated): `);
    const keyNames = keysInput.split(",").map((s) => s.trim()).filter(Boolean);
    for (const keyName of keyNames) {
      const typeInput = (await prompt(rl, `  ${keyName} type (string/number) [string]: `)) || "string";
      const requiredInput = await prompt(rl, `  ${keyName} required? (y/N) [N]: `);
      const secretInput = await prompt(rl, `  ${keyName} secret? (y/N) [N]: `);
      configKeys.push({
        name: keyName,
        type: ["string", "number"].includes(typeInput) ? typeInput : "string",
        required: requiredInput.toLowerCase() === "y",
        secret: secretInput.toLowerCase() === "y",
      });
    }
  }

  return { name, description, tier, grants, provides, consumes, hasConfig, configKeys, driver };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// buildConfigFromFlags
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

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
