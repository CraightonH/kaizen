import { test, expect, describe, afterEach } from "bun:test";
import { mergePluginConfig, separateSecrets, applyEnvOverrides, envVarNameFor } from "./config-merge";

describe("mergePluginConfig", () => {
  test("mergePluginConfig: user global wins over harness default", () => {
    const declaration = { defaults: { base_url: "https://gitlab.com", timeout: 30 } };
    const userPluginConfig = { base_url: "https://gitlab.mycompany.com" };
    const harnessConfig = { base_url: "https://harness.example.com" };

    const merged = mergePluginConfig(declaration, userPluginConfig, harnessConfig);

    expect(merged).toEqual({
      base_url: "https://gitlab.mycompany.com", // user wins
      timeout: 30,                              // declaration fallback preserved
    });
  });

  test("mergePluginConfig: harness wins over plugin declaration defaults", () => {
    const declaration = { defaults: { base_url: "plugin-default" } };
    const userPluginConfig = {};
    const harnessConfig = { base_url: "harness-default" };

    const merged = mergePluginConfig(declaration, userPluginConfig, harnessConfig);

    expect(merged.base_url).toBe("harness-default");
  });

  test("plugin defaults < harness config < user config (right wins)", () => {
    const declaration = {
      defaults: { timeout: 5000, retries: 2 },
    };
    const userPluginConfig = { timeout: 10000 };
    const harnessConfig = { retries: 5 };

    const result = mergePluginConfig(declaration, userPluginConfig, harnessConfig);

    expect(result).toEqual({
      timeout: 10000,
      retries: 5,
    });
  });

  test("shallow replace: harness config replaces entire nested objects", () => {
    const declaration = {
      defaults: {
        retry: { max: 3, delay: 100 },
      },
    };
    const globalDefaults = {};
    const harnessConfig = {
      retry: { max: 5 },
    };

    const result = mergePluginConfig(declaration, globalDefaults, harnessConfig);

    expect(result).toEqual({
      retry: { max: 5 },
    });
    expect((result.retry as Record<string, unknown>).delay).toBeUndefined();
  });

  test("undefined declaration defaults to empty object", () => {
    const userPluginConfig = { timeout: 5000 };
    const harnessConfig = { retries: 3 };

    const result = mergePluginConfig(undefined, userPluginConfig, harnessConfig);

    expect(result).toEqual({
      timeout: 5000,
      retries: 3,
    });
  });

  test("all empty configs returns empty object", () => {
    const result = mergePluginConfig(undefined, {}, {});
    expect(result).toEqual({});
  });
});

describe("separateSecrets", () => {
  test("bare string refs become SecretRef; structured refs pass through", () => {
    const merged = {
      apiKey: "my-key",
      database: {
        provider: "vault",
        ref: "secret/db",
        envOverride: "DB_PASSWORD",
      },
      timeout: 5000,
    };
    const secretKeys = ["apiKey", "database"];

    const { config, secretRefs } = separateSecrets(merged, secretKeys);

    expect(config).toEqual({ timeout: 5000 });
    expect(secretRefs).toEqual({
      apiKey: "my-key",
      database: {
        provider: "vault",
        ref: "secret/db",
        envOverride: "DB_PASSWORD",
      },
    });
  });

  test("non-secrets stay in config", () => {
    const merged = {
      timeout: 5000,
      maxRetries: 3,
    };
    const secretKeys: string[] = [];

    const { config, secretRefs } = separateSecrets(merged, secretKeys);

    expect(config).toEqual({
      timeout: 5000,
      maxRetries: 3,
    });
    expect(secretRefs).toEqual({});
  });

  test("throws on malformed ref (number value for secret key)", () => {
    const merged = {
      apiKey: 12345,
    };
    const secretKeys = ["apiKey"];

    expect(() => separateSecrets(merged, secretKeys)).toThrow(
      /Invalid secret reference for key "apiKey"/,
    );
  });

  test("throws on malformed ref (object missing required fields)", () => {
    const merged = {
      apiKey: { provider: "vault" },
    };
    const secretKeys = ["apiKey"];

    expect(() => separateSecrets(merged, secretKeys)).toThrow(
      /Invalid secret reference for key "apiKey"/,
    );
  });

  test("missing declared secret key is not included in secretRefs", () => {
    const merged = {
      timeout: 5000,
    };
    const secretKeys = ["apiKey", "dbPassword"];

    const { config, secretRefs } = separateSecrets(merged, secretKeys);

    expect(config).toEqual({ timeout: 5000 });
    expect(secretRefs).toEqual({});
  });

  test("structured ref with envOverride is preserved", () => {
    const merged = {
      secret: {
        provider: "vault",
        ref: "secret/my-secret",
        envOverride: "MY_SECRET_ENV",
      },
    };
    const secretKeys = ["secret"];

    const { secretRefs } = separateSecrets(merged, secretKeys);

    expect(secretRefs.secret).toEqual({
      provider: "vault",
      ref: "secret/my-secret",
      envOverride: "MY_SECRET_ENV",
    });
  });
});

describe("applyEnvOverrides", () => {
  afterEach(() => {
    delete process.env.KAIZEN_MY_PLUGIN_TIMEOUT;
    delete process.env.KAIZEN_MY_PLUGIN_RETRIES;
    delete process.env.KAIZEN_MY_PLUGIN_DEBUG;
    delete process.env.KAIZEN_MY_PLUGIN_ENDPOINT;
  });

  test("env var coerces number from string", () => {
    process.env.KAIZEN_MY_PLUGIN_TIMEOUT = "30000";
    const config = { timeout: 5000 };
    const schema = {
      properties: {
        timeout: { type: "number" },
      },
    };

    applyEnvOverrides("my-plugin", config, schema);

    expect(config.timeout).toBe(30000);
  });

  test("env var coerces boolean from string", () => {
    process.env.KAIZEN_MY_PLUGIN_DEBUG = "true";
    const config = { debug: false };
    const schema = {
      properties: {
        debug: { type: "boolean" },
      },
    };

    applyEnvOverrides("my-plugin", config, schema);

    expect(config.debug).toBe(true);
  });

  test("env var coerces boolean false from string", () => {
    process.env.KAIZEN_MY_PLUGIN_DEBUG = "false";
    const config = { debug: true };
    const schema = {
      properties: {
        debug: { type: "boolean" },
      },
    };

    applyEnvOverrides("my-plugin", config, schema);

    expect(config.debug).toBe(false);
  });

  test("string value passes through unchanged", () => {
    process.env.KAIZEN_MY_PLUGIN_ENDPOINT = "https://api.example.com";
    const config = { endpoint: "https://default.com" };
    const schema = {
      properties: {
        endpoint: { type: "string" },
      },
    };

    applyEnvOverrides("my-plugin", config, schema);

    expect(config.endpoint).toBe("https://api.example.com");
  });

  test("no-op if env var not set", () => {
    const config = { timeout: 5000, debug: false };
    const schema = {
      properties: {
        timeout: { type: "number" },
        debug: { type: "boolean" },
      },
    };

    applyEnvOverrides("my-plugin", config, schema);

    expect(config.timeout).toBe(5000);
    expect(config.debug).toBe(false);
  });

  test("handles undefined schema gracefully", () => {
    process.env.KAIZEN_MY_PLUGIN_TIMEOUT = "10000";
    const config = { timeout: 5000 };

    applyEnvOverrides("my-plugin", config, undefined);

    expect((config as Record<string, unknown>).timeout).toBe("10000");
  });

  test("coerces multiple keys simultaneously", () => {
    process.env.KAIZEN_MY_PLUGIN_TIMEOUT = "30000";
    process.env.KAIZEN_MY_PLUGIN_RETRIES = "5";
    const config = { timeout: 5000, retries: 3, endpoint: "https://default.com" };
    const schema = {
      properties: {
        timeout: { type: "number" },
        retries: { type: "number" },
        endpoint: { type: "string" },
      },
    };

    applyEnvOverrides("my-plugin", config, schema);

    expect(config.timeout).toBe(30000);
    expect(config.retries).toBe(5);
    expect(config.endpoint).toBe("https://default.com");

    delete process.env.KAIZEN_MY_PLUGIN_RETRIES;
  });
});

describe("envVarNameFor", () => {
  test("plugin name with hyphens and key with underscores", () => {
    const result = envVarNameFor("my-plugin", "api_key");
    expect(result).toBe("KAIZEN_MY_PLUGIN_API_KEY");
  });

  test("stripe-billing and api_key", () => {
    const result = envVarNameFor("stripe-billing", "api_key");
    expect(result).toBe("KAIZEN_STRIPE_BILLING_API_KEY");
  });

  test("converts dots and special chars to underscores", () => {
    const result = envVarNameFor("core.events", "db.host");
    expect(result).toBe("KAIZEN_CORE_EVENTS_DB_HOST");
  });

  test("lowercase input is uppercased", () => {
    const result = envVarNameFor("myplugin", "timeout");
    expect(result).toBe("KAIZEN_MYPLUGIN_TIMEOUT");
  });

  test("mixed case is preserved then uppercased", () => {
    const result = envVarNameFor("MyPlugin", "TimeOut");
    expect(result).toBe("KAIZEN_MYPLUGIN_TIMEOUT");
  });
});
