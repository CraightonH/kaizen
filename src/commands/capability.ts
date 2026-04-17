import type { CapabilityRegistry } from "../core/capability-registry.js";

export function capabilityList(reg: CapabilityRegistry): void {
  const entries = reg.list().sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) {
    console.log("No capabilities defined.");
    return;
  }
  for (const e of entries) {
    console.log(`${e.name}  (${e.spec.cardinality})  — ${e.spec.description}`);
    console.log(`    defined by: ${e.definedBy}`);
    console.log(`    providers:  ${e.providers.join(", ") || "(none)"}`);
    console.log(`    consumers:  ${e.consumers.join(", ") || "(none)"}`);
  }
}

export function capabilityShow(reg: CapabilityRegistry, name: string): void {
  const entry = reg.list().find((e) => e.name === name);
  if (!entry) {
    console.error(`Capability '${name}' not defined.`);
    process.exit(1);
  }
  console.log(`Name:        ${entry.name}`);
  console.log(`Cardinality: ${entry.spec.cardinality}`);
  console.log(`Defined by:  ${entry.definedBy}`);
  console.log(`Description: ${entry.spec.description}`);
  if (entry.spec.version) console.log(`Version:     ${entry.spec.version}`);
  console.log(`Providers:   ${entry.providers.join(", ") || "(none)"}`);
  console.log(`Consumers:   ${entry.consumers.join(", ") || "(none)"}`);
  if (entry.spec.schema) {
    console.log("Schema:");
    console.log(JSON.stringify(entry.spec.schema, null, 2));
  }
}
