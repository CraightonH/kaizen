import { AsyncLocalStorage } from "async_hooks";

const als = new AsyncLocalStorage<string>();

/** Runs `fn` with `pluginName` as the current plugin in scope. */
export async function runInPluginScope<T>(pluginName: string, fn: () => Promise<T>): Promise<T> {
  return als.run(pluginName, fn);
}

/** Synchronous variant (for event handlers that return synchronously). */
export function runInPluginScopeSync<T>(pluginName: string, fn: () => T): T {
  return als.run(pluginName, fn);
}

/** Returns the plugin name in scope, or undefined if called outside any plugin scope. */
export function getCurrentPlugin(): string | undefined {
  return als.getStore();
}

export function hasPluginScope(): boolean {
  return als.getStore() !== undefined;
}
