import type { KaizenPlugin } from "../../src/types/plugin.js";
import { SecretsProviderToken } from "../../src/core/secrets.js";
import { detectBackend } from "./detect.js";
import { fileProvider } from "./file-fallback.js";
import { macosProvider } from "./keychain-macos.js";
import { windowsProvider } from "./keychain-windows.js";
import { linuxProvider } from "./keychain-linux.js";
import type { SecretProvider } from "../../src/core/secret-providers/types.js";

function pickBackend(backend: ReturnType<typeof detectBackend>): SecretProvider {
  switch (backend) {
    case "macos": return macosProvider;
    case "windows": return windowsProvider;
    case "linux": return linuxProvider;
    default: return fileProvider;
  }
}

const plugin: KaizenPlugin = {
  name: "core-secrets",
  apiVersion: "2.0.0",
  permissions: { tier: "trusted" },
  capabilities: {
    provides: ["core-secrets:provider"],
  },

  async setup(ctx) {
    const backend = detectBackend();
    const provider = pickBackend(backend);
    ctx.log(`using backend: ${backend}`);
    ctx.registerService(SecretsProviderToken, provider);
  },
};

export default plugin;
