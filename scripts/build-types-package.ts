/**
 * Produce a publish-ready kaizen npm package containing:
 *   - dist/host-api.d.ts (bundled .d.ts for the host-api surface)
 *   - dist/types.js      stub that throws if required outside a kaizen session
 *   - package.json       with exports["./types"] pointing at the above
 *
 * Run: bun scripts/build-types-package.ts
 * Output: dist/kaizen-types-pkg/
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { $ } from "bun";

const OUT = join(process.cwd(), "dist", "kaizen-types-pkg");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "dist"), { recursive: true });

// Generate .d.ts using tsc.
await $`bun x tsc -p tsconfig.types.json --outDir ${join(OUT, "dist")}`.quiet();

// Stub runtime module.
writeFileSync(
  join(OUT, "dist", "types.js"),
  `export default null;
throw new Error("kaizen/types is provided by the kaizen runtime; this module cannot be used outside a kaizen session.");
`,
);

// Package.json.
const srcPkg = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, unknown>;
const pubPkg = {
  name: "kaizen",
  version: srcPkg.version,
  description: "Type declarations for kaizen plugin authoring.",
  type: "module",
  exports: {
    "./types": { types: "./dist/host-api.d.ts", default: "./dist/types.js" },
  },
  files: ["dist/"],
};
writeFileSync(join(OUT, "package.json"), JSON.stringify(pubPkg, null, 2) + "\n");

console.log(`built ${OUT}`);
