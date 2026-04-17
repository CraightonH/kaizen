import type { Executor } from "../types/plugin.js";
import { fatal } from "./errors.js";

export class ExecutorRegistry {
  private impl: Executor | null = null;
  private registeredBy: string | null = null;

  register(impl: Executor, pluginName: string): void {
    if (this.impl !== null) {
      fatal(`Two plugins registered an executor: '${this.registeredBy}' and '${pluginName}'. Remove one.`);
    }
    this.impl = impl;
    this.registeredBy = pluginName;
  }

  get(): Executor {
    if (!this.impl) fatal("No executor registered. Add an executor plugin to kaizen.json.");
    return this.impl;
  }

  isRegistered(): boolean { return this.impl !== null; }

  deregisterByPlugin(pluginName: string): void {
    if (this.registeredBy === pluginName) {
      this.impl = null;
      this.registeredBy = null;
    }
  }
}
