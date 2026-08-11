/** End-to-end contract for `yaco paths <subcommand>`.
 *
 *  Spawned subprocess tests because the dispatcher exits the process. We
 *  verify the documented JSON shapes and the stderr-only failure envelope
 *  with exit-3 for ENV errors (malformed yaco.toml).
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  it("returns defaults resolved to absolute paths under --repo", () => {
    const repo = tempDir();
    const r = runYaco(["paths", "project", "--json", "--repo", repo]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toEqual({
      ok: true,
      data: {
        plan: `${repo}/plan`,
        tasks: `${repo}/plan/tasks`,
        active: `${repo}/plan/active`,
        archive: `${repo}/plan/archive`,
        backlog: `${repo}/plan/backlog`,
        worktrees: `${repo}/.worktrees`,
      },
    });
  });

  it("applies a [paths] plan override and re-roots sub-paths to absolute", () => {
    const repo = tempDir();
    writeFileSync(
      join(repo, "yaco.toml"),
      '[paths]\nplan = "pl"\n',
      "utf-8",
    );
    const r = runYaco(["paths", "project", "--json", "--repo", repo]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.data.plan).toBe(`${repo}/pl`);
    expect(parsed.data.tasks).toBe(`${repo}/pl/tasks`);
    expect(parsed.data.active).toBe(`${repo}/pl/active`);
    expect(parsed.data.backlog).toBe(`${repo}/pl/backlog`);
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

describe("yaco paths project — duplicate key in yaco.toml", () => {
  it("exits 3 with ENV envelope identifying the duplicated key", () => {
    const repo = tempDir();
    writeFileSync(
      join(repo, "yaco.toml"),
      '[paths]\ntasks = "a.json"\ntasks = "b.json"\n',
      "utf-8",
    );
    const r = runYaco(["paths", "project", "--json", "--repo", repo]);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    const trimmed = r.stderr.endsWith("\n") ? r.stderr.slice(0, -1) : r.stderr;
    const parsed = JSON.parse(trimmed);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("ENV");
    expect(parsed.error.message).toMatch(/duplicate key "tasks"/);
  });
});

describe("yaco paths project — malformed yaco.toml", () => {
  it("exits 3 with ok:false envelope on stderr (stdout empty)", () => {
    const repo = tempDir();
    writeFileSync(
      join(repo, "yaco.toml"),
      "this is not valid toml at all\n",
      "utf-8",
    );
    const r = runYaco(["paths", "project", "--json", "--repo", repo]);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    const trimmed = r.stderr.endsWith("\n") ? r.stderr.slice(0, -1) : r.stderr;
    const parsed = JSON.parse(trimmed);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("ENV");
    expect(typeof parsed.error.message).toBe("string");
  });

  it("text mode also exits 3 and writes a human error line to stderr", () => {
    const repo = tempDir();
    writeFileSync(join(repo, "yaco.toml"), "@@@nope\n", "utf-8");
    const r = runYaco(["paths", "project", "--repo", repo]);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error [ENV]");
  });
});
