import { Module } from "module";
import type { PermissionEnforcer } from "./permission-enforcer.js";
import { getCurrentPlugin } from "./plugin-scope.js";

let installed = false;
let originalRequire: typeof Module.prototype.require | null = null;
let originalFetch: typeof globalThis.fetch | null = null;
let envProxy: typeof process.env | null = null;
let originalEnv: typeof process.env | null = null;

/**
 * Install process-wide sandbox hooks. MUST be called before any plugin loads.
 * Safe to call multiple times (idempotent).
 */
export function initializeSandbox(enforcer: PermissionEnforcer): void {
  if (installed) return;
  installed = true;

  // --- Patch Module.prototype.require -------------------------------------
  originalRequire = Module.prototype.require;
  const origReq = originalRequire;
  Module.prototype.require = function patchedRequire(id: string) {
    const plugin = getCurrentPlugin();
    if (plugin) enforcer.check(plugin, { kind: "import", module: id });
    return origReq.call(this, id);
  } as typeof Module.prototype.require;

  // --- Patch global fetch -------------------------------------------------
  originalFetch = globalThis.fetch;
  const origFetch = originalFetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const plugin = getCurrentPlugin();
    if (plugin) {
      try {
        const url = typeof input === "string" ? new URL(input)
          : input instanceof URL ? input
          : new URL((input as Request).url);
        const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
        enforcer.check(plugin, { kind: "net.connect", host: url.hostname, port });
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return origFetch(input, init);
  }) as typeof globalThis.fetch;

  // --- Proxy process.env --------------------------------------------------
  originalEnv = process.env;
  const origEnv = originalEnv;
  envProxy = new Proxy(origEnv, {
    get(target, prop: string | symbol) {
      if (typeof prop !== "string") return Reflect.get(target, prop);
      const plugin = getCurrentPlugin();
      if (!plugin) return target[prop];
      try {
        enforcer.check(plugin, { kind: "env.get", name: prop });
        return target[prop];
      } catch {
        return undefined;
      }
    },
    has(target, prop: string | symbol) {
      if (typeof prop !== "string") return Reflect.has(target, prop);
      const plugin = getCurrentPlugin();
      if (!plugin) return prop in target;
      try {
        enforcer.check(plugin, { kind: "env.get", name: prop });
        return prop in target;
      } catch {
        return false;
      }
    },
    ownKeys(target) {
      const plugin = getCurrentPlugin();
      if (!plugin) return Reflect.ownKeys(target);
      const keys = Reflect.ownKeys(target);
      return keys.filter((k) => {
        if (typeof k !== "string") return true;
        try { enforcer.check(plugin, { kind: "env.get", name: k }); return true; }
        catch { return false; }
      });
    },
  }) as typeof process.env;
  Object.defineProperty(process, "env", {
    configurable: true,
    get: () => envProxy!,
  });
}

/** Test-only: restore the unpatched runtime. Do NOT call from production code. */
export function resetSandboxForTesting(): void {
  if (!installed) return;
  if (originalRequire) Module.prototype.require = originalRequire;
  if (originalFetch) globalThis.fetch = originalFetch;
  if (originalEnv) {
    Object.defineProperty(process, "env", {
      configurable: true, writable: true, enumerable: true, value: originalEnv,
    });
  }
  installed = false;
  originalRequire = null;
  originalFetch = null;
  originalEnv = null;
  envProxy = null;
}
