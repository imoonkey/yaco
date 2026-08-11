/** The benchmark's control, guarded at the two places it has already drifted.
 *
 *  `test/bench/history-retired-control.ts` is the reader this cutover replaced,
 *  checked in so the stall harness has something to separate from. Its value is
 *  entirely in being *that* reader: a control that has quietly become something
 *  else makes every figure measured against it a fiction.
 *
 *  Review found two drifts in its first version — a `spawnedBy` check loosened
 *  to any string, and the `ProviderHistory` factory seam bypassed — and both are
 *  pinned here. This is deliberately behavioural rather than a diff against
 *  `git show 725c46f3:…`: a check bound to a commit sha stops meaning anything
 *  the moment the branch is squashed or rebased, which is the same staleness
 *  `doc/main/cli/read-path.md`'s rollback matrix records. The header of the
 *  control carries that diff command for a human; these tests are what fail
 *  closed.
 *
 *  The factory drift takes two assertions and neither is enough alone, which is
 *  the interesting part: proving the factories *work* would not have caught it,
 *  because they did. What holds is that the control publishes no provider scan
 *  to call instead, **and** that the timed route is written to go through them.
 *  The second is a source-shape check because the route is benchmark code with
 *  no seam to inject through — giving it one would change the thing being timed.
 *
 *  What none of this is is a claim that the control is byte-identical to the
 *  retired module. Nothing here would catch a changed parser. The file's header
 *  names the four mechanical edits it is allowed to carry, and the diff command
 *  there is how that claim is checked. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as control from "../../bench/history-retired-control.ts";
import { claudeHistory, codexHistory, retiredFinalizeHistory } from "../../bench/history-retired-control.ts";
import { originPathForSessionId } from "../../../src/lib/core/agent/origin-read.ts";
import type { HistorySession } from "../../../src/lib/core/agent/providers/types.ts";

const saved = { ...process.env };
let sandbox: string;

function row(sessionId: string): HistorySession {
  return {
    sessionId,
    provider: "claude",
    title: null,
    summary: "x",
    created: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    tokens: null,
    gitBranch: null,
  };
}

function writeOrigin(sessionId: string, record: Record<string, unknown>): void {
  const path = originPathForSessionId(sessionId)!;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(record));
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-retired-control-"));
  process.env["YACO_HOME"] = sandbox;
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(sandbox, { recursive: true, force: true });
});

describe("the retired control still behaves like the reader it stands in for", () => {
  it("drops an origin record whose spawnedBy is not one of the three known values", () => {
    // The drift this catches accepted any string, which would have let the
    // control emit an origin the retired reader dropped.
    writeOrigin("bad-origin", { sessionId: "bad-origin", spawnedBy: "corrupt" });
    writeOrigin("good-origin", { sessionId: "good-origin", spawnedBy: "agent", parentSession: "boss" });

    const window = retiredFinalizeHistory([row("bad-origin"), row("good-origin")], []);

    expect(window.rows.find((r) => r.sessionId === "bad-origin")).toMatchObject({
      spawnedBy: null,
      parentSession: null,
    });
    expect(window.rows.find((r) => r.sessionId === "good-origin")).toMatchObject({
      spawnedBy: "agent",
      parentSession: "boss",
    });
  });

  it("offers the timed route no way to skip the provider factories", () => {
    // The drift this catches called the list functions directly, dropping two
    // wrapper calls and two object constructions per invocation from the timed
    // route — small, and not the shape being reproduced.
    //
    // Asserting that the factories *work* would not have caught it: they did.
    // What has to hold is that the module publishes nothing else to call, so
    // reintroducing the bypass means widening this surface, which fails here
    // before the benchmark can use it.
    expect(Object.keys(control).sort()).toEqual([
      // A constant, and the two factories, and the merge. No provider scan.
      "DEFAULT_HISTORY_LIMIT",
      "claudeHistory",
      "codexHistory",
      "retiredFinalizeHistory",
    ]);
    for (const factory of [control.claudeHistory, control.codexHistory]) {
      const provider = factory();
      expect(typeof provider.list).toBe("function");
      expect(provider).not.toBe(factory());
    }
  });

  it("is invoked through those factories by the timed route", () => {
    // The surface check above is the structural half; this is the other. The
    // route is benchmark code with no seam to inject through — giving it one
    // would change the thing being timed — so the call shape is read from the
    // source, which is what the drift changed.
    const harness = readFileSync(
      new URL("../../bench/history-stall.ts", import.meta.url),
      "utf-8",
    );
    expect(harness).toContain("retiredClaudeHistory().list(projectPath)");
    expect(harness).toContain("retiredCodexHistory().list(projectPath)");
  });

  it("returns an empty list from each provider when no provider home exists", async () => {
    process.env["HOME"] = sandbox;
    await expect(claudeHistory().list("/no/such/project")).resolves.toEqual([]);
    await expect(codexHistory().list("/no/such/project")).resolves.toEqual([]);
  });
});
