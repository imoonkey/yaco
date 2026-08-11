/** The ordering prerequisite changed ordering and nothing else.
 *
 *  Compares the two committed matrices — `matrix.original.json` captured on Bun
 *  before directory ordering was defined, `matrix.json` captured after — and
 *  holds every observable equal except the sequence in which rows come out.
 *
 *  A case that reads no order-bearing directory (`orderSensitive: false`) must be
 *  byte-identical; only the cases that do are allowed the weaker order-free
 *  comparison, so the normalization can never excuse a change it was not written
 *  to excuse.
 *
 *  Both files are static, so this comparison is machine-independent even though
 *  the original capture was not: it verifies the recorded artifacts, it does not
 *  re-run the pre-ordering code. */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CASES } from "./cases.ts";
import type { CaseResult, GoldenMatrix } from "./capture.ts";

function load(name: string): GoldenMatrix {
  return JSON.parse(readFileSync(join(import.meta.dirname, name), "utf-8")) as GoldenMatrix;
}

const original = load("matrix.original.json");
const current = load("matrix.json");

/** Recursively sort every array so two values that differ only in element order
 *  compare equal. Object key order is already normalized by JSON.stringify's
 *  insertion order in the envelope writer, so only arrays need canonicalizing. */
function sortArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(sortArrays)
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sortArrays(v)]),
    );
  }
  return value;
}

/** stdout stripped of order: JSON payloads with their arrays sorted, text with
 *  its lines sorted. Anything else that changed survives this and fails. */
function orderFreeStdout(stdout: string): string {
  try {
    return JSON.stringify(sortArrays(JSON.parse(stdout)));
  } catch {
    return stdout.split("\n").filter(Boolean).sort().join("\n");
  }
}

function pairs(): [CaseResult, CaseResult][] {
  return original.cases.map((before, i) => [before, current.cases[i]!]);
}

describe("ordering delta: original Bun baseline → post-ordering baseline", () => {
  it("compares the same case list", () => {
    expect(current.casesDigest).toBe(original.casesDigest);
    expect(current.cases.map((c) => c.id)).toEqual(original.cases.map((c) => c.id));
  });

  it("leaves every case that does not read a directory byte-identical", () => {
    for (const [before, after] of pairs()) {
      if (CASES.find((c) => c.id === before.id)!.orderSensitive) continue;
      expect({ [before.id]: after }).toEqual({ [before.id]: before });
    }
  });

  it("changes nothing but order in the cases that do", () => {
    for (const [before, after] of pairs()) {
      expect({ [before.id]: after.exitCode }).toEqual({ [before.id]: before.exitCode });
      expect({ [before.id]: after.stderr }).toEqual({ [before.id]: before.stderr });
      expect({ [before.id]: after.durable }).toEqual({ [before.id]: before.durable });
      expect({ [before.id]: orderFreeStdout(after.stdout) }).toEqual({
        [before.id]: orderFreeStdout(before.stdout),
      });
    }
  });

  it("actually reordered output — the delta is not vacuous", () => {
    const reordered = pairs()
      .filter(([before, after]) => before.stdout !== after.stdout)
      .map(([before]) => before.id);
    // Five out-of-order session fixtures and three project logs reach several
    // surfaces; a one-row fixture could not produce this.
    expect(reordered.length).toBeGreaterThanOrEqual(3);
    expect(reordered).toContain("agent-list-all-text");
    expect(reordered).toContain("agent-history-json");
  });

  it("settles `agent list` on ascending handle order", () => {
    const listCase = current.cases.find((c) => c.id === "agent-list-all-json")!;
    const rows = (JSON.parse(listCase.stdout) as { data: { name: string }[] }).data;
    const names = rows.map((r) => r.name);
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names).toEqual([...names].sort());
  });
});
