import { execSync, spawn } from "child_process";
import type { KaizenPlugin, ToolDefinition, ToolResult } from "../../src/types/plugin.js";
import { readStdinLine } from "../../src/core/stdin.js";
import { EVENTS } from "../core-events/index.js";

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

async function runCli(
  cliName: string,
  args: string[],
  timeoutMs: number,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(cliName, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: `${cliName}: timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, output: stdout || stderr });
      } else {
        const result: ToolResult = { ok: false, error: stderr || stdout };
        if (code !== null) result.exit_code = code;
        resolve(result);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}

function getHelpText(cliName: string, timeoutMs: number): string {
  try {
    return execSync(`${cliName} --help`, {
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: unknown) {
    // Many CLIs exit non-zero for --help but still write to stdout/stderr
    if (e && typeof e === "object") {
      const err = e as { stdout?: string; stderr?: string };
      if (typeof err.stdout === "string" && err.stdout.trim()) return err.stdout;
      if (typeof err.stderr === "string" && err.stderr.trim()) return err.stderr;
    }
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
      return runCli(cliName, cmdArgs, timeoutMs);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: KaizenPlugin = {
  name: "core-cli",
  apiVersion: "1.0.0",
  provides: [],
  depends: ["lifecycle"],

  async setup(ctx) {
    const clis = (ctx.config["clis"] as string[] | undefined) ?? [];
    const allowDestructive = Boolean(ctx.config["allow_destructive"] ?? false);
    const timeoutMs = Number(ctx.config["subprocess_timeout_ms"] ?? 30000);

    for (const cliName of clis) {
      const helpText = getHelpText(cliName, timeoutMs);
      const tool = createCliTool(cliName, helpText, allowDestructive, timeoutMs);
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
