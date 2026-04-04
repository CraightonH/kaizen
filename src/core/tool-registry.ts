import Ajv from "ajv";
import type { ToolDefinition, ToolResult } from "../types/plugin.js";
import { debug, warn } from "./errors.js";

const ajv = new Ajv({ coerceTypes: false, strict: false });

export class ToolRegistry {
  private tools = new Map<string, { tool: ToolDefinition; registeredBy: string }>();

  register(tool: ToolDefinition, pluginName: string): void {
    if (this.tools.has(tool.name)) {
      const existing = this.tools.get(tool.name)!;
      warn(
        `Tool '${tool.name}' already registered by '${existing.registeredBy}'. Skipping duplicate from '${pluginName}'.`,
      );
      return;
    }
    this.tools.set(tool.name, { tool, registeredBy: pluginName });
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((e) => e.tool);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) {
      return { ok: false, error: `Unknown tool '${name}'.` };
    }

    const { tool } = entry;

    // Validate args against JSON Schema
    const validate = ajv.compile(tool.parameters);
    if (!validate(args)) {
      const msg = ajv.errorsText(validate.errors);
      return { ok: false, error: `Invalid arguments: ${msg}` };
    }

    try {
      return await tool.execute(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.stack) {
        debug(err.stack);
      }
      return { ok: false, error: message };
    }
  }
}
