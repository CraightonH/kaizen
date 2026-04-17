export class KaizenError extends Error {
  constructor(
    message: string,
    public readonly fatal: boolean = true,
  ) {
    super(message);
    this.name = "KaizenError";
  }
}

export function fatal(message: string): never {
  throw new KaizenError(message, true);
}

export function warn(message: string): void {
  console.error(`[kaizen] warn: ${message}`);
}

export function debug(message: string): void {
  if (process.env["KAIZEN_DEBUG"]) {
    console.error(`[kaizen] debug: ${message}`);
  }
}

export class PermissionError extends KaizenError {
  constructor(
    public readonly pluginName: string,
    public readonly op: string,
    public readonly detail: string,
  ) {
    super(
      `Permission denied: plugin '${pluginName}' attempted ${op} (${detail}). ` +
      `Declare this in the plugin's permissions manifest, or escalate to a higher tier.`,
      false,
    );
    this.name = "PermissionError";
  }
}
