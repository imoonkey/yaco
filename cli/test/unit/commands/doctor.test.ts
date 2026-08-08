/** Unit tests for `yaco doctor` — direct runAllChecks() calls.
 *
 *  Every test runs in an isolated tmpdir with HOME, YACO_HOME, PATH all set
 *  to sandbox paths. PATH is a shim bin so doctor's `which` lookups for
 *  tmux/git/claude/codex are hermetic.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runAllChecks, REQUIRED_CHECKS } from "../../../src/commands/doctor.ts";
import { runInstall } from "../../../src/commands/install.ts";

const BIN = resolve(import.meta.dir, "../../../src/main.ts");

const ORIG = {
  HOME: process.env["HOME"],
  YACO_HOME: process.env["YACO_HOME"],
  YACO_BIN_DIR: process.env["YACO_BIN_DIR"],
  YACO_REPO_ROOT: process.env["YACO_REPO_ROOT"],
  PATH: process.env["PATH"],
};

let sandbox: string;
let repoRoot: string;

function makeShim(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-doctor-unit-"));
  process.env["HOME"] = join(sandbox, "home");
  process.env["YACO_HOME"] = join(sandbox, "yaco");
  process.env["YACO_BIN_DIR"] = join(sandbox, "bin");
  mkdirSync(process.env["YACO_BIN_DIR"]!, { recursive: true });
  repoRoot = join(sandbox, "repo");
  mkdirSync(join(repoRoot, "agent-config", "global", "skills"), { recursive: true });
  // Minimal valid tasks graph for the task-graph check.
  mkdirSync(join(repoRoot, "plan", "tasks"), { recursive: true });
  writeFileSync(join(repoRoot, "plan", "tasks", "tasks.json"), "{}\n");
  process.env["YACO_REPO_ROOT"] = repoRoot;
  const shimBin = join(sandbox, "shim-bin");
  mkdirSync(shimBin, { recursive: true });
  for (const c of ["yaco", "tmux", "git", "claude", "codex"]) {
    makeShim(join(shimBin, c));
  }
  process.env["PATH"] = `${shimBin}:${ORIG.PATH ?? ""}`;
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function installPrereqs(): void {
  runInstall({
    cliOnly: true,
    skipHooks: false,
    noRegistry: false,
    skipLinks: false,
    skipDoctor: true,
    dryRun: false,
    force: false,
    json: false,
  });
}

describe("runAllChecks — required check surface", () => {
  it("returns exactly the 11 required check names in stable order", () => {
    installPrereqs();
    const r = runAllChecks();
    expect(r.checks.map((c) => c.name)).toEqual([...REQUIRED_CHECKS]);
  });

  it("each check result has {name, status, detail}", () => {
    installPrereqs();
    const r = runAllChecks();
    for (const c of r.checks) {
      expect(typeof c.name).toBe("string");
      expect(["pass", "fail", "skip"]).toContain(c.status);
      expect(typeof c.detail).toBe("string");
    }
  });

  it("summary is {pass, fail} only (no extra keys)", () => {
    installPrereqs();
    const r = runAllChecks();
    expect(Object.keys(r.summary).sort()).toEqual(["fail", "pass"]);
    expect(r.summary.pass + r.summary.fail).toBe(r.checks.length);
  });

  it("after a fresh install + shimmed PATH, all 11 checks pass", () => {
    installPrereqs();
    const r = runAllChecks();
    if (r.summary.fail > 0) {
      const failed = r.checks.filter((c) => c.status === "fail");
      console.error("failed checks:", JSON.stringify(failed, null, 2));
    }
    expect(r.summary.fail).toBe(0);
    expect(r.summary.pass).toBe(REQUIRED_CHECKS.length);
  });
});

describe("runAllChecks — task-graph zero state (fresh clone)", () => {
  const tasksDir = () => join(repoRoot, "plan", "tasks");

  it("skips task-graph when the repo has no tasks tree, and the skip is not a failure", () => {
    installPrereqs();
    rmSync(join(repoRoot, "plan"), { recursive: true, force: true });
    const r = runAllChecks();
    const tg = r.checks.find((c) => c.name === "task-graph");
    expect(tg?.status).toBe("skip");
    // Actionable detail: the path that is absent + how a graph gets created.
    expect(tg?.detail).toContain(tasksDir());
    expect(tg?.detail).toContain("yaco task set");
    // Skips count in neither bucket, so the exit-code signal stays clean.
    expect(r.summary.fail).toBe(0);
    expect(r.summary.pass).toBe(REQUIRED_CHECKS.length - 1);
    // The 11-name contract is unchanged by the skip.
    expect(r.checks.map((c) => c.name)).toEqual([...REQUIRED_CHECKS]);
  });

  it("still fails task-graph when the tree exists but the graph is invalid", () => {
    installPrereqs();
    writeFileSync(
      join(tasksDir(), "tasks.json"),
      JSON.stringify({
        orphan: {
          title: "orphan",
          state: "ready",
          depends: [],
          parent: "ghost",
          acceptCriteria: ["x"],
        },
      }) + "\n",
    );
    const r = runAllChecks();
    const tg = r.checks.find((c) => c.name === "task-graph");
    expect(tg?.status).toBe("fail");
    expect(r.summary.fail).toBe(1);
  });

  it("still fails task-graph when the tasks file is unreadable", () => {
    installPrereqs();
    writeFileSync(join(tasksDir(), "tasks.json"), "not json\n");
    const r = runAllChecks();
    const tg = r.checks.find((c) => c.name === "task-graph");
    expect(tg?.status).toBe("fail");
  });
});

describe("runAllChecks — individual failure modes", () => {
  it("yaco-home check fails when ${YACO_HOME} is missing", () => {
    // No install — YACO_HOME does not exist.
    const r = runAllChecks();
    const home = r.checks.find((c) => c.name === "yaco-home");
    expect(home?.status).toBe("fail");
  });

  it("registry check fails when projects.json is missing", () => {
    mkdirSync(process.env["YACO_HOME"]!, { recursive: true });
    const r = runAllChecks();
    const reg = r.checks.find((c) => c.name === "registry");
    expect(reg?.status).toBe("fail");
  });

  it("skills-link check fails when the symlink is missing", () => {
    const r = runAllChecks();
    const skills = r.checks.find((c) => c.name === "skills-link");
    expect(skills?.status).toBe("fail");
  });

  it("agent-wrapper check fails when ${YACO_HOME}/agent-wrapper.sh is missing", () => {
    mkdirSync(process.env["YACO_HOME"]!, { recursive: true });
    const r = runAllChecks();
    const w = r.checks.find((c) => c.name === "agent-wrapper");
    expect(w?.status).toBe("fail");
  });

  it("agent-hook-config check fails when neither claude nor codex config has yaco entries", () => {
    const r = runAllChecks();
    const h = r.checks.find((c) => c.name === "agent-hook-config");
    expect(h?.status).toBe("fail");
  });

  it("providers check fails when neither claude nor codex is on PATH", () => {
    // Strip the shims entirely.
    process.env["PATH"] = "/nonexistent-yaco-test-bin";
    const r = runAllChecks();
    const p = r.checks.find((c) => c.name === "providers");
    expect(p?.status).toBe("fail");
  });
});

describe("doctor --json — envelope contract (AC 6 + AC 7)", () => {
  it("data.checks shape and data.summary {pass, fail} via subprocess", () => {
    installPrereqs();
    const r = spawnSync("bun", ["run", BIN, "doctor", "--json"], {
      encoding: "utf-8",
      env: { ...process.env },
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.data.checks)).toBe(true);
    for (const c of parsed.data.checks) {
      expect(Object.keys(c).sort()).toEqual(["detail", "name", "status"]);
    }
    expect(Object.keys(parsed.data.summary).sort()).toEqual(["fail", "pass"]);
    // AC 7 — all 11 required names present.
    const names = parsed.data.checks.map((c: any) => c.name);
    for (const required of REQUIRED_CHECKS) {
      expect(names).toContain(required);
    }
  });
});

describe("doctor --json — stable envelope on failure (HIGH 3)", () => {
  it("returns {ok:true, data:{checks, summary}} with exit 1 when checks fail", () => {
    // No install — most checks fail. Subprocess used to bypass mock.module
    // pollution and to capture the real exit code path through process.exit().
    const r = spawnSync("bun", ["run", BIN, "doctor", "--json"], {
      encoding: "utf-8",
      env: { ...process.env },
    });
    // Exit code reflects fail count, not envelope shape.
    expect(r.status).toBe(1);
    // Stdout must still be the canonical success envelope so callers can
    // parse data.checks unconditionally; stderr stays empty.
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.data.checks)).toBe(true);
    expect(parsed.data.summary.fail).toBeGreaterThan(0);
  });
});

describe("doctor --repo (HIGH 2 wire-through)", () => {
  it("uses --repo for the task-graph check", () => {
    installPrereqs();
    // Point doctor at a repo whose graph is invalid — the failure detail
    // naming that repo proves the flag reached the task-graph check.
    const otherRepo = join(sandbox, "other-repo");
    mkdirSync(join(otherRepo, "plan", "tasks"), { recursive: true });
    writeFileSync(join(otherRepo, "plan", "tasks", "tasks.json"), "not json\n");
    const r = spawnSync(
      "bun",
      ["run", BIN, "doctor", "--repo", otherRepo, "--json"],
      { encoding: "utf-8", env: { ...process.env } },
    );
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    const taskGraph = parsed.data.checks.find((c: any) => c.name === "task-graph");
    expect(taskGraph.status).toBe("fail");
    expect(taskGraph.detail).toContain(otherRepo);
  });

  it("exits 0 with a task-graph skip when --repo has no tasks tree", () => {
    installPrereqs();
    const r = spawnSync(
      "bun",
      ["run", BIN, "doctor", "--repo", sandbox, "--json"],
      { encoding: "utf-8", env: { ...process.env } },
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    const taskGraph = parsed.data.checks.find((c: any) => c.name === "task-graph");
    expect(taskGraph.status).toBe("skip");
    expect(taskGraph.detail).toContain(sandbox);
  });
});
