import { existsSync } from "fs";
import { join } from "path";

export interface WarnSink {
  warn: (message: string) => void;
}

const PROJECT_LOCAL = join(".kaizen", "kaizen.json");
const LEGACY_ROOT = "kaizen.json";

const MESSAGE = (path: string) =>
  `Found '${path}'. Project-level kaizen config is no longer supported. ` +
  `Move 'extends' to '~/.kaizen/kaizen.json' as 'defaults.harness', ` +
  `or pass --harness explicitly. See docs/concepts/configuration.md.`;

export function warnStaleProjectConfig(sink: WarnSink): void {
  if (existsSync(PROJECT_LOCAL)) sink.warn(MESSAGE(PROJECT_LOCAL));
  if (existsSync(LEGACY_ROOT)) sink.warn(MESSAGE(LEGACY_ROOT));
}
