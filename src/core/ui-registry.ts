import type { UiProvider } from "../types/plugin.js";
import { fatal } from "./errors.js";

export class UiRegistry {
  private impl: UiProvider | null = null;
  private registeredBy: string | null = null;

  register(impl: UiProvider, pluginName: string): void {
    if (this.impl !== null) {
      fatal(`Two plugins registered a UI provider: '${this.registeredBy}' and '${pluginName}'. Remove one.`);
    }
    this.impl = impl;
    this.registeredBy = pluginName;
  }

  get(): UiProvider {
    if (!this.impl) fatal("No UI provider registered. Add a UI plugin to kaizen.json.");
    return this.impl;
  }

  isRegistered(): boolean { return this.impl !== null; }
}
