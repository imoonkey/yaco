/** End-to-end contract for `yaco paths <subcommand>`.
 *
 *  Spawned subprocess tests because the dispatcher exits the process. We
 *  verify the documented JSON shapes and the stderr-only USAGE envelope.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../../helpers/cli-process.ts";
const TMP_DIRS: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "yaco-paths-cli-"));
  TMP_DIRS.push(d);
  return d;
}

afterAll(() => {
  for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true });
});

function runYaco(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const r = runCli(args, { env: { ...process.env, NO_COLOR: "1", ...env } });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? -1,
  };
}

describe("yaco paths runtime --json", () => {
  it("returns the documented runtime shape under a YACO_HOME fixture", () => {
    const fixture = "/tmp/yaco-fixture-cli";
    const r = runYaco(["paths", "runtime", "--json"], { YACO_HOME: fixture });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    const data = parsed.data;
    expect(Object.keys(data).sort()).toEqual([
      "agentWrapperPath",
      "channelsDir",
      "projectsFile",
      "sessionsDir",
      "shellSessionsDir",
      "uiStateDir",
      "yacoHome",
    ]);
    expect(data.yacoHome).toBe(fixture);
    expect(data.projectsFile).toBe(`${fixture}/projects.json`);
    expect(data.sessionsDir).toBe(`${fixture}/sessions`);
    expect(data.uiStateDir).toBe(`${fixture}/ui-state`);
    expect(data.shellSessionsDir).toBe(`${fixture}/shell-sessions`);
    expect(data.channelsDir).toBe(`${fixture}/channels`);
    expect(data.agentWrapperPath).toBe(`${fixture}/agent-wrapper.sh`);
  });
});

describe("yaco paths project --json", () => {
  it("returns the fixed layout and the default doc folder, absolute under --repo", () => {
    const repo = tempDir();
    const r = runYaco(["paths", "project", "--json", "--repo", repo]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toEqual({
      ok: true,
      data: {
        plan: `${repo}/.yaco/plan`,
        tasks: `${repo}/.yaco/plan/tasks`,
        worktrees: `${repo}/.yaco/worktrees`,
        doc: `${repo}/docs`,
      },
    });
  });

  it("reports an existing doc/ folder", () => {
    const repo = tempDir();
    mkdirSync(join(repo, "doc"));
    const r = runYaco(["paths", "project", "--json", "--repo", repo]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).data.doc).toBe(`${repo}/doc`);
  });
});

describe("yaco paths project --repo (missing value)", () => {
  it("exits 2 with a USAGE envelope on stderr (stdout empty)", () => {
    const r = runYaco(["paths", "project", "--json", "--repo"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    const trimmed = r.stderr.endsWith("\n") ? r.stderr.slice(0, -1) : r.stderr;
    const parsed = JSON.parse(trimmed);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("USAGE");
    expect(parsed.error.message).toMatch(/--repo/);
  });

  it("text mode also exits 2 and writes a USAGE error line", () => {
    const r = runYaco(["paths", "project", "--repo"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error [USAGE]");
    expect(r.stderr).toMatch(/--repo/);
  });
});
