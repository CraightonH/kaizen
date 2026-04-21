import { readFile, writeFile, readdir, stat } from "fs/promises";
import type { Stats } from "fs";
import { spawn } from "child_process";
import type { PermissionEnforcer } from "./permission-enforcer.js";

export interface CtxFs {
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  write(path: string, data: Uint8Array | string): Promise<void>;
  list(path: string): Promise<string[]>;
  stat(path: string): Promise<Stats>;
}

export interface CtxNet {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface ExecOpts {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CtxExec {
  run(binary: string, args: string[], opts?: ExecOpts): Promise<ExecResult>;
}

export interface CtxIo {
  fs: CtxFs;
  net: CtxNet;
  exec: CtxExec;
}

export function createCtxIo(plugin: string, enforcer: PermissionEnforcer): CtxIo {
  return {
    fs: {
      async read(path)     { enforcer.check(plugin, { kind: "fs.read",  path }); return new Uint8Array(await readFile(path)); },
      async readText(path) { enforcer.check(plugin, { kind: "fs.read",  path }); return await readFile(path, "utf8"); },
      async write(path, data) { enforcer.check(plugin, { kind: "fs.write", path }); await writeFile(path, data); },
      async list(path)     { enforcer.check(plugin, { kind: "fs.read",  path }); return await readdir(path); },
      async stat(path)     { enforcer.check(plugin, { kind: "fs.read",  path }); return await stat(path); },
    },

    net: {
      async fetch(url, init) {
        const u = new URL(url);
        const port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
        enforcer.check(plugin, { kind: "net.connect", host: u.hostname, port });
        return await fetch(url, init);
      },
    },

    exec: {
      async run(binary, args, opts = {}) {
        enforcer.check(plugin, { kind: "exec.run", binary });
        return await new Promise<ExecResult>((resolve, reject) => {
          const proc = spawn(binary, args, { cwd: opts.cwd });
          let stdout = "", stderr = "";
          proc.stdout.on("data", (c) => { stdout += c.toString(); });
          proc.stderr.on("data", (c) => { stderr += c.toString(); });
          proc.on("error", reject);
          proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
          if (opts.input !== undefined) { proc.stdin.write(opts.input); proc.stdin.end(); }
          if (opts.timeoutMs) setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs);
        });
      },
    },
  };
}
