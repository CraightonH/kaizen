import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, basename } from "path";
import * as readline from "readline";

// ---------------------------------------------------------------------------
// Marketplace configuration interface
// ---------------------------------------------------------------------------

export interface MarketplaceConfig {
  name: string;
  description: string;
  url: string;
}

// ---------------------------------------------------------------------------
// File generators
// ---------------------------------------------------------------------------

export function generateMarketplaceJson(cfg: MarketplaceConfig): string {
  const marketplace = {
    version: "1.0.0",
    name: cfg.name,
    description: cfg.description,
    url: cfg.url,
    entries: [],
  };
  return JSON.stringify(marketplace, null, 2) + "\n";
}

export function generateReadme(cfg: MarketplaceConfig): string {
  return [
    `# ${cfg.name}`,
    ``,
    cfg.description || "_No description provided._",
    ``,
    `## What is this marketplace?`,
    ``,
    `This marketplace contains Kaizen plugins and harnesses available for your Kaizen installation.`,
    ``,
    `## Adding a plugin entry`,
    ``,
    `Add entries to \`.kaizen/marketplace.json\` with \`kind: "plugin"\`. Specify a source type:`,
    ``,
    `### npm source`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "kind": "plugin",`,
    `  "name": "my-plugin",`,
    `  "description": "A useful plugin",`,
    `  "versions": [`,
    `    {`,
    `      "version": "1.0.0",`,
    `      "source": {`,
    `        "type": "npm",`,
    `        "name": "my-plugin-package",`,
    `        "version": "1.0.0"`,
    `      }`,
    `    }`,
    `  ]`,
    `}`,
    `\`\`\``,
    ``,
    `### tarball source`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "source": {`,
    `    "type": "tarball",`,
    `    "url": "https://example.com/my-plugin-1.0.0.tgz",`,
    `    "sha256": "abc123...def456"`,
    `  }`,
    `}`,
    `\`\`\``,
    ``,
    `### file source`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "source": {`,
    `    "type": "file",`,
    `    "path": "plugins/my-plugin/index.ts"`,
    `  }`,
    `}`,
    `\`\`\``,
    ``,
    `## Adding a harness entry`,
    ``,
    `Add entries with \`kind: "harness"\` and reference the harness path:`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "kind": "harness",`,
    `  "name": "my-harness",`,
    `  "description": "A harness for Kaizen",`,
    `  "versions": [`,
    `    {`,
    `      "version": "1.0.0",`,
    `      "path": "harnesses/my-harness/kaizen.json"`,
    `    }`,
    `  ]`,
    `}`,
    `\`\`\``,
    ``,
    `## Adding this marketplace to Kaizen`,
    ``,
    `Users can add this marketplace with:`,
    ``,
    `\`\`\`sh`,
    `kaizen marketplace add ${cfg.url}`,
    `\`\`\``,
    ``,
    `## Validating the marketplace`,
    ``,
    `Before sharing, validate your marketplace:`,
    ``,
    `\`\`\`sh`,
    `kaizen marketplace validate .`,
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

async function promptConfig(rl: readline.Interface, targetPath: string): Promise<MarketplaceConfig> {
  const defaultName = basename(targetPath);

  const name = (await prompt(rl, `Marketplace name [${defaultName}]: `)) || defaultName;
  const description = (await prompt(rl, `Description [Kaizen plugins for ${name}.]: `)) ||
    `Kaizen plugins for ${name}.`;
  const url = await prompt(rl, `Marketplace URL []: `);

  return { name, description, url };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runMarketplaceCreate(
  targetPath: string,
  opts: { defaults?: boolean },
): Promise<number> {
  // 1. Check target does not exist
  if (existsSync(targetPath)) {
    console.error(`Error: target path already exists: ${targetPath}`);
    return 1;
  }

  let cfg: MarketplaceConfig;

  if (opts.defaults) {
    // 2. Defaults mode
    const name = basename(targetPath);
    cfg = {
      name,
      description: `Kaizen plugins for ${name}.`,
      url: `https://example.com/${name}`,
    };
  } else {
    // 3. Interactive mode
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

  // 4. Create directories
  mkdirSync(join(targetPath, ".kaizen"), { recursive: true });
  mkdirSync(join(targetPath, "plugins"), { recursive: true });
  mkdirSync(join(targetPath, "harnesses"), { recursive: true });

  // 5. Write files
  writeFileSync(join(targetPath, ".kaizen", "marketplace.json"), generateMarketplaceJson(cfg));
  writeFileSync(join(targetPath, "plugins", ".gitkeep"), "");
  writeFileSync(join(targetPath, "harnesses", ".gitkeep"), "");
  writeFileSync(join(targetPath, "README.md"), generateReadme(cfg));

  // 6. Print success message
  const displayPath = `./${basename(targetPath)}`;
  console.log(`Created marketplace scaffold at ${displayPath}`);
  console.log(`Next steps:`);
  console.log(`  Add plugin entries to .kaizen/marketplace.json`);
  console.log(`  kaizen marketplace validate .`);

  return 0;
}
