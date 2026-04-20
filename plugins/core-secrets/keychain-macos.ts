import { execSync } from "child_process";
import type { SecretProvider } from "../../src/core/secret-providers/types.js";

const SERVICE = "kaizen";

export const macosProvider: SecretProvider = {
  name: "kaizen",

  async get(ref: string): Promise<string | undefined> {
    try {
      const result = execSync(
        `security find-generic-password -s ${SERVICE} -a ${ref} -w`,
        { stdio: ["ignore", "pipe", "ignore"] },
      ).toString().trim();
      return result || undefined;
    } catch {
      return undefined;
    }
  },

  async set(ref: string, value: string): Promise<void> {
    // Delete existing if present, then add
    try {
      execSync(`security delete-generic-password -s ${SERVICE} -a ${ref}`, { stdio: "ignore" });
    } catch { /* not found — ok */ }
    execSync(`security add-generic-password -s ${SERVICE} -a ${ref} -w ${value}`, { stdio: "ignore" });
  },

  async prefetch(_refs: string[]): Promise<void> {
    // Keychain reads are cheap; no-op.
  },
};
