import type { PluginPermissions } from "../types/plugin.js";

export interface UacInput {
  pluginName: string;
  version: string;
  source: string;
  permissions: PluginPermissions;
}

export function renderScopedUAC(input: UacInput): string {
  const p = input.permissions;
  const lines: string[] = [];
  lines.push("┌────────────────────────────────────────────────────────────────────┐");
  lines.push(`│  Install: ${input.pluginName}@${input.version}`);
  lines.push("│");
  lines.push("│  Tier: SCOPED — kaizen will enforce the permissions below.");
  lines.push("│");
  lines.push("│  This plugin requests:");

  const sections: string[] = [];
  if (p.fs?.read?.length) sections.push(`Filesystem read:\n${listBullets(p.fs.read)}`);
  if (p.fs?.write?.length) sections.push(`Filesystem write:\n${listBullets(p.fs.write)}`);
  if (p.net?.connect?.length) sections.push(`Network access:\n${listBullets(p.net.connect)}`);
  if (p.env?.length) sections.push(`Environment variables:\n${listBullets(p.env)}`);
  if (p.exec?.binaries?.length) sections.push(`Command execution (binaries):\n${listBullets(p.exec.binaries)}`);
  if (p.events?.subscribe?.length) sections.push(`Event subscriptions (from other plugins):\n${listBullets(p.events.subscribe)}`);

  if (sections.length === 0) {
    lines.push("│    (none)");
  } else {
    for (const s of sections) {
      for (const line of s.split("\n")) lines.push(`│    ${line}`);
      lines.push("│");
    }
  }

  if (input.source) lines.push(`│  Source: ${input.source}`);
  lines.push(`│  Verify: kaizen plugin review ${input.pluginName}`);
  lines.push("│");
  lines.push("│  [a]ccept   [r]eject   [i]nspect source");
  lines.push("└────────────────────────────────────────────────────────────────────┘");
  return lines.join("\n");
}

export function renderUnscopedUAC(input: UacInput): string {
  const lines: string[] = [];
  lines.push("╔════════════════════════════════════════════════════════════════════╗");
  lines.push(`║  Install: ${input.pluginName}@${input.version}`);
  lines.push("║");
  lines.push("║  Tier: UNSCOPED — this plugin has NOT declared what it needs.");
  lines.push("║");
  lines.push("║  Accepting installs it with full system access:");
  lines.push("║    filesystem, network, environment variables, command execution,");
  lines.push("║    all other plugins' events, and anything else Node.js can reach.");
  lines.push("║");
  lines.push("║  Kaizen cannot enforce any limits on an UNSCOPED plugin.");
  lines.push("║");
  if (input.source) lines.push(`║  Source: ${input.source}`);
  lines.push(`║  Verify: kaizen plugin review ${input.pluginName}`);
  lines.push("║");
  lines.push("║  Type the plugin name to confirm: _");
  lines.push("╚════════════════════════════════════════════════════════════════════╝");
  return lines.join("\n");
}

function listBullets(items: string[]): string {
  return items.map((i) => `  • ${i}`).join("\n");
}
