import { test, expect, describe } from "bun:test";
import { validateConfig, validateSchemaItself } from "./config-validator";

describe("validateConfig", () => {
  test("valid config returns empty array", () => {
    const schema = {
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    };
    const data = { name: "John", age: 30 };
    const errors = validateConfig(schema, data);
    expect(errors).toEqual([]);
  });

  test("missing required field returns error with path and message", () => {
    const schema = {
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    };
    const data = {};
    const errors = validateConfig(schema, data);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("required");
  });

  test("wrong type returns error", () => {
    const schema = {
      properties: {
        age: { type: "number" },
      },
      required: ["age"],
    };
    const data = { age: "not a number" };
    const errors = validateConfig(schema, data);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("number");
  });

  test("nested path errors include correct path", () => {
    const schema = {
      properties: {
        config: {
          type: "object",
          properties: {
            timeout_ms: { type: "number" },
          },
          required: ["timeout_ms"],
        },
      },
      required: ["config"],
    };
    const data = { config: {} };
    const errors = validateConfig(schema, data);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.path).toContain("config");
  });

  test("empty schema with no properties accepts anything", () => {
    const schema = {
      properties: {},
    };
    const data = { anything: "goes", nested: { deep: true } };
    const errors = validateConfig(schema, data);
    expect(errors).toEqual([]);
  });
});

describe("validateSchemaItself", () => {
  test("returns true for valid schema", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };
    const result = validateSchemaItself(schema);
    expect(result).toBe(true);
  });

  test("returns false for invalid schema with bad type", () => {
    const schema = {
      type: "not-a-type",
    };
    const result = validateSchemaItself(schema);
    expect(result).toBe(false);
  });

  test("returns false for invalid schema with malformed properties", () => {
    const schema = {
      type: "object",
      properties: {
        field: { type: "invalid-type" },
      },
    };
    const result = validateSchemaItself(schema);
    expect(result).toBe(false);
  });
});
