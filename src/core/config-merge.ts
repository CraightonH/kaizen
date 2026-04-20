import type { PluginConfigDeclaration, SecretRef, StructuredSecretRef } from "../types/plugin.js";

export function mergePluginConfig(
  declaration: PluginConfigDeclaration | undefined,
  globalDefaults: Record<string, unknown>,
  harnessConfig: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(declaration?.defaults ?? {}),
    ...globalDefaults,
    ...harnessConfig,
  };
}

export function separateSecrets(
  merged: Record<string, unknown>,
  secretKeys: string[],
): { config: Record<string, unknown>; secretRefs: Record<string, SecretRef> } {
  const config: Record<string, unknown> = {};
  const secretRefs: Record<string, SecretRef> = {};

  for (const [key, value] of Object.entries(merged)) {
    if (secretKeys.includes(key)) {
      const ref = value as unknown;

      if (typeof ref === "string") {
        secretRefs[key] = ref;
      } else if (
        ref !== null &&
        typeof ref === "object" &&
        "provider" in ref &&
        "ref" in ref &&
        typeof (ref as Record<string, unknown>).provider === "string" &&
        typeof (ref as Record<string, unknown>).ref === "string"
      ) {
        secretRefs[key] = ref as StructuredSecretRef;
      } else {
        throw new Error(
          `Invalid secret reference for key "${key}": must be string or { provider: string, ref: string, envOverride?: string }`,
        );
      }
    } else {
      config[key] = value;
    }
  }

  return { config, secretRefs };
}

export function applyEnvOverrides(
  pluginName: string,
  config: Record<string, unknown>,
  schema?: Record<string, unknown>,
): void {
  const schemaProps = (schema?.properties as Record<string, unknown>) ?? {};

  for (const key of Object.keys(config)) {
    const envVarName = envVarNameFor(pluginName, key);
    const envValue = process.env[envVarName];

    if (envValue !== undefined) {
      const schemaType = (schemaProps[key] as { type?: string } | undefined)?.type;

      if (schemaType === "number") {
        config[key] = parseFloat(envValue);
      } else if (schemaType === "boolean") {
        config[key] = envValue.toLowerCase() === "true";
      } else {
        config[key] = envValue;
      }
    }
  }
}

export function envVarNameFor(pluginName: string, key: string): string {
  const upperSnake = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return `KAIZEN_${upperSnake(pluginName)}_${upperSnake(key)}`;
}
