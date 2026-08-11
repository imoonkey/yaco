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
 *  A case whose observable was later changed on purpose stays in the comparison,
 *  and {@link INTENTIONAL_DELTAS} gives up as little of it as the change costs.
 *  `stdout` is a composite, so waiving the whole string is nearly as blunt as
 *  waiving the case: `doctor-json` carries eleven check records, of which three
 *  moved, and the other eight go on being compared here. Only where the two
 *  matrices have no corresponding value left — `install-dry-run-json` turned an
 *  error envelope into a success one — is a field given up whole, and then the
 *  transformation itself is pinned by {@link ASSERTED_TRANSFORMATIONS} rather
 *  than merely permitted. `durable` is exemptible by neither route: no
 *  intentional output change may quietly move `$YACO_HOME` state. */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGED_SKILLS_DIR } from "../../src/package-root.ts";
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

/** What a case is allowed to have changed for a reason other than ordering.
 *  `checks` names doctor records to set aside while the rest of stdout is still
 *  compared; `fields` gives up a whole observable and obliges an entry in
 *  {@link ASSERTED_TRANSFORMATIONS}. `durable` is in neither. */
type ExemptField = "stdout" | "stderr" | "exitCode";
const INTENTIONAL_DELTAS: Record<
  string,
  { fields?: readonly ExemptField[]; checks?: readonly string[]; why: string }
> = {
  "doctor-json": {
    checks: ["registry", "skills-link", "providers"],
    why:
      "`registry` stopped asserting a 'yaco' entry — nothing reads one now that " +
      "`skills-link` resolves the manifest from the package rather than through it; " +
      "`providers` skips instead of failing when no agent CLI is on $PATH, because " +
      "YACO ships no agent and `yaco install` throws on any failing check",
  },
  "install-dry-run-json": {
    fields: ["stdout", "stderr", "exitCode"],
    why:
      "`install` no longer needs a checkout, so a root that is not one plans the " +
      "install (exit 0) instead of refusing it (ENV, exit 3, message on stderr) — " +
      "an error envelope and a success envelope share no field to compare",
  },
};

function pairs(): [CaseResult, CaseResult][] {
  return original.cases.map((before, i): [CaseResult, CaseResult] => [before, current.cases[i]!]);
}

/** A case reduced to what the two matrices must still agree on: every observable
 *  the case was not granted, with stdout stripped of order when it reads a
 *  directory. */
function comparable(c: CaseResult, orderFree: boolean): Record<string, unknown> {
  const delta = INTENTIONAL_DELTAS[c.id];
  const exempt = new Set<string>(delta?.fields ?? []);
  const out: Record<string, unknown> = { durable: c.durable };
  if (!exempt.has("exitCode")) out["exitCode"] = c.exitCode;
  if (!exempt.has("stderr")) out["stderr"] = c.stderr;
  if (exempt.has("stdout")) return out;
  out["stdout"] = delta?.checks
    ? remainingChecks(c.stdout, delta.checks)
    : orderFree ? orderFreeStdout(c.stdout) : c.stdout;
  return out;
}

/** A doctor report minus the named records: every other check, verbatim, plus
 *  the full name sequence — so a check that quietly changed status, detail, or
 *  position still fails the comparison the two named ones were excused from. */
function remainingChecks(stdout: string, excused: readonly string[]): unknown {
  const { checks } = (JSON.parse(stdout) as { data: { checks: CheckRecord[] } }).data;
  return {
    order: checks.map((c) => c.name),
    kept: checks.filter((c) => !excused.includes(c.name)),
  };
}
interface CheckRecord { name: string; status: string; detail: string }

/** The skills the package ships, in the order install plants them. */
function shippedSkills(): string[] {
  return readdirSync(PACKAGED_SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** The exact before → after of every field given up whole. A waiver says "this
 *  may differ"; these say what it was and what it became, so the change that
 *  was claimed is the change that happened. */
const ASSERTED_TRANSFORMATIONS: Record<string, (before: CaseResult, after: CaseResult) => void> = {
  "doctor-json": (before, after) => {
    const record = (c: CaseResult, name: string) =>
      (JSON.parse(c.stdout) as { data: { checks: CheckRecord[] } }).data.checks
        .find((k) => k.name === name)!;
    expect(record(before, "registry")).toMatchObject({ status: "fail" });
    expect(record(before, "registry").detail).toContain("no 'yaco' entry");
    expect(record(after, "registry")).toMatchObject({ status: "pass" });
    expect(record(after, "registry").detail).toContain("project(s)");
    // skills-link failed before for want of a registry entry and fails now for
    // the only reason left: the links are not there.
    expect(record(before, "skills-link").detail).toContain("no 'yaco' registry entry");
    expect(record(after, "skills-link").detail).toContain("missing");
    // `providers` reports the same condition — this sandbox has no agent CLI on
    // its $PATH — without failing on it, and still names what is missing. Both
    // records whole: this record is exempted from the comparison above, so a
    // substring match is the only thing a later recapture would have to satisfy
    // to change the rest of the detail unnoticed.
    expect(record(before, "providers")).toEqual({
      name: "providers",
      status: "fail",
      detail: "no provider executable on $PATH (claude, codex)",
    });
    expect(record(after, "providers")).toEqual({
      name: "providers",
      status: "skip",
      detail:
        "no provider executable on $PATH (claude, codex) — install one before starting agents",
    });
    const summary = (c: CaseResult) => (JSON.parse(c.stdout) as { data: { summary: unknown } }).data.summary;
    expect(summary(before)).toEqual({ pass: 2, fail: 9 });
    expect(summary(after)).toEqual({ pass: 3, fail: 7 });
  },
  "install-dry-run-json": (before, after) => {
    expect(before.exitCode).toBe(3);
    expect(before.stdout).toBe("");
    expect(before.stderr).toContain('"code":"ENV"');
    expect(before.stderr).toContain("not a YACO checkout");

    expect(after.exitCode).toBe(0);
    expect(after.stderr).toBe("");
    const { ok, data } = JSON.parse(after.stdout) as { ok: boolean; data: { actions: string[] } };
    expect(ok).toBe(true);
    // The plan in full, in order. This case gives up its whole stdout, so it is
    // the only thing standing between an unintended change and a recapture that
    // swallows it — a loose "some skills were planned" would let 21 of 22 go
    // missing, or an unrelated action appear, without a word. The skill names
    // come from the package, so adding one needs a recapture and nothing else.
    expect(data.actions).toEqual([
      "write {SANDBOX}/yaco/agent-wrapper.sh",
      "merge {SANDBOX}/home/.claude/settings.json hooks",
      "merge {SANDBOX}/home/.codex/hooks.json hooks",
      "create dir {SANDBOX}/home/.claude/skills",
      ...shippedSkills().map((name) => `symlink skill ${name}`),
      "symlink {SANDBOX}/home/.agents/skills -> {SANDBOX}/home/.claude/skills",
      "skipped registry: {SANDBOX} is not a yaco checkout (`yaco project add` registers your own repos)",
      "run yaco doctor",
    ]);
  },
};

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
    for (const [before, after] of pairs()) {
      const delta = INTENTIONAL_DELTAS[before.id];
      if (!delta) continue;
      // A waived field that did not move is a waiver nobody needs, left behind
      // to cover the next change silently.
      for (const field of delta.fields ?? []) {
        expect({ [`${before.id}.${field}`]: after[field] }).not.toEqual({
          [`${before.id}.${field}`]: before[field],
        });
      }
      ASSERTED_TRANSFORMATIONS[before.id]!(before, after);
    }
  });

  it("asserts a transformation for every case that gave up a whole field", () => {
    for (const [id, delta] of Object.entries(INTENTIONAL_DELTAS)) {
      if (!delta.fields?.length) continue;
      expect({ [id]: typeof ASSERTED_TRANSFORMATIONS[id] }).toEqual({ [id]: "function" });
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
