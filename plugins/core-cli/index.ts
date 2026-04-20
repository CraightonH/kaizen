import type { KaizenPlugin, PluginContext, ToolDefinition, ToolResult } from "../../src/types/plugin.js";
import { readStdinLine } from "../../src/core/stdin.js";
import { EVENTS } from "../core-events/index.js";

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

async function runCli(
  ctx: PluginContext,
  cliName: string,
  args: string[],
  timeoutMs: number,
): Promise<ToolResult> {
  try {
    const result = await ctx.exec.run(cliName, args, { timeoutMs });
    if (result.exitCode === 0) {
      return { ok: true, output: result.stdout || result.stderr };
    } else {
      const toolResult: ToolResult = { ok: false, error: result.stderr || result.stdout };
      toolResult.exit_code = result.exitCode;
      return toolResult;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

async function getHelpText(ctx: PluginContext, cliName: string, timeoutMs: number): Promise<string> {
  try {
    const result = await ctx.exec.run(cliName, ["--help"], { timeoutMs });
    // Many CLIs exit non-zero for --help but still write to stdout/stderr
    const text = result.stdout.trim() || result.stderr.trim();
    return text || `${cliName} CLI tool`;
  } catch {
    return `${cliName} CLI tool`;
  }
}

// ---------------------------------------------------------------------------
// Shell argument parsing (handles quoted strings)
// ---------------------------------------------------------------------------

function parseArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (const ch of input) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) { args.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

// ---------------------------------------------------------------------------
// Destructive guard
// ---------------------------------------------------------------------------

const DESTRUCTIVE_PATTERNS = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bdestroy\b/i,
  /\bdrop\b/i,
  /\bpurge\b/i,
  /\bwipe\b/i,
  /\berase\b/i,
  /--force\b/,
  /\b-f\b/,
  /--delete\b/,
  /\bclose\b.*\b(issue|pr|pull)\b/i,
];

function looksDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}

async function confirmDestructive(cliName: string, command: string): Promise<boolean> {
  process.stdout.write(
    `\n[core-cli] Potentially destructive: ${cliName} ${command}\nProceed? (y/N) `,
  );
  const answer = await readStdinLine();
  return answer.toLowerCase().startsWith("y");
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

function createCliTool(
  ctx: PluginContext,
  cliName: string,
  helpText: string,
  allowDestructive: boolean,
  timeoutMs: number,
): ToolDefinition {
  // Trim help text to a reasonable size for the LLM description
  const description = helpText.trim().slice(0, 800);

  return {
    name: cliName,
    description: `${cliName} CLI. Run any ${cliName} subcommand.\n\n${description}`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            `The ${cliName} subcommand and arguments (e.g. "issue list --limit 5"). ` +
            `Do not include "${cliName}" itself — only the subcommand.`,
        },
      },
      required: ["command"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const command = String(args.command ?? "").trim();

      if (!allowDestructive && looksDestructive(command)) {
        const ok = await confirmDestructive(cliName, command);
        if (!ok) return { ok: false, error: "Cancelled by user." };
      }

      const cmdArgs = parseArgs(command);
      return runCli(ctx, cliName, cmdArgs, timeoutMs);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: KaizenPlugin = {
  name: "core-cli",
  apiVersion: "2.0.0",
  capabilities: { consumes: ["core-lifecycle:lifecycle.drive"] },

  // SCOPED with exec.binaries: ["*"]
  // Rationale: the binary list comes from ctx.config["clis"] which is not
  // available at plugin declaration time (only during setup()). A static
  // allowlist would require duplicating config in two places. Using "*" is
  // conservative in the other direction — it permits any binary — but the
  // enforcer still gates every exec.run call through the permission check,
  // and the actual binaries invoked are limited to what the user configured.
  // Deviation logged in plan 3 Deviation Log.
  permissions: {
    tier: "scoped",
    exec: { binaries: ["*"] },
  },

  config: {
    schema: {
      properties: {
        clis: { type: "array", items: { type: "string" } },
        allow_destructive: { type: "boolean" },
        subprocess_timeout_ms: { type: "number" },
      },
    },
    defaults: {
      clis: [],
      allow_destructive: false,
      subprocess_timeout_ms: 30000,
    },
  },

  async setup(ctx) {
    const clis = (ctx.config["clis"] as string[] | undefined) ?? [];
    const allowDestructive = Boolean(ctx.config["allow_destructive"] ?? false);
    const timeoutMs = Number(ctx.config["subprocess_timeout_ms"] ?? 30000);

    for (const cliName of clis) {
      const helpText = await getHelpText(ctx, cliName, timeoutMs);
      const tool = createCliTool(ctx, cliName, helpText, allowDestructive, timeoutMs);
      ctx.registerTool(tool);
      ctx.log(`registered tool: ${cliName}`);
    }

    ctx.on(EVENTS.TOOL_BEFORE, async (payload) => {
      const p = payload as { tool: string; args: Record<string, unknown> } | undefined;
      if (p) ctx.log(`→ ${p.tool}(${JSON.stringify(p.args)})`);
    });

    ctx.on(EVENTS.TOOL_AFTER, async (payload) => {
      const p = payload as { tool: string; ok: boolean } | undefined;
      if (p) ctx.log(`← ${p.tool}: ${p.ok ? "ok" : "err"}`);
    });
  },
};

export default plugin;
