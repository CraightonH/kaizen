import type { UiProvider } from "../types/plugin.js";
import { fatal } from "./errors.js";

interface Entry { impl: UiProvider; pluginName: string; }

export class UiRegistry {
  private readonly entries: Entry[] = [];

  register(impl: UiProvider, pluginName: string): void {
    this.entries.push({ impl, pluginName });
  }

  /** All registered providers, in registration order. */
  list(): UiProvider[] {
    return this.entries.map((e) => e.impl);
  }

  /** First-registered provider, for back-compat with single-provider code paths. */
  getFirst(): UiProvider {
    if (this.entries.length === 0) fatal("No UI provider registered.");
    return this.entries[0]!.impl;
  }

  isRegistered(): boolean { return this.entries.length > 0; }

  deregisterByPlugin(pluginName: string): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.pluginName === pluginName) this.entries.splice(i, 1);
    }
  }
}
