import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import type { DenialRecord } from "./permission-enforcer.js";

export interface AuditLogOpts {
  rootDir: string;           // e.g. "./.kaizen/audit"
  sessionId: string;
  enabled?: boolean;         // default true
}

export class AuditLog {
  private readonly path: string;
  private readonly enabled: boolean;
  private buffer: string[] = [];

  constructor(opts: AuditLogOpts) {
    this.enabled = opts.enabled !== false;
    if (this.enabled) mkdirSync(opts.rootDir, { recursive: true });
    this.path = join(opts.rootDir, `${opts.sessionId}.jsonl`);
  }

  record(r: DenialRecord): void {
    if (!this.enabled) return;
    this.buffer.push(JSON.stringify(r));
    if (this.buffer.length >= 32) this.flushSync();
  }

  flushSync(): void {
    if (!this.enabled || this.buffer.length === 0) return;
    appendFileSync(this.path, this.buffer.join("\n") + "\n");
    this.buffer = [];
  }

  async flush(): Promise<void> { this.flushSync(); }
}
