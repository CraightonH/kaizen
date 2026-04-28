import { describe, test, expect } from "bun:test";
import { formatSummary } from "./plugin-consent-all.js";
import type { ConsentAllOutcome } from "./plugin-consent-all.js";

describe("formatSummary", () => {
  test("renders all outcome types and correct totals", () => {
    const outcomes: ConsentAllOutcome[] = [
      { status: "consented", ref: "mkt/session-driver@1.0.0", tier: "scoped" },
      { status: "consented", ref: "mkt/ui-plugin@0.4.1",      tier: "unscoped" },
      { status: "already",   ref: "mkt/secrets@2.0.0",        tier: "trusted" },
      { status: "skipped",   ref: "./local-plugin" },
      { status: "refused",   ref: "mkt/bad-plugin@0.1.0",     reason: "hash mismatch" },
    ];
    const out = formatSummary("./kaizen.json", outcomes);
    expect(out).toContain("✓ consented");
    expect(out).toContain("○ already");
    expect(out).toContain("- skipped");
    expect(out).toContain("✗ refused");
    expect(out).toContain("hash mismatch");
    expect(out).toContain("5 plugins");
    expect(out).toContain("2 consented");
    expect(out).toContain("1 already consented");
    expect(out).toContain("1 refused");
    expect(out).toContain("1 skipped");
  });

  test("omits zero-count categories from totals line", () => {
    const outcomes: ConsentAllOutcome[] = [
      { status: "consented", ref: "mkt/plugin@1.0.0", tier: "trusted" },
    ];
    const out = formatSummary("./kaizen.json", outcomes);
    expect(out).not.toContain("refused");
    expect(out).not.toContain("skipped");
    expect(out).toContain("1 plugins: 1 consented.");
  });
});
