import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mergePluginConfig, separateSecrets, applyEnvOverrides } from "../config-merge.js";
import { validateConfig } from "../config-validator.js";
import { SecretsRegistry, createSecretsContext } from "../secrets.js";
import type { SecretRef, StructuredSecretRef, PluginConfigDeclaration } from "../../types/plugin.js";
import type { SecretProvider } from "../secret-providers/types.js";
import { fileProvider } from "../../../plugins/core-secrets/file-fallback.js";

describe("Plugin Config Integration Tests", () => {
  // ============================================================================
  // Test 1: Install-time shape validation
  // ============================================================================

  describe("Test 1: Install-time shape validation", () => {
    test("missing required non-secret key fails validation", () => {
      const schema = {
        properties: { api_key: { type: "string" }, timeout_ms: { type: "number" } },
        required: ["timeout_ms"],
      };
      const config = { api_key: "skip-this" }; // api_key is a secret, so not in config

      const errors = validateConfig(schema, config);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]!.message).toMatch(/required/i);
    });
  });

  // ============================================================================
  // Test 2: Install-time does NOT check secret value availability
  // ============================================================================

  describe("Test 2: Install-time does NOT check secret value availability", () => {
    test("install-time does not fail on missing secret values", () => {
      const schema = {
        properties: { api_key: { type: "string" }, model: { type: "string" } },
        required: ["api_key", "model"],
      };
      const merged = { api_key: "doppler:my-key", model: "gpt-4" };
      const { config } = separateSecrets(merged, ["api_key"]);

      // After separation, api_key should be stripped
      expect(config.api_key).toBeUndefined();
      expect(config.model).toBe("gpt-4");

      // Validate only non-secret config
      const nonSecretSchema = {
        properties: { model: { type: "string" } },
        required: ["model"],
      };
      const errors = validateConfig(nonSecretSchema, config);
      expect(errors).toHaveLength(0);
    });
  });

  // ============================================================================
  // Test 3: Load-time provider existence check
  // ============================================================================

  describe("Test 3: Load-time provider existence check", () => {
    test("load-time: missing secret provider causes error", () => {
      const registry = new SecretsRegistry();
      // 'doppler' provider is NOT registered
      expect(registry.getProvider("doppler")).toBeUndefined();

      // Verify the check logic that plugin-manager would do
      const ref: SecretRef = { provider: "doppler", ref: "my-key" } as StructuredSecretRef;
      const providerName = typeof ref === "string" ? "kaizen" : ref.provider;
      expect(registry.getProvider(providerName)).toBeUndefined();
    });

    test("registered provider can be retrieved", () => {
      const registry = new SecretsRegistry();
      const mockProvider: SecretProvider = {
        name: "test-provider",
        get: async () => "test-value",
      };
      registry.register(mockProvider);
      expect(registry.getProvider("test-provider")).toBe(mockProvider);
    });
  });

  // ============================================================================
  // Test 4: Secret resolution end-to-end with file backend
  // ============================================================================

  describe("Test 4: Secret resolution end-to-end with file backend", () => {
    test("file backend: set then get returns correct value", async () => {
      const testRef = `test-integration-${Date.now()}`;
      const testValue = "integration-test-secret-value";

      // Set the secret
      await fileProvider.set!(testRef, testValue);

      // Get it back
      const retrieved = await fileProvider.get(testRef);
      expect(retrieved).toBe(testValue);

      // Cleanup
      await fileProvider.set!(testRef, "");
    });

    test("file backend: get returns undefined for nonexistent key", async () => {
      const nonexistentRef = `nonexistent-${Date.now()}`;
      const result = await fileProvider.get(nonexistentRef);
      expect(result).toBeUndefined();
    });
  });

  // ============================================================================
  // Test 5: Env override beats harness config
  // ============================================================================

  describe("Test 5: Env override beats harness config", () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.KAIZEN_STRIPE_BILLING_TIMEOUT_MS;
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.KAIZEN_STRIPE_BILLING_TIMEOUT_MS;
      } else {
        process.env.KAIZEN_STRIPE_BILLING_TIMEOUT_MS = originalEnv;
      }
    });

    test("KAIZEN_<PLUGIN>_<KEY> env override beats harness value", () => {
      process.env.KAIZEN_STRIPE_BILLING_TIMEOUT_MS = "999";

      const config = { timeout_ms: 3000 };
      const schema = { properties: { timeout_ms: { type: "number" } } };

      applyEnvOverrides("stripe-billing", config, schema);

      expect(config.timeout_ms).toBe(999);
    });

    test("env override with boolean type coercion", () => {
      process.env.KAIZEN_TEST_PLUGIN_DEBUG_MODE = "true";

      const config = { debug_mode: false };
      const schema = { properties: { debug_mode: { type: "boolean" } } };

      applyEnvOverrides("test-plugin", config, schema);

      expect(config.debug_mode).toBe(true);
    });

    test("env override without schema defaults to string", () => {
      process.env.KAIZEN_MY_PLUGIN_API_ENDPOINT = "https://custom.example.com";

      const config = { api_endpoint: "https://default.example.com" };

      applyEnvOverrides("my-plugin", config);

      expect(config.api_endpoint).toBe("https://custom.example.com");
    });
  });

  // ============================================================================
  // Test 6: envOverride field on StructuredSecretRef takes precedence
  // ============================================================================

  describe("Test 6: envOverride field on StructuredSecretRef takes precedence", () => {
    let envKey: string;

    beforeEach(() => {
      envKey = `STRIPE_KEY_${Date.now()}`;
    });

    afterEach(() => {
      delete process.env[envKey];
    });

    test("envOverride field on StructuredSecretRef takes precedence", async () => {
      const registry = new SecretsRegistry();
      const mockProvider: SecretProvider = {
        name: "kaizen",
        get: async () => "from-provider",
      };
      registry.register(mockProvider);

      process.env[envKey] = "from-env-override";

      const ref: SecretRef = { provider: "kaizen", ref: "stripe-prod", envOverride: envKey } as StructuredSecretRef;
      const result = await registry.resolve("stripe", "api_key", ref);

      expect(result).toBe("from-env-override");
    });

    test("envOverride falls through to provider if not set", async () => {
      const registry = new SecretsRegistry();
      const mockProvider: SecretProvider = {
        name: "kaizen",
        get: async () => "from-provider",
      };
      registry.register(mockProvider);

      // Don't set the env var
      const ref: SecretRef = { provider: "kaizen", ref: "stripe-prod", envOverride: envKey } as StructuredSecretRef;
      const result = await registry.resolve("stripe", "api_key", ref);

      expect(result).toBe("from-provider");
    });
  });

  // ============================================================================
  // Test 7: Undeclared secret via default provider
  // ============================================================================

  describe("Test 7: Undeclared secret via default provider", () => {
    test("undeclared secret resolves via default kaizen provider", async () => {
      const registry = new SecretsRegistry();
      const mockProvider: SecretProvider = {
        name: "kaizen",
        get: async (ref: string) => `value-for-${ref}`,
      };
      registry.register(mockProvider);

      const ctx = createSecretsContext(registry, "my-plugin", {});
      const result = await ctx.get("random-runtime-key");

      expect(result).toBe("value-for-random-runtime-key");
    });

    test("undeclared secret throws if no default provider registered", async () => {
      const registry = new SecretsRegistry();
      const ctx = createSecretsContext(registry, "my-plugin", {});

      try {
        await ctx.get("random-key");
        throw new Error("should have thrown");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toMatch(/no default provider/i);
      }
    });
  });

  // ============================================================================
  // Test 8: refresh bypasses cache
  // ============================================================================

  describe("Test 8: refresh bypasses cache", () => {
    test("refresh bypasses cache and returns new value", async () => {
      let callCount = 0;
      const values = ["first-value", "second-value"];

      const registry = new SecretsRegistry();
      const mockProvider: SecretProvider = {
        name: "kaizen",
        get: async () => values[callCount++] ?? "end",
      };
      registry.register(mockProvider);

      const ref: SecretRef = "my-ref";
      const ctx = createSecretsContext(registry, "my-plugin", { api_key: ref });

      // First call
      const first = await ctx.get("api_key");
      expect(first).toBe("first-value");
      expect(callCount).toBe(1);

      // Second call should use cache
      const cached = await ctx.get("api_key");
      expect(cached).toBe("first-value");
      expect(callCount).toBe(1);

      // Refresh should bypass cache
      const refreshed = await ctx.refresh("api_key");
      expect(refreshed).toBe("second-value");
      expect(callCount).toBe(2);
    });

    test("refresh for undeclared secret always does live lookup", async () => {
      let callCount = 0;
      const values = ["first-value", "second-value", "third-value"];

      const registry = new SecretsRegistry();
      const mockProvider: SecretProvider = {
        name: "kaizen",
        get: async () => values[callCount++] ?? "end",
      };
      registry.register(mockProvider);

      const ctx = createSecretsContext(registry, "my-plugin", {});

      // First get (undeclared, so no caching)
      const first = await ctx.get("runtime-key");
      expect(first).toBe("first-value");
      expect(callCount).toBe(1);

      // Second get (undeclared, so no caching)
      const second = await ctx.get("runtime-key");
      expect(second).toBe("second-value");
      expect(callCount).toBe(2);

      // Refresh (no difference for undeclared)
      const refreshed = await ctx.refresh("runtime-key");
      expect(refreshed).toBe("third-value");
      expect(callCount).toBe(3);
    });
  });

  // ============================================================================
  // Test 9: Four-layer merge precedence
  // ============================================================================

  describe("Test 9: Four-layer merge precedence", () => {
    test("merge precedence: plugin < global < harness (shallow)", () => {
      const declaration: PluginConfigDeclaration = {
        defaults: {
          timeout: 1000,
          base_url: "https://default.example.com",
          retry: { max: 3, delay: 100 },
        },
      };
      const global = { timeout: 2000 };
      const harness = { timeout: 3000, retry: { max: 5 } };

      const merged = mergePluginConfig(declaration, global, harness);

      expect(merged.timeout).toBe(3000);
      expect(merged.base_url).toBe("https://default.example.com");
      expect((merged.retry as Record<string, unknown>).max).toBe(5);
      expect((merged.retry as Record<string, unknown>).delay).toBeUndefined();
    });

    test("merge with undeclared defaults", () => {
      const declaration: PluginConfigDeclaration = {
        defaults: { timeout: 1000 },
      };
      const global = { base_url: "https://global.example.com" };
      const harness = { retries: 5 };

      const merged = mergePluginConfig(declaration, global, harness);

      expect(merged).toEqual({
        timeout: 1000,
        base_url: "https://global.example.com",
        retries: 5,
      });
    });

    test("merge with empty layers", () => {
      const declaration: PluginConfigDeclaration = {};
      const global = {};
      const harness = { timeout: 3000 };

      const merged = mergePluginConfig(declaration, global, harness);

      expect(merged).toEqual({ timeout: 3000 });
    });
  });

  // ============================================================================
  // Test 10: Integration - full config flow
  // ============================================================================

  describe("Test 10: Full config flow integration", () => {
    test("complete flow: merge, separate, validate, resolve", async () => {
      // 1. Declare a plugin's configuration
      const declaration: PluginConfigDeclaration = {
        schema: {
          properties: {
            timeout_ms: { type: "number" },
            model: { type: "string" },
            api_key: { type: "string" },
          },
          required: ["timeout_ms", "model"],
        },
        defaults: {
          timeout_ms: 5000,
          model: "gpt-4",
          api_key: "default:key",
        },
        secrets: ["api_key"],
      };

      // 2. Merge from multiple sources
      const globalDefaults = { timeout_ms: 10000 };
      const harnessConfig = {
        model: "gpt-4-turbo",
        api_key: { provider: "my-provider", ref: "prod-key" } as StructuredSecretRef,
      };

      const merged = mergePluginConfig(declaration, globalDefaults, harnessConfig);
      expect(merged).toEqual({
        timeout_ms: 10000,
        model: "gpt-4-turbo",
        api_key: { provider: "my-provider", ref: "prod-key" },
      });

      // 3. Separate secrets from config
      const { config, secretRefs } = separateSecrets(merged, declaration.secrets!);
      expect(config).toEqual({
        timeout_ms: 10000,
        model: "gpt-4-turbo",
      });
      expect(secretRefs).toEqual({
        api_key: { provider: "my-provider", ref: "prod-key" },
      });

      // 4. Validate non-secret config at install time
      const nonSecretSchema = {
        properties: { timeout_ms: { type: "number" }, model: { type: "string" } },
        required: ["timeout_ms", "model"],
      };
      const errors = validateConfig(nonSecretSchema, config);
      expect(errors).toHaveLength(0);

      // 5. At load time, resolve secrets
      const registry = new SecretsRegistry();
      const mockProvider: SecretProvider = {
        name: "my-provider",
        get: async (ref: string) => {
          // ref comes in as just the ref part (e.g. "prod-key")
          if (ref === "prod-key") return "secret-prod-key";
          return `secret-${ref}`;
        },
      };
      registry.register(mockProvider);

      // Also register the default provider in case there are undeclared secrets
      const defaultProvider: SecretProvider = {
        name: "kaizen",
        get: async (ref: string) => `default-${ref}`,
      };
      registry.register(defaultProvider);

      const ctx = createSecretsContext(registry, "test-plugin", secretRefs);
      const apiKey = await ctx.get("api_key");
      expect(apiKey).toBe("secret-prod-key");
    });

    test("complete flow with env overrides at runtime", async () => {
      const declaration: PluginConfigDeclaration = {
        schema: {
          properties: {
            timeout_ms: { type: "number" },
            api_key: { type: "string" },
          },
        },
        defaults: {
          timeout_ms: 5000,
          api_key: "default:key",
        },
        secrets: ["api_key"],
      };

      let originalEnv: string | undefined;

      try {
        originalEnv = process.env.KAIZEN_MY_PLUGIN_TIMEOUT_MS;
        process.env.KAIZEN_MY_PLUGIN_TIMEOUT_MS = "20000";

        const merged = mergePluginConfig(declaration, {}, {});
        const { config, secretRefs } = separateSecrets(merged, declaration.secrets!);

        // Apply env overrides to non-secret config
        applyEnvOverrides("my-plugin", config, declaration.schema);
        expect(config.timeout_ms).toBe(20000);

        // Verify secret is still unresolved
        expect(secretRefs.api_key).toBe("default:key");
      } finally {
        if (originalEnv === undefined) {
          delete process.env.KAIZEN_MY_PLUGIN_TIMEOUT_MS;
        } else {
          process.env.KAIZEN_MY_PLUGIN_TIMEOUT_MS = originalEnv;
        }
      }
    });
  });

  // ============================================================================
  // Test 11: Error handling - invalid secret references
  // ============================================================================

  describe("Test 11: Error handling - invalid secret references", () => {
    test("separateSecrets rejects invalid structured refs", () => {
      const merged = {
        api_key: { provider: "kaizen" }, // missing 'ref'
      };

      expect(() => {
        separateSecrets(merged, ["api_key"]);
      }).toThrow(/invalid secret reference/i);
    });

    test("separateSecrets accepts string refs", () => {
      const merged = { api_key: "kaizen:my-key" };
      const { secretRefs } = separateSecrets(merged, ["api_key"]);
      expect(secretRefs.api_key).toBe("kaizen:my-key");
    });

    test("resolve throws when provider not registered", async () => {
      const registry = new SecretsRegistry();
      const ref: SecretRef = { provider: "nonexistent", ref: "key" } as StructuredSecretRef;

      try {
        await registry.resolve("plugin", "field", ref);
        throw new Error("should have thrown");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toMatch(/no secret provider.*nonexistent/i);
      }
    });
  });

  // ============================================================================
  // Test 12: Provider registration - duplicates and isolation
  // ============================================================================

  describe("Test 12: Provider registration", () => {
    test("duplicate provider registration throws", () => {
      const registry = new SecretsRegistry();
      const provider: SecretProvider = {
        name: "kaizen",
        get: async () => "test",
      };

      registry.register(provider);

      expect(() => {
        registry.register(provider);
      }).toThrow(/already registered/i);
    });

    test("multiple registries are isolated", () => {
      const registry1 = new SecretsRegistry();
      const registry2 = new SecretsRegistry();

      const provider: SecretProvider = {
        name: "test",
        get: async () => "test",
      };

      registry1.register(provider);
      expect(registry2.getProvider("test")).toBeUndefined();
    });
  });

  // ============================================================================
  // Test 13: Convention env var precedence over declared ref
  // ============================================================================

  describe("Test 13: Convention env var precedence", () => {
    let envKey: string;

    beforeEach(() => {
      envKey = "KAIZEN_TEST_PLUGIN_API_KEY";
    });

    afterEach(() => {
      delete process.env[envKey];
    });

    test("KAIZEN_<PLUGIN>_<KEY> convention beats declared ref", async () => {
      const registry = new SecretsRegistry();
      const mockProvider: SecretProvider = {
        name: "kaizen",
        get: async () => "from-provider",
      };
      registry.register(mockProvider);

      process.env[envKey] = "from-convention-env";

      const ref: SecretRef = "default-ref";
      const result = await registry.resolve("test-plugin", "api_key", ref);

      expect(result).toBe("from-convention-env");
    });

    test("precedence order: envOverride > convention > provider", async () => {
      const registry = new SecretsRegistry();
      const mockProvider: SecretProvider = {
        name: "kaizen",
        get: async () => "from-provider",
      };
      registry.register(mockProvider);

      const overrideEnvKey = "CUSTOM_API_KEY";
      process.env[overrideEnvKey] = "from-override";
      process.env[envKey] = "from-convention";

      const ref: SecretRef = {
        provider: "kaizen",
        ref: "default-ref",
        envOverride: overrideEnvKey,
      } as StructuredSecretRef;

      const result = await registry.resolve("test-plugin", "api_key", ref);
      expect(result).toBe("from-override");

      delete process.env[overrideEnvKey];
    });
  });
});
