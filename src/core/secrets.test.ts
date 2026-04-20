import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { SecretsRegistry, createSecretsContext } from "./secrets.js";
import type { SecretProvider } from "./secret-providers/types.js";
import type { SecretRef } from "../types/plugin.js";

function makeProvider(name: string, store: Record<string, string> = {}): SecretProvider & { getCalls: string[]; prefetchCalls: string[][] } {
  const getCalls: string[] = [];
  const prefetchCalls: string[][] = [];
  return {
    name,
    getCalls,
    prefetchCalls,
    async get(ref: string) {
      getCalls.push(ref);
      return store[ref];
    },
    async prefetch(refs: string[]) {
      prefetchCalls.push(refs);
    },
  };
}

describe("SecretsRegistry", () => {
  let registry: SecretsRegistry;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    registry = new SecretsRegistry();
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    // Clear tracked keys
    for (const key of Object.keys(savedEnv)) {
      delete savedEnv[key];
    }
  });

  function setEnv(key: string, value: string) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function unsetEnv(key: string) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  // 1. register collision throws
  it("register: throws on duplicate provider name", () => {
    const p1 = makeProvider("vault");
    const p2 = makeProvider("vault");
    registry.register(p1);
    expect(() => registry.register(p2)).toThrow("secret provider 'vault' already registered");
  });

  // 2. resolve uses envOverride when present
  it("resolve: uses envOverride env var when set", async () => {
    setEnv("MY_OVERRIDE", "override-value");
    const provider = makeProvider("kaizen", { "my-ref": "provider-value" });
    registry.register(provider);

    const ref: SecretRef = { provider: "kaizen", ref: "my-ref", envOverride: "MY_OVERRIDE" };
    const result = await registry.resolve("myplugin", "apiKey", ref);
    expect(result).toBe("override-value");
    // Provider should not be called
    expect(provider.getCalls).toHaveLength(0);
  });

  // 3. resolve uses KAIZEN_<PLUGIN>_<KEY> convention
  it("resolve: uses KAIZEN convention env var", async () => {
    setEnv("KAIZEN_MYPLUGIN_APIKEY", "convention-value");
    const provider = makeProvider("kaizen", { "my-ref": "provider-value" });
    registry.register(provider);

    const result = await registry.resolve("myplugin", "apiKey", "my-ref");
    expect(result).toBe("convention-value");
    expect(provider.getCalls).toHaveLength(0);
  });

  // 4. resolve falls through to provider
  it("resolve: calls provider when no env vars set", async () => {
    unsetEnv("KAIZEN_MYPLUGIN_APIKEY");
    const provider = makeProvider("kaizen", { "my-ref": "secret-value" });
    registry.register(provider);

    const result = await registry.resolve("myplugin", "apiKey", "my-ref");
    expect(result).toBe("secret-value");
    expect(provider.getCalls).toEqual(["my-ref"]);
  });

  // 5. resolve caches results
  it("resolve: caches results (provider called once)", async () => {
    unsetEnv("KAIZEN_MYPLUGIN_APIKEY");
    const provider = makeProvider("kaizen", { "my-ref": "secret-value" });
    registry.register(provider);

    await registry.resolve("myplugin", "apiKey", "my-ref");
    await registry.resolve("myplugin", "apiKey", "my-ref");
    expect(provider.getCalls).toHaveLength(1);
  });

  // 6. resolve with bypassCache calls provider again
  it("resolve: bypassCache forces re-fetch", async () => {
    unsetEnv("KAIZEN_MYPLUGIN_APIKEY");
    const provider = makeProvider("kaizen", { "my-ref": "secret-value" });
    registry.register(provider);

    await registry.resolve("myplugin", "apiKey", "my-ref");
    await registry.resolve("myplugin", "apiKey", "my-ref", { bypassCache: true });
    expect(provider.getCalls).toHaveLength(2);
  });

  // 7. resolve throws when provider not registered
  it("resolve: throws when provider not registered", async () => {
    unsetEnv("KAIZEN_MYPLUGIN_APIKEY");
    const ref: SecretRef = { provider: "vault", ref: "secret/data/foo" };
    await expect(registry.resolve("myplugin", "apiKey", ref)).rejects.toThrow(
      "no secret provider named 'vault' is registered",
    );
  });

  // 12. prefetchForPlugin groups by provider and calls prefetch
  it("prefetchForPlugin: groups refs by provider and calls prefetch", async () => {
    const kaizenProvider = makeProvider("kaizen");
    const vaultProvider = makeProvider("vault");
    registry.register(kaizenProvider);
    registry.register(vaultProvider);

    const declaredRefs: Record<string, SecretRef> = {
      key1: "ref-a",           // string -> kaizen
      key2: "ref-b",           // string -> kaizen
      key3: { provider: "vault", ref: "secret/x" },
    };

    await registry.prefetchForPlugin("myplugin", declaredRefs);

    expect(kaizenProvider.prefetchCalls).toHaveLength(1);
    expect(kaizenProvider.prefetchCalls[0]).toContain("ref-a");
    expect(kaizenProvider.prefetchCalls[0]).toContain("ref-b");
    expect(vaultProvider.prefetchCalls).toHaveLength(1);
    expect(vaultProvider.prefetchCalls[0]).toEqual(["secret/x"]);
  });

  it("prefetchForPlugin: skips missing providers gracefully", async () => {
    const declaredRefs: Record<string, SecretRef> = {
      key1: { provider: "vault", ref: "secret/x" },
    };
    // vault not registered — should not throw
    await expect(registry.prefetchForPlugin("myplugin", declaredRefs)).resolves.toBeUndefined();
  });

  it("prefetchForPlugin: warns on prefetch error but does not throw", async () => {
    const badProvider: SecretProvider = {
      name: "bad",
      async get() { return undefined; },
      async prefetch() { throw new Error("timeout"); },
    };
    registry.register(badProvider);

    const declaredRefs: Record<string, SecretRef> = {
      key1: { provider: "bad", ref: "some-ref" },
    };

    // Should not throw
    await expect(registry.prefetchForPlugin("myplugin", declaredRefs)).resolves.toBeUndefined();
  });
});

describe("createSecretsContext", () => {
  let registry: SecretsRegistry;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    registry = new SecretsRegistry();
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    for (const key of Object.keys(savedEnv)) {
      delete savedEnv[key];
    }
  });

  function unsetEnv(key: string) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  // 8. get for declared key uses registry.resolve
  it("get: declared key resolved via registry", async () => {
    unsetEnv("KAIZEN_MYPLUGIN_APIKEY");
    const provider = makeProvider("kaizen", { "my-ref": "secret-value" });
    registry.register(provider);

    const ctx = createSecretsContext(registry, "myplugin", { apiKey: "my-ref" });
    const result = await ctx.get("apiKey");
    expect(result).toBe("secret-value");
    expect(provider.getCalls).toEqual(["my-ref"]);
  });

  // 9. get for undeclared key calls default provider directly
  it("get: undeclared key calls default kaizen provider", async () => {
    const provider = makeProvider("kaizen", { "undeclared-key": "direct-value" });
    registry.register(provider);

    const ctx = createSecretsContext(registry, "myplugin", {});
    const result = await ctx.get("undeclared-key");
    expect(result).toBe("direct-value");
    expect(provider.getCalls).toEqual(["undeclared-key"]);
  });

  // 10. get for undeclared key throws if no kaizen provider
  it("get: throws for undeclared key when no kaizen provider", async () => {
    const ctx = createSecretsContext(registry, "myplugin", {});
    await expect(ctx.get("some-key")).rejects.toThrow(
      `ctx.secrets.get("some-key"): no default provider 'kaizen' registered`,
    );
  });

  // 11. refresh bypasses cache
  it("refresh: bypasses cache and calls provider again", async () => {
    unsetEnv("KAIZEN_MYPLUGIN_APIKEY");
    const provider = makeProvider("kaizen", { "my-ref": "secret-value" });
    registry.register(provider);

    const ctx = createSecretsContext(registry, "myplugin", { apiKey: "my-ref" });

    // First get — populates cache
    await ctx.get("apiKey");
    expect(provider.getCalls).toHaveLength(1);

    // refresh — should bypass cache and call provider again
    await ctx.refresh("apiKey");
    expect(provider.getCalls).toHaveLength(2);
  });

  it("refresh: undeclared key calls default provider directly", async () => {
    const provider = makeProvider("kaizen", { "live-key": "live-value" });
    registry.register(provider);

    const ctx = createSecretsContext(registry, "myplugin", {});
    const result = await ctx.refresh("live-key");
    expect(result).toBe("live-value");
    expect(provider.getCalls).toEqual(["live-key"]);
  });

  it("refresh: undeclared key throws if no kaizen provider", async () => {
    const ctx = createSecretsContext(registry, "myplugin", {});
    await expect(ctx.refresh("some-key")).rejects.toThrow(
      `ctx.secrets.refresh("some-key"): no default provider 'kaizen' registered`,
    );
  });
});
