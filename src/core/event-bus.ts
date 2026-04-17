import type { EventHandler } from "../types/plugin.js";
import { debug, warn } from "./errors.js";

export class EventBus {
  private defined = new Set<string>();
  private definedBy = new Map<string, string>();
  private handlers = new Map<string, Array<{ handler: EventHandler; pluginName: string }>>();

  defineEvent(name: string, pluginName: string): void {
    if (this.defined.has(name)) {
      warn(`Event '${name}' already defined. Ignoring duplicate definition.`);
      return;
    }
    this.defined.add(name);
    this.definedBy.set(name, pluginName);
  }

  on(name: string, handler: EventHandler, pluginName: string): void {
    const existing = this.handlers.get(name) ?? [];
    existing.push({ handler, pluginName });
    this.handlers.set(name, existing);
  }

  deregisterByPlugin(pluginName: string): void {
    for (const [event, entries] of [...this.handlers]) {
      const remaining = entries.filter((e) => e.pluginName !== pluginName);
      if (remaining.length > 0) {
        this.handlers.set(event, remaining);
      } else {
        this.handlers.delete(event);
      }
    }
    for (const [event, owner] of [...this.definedBy]) {
      if (owner === pluginName) {
        this.defined.delete(event);
        this.definedBy.delete(event);
      }
    }
  }

  async emit(name: string, payload?: unknown): Promise<unknown[]> {
    if (!this.defined.has(name)) {
      warn(`Unknown event '${name}' — possible typo or missing plugin dependency.`);
    }
    const entries = this.handlers.get(name) ?? [];
    const results: unknown[] = [];
    for (const { handler } of entries) {
      try {
        results.push(await handler(payload));
      } catch (err) {
        debug(`Handler for event '${name}' threw: ${err}`);
        console.error(
          `[kaizen] error: handler for '${name}' threw:`,
          err instanceof Error ? err.message : err,
        );
        if (err instanceof Error && err.stack) debug(err.stack);
        results.push(undefined);
      }
    }
    return results;
  }
}
