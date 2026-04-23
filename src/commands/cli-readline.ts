/**
 * Line reader for CLI commands that run as the kaizen binary itself
 * (install consent prompts, scaffolding wizards). Plugin code must NOT
 * use this — it is not part of the plugin host API. A plugin that
 * needs stdin input should own its own readline interface and expose
 * it as a service.
 */
import { createInterface } from "readline";

const rl = createInterface({ input: process.stdin, terminal: false });
const waiting: Array<(line: string) => void> = [];
const buffered: string[] = [];

rl.on("line", (line) => {
  const resolve = waiting.shift();
  if (resolve) resolve(line);
  else buffered.push(line);
});

rl.on("close", () => {
  for (const resolve of waiting) resolve("");
  waiting.length = 0;
});

export function readStdinLine(): Promise<string> {
  return new Promise((resolve) => {
    const line = buffered.shift();
    if (line !== undefined) resolve(line);
    else waiting.push(resolve);
  });
}
