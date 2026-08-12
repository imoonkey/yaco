/** The exit report — what the provider printed before it died.
 *
 *  The wrapper writes it from inside the dying pane; these tests own the
 *  reading half: only this generation's report counts, anything malformed
 *  reads as "no report" (it decorates an error message and must never be able
 *  to raise one), and deleting the session deletes it.
 *
 *  The wrapper's writing half is covered against real tmux in
 *  `test/integration/crash-contract.integration.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  cleanupOrphanBreadcrumbs,
  deleteState,
  exitReportPath,
  readExitReport,
  writeState,
  type SessionState,
} from "../src/lib/core/agent/session-state.ts";
import { bootstrapDeathMessage } from "../src/commands/agent/start.ts";

const ORIGINAL = process.env["YACO_AGENT_SESSIONS_DIR"];
const CREATED_AT = "2026-08-12T00:00:00.000Z";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "yaco-exit-report-"));
  process.env["YACO_AGENT_SESSIONS_DIR"] = dir;
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
  else process.env["YACO_AGENT_SESSIONS_DIR"] = ORIGINAL;
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
});

/** Exactly the bytes `write_exit_report` emits: generation, code, text. */
function writeReport(handle: string, generation: string, code: string, output: string): void {
  writeFileSync(exitReportPath(handle), `${generation}\n${code}\n${output}\n`);
}

function makeState(handle: string): SessionState {
  return {
    handle,
    provider: "claude",
    sessionPath: "/tmp/project",
    pid: 0,
    sessionId: "",
    status: "starting",
    createdAt: CREATED_AT,
  };
}

describe("readExitReport", () => {
  it("carries the exit code and the provider's text", () => {
    writeReport("w", CREATED_AT, "2", "error: unknown option '--nmae'\n(Did you mean --name?)");
    expect(readExitReport("w", CREATED_AT)).toEqual({
      exitCode: 2,
      output: "error: unknown option '--nmae'\n(Did you mean --name?)",
    });
  });

  it("keeps a report whose text is empty, because the exit code still says something", () => {
    writeReport("w", CREATED_AT, "127", "");
    expect(readExitReport("w", CREATED_AT)).toEqual({ exitCode: 127, output: "" });
  });

  it("ignores a report left by an earlier session of the same handle", () => {
    // A handle is reusable. A report stamped with a different createdAt
    // describes a different run, and attaching it here would misattribute it.
    writeReport("w", "2026-01-01T00:00:00.000Z", "2", "an older run's error");
    expect(readExitReport("w", CREATED_AT)).toBeNull();
  });

  it("is null when there is no report at all", () => {
    expect(readExitReport("never-ran", CREATED_AT)).toBeNull();
  });

  it.each([
    ["a truncated file", `${CREATED_AT}\n`],
    ["a blank exit code", `${CREATED_AT}\n\nsomething\n`],
    ["a non-numeric exit code", `${CREATED_AT}\nboom\nsomething\n`],
    ["an empty file", ""],
  ])("reads %s as no report rather than raising", (_label, body) => {
    writeFileSync(exitReportPath("w"), body);
    expect(readExitReport("w", CREATED_AT)).toBeNull();
  });
});

describe("cleanup", () => {
  it("deleteState takes the exit report with it", () => {
    writeState(makeState("w"));
    writeReport("w", CREATED_AT, "2", "boom");
    deleteState("w");
    expect(existsSync(exitReportPath("w"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("cleanupOrphanBreadcrumbs keeps a report whose session still has a state file", () => {
    // The crash branch tombstones rather than deletes, so this is the shape a
    // crashed session has until someone reads or kills it.
    writeState(makeState("w"));
    writeReport("w", CREATED_AT, "139", "segfault");
    cleanupOrphanBreadcrumbs();
    expect(existsSync(exitReportPath("w"))).toBe(true);
  });

  it("cleanupOrphanBreadcrumbs drops a report no state file explains any more", () => {
    writeReport("gone", CREATED_AT, "2", "boom");
    cleanupOrphanBreadcrumbs();
    expect(existsSync(exitReportPath("gone"))).toBe(false);
  });
});

describe("bootstrapDeathMessage", () => {
  it("is unchanged when there is nothing to add", () => {
    expect(bootstrapDeathMessage("h", "claude", null)).toBe(
      'Session "h" died during bootstrap',
    );
  });

  it("names the executable and its exit code", () => {
    expect(bootstrapDeathMessage("h", "codex", { exitCode: 127, output: "" })).toBe(
      'Session "h" died during bootstrap (codex exited 127)',
    );
  });

  it("appends the provider's own words", () => {
    expect(
      bootstrapDeathMessage("h", "claude", { exitCode: 1, output: "error: unknown option" }),
    ).toBe('Session "h" died during bootstrap (claude exited 1):\nerror: unknown option');
  });
});
