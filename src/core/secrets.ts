import type { SecretProvider } from "./secret-providers/types.js";
import type { SecretRef, SecretsContext } from "../types/plugin.js";
import { envVarNameFor } from "./config-merge.js";

export const SECRETS_PROVIDER_SERVICE = "core-secrets:provider";

export class SecretsRegistry {
  private providers = new Map<string, SecretProvider>();
  private cache = new Map<string, string | undefined>();  // key: `<provider>:<ref>`

  register(provider: SecretProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`secret provider '${provider.name}' already registered`);
    }
    this.providers.set(provider.name, provider);
  }

  getProvider(name: string): SecretProvider | undefined {
    return this.providers.get(name);
  }

  async resolve(
    pluginName: string,
    key: string,
    ref: SecretRef,
    opts: { bypassCache?: boolean } = {},
  ): Promise<string | undefined> {
    // 1. envOverride (only for structured refs with envOverride set)
    if (typeof ref !== "string" && ref.envOverride) {
      const val = process.env[ref.envOverride];
      if (val !== undefined) return val;
    }

    // 2. KAIZEN_<PLUGIN>_<KEY>
    const conventionEnvVar = envVarNameFor(pluginName, key);
    const conventionVal = process.env[conventionEnvVar];
    if (conventionVal !== undefined) return conventionVal;

    // 3. Resolve provider + ref
    const providerName = typeof ref === "string" ? "kaizen" : ref.provider;
    const refStr = typeof ref === "string" ? ref : ref.ref;
    const cacheKey = `${providerName}:${refStr}`;

    if (!opts.bypassCache && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`no secret provider named '${providerName}' is registered`);
    }

    const value = await provider.get(refStr);
    this.cache.set(cacheKey, value);
    return value;
  }

  async prefetchForPlugin(
    pluginName: string,
    declaredRefs: Record<string, SecretRef>,
  ): Promise<void> {
    // Group refs by provider
    const byProvider = new Map<string, string[]>();
    for (const [key, ref] of Object.entries(declaredRefs)) {
      const providerName = typeof ref === "string" ? "kaizen" : ref.provider;
      const refStr = typeof ref === "string" ? ref : ref.ref;
      const existing = byProvider.get(providerName) ?? [];
      existing.push(refStr);
      byProvider.set(providerName, existing);
    }

    for (const [providerName, refs] of byProvider) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;
      try {
        await provider.prefetch?.(refs);
      } catch (err) {
        console.warn(`[kaizen] prefetch failed for plugin '${pluginName}' via provider '${providerName}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export function createSecretsContext(
  registry: SecretsRegistry,
  pluginName: string,
  declaredRefs: Record<string, SecretRef>,
): SecretsContext {
  return {
    async get(key: string): Promise<string | undefined> {
      const ref = declaredRefs[key];
      if (ref !== undefined) {
        return registry.resolve(pluginName, key, ref);
      }
      // Undeclared: treat as ref against default provider
      const defaultProvider = registry.getProvider("kaizen");
      if (!defaultProvider) {
        throw new Error(`ctx.secrets.get("${key}"): no default provider 'kaizen' registered`);
      }
      return defaultProvider.get(key);
    },
    async refresh(key: string): Promise<string | undefined> {
      const ref = declaredRefs[key];
      if (ref === undefined) {
        // Undeclared: live lookup
        const defaultProvider = registry.getProvider("kaizen");
        if (!defaultProvider) {
          throw new Error(`ctx.secrets.refresh("${key}"): no default provider 'kaizen' registered`);
        }
        return defaultProvider.get(key);
      }
      return registry.resolve(pluginName, key, ref, { bypassCache: true });
    },
  };
}
