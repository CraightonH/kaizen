import { describe, test, expect } from "bun:test";
import { deriveLockfilePath } from "./lockfile-path.js";

describe("deriveLockfilePath", () => {
  test("returns sibling permissions.lock for a kaizen.json path", () => {
    expect(deriveLockfilePath("/foo/bar/kaizen.json")).toBe("/foo/bar/permissions.lock");
  });

  test("works for marketplace harness paths", () => {
    const p = "/home/u/.kaizen/marketplaces/official/harnesses/core-debug/kaizen.json";
    expect(deriveLockfilePath(p))
      .toBe("/home/u/.kaizen/marketplaces/official/harnesses/core-debug/permissions.lock");
  });

  test("works for project-scoped harness paths", () => {
    expect(deriveLockfilePath(".kaizen/harnesses/dev/kaizen.json"))
      .toBe(".kaizen/harnesses/dev/permissions.lock");
  });
});
