/**
 * Shared stdin line reader.
 *
 * A single readline interface for the process. Sequential callers each get
 * the next line in order — no race, no buffering loss. Both core-ui-terminal
 * and core-executor-debug import readStdinLine() from here so they share
 * the same queue rather than fighting over separate readline instances.
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
  // Drain any pending readers with empty string so they don't hang
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

export function stdinClosed(): Promise<void> {
  return new Promise((resolve) => rl.once("close", resolve));
}
