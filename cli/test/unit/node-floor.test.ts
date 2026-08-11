/** The launcher's Node floor.
 *
 *  The guard's job is to turn "this Node cannot load the bundle" into one
 *  sentence naming the version yaco wants, so the versions it must reject are
 *  exactly the ones no developer is running while writing it. The prerelease
 *  rows are the reason this file exists: an earlier comparator mapped the patch
 *  component of `24.15.0-rc.1` to NaN, compared it to 0, and admitted a runtime
 *  below its own floor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MINIMUM_NODE, belowNodeFloor } from "../../bin/node-floor.mjs";

const floor: string = MINIMUM_NODE;

describe("belowNodeFloor", () => {
  it.each([
    ["24.15.0", false],
    ["24.15.1", false],
    ["24.16.0", false],
    ["25.0.0", false],
    ["24.14.9", true],
    ["24.9.0", true],
    ["22.22.1", true],
    ["20.19.0", true],
    // Semver: a prerelease precedes the release it is a candidate for. The
    // exact-floor forms are the ones that used to slip through.
    ["24.15.0-rc.1", true],
    ["24.15.0-pre", true],
    ["24.15.0-nightly20260101abcdef", true],
    ["24.14.0-rc.1", true],
    // ...and a prerelease of something already past the floor is not below it.
    ["24.16.0-nightly20260101abcdef", false],
    ["25.0.0-rc.1", false],
  ])("%s below %s -> %s", (version, expected) => {
    expect(belowNodeFloor(version as string, floor)).toBe(expected);
  });

  it("uses the CLI's declared engines.node as its floor", () => {
    // Two places state the requirement — the manifest npm enforces at install
    // time and the launcher that enforces it at run time. They have to agree,
    // or one of them is telling users something the other does not honor.
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../package.json"), "utf-8"),
    );
    expect(manifest.engines.node).toBe(`>=${floor}`);
  });
});
