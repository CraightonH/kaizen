import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true });

export interface ConfigValidationError {
  path: string;
  message: string;
}

export function validateConfig(
  schema: Record<string, unknown>,
  data: Record<string, unknown>,
): ConfigValidationError[] {
  const validate = ajv.compile({ type: "object", ...schema });
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => ({
    path: e.instancePath || "/",
    message: e.message ?? "invalid",
  }));
}

export function validateSchemaItself(schema: Record<string, unknown>): boolean {
  try {
    ajv.compile(schema);
    return true;
  } catch {
    return false;
  }
}
