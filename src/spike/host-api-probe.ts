/**
 * Probe: does Bun.plugin + build.module at runtime affect subsequent
 * dynamic imports that reference the virtual module?
 *
 * Run:  bun src/spike/host-api-probe.ts
 * Exit: 0 on success, non-zero on failure.
 */
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const marker = Symbol("kaizen-probe");
const hostApi = { marker, PLUGIN_API_VERSION: "probe" };

Bun.plugin({
  name: "kaizen-host-api-probe",
  setup(build) {
    build.module("kaizen/types", () => ({
      loader: "object",
      exports: hostApi,
    }));
  },
});

const dir = mkdtempSync(join(tmpdir(), "kaizen-probe-"));
const pluginPath = join(dir, "plugin.ts");
writeFileSync(pluginPath, `
  import { marker, PLUGIN_API_VERSION } from "kaizen/types";
  export default { marker, PLUGIN_API_VERSION };
`);

try {
  const mod = await import(pluginPath) as { default: { marker: symbol; PLUGIN_API_VERSION: string } };
  if (mod.default.marker !== marker) {
    console.error(`FAIL: marker identity mismatch`);
    process.exit(1);
  }
  if (mod.default.PLUGIN_API_VERSION !== "probe") {
    console.error(`FAIL: PLUGIN_API_VERSION mismatch`);
    process.exit(1);
  }
  console.log("PASS: Bun.plugin virtual module resolves from arbitrary filesystem paths");
  process.exit(0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
