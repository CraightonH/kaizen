import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import type { CheckRecord } from "./permission-enforcer.js";

export class ObserveRecorder {
  private readonly _path: string;
  private buffer: string[] = [];

  constructor(rootDir: string, sessionId: string) {
    mkdirSync(rootDir, { recursive: true });
    this._path = join(rootDir, `observe-${sessionId}.jsonl`);
  }

  record(r: CheckRecord): void {
    this.buffer.push(JSON.stringify(r));
    if (this.buffer.length >= 32) this.flushSync();
  }

  flushSync(): void {
    if (this.buffer.length === 0) return;
    appendFileSync(this._path, this.buffer.join("\n") + "\n");
    this.buffer = [];
  }

  path_(): string { return this._path; }
}
