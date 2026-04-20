import { execSync } from "child_process";
import type { SecretProvider } from "../../src/core/secret-providers/types.js";

export const linuxProvider: SecretProvider = {
  name: "kaizen",

  async get(ref: string): Promise<string | undefined> {
    try {
      const result = execSync(
        `secret-tool lookup service kaizen account ${ref}`,
        { stdio: ["ignore", "pipe", "ignore"] },
      ).toString().trim();
      return result || undefined;
    } catch {
      return undefined;
    }
  },

  async set(ref: string, value: string): Promise<void> {
    execSync(
      `echo -n '${value}' | secret-tool store --label='kaizen:${ref}' service kaizen account ${ref}`,
      { stdio: "pipe" },
    );
  },

  async prefetch(_refs: string[]): Promise<void> {
    // No-op.
  },
};
