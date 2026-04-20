import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { SecretProvider } from "../../src/core/secret-providers/types.js";

const credentialsPath = join(homedir(), ".kaizen", ".credentials.json");

function readCredentials(): Record<string, string> {
  if (!existsSync(credentialsPath)) return {};
  try {
    return JSON.parse(readFileSync(credentialsPath, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeCredentials(data: Record<string, string>): void {
  const dir = join(homedir(), ".kaizen");
  mkdirSync(dir, { recursive: true });
  const content = JSON.stringify(data, null, 2);
  writeFileSync(credentialsPath, content, { encoding: "utf8" });
  chmodSync(credentialsPath, 0o600);
}

export const fileProvider: SecretProvider = {
  name: "kaizen",

  async get(ref: string): Promise<string | undefined> {
    return readCredentials()[ref];
  },

  async set(ref: string, value: string): Promise<void> {
    const data = readCredentials();
    data[ref] = value;
    writeCredentials(data);
  },

  async prefetch(_refs: string[]): Promise<void> {
    // Pre-load JSON once — readCredentials caches nothing, just reads on demand.
    // No-op for now; file reads are cheap.
  },
};
