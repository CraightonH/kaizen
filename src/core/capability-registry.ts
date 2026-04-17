import type { CapabilitySpec } from "../types/plugin.js";
import { warn } from "./errors.js";

export interface CapabilityEntry {
  name: string;
  spec: CapabilitySpec;
  definedBy: string;
  providers: string[];
  consumers: string[];
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityEntry>();
  private readonly providers = new Map<string, Set<string>>();
  private readonly consumers = new Map<string, Set<string>>();

  define(name: string, pluginName: string, spec: CapabilitySpec): void {
    const colon = name.indexOf(":");
    if (colon < 0 || name.slice(0, colon) !== pluginName) {
      throw new Error(
        `Capability '${name}' must be prefixed with plugin name '${pluginName}' ` +
        `(e.g. '${pluginName}:...').`,
      );
    }
    if (this.entries.has(name)) {
      warn(`Capability '${name}' already defined. Ignoring duplicate from '${pluginName}'.`);
      return;
    }
    this.entries.set(name, {
      name, spec, definedBy: pluginName,
      providers: [], consumers: [],
    });
  }

  addProvider(name: string, pluginName: string): void {
    const set = this.providers.get(name) ?? new Set<string>();
    set.add(pluginName);
    this.providers.set(name, set);
  }

  addConsumer(name: string, pluginName: string): void {
    const set = this.consumers.get(name) ?? new Set<string>();
    set.add(pluginName);
    this.consumers.set(name, set);
  }

  providersOf(name: string): string[] {
    return Array.from(this.providers.get(name) ?? []);
  }

  consumersOf(name: string): string[] {
    return Array.from(this.consumers.get(name) ?? []);
  }

  getSpec(name: string): CapabilitySpec | undefined {
    return this.entries.get(name)?.spec;
  }

  resolveName(name: string, aliases: Record<string, string>): string {
    return aliases[name] ?? name;
  }

  list(): CapabilityEntry[] {
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
          `Plugin(s) [${plugins.join(", ")}] ${where} undefined capability '${name}'. ` +
          `Typo, missing plugin dependency, or missing alias?`,
        );
      }
    }

    for (const entry of this.entries.values()) {
      if (entry.spec.cardinality !== "one") continue;
      const consumers = this.consumersOf(entry.name);
      if (consumers.length === 0) continue;
      const providers = this.providersOf(entry.name);
      if (providers.length === 0) {
        throw new Error(
          `No plugin provides capability '${entry.name}' (consumed by: ${consumers.join(", ")}).`,
        );
      }
      if (providers.length > 1) {
        throw new Error(
          `Multiple plugins provide capability '${entry.name}': ${providers.join(", ")}. Remove one.`,
        );
      }
    }
  }

  deregisterByPlugin(pluginName: string): void {
    for (const [name, entry] of this.entries) {
      if (entry.definedBy === pluginName) this.entries.delete(name);
    }
    for (const [name, set] of this.providers) {
      set.delete(pluginName);
      if (set.size === 0) this.providers.delete(name);
    }
    for (const [name, set] of this.consumers) {
      set.delete(pluginName);
      if (set.size === 0) this.consumers.delete(name);
    }
  }
}
