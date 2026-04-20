import { execSync } from "child_process";
import type { SecretProvider } from "../../src/core/secret-providers/types.js";

const SERVICE = "kaizen";

export const windowsProvider: SecretProvider = {
  name: "kaizen",

  async get(ref: string): Promise<string | undefined> {
    try {
      const target = `${SERVICE}/${ref}`;
      const script = `(Get-StoredCredential -Target '${target}').Password`;
      const result = execSync(`powershell -Command "${script}"`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString().trim();
      return result || undefined;
    } catch {
      return undefined;
    }
  },

  async set(ref: string, value: string): Promise<void> {
    const target = `${SERVICE}/${ref}`;
    const script = `New-StoredCredential -Target '${target}' -Password '${value}' -Persist LocalMachine`;
    execSync(`powershell -Command "${script}"`, { stdio: "ignore" });
  },

  async prefetch(_refs: string[]): Promise<void> {
    // No-op.
  },
};
