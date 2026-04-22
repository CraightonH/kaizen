import type { ServiceRegistry } from "../core/service-registry.js";

export function serviceList(reg: ServiceRegistry): void {
  const entries = reg.list().sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) {
    console.log("No services defined.");
    return;
  }
  for (const e of entries) {
    console.log(`${e.name}  — ${e.spec.description}`);
    console.log(`    defined by: ${e.definedBy}`);
    console.log(`    provider:   ${e.providers[0] ?? "(none)"}`);
    console.log(`    consumers:  ${e.consumers.join(", ") || "(none)"}`);
  }
}

export function serviceShow(reg: ServiceRegistry, name: string): void {
  const entry = reg.list().find((e) => e.name === name);
  if (!entry) {
    console.error(`Service '${name}' not defined.`);
    process.exit(1);
  }
  console.log(`Name:        ${entry.name}`);
  console.log(`Defined by:  ${entry.definedBy}`);
  console.log(`Description: ${entry.spec.description}`);
  if (entry.spec.version) console.log(`Version:     ${entry.spec.version}`);
  console.log(`Provider:    ${entry.providers[0] ?? "(none)"}`);
  console.log(`Consumers:   ${entry.consumers.join(", ") || "(none)"}`);
  if (entry.spec.schema) {
    console.log("Schema:");
    console.log(JSON.stringify(entry.spec.schema, null, 2));
  }
}
