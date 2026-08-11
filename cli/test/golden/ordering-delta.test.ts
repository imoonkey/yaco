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
 *  re-run the pre-ordering code.
 *
 *  A case whose observable was later changed on purpose stays in the comparison;
 *  what {@link INTENTIONAL_DELTAS} exempts is the individual *fields* that
 *  changed, and nothing else. Dropping the whole case would be the easy version
 *  and it waives too much — every unrelated field of that case would stop being
 *  compared, and an unintended change captured in the same recapture would sail
 *  through both this file and the recapture test. `durable` is not exemptible at
 *  all: no intentional output change may quietly move `$YACO_HOME` state. */

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

/** Fields a case is allowed to have changed for a reason other than ordering,
 *  and the change that earned it. `durable` is deliberately not in the union. */
type ExemptField = "stdout" | "stderr" | "exitCode";
const INTENTIONAL_DELTAS: Record<string, { fields: readonly ExemptField[]; why: string }> = {
  "doctor-json": {
    fields: ["stdout"],
    why:
      "`registry` stopped asserting a 'yaco' entry — nothing reads one now that " +
      "`skills-link` resolves the manifest from the package rather than through it",
  },
  "install-dry-run-json": {
    fields: ["stdout", "stderr", "exitCode"],
    why:
      "`install` no longer needs a checkout, so a root that is not one plans the " +
      "install (exit 0) instead of refusing it (ENV, exit 3, message on stderr)",
  },
};

function pairs(): [CaseResult, CaseResult][] {
  return original.cases.map((before, i): [CaseResult, CaseResult] => [before, current.cases[i]!]);
}

/** A case reduced to what the two matrices must still agree on: every observable
 *  the case was not granted, with stdout stripped of order when it reads a
 *  directory. */
function comparable(c: CaseResult, orderFree: boolean): Record<string, unknown> {
  const exempt = new Set<string>(INTENTIONAL_DELTAS[c.id]?.fields ?? []);
  const out: Record<string, unknown> = { durable: c.durable };
  if (!exempt.has("exitCode")) out["exitCode"] = c.exitCode;
  if (!exempt.has("stderr")) out["stderr"] = c.stderr;
  if (!exempt.has("stdout")) out["stdout"] = orderFree ? orderFreeStdout(c.stdout) : c.stdout;
  return out;
}

describe("ordering delta: original Bun baseline → post-ordering baseline", () => {
  it("compares the same case list", () => {
    expect(current.casesDigest).toBe(original.casesDigest);
    expect(current.cases.map((c) => c.id)).toEqual(original.cases.map((c) => c.id));
  });

  it("leaves every case that does not read a directory byte-identical", () => {
    for (const [before, after] of pairs()) {
      if (CASES.find((c) => c.id === before.id)!.orderSensitive) continue;
      expect({ [before.id]: comparable(after, false) }).toEqual({
        [before.id]: comparable(before, false),
      });
    }
  });

  it("changes nothing but order in the cases that do", () => {
    for (const [before, after] of pairs()) {
      expect({ [before.id]: comparable(after, true) }).toEqual({
        [before.id]: comparable(before, true),
      });
    }
  });

  it("exempts nothing it did not name", () => {
    const ids = new Set(current.cases.map((c) => c.id));
    for (const id of Object.keys(INTENTIONAL_DELTAS)) expect(ids.has(id)).toBe(true);
    // Every case still reaches the comparison, and every one of them still has
    // its durable state compared — the exemptions take fields, never cases.
    expect(pairs()).toHaveLength(original.cases.length);
    for (const [before] of pairs()) expect(comparable(before, false)["durable"]).toBeDefined();
  });

  it("holds each exempted case to the exact change that was claimed", () => {
    // The named field must actually have moved. An exemption for a field that
    // did not change is a waiver nobody needs, left behind to cover the next one.
    for (const [before, after] of pairs()) {
      const delta = INTENTIONAL_DELTAS[before.id];
      if (!delta) continue;
      for (const field of delta.fields) {
        expect({ [`${before.id}.${field}`]: after[field] }).not.toEqual({
          [`${before.id}.${field}`]: before[field],
        });
      }
    }
  });

  it("actually reordered output — the delta is not vacuous", () => {
    const reordered = pairs()
      .filter(([before]) => !(before.id in INTENTIONAL_DELTAS))
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
