import { execSync } from "child_process";

export type SecretBackend = "macos" | "windows" | "linux" | "file";

export function detectBackend(): SecretBackend {
  // Honor explicit override
  if (process.env["KAIZEN_SECRETS_BACKEND"] === "file") return "file";

  const platform = process.platform;
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") {
    // Check if secret-tool is available
    try {
      execSync("which secret-tool", { stdio: "ignore" });
      return "linux";
    } catch {
      return "file";
    }
  }
  return "file";
}
