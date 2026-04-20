import { runInstall } from "./install.js";
import { readLockfile, removePluginEntry, writeLockfile } from "../core/lockfile.js";

export interface InstallArgs {
  pluginName: string;
  lockfilePath: string;
  allowUnscoped: boolean;
  nonInteractive: boolean;
}

/**
 * Force re-consent for a plugin. Removes any existing lockfile entry, then
 * runs the install flow, which prompts the user (if interactive) or refuses
 * (if not and not TRUSTED).
 */
export async function runPluginConsent(args: InstallArgs): Promise<number> {
  const lf = readLockfile(args.lockfilePath);
  if (lf.plugins[args.pluginName]) {
    writeLockfile(args.lockfilePath, removePluginEntry(lf, args.pluginName));
  }
  return runInstall(args);
}
