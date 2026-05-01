import type { ServiceSpec } from "../types/plugin.js";

export interface ServiceEntry {
  name: string;
  spec: ServiceSpec;
  definedBy: string;
  providers: string[];
  consumers: string[];
}

/**
 * String-keyed registry for cross-plugin services.
 *
 * Each service has one definer (plugin declaring `defineService`), exactly
 * one provider (plugin calling `provideService`), and any number of consumers.
 * Cardinality is implicitly "one" in v1. Payloads are arbitrary JS values;
 * `use` returns the exact reference registered by `provide`.
 */
export class ServiceRegistry {
  private readonly entries = new Map<string, ServiceEntry>();
  private readonly providers = new Map<string, string>();  // name -> providerPluginName
  private readonly impls = new Map<string, unknown>();     // name -> impl
  private readonly consumers = new Map<string, Set<string>>();

  define(name: string, pluginName: string, spec: ServiceSpec): void {
    if (name.length === 0 || name.includes(" ")) {
      throw new Error(
        `Service name '${name}' is invalid: must be non-empty and contain no whitespace.`,
      );
    }
    const existing = this.entries.get(name);
    if (existing) {
      throw new Error(
        `Service '${name}' is already defined by plugin '${existing.definedBy}'; ` +
        `plugin '${pluginName}' cannot redefine it. ` +
        `If both plugins implement the same contract, only one should defineService(); ` +
        `the other should provideService() against the existing definition.`,
      );
    }
    this.entries.set(name, {
      name, spec, definedBy: pluginName,
      providers: [], consumers: [],
    });
  }

  provide<T>(name: string, pluginName: string, impl: T): void {
    if (!this.entries.has(name)) {
      throw new Error(
        `Plugin '${pluginName}' provides undefined service '${name}'. ` +
        `The defining plugin must call defineService() first.`,
      );
    }
    if (this.providers.has(name)) {
      throw new Error(
        `Service '${name}' already has a provider ('${this.providers.get(name)}'). ` +
        `Cardinality is one — only one plugin may provide a service.`,
      );
    }
    this.providers.set(name, pluginName);
    this.impls.set(name, impl);
  }

  consume(name: string, pluginName: string): void {
    const set = this.consumers.get(name) ?? new Set<string>();
    set.add(pluginName);
    this.consumers.set(name, set);
  }

  use<T>(name: string): T {
    if (!this.impls.has(name)) {
      throw new Error(
        `Service '${name}' has no provider. Check that the provider plugin ` +
        `is loaded and listed before consumers.`,
      );
    }
    return this.impls.get(name) as T;
  }

  providersOf(name: string): string[] {
    const p = this.providers.get(name);
    return p ? [p] : [];
  }

  consumersOf(name: string): string[] {
    return Array.from(this.consumers.get(name) ?? []);
  }

  getSpec(name: string): ServiceSpec | undefined {
    return this.entries.get(name)?.spec;
  }

  list(): ServiceEntry[] {
    return Array.from(this.entries.values()).map((e) => ({
      ...e,
      providers: this.providersOf(e.name),
      consumers: this.consumersOf(e.name),
    }));
  }

  validateAll(): void {
    const referenced = new Set<string>([
      ...this.providers.keys(),
      ...this.consumers.keys(),
    ]);
    for (const name of referenced) {
      if (!this.entries.has(name)) {
        const where = this.providers.has(name) ? "provides" : "consumes";
        const plugins = where === "provides"
          ? this.providersOf(name) : this.consumersOf(name);
        throw new Error(
          `Plugin(s) [${plugins.join(", ")}] ${where} undefined service '${name}'. ` +
          `Typo or missing plugin dependency?`,
        );
      }
    }

    for (const entry of this.entries.values()) {
      const consumers = this.consumersOf(entry.name);
      if (consumers.length === 0) continue;
      const providers = this.providersOf(entry.name);
      if (providers.length === 0) {
        throw new Error(
          `No plugin provides service '${entry.name}' (consumed by: ${consumers.join(", ")}).`,
        );
      }
    }
  }

  deregisterByPlugin(pluginName: string): void {
    for (const [name, entry] of this.entries) {
      if (entry.definedBy === pluginName) this.entries.delete(name);
    }
    for (const [name, provider] of this.providers) {
      if (provider === pluginName) {
        this.providers.delete(name);
        this.impls.delete(name);
      }
    }
    for (const [name, set] of this.consumers) {
      set.delete(pluginName);
      if (set.size === 0) this.consumers.delete(name);
    }
  }
}
