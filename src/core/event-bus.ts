import type { EventHandler } from "../types/plugin.js";
import { debug, warn } from "./errors.js";

export class EventBus {
  private defined = new Set<string>();
  private handlers = new Map<string, EventHandler[]>();

  defineEvent(name: string): void {
    if (this.defined.has(name)) {
      warn(`Event '${name}' already defined. Ignoring duplicate definition.`);
      return;
    }
    this.defined.add(name);
  }

  on(name: string, handler: EventHandler): void {
    const existing = this.handlers.get(name) ?? [];
    existing.push(handler);
    this.handlers.set(name, existing);
  }

  async emit(name: string, payload?: unknown): Promise<unknown[]> {
    if (!this.defined.has(name)) {
      warn(
        `Unknown event '${name}' — possible typo or missing plugin dependency.`,
      );
    }

    const handlers = this.handlers.get(name) ?? [];
    const results: unknown[] = [];

    for (const handler of handlers) {
      try {
        results.push(await handler(payload));
      } catch (err) {
        debug(`Handler for event '${name}' threw: ${err}`);
        console.error(
          `[kaizen] error: handler for '${name}' threw:`,
          err instanceof Error ? err.message : err,
        );
        if (err instanceof Error && err.stack) {
          debug(err.stack);
        }
        results.push(undefined);
      }
    }

    return results;
  }
}
