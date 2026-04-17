import type { Executor } from "../types/plugin.js";
import { fatal } from "./errors.js";

interface Entry { impl: Executor; pluginName: string; }

export class ExecutorRegistry {
  private readonly entries: Entry[] = [];

  register(impl: Executor, pluginName: string): void {
    this.entries.push({ impl, pluginName });
  }

  list(): Executor[] {
    return this.entries.map((e) => e.impl);
  }

  getFirst(): Executor {
    if (this.entries.length === 0) fatal("No executor registered.");
    return this.entries[0]!.impl;
  }

  isRegistered(): boolean { return this.entries.length > 0; }

  deregisterByPlugin(pluginName: string): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.pluginName === pluginName) this.entries.splice(i, 1);
    }
  }
}
