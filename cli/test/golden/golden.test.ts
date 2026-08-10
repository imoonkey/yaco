/** The golden matrix is current: recapturing reproduces the committed baseline
 *  byte for byte. This is what makes `matrix.json` a parity baseline rather than
 *  a snapshot of one run — a capture that cannot reproduce itself cannot tell a
 *  runtime port apart from noise. */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureMatrix, type GoldenMatrix } from "./capture.ts";
import { CASES, CASES_DIGEST } from "./cases.ts";

const committed = JSON.parse(
  readFileSync(join(import.meta.dir, "matrix.json"), "utf-8"),
) as GoldenMatrix;

describe("golden matrix", () => {
  it("was captured from the current case list", () => {
    expect(committed.casesDigest).toBe(CASES_DIGEST);
    expect(committed.cases.map((c) => c.id)).toEqual(CASES.map((c) => c.id));
  });

  it("reproduces exactly on recapture", () => {
    const fresh = captureMatrix();
    expect(fresh.cases).toHaveLength(committed.cases.length);
    // Per-case so a failure names the command that drifted.
    for (const [i, actual] of fresh.cases.entries()) {
      expect({ [actual.id]: actual }).toEqual({ [actual.id]: committed.cases[i]! });
    }
  }, 120_000);
});
