# Secret Providers for Plugin Authors

*Read when: you are writing a plugin that provides custom secret storage
or management (e.g., Vault, Doppler, AWS Secrets Manager).*

## Overview

A secret provider is a plugin that implements the `SecretProvider` interface
and makes it available to other plugins via the Service Registry. Secret providers
abstract the storage backend — vault, environment variables, cloud services, or
custom encrypted files.

## When to write a secret provider

Write a secret provider when:
- Your harness uses an external secret store (Vault, Doppler, AWS Secrets Manager)
- You want to offer a custom credential rotation mechanism
- You need encryption and key management beyond OS keystores
- You're building a compliance-heavy system needing audit trails

For simple cases, the default OS keychain provider (macOS Keychain, Windows
Credential Manager, Linux libsecret) is sufficient.

## The `SecretProvider` interface

```typescript
interface SecretProvider {
  readonly name: string;
  
  async get(ref: string): Promise<string>;
  
  async set?(ref: string, value: string): Promise<void>;
  
  async prefetch?(refs: string[]): Promise<Map<string, string>>;
}
```

### `name` — provider identifier

A stable identifier used in harness config (e.g., `"vault"`, `"doppler"`).
Must match the name declared in your `provides[]`.

### `get(ref): Promise<string>`

Fetch a secret. `ref` is the provider-specific reference string.

- **Vault example:** `ref = "secret/data/my-app/api-key"`
- **Doppler example:** `ref = "API_KEY"` (env var name)
- **AWS example:** `ref = "my-app/prod/api-key"` (secret name)

Throw if the secret is not found or access is denied. The exception message
is logged but not sent to the LLM.

### `set?(ref, value): Promise<void>` (optional)

Write a secret. Implementing this allows `kaizen config set-secret` to work
with your provider. Omit if your provider is read-only.

Throw if the operation fails.

### `prefetch?(refs): Promise<Map<string, string>>` (optional)

Batch-fetch secrets. Called when core initializes plugins. Returning a map
of `ref → value` allows you to optimize repeated calls (e.g., fetch once,
cache locally, or batch API requests).

Omit if not needed. Core falls back to individual `get()` calls.

## Declaring a secret provider

In your plugin, declare `provides: [{ kind: "core-secrets:provider", name: "your-name" }]`:

```typescript
import type { KaizenPlugin, SecretProvider } from "kaizen/types";

const myProvider: SecretProvider = {
  name: "doppler",
  async get(ref) {
    const token = process.env.DOPPLER_TOKEN;
    if (!token) throw new Error("DOPPLER_TOKEN not set");
    
    const response = await fetch(
      `https://api.doppler.com/v3/configs/config/secrets/get?name=${encodeURIComponent(ref)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      throw new Error(`Doppler API error: ${response.statusText}`);
    }
    const data = await response.json();
    return data.secret.value;
  },

  async set(ref, value) {
    // Doppler doesn't support direct writes via API; throw
    throw new Error("set() not supported by Doppler provider");
  },
};

const plugin: KaizenPlugin = {
  name: "core-secrets-doppler",
  apiVersion: "1.0.0",
  services: { provides: ["core-secrets:provider"] },
  async setup(ctx) {
    ctx.defineService("core-secrets:provider", { description: "Doppler secrets provider" });
    ctx.provideService("core-secrets:provider", myProvider);
    ctx.log("Doppler secrets provider loaded");
  },
};

export default plugin;
```

## Using a secret provider in harness config

Once registered, reference the provider in `kaizen.json`:

```json
{
  "my-api": {
    "api_key": {
      "provider": "doppler",
      "ref": "MY_API_KEY"
    },
    "timeout_ms": 5000
  }
}
```

When `ctx.secrets.get("api_key")` is called, core routes to the `doppler`
provider's `get("MY_API_KEY")` method.

## Minimal worked example

Here's a complete in-memory secret provider for testing:

```typescript
import type { KaizenPlugin } from "kaizen/types";
import { SecretsProviderToken, type SecretProvider } from "kaizen/core-secrets";

const testProvider: SecretProvider = {
  name: "test",
  
  // In-memory storage
  _store: new Map<string, string>(),
  
  async get(ref) {
    const value = this._store.get(ref);
    if (!value) {
      throw new Error(`Secret not found: ${ref}`);
    }
    return value;
  },
  
  async set(ref, value) {
    this._store.set(ref, value);
  },
  
  async prefetch(refs) {
    const result = new Map<string, string>();
    for (const ref of refs) {
      try {
        result.set(ref, await this.get(ref));
      } catch {
        // Skip missing secrets; let get() throw at use time
      }
    }
    return result;
  },
};

const plugin: KaizenPlugin = {
  name: "core-secrets-test",
  apiVersion: "1.0.0",
  services: { provides: ["core-secrets:provider"] },
  async setup(ctx) {
    ctx.defineService("core-secrets:provider", { description: "test secrets provider" });
    ctx.provideService("core-secrets:provider", testProvider);
  },
};

export default plugin;
```

## Best practices

1. **Error messages are logged, not sent to LLM** — Throw detailed errors
   without worrying they'll leak secrets. Core logs them to stderr.

2. **Implement `prefetch()` if possible** — Batch requests at initialization
   to reduce latency during plugin setup.

3. **Validate `ref` format early** — Throw with a clear message if `ref` is
   malformed for your provider.

4. **Use `ctx.log()` sparingly** — Log at startup and on errors, not per
   `get()` call (can be noisy).

5. **Handle expiry and refresh** — If your provider has token TTLs, refresh
   them in `prefetch()` and consider periodic refresh if appropriate.

6. **Document your `ref` format** — Users need to know what to put in
   `"ref": "..."`. Include examples in your plugin's README.

## See also

- `docs/plugin-api.md` — Plugin authoring guide (config section)
- `kaizen.json` — Harness config schema
