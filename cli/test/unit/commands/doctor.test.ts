/** Unit tests for `yaco doctor` — direct runAllChecks() calls.
 *
 *  Every test runs in an isolated tmpdir with HOME, YACO_HOME, PATH all set
 *  to sandbox paths. PATH is a shim bin so doctor's `which` lookups for
 *  tmux/git/claude/codex are hermetic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKAGED_SKILLS_DIR } from "../../../src/package-root.ts";
import { runAllChecks, REQUIRED_CHECKS } from "../../../src/commands/doctor.ts";
import { runInstall } from "../../../src/commands/install.ts";
import { runCli } from "../../helpers/cli-process.ts";


const ORIG = {
  HOME: process.env["HOME"],
  YACO_HOME: process.env["YACO_HOME"],
  YACO_BIN_DIR: process.env["YACO_BIN_DIR"],
  YACO_REPO_ROOT: process.env["YACO_REPO_ROOT"],
  PATH: process.env["PATH"],
};

/** One of the skills this package ships. The manifest is a package asset, so
 *  the fixtures have to be the real listing — there is no other one to stage. */
const SHIPPED_SKILL: string = readdirSync(PACKAGED_SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()[0]!;

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
  // A stand-in yaco checkout: install registers a repo that carries this
  // package's manifest, and several checks below read what it wrote.
  repoRoot = join(sandbox, "repo");
  mkdirSync(join(repoRoot, "cli"), { recursive: true });
  writeFileSync(join(repoRoot, "cli", "package.json"), JSON.stringify({ name: "@yaco/cli" }));
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

async function installPrereqs(): Promise<void> {
  await runInstall({
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
  it("returns exactly the 11 required check names in stable order", async () => {
    await installPrereqs();
    const r = await runAllChecks();
    expect(r.checks.map((c) => c.name)).toEqual([...REQUIRED_CHECKS]);
  });

  it("each check result has {name, status, detail}", async () => {
    await installPrereqs();
    const r = await runAllChecks();
    for (const c of r.checks) {
      expect(typeof c.name).toBe("string");
      expect(["pass", "fail", "skip"]).toContain(c.status);
      expect(typeof c.detail).toBe("string");
    }
  });

  it("summary is {pass, fail} only (no extra keys)", async () => {
    await installPrereqs();
    const r = await runAllChecks();
    expect(Object.keys(r.summary).sort()).toEqual(["fail", "pass"]);
    expect(r.summary.pass + r.summary.fail).toBe(r.checks.length);
  });

  it("after a fresh install + shimmed PATH, all 11 checks pass", async () => {
    await installPrereqs();
    const r = await runAllChecks();
    if (r.summary.fail > 0) {
      const failed = r.checks.filter((c) => c.status === "fail");
      console.error("failed checks:", JSON.stringify(failed, null, 2));
    }
    expect(r.summary.fail).toBe(0);
    expect(r.summary.pass).toBe(REQUIRED_CHECKS.length);
  });
});

describe("runAllChecks — providers zero state (no agent CLI installed)", () => {
  /** A $PATH that holds exactly what `yaco install` needs and no agent CLI.
   *  Built from shims rather than by subtracting from the operator's $PATH:
   *  one inherited directory that happens to carry a `claude` would make every
   *  assertion below a statement about this machine instead of about the check.
   *  `which` is on it because doctor's probe spawns it. */
  function pathWithoutAgentCli(): string {
    const bin = join(sandbox, "no-agent-bin");
    mkdirSync(bin, { recursive: true });
    for (const c of ["yaco", "tmux", "git"]) makeShim(join(bin, c));
    const whichPath = spawnSync("which", ["which"], { encoding: "utf-8" }).stdout.trim();
    expect(whichPath.length).toBeGreaterThan(0);
    symlinkSync(whichPath, join(bin, "which"));
    return bin;
  }

  it("skips providers, and nothing fails, when only the agent CLI is missing", async () => {
    // The stranger's machine: `npm i -g @yaco/cli` before `claude` or `codex`.
    // `yaco install` throws on any failing check, so a fail here would be a
    // throw from the documented first command — and there is nothing install
    // could have done about it, because YACO ships no agent.
    await installPrereqs();
    process.env["PATH"] = pathWithoutAgentCli();
    const r = await runAllChecks();
    const p = r.checks.find((c) => c.name === "providers");
    expect(p?.status).toBe("skip");
    // Still visible: which providers are missing, and what to do about it.
    expect(p?.detail).toContain("claude");
    expect(p?.detail).toContain("codex");
    expect(p?.detail).toContain("install one before starting agents");
    // Skips count in neither bucket, so install completes.
    expect(r.summary.fail).toBe(0);
    expect(r.summary.pass).toBe(REQUIRED_CHECKS.length - 1);
    expect(r.checks.map((c) => c.name)).toEqual([...REQUIRED_CHECKS]);
  });

  it("still passes, naming the one that is missing, when a single provider resolves", async () => {
    // The partial case is untouched: one provider is enough, and the detail
    // still reports the other as missing.
    await installPrereqs();
    const bin = pathWithoutAgentCli();
    makeShim(join(bin, "claude"));
    process.env["PATH"] = bin;
    const r = await runAllChecks();
    const p = r.checks.find((c) => c.name === "providers");
    expect(p?.status).toBe("pass");
    expect(p?.detail).toBe(`claude=${join(bin, "claude")}; codex missing`);
  });
});

describe("runAllChecks — task-graph zero state (fresh clone)", () => {
  const tasksDir = () => join(repoRoot, "plan", "tasks");

  it("skips task-graph when the repo has no tasks tree, and the skip is not a failure", async () => {
    await installPrereqs();
    rmSync(join(repoRoot, "plan"), { recursive: true, force: true });
    const r = await runAllChecks();
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

  it("still fails task-graph when the tree exists but the graph is invalid", async () => {
    await installPrereqs();
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
    const r = await runAllChecks();
    const tg = r.checks.find((c) => c.name === "task-graph");
    expect(tg?.status).toBe("fail");
    expect(r.summary.fail).toBe(1);
  });

  it("still fails task-graph when the tasks file is malformed", async () => {
    await installPrereqs();
    writeFileSync(join(tasksDir(), "tasks.json"), "not json\n");
    const r = await runAllChecks();
    const tg = r.checks.find((c) => c.name === "task-graph");
    expect(tg?.status).toBe("fail");
  });

  // The skip is for a path that is genuinely NOT THERE. A path that is there
  // but cannot be read is breakage and must not be laundered into a skip —
  // `plan/tasks` symlinked at an extracted task store is exactly how this repo
  // family keeps its plan out of the public tree.
  it("fails task-graph when the tasks path is a dangling symlink", async () => {
    await installPrereqs();
    rmSync(join(repoRoot, "plan"), { recursive: true, force: true });
    mkdirSync(join(repoRoot, "plan"), { recursive: true });
    symlinkSync(join(sandbox, "extracted-store-that-moved"), tasksDir());
    const r = await runAllChecks();
    const tg = r.checks.find((c) => c.name === "task-graph");
    expect(tg?.status).toBe("fail");
    expect(tg?.detail).toContain("dangling symlink");
    expect(r.summary.fail).toBe(1);
  });

  it("fails task-graph when a dangling symlink sits ABOVE the tasks path", async () => {
    // `plan -> /moved/private-plan` breaks `plan/tasks` exactly as a link at
    // the final component does — and it is the likelier shape, since the plan
    // ROOT is what gets extracted out of a public tree.
    await installPrereqs();
    rmSync(join(repoRoot, "plan"), { recursive: true, force: true });
    symlinkSync(join(sandbox, "moved-private-plan"), join(repoRoot, "plan"));
    const r = await runAllChecks();
    const tg = r.checks.find((c) => c.name === "task-graph");
    expect(tg?.status).toBe("fail");
    expect(tg?.detail).toContain(`dangling symlink at ${join(repoRoot, "plan")}`);
    expect(r.summary.fail).toBe(1);
  });

  it("skips when a LIVE symlinked plan root simply has no tasks tree yet", async () => {
    await installPrereqs();
    rmSync(join(repoRoot, "plan"), { recursive: true, force: true });
    const external = join(sandbox, "external-plan");
    mkdirSync(external, { recursive: true });
    symlinkSync(external, join(repoRoot, "plan"));
    const r = await runAllChecks();
    const tg = r.checks.find((c) => c.name === "task-graph");
    expect(tg?.status).toBe("skip");
    expect(r.summary.fail).toBe(0);
  });

  it("fails task-graph when the tasks path cannot be read", async () => {
    if (process.getuid?.() === 0) return; // root defeats the permission wall
    await installPrereqs();
    chmodSync(join(repoRoot, "plan"), 0o000);
    try {
      const r = await runAllChecks();
      const tg = r.checks.find((c) => c.name === "task-graph");
      expect(tg?.status).toBe("fail");
      expect(tg?.detail).toContain("EACCES");
    } finally {
      chmodSync(join(repoRoot, "plan"), 0o755); // let afterEach clean up
    }
  });
});

describe("runAllChecks — individual failure modes", () => {
  it("yaco-home check fails when ${YACO_HOME} is missing", async () => {
    // No install — YACO_HOME does not exist.
    const r = await runAllChecks();
    const home = r.checks.find((c) => c.name === "yaco-home");
    expect(home?.status).toBe("fail");
  });

  it("registry check skips when projects.json is missing", async () => {
    // An absent registry is a zero state, not breakage: `yaco install` writes
    // the "yaco" entry only against a checkout, and an `npm i -g` user adds
    // their own repos with `yaco project add`. A skip counts in neither summary
    // bucket, which is what keeps that user's first install at exit 0.
    mkdirSync(process.env["YACO_HOME"]!, { recursive: true });
    const r = await runAllChecks();
    const reg = r.checks.find((c) => c.name === "registry");
    expect(reg?.status).toBe("skip");
  });

  it("registry check fails on a malformed projects.json", async () => {
    mkdirSync(process.env["YACO_HOME"]!, { recursive: true });
    writeFileSync(join(process.env["YACO_HOME"]!, "projects.json"), "{not json[");
    const r = await runAllChecks();
    const reg = r.checks.find((c) => c.name === "registry");
    expect(reg?.status).toBe("fail");
  });

  it("skills-link check fails when the symlink is missing", async () => {
    const r = await runAllChecks();
    const skills = r.checks.find((c) => c.name === "skills-link");
    expect(skills?.status).toBe("fail");
  });

  it("skills-link fails on the legacy whole-dir symlink layout", async () => {
    await installPrereqs();
    const container = join(process.env["HOME"]!, ".claude", "skills");
    rmSync(container, { recursive: true, force: true });
    symlinkSync(PACKAGED_SKILLS_DIR, container);
    const r = await runAllChecks();
    const skills = r.checks.find((c) => c.name === "skills-link");
    expect(skills?.status).toBe("fail");
    expect(skills?.detail).toContain("legacy");
  });

  it("skills-link fails when a shipped skill's link is missing, names it", async () => {
    await installPrereqs();
    rmSync(join(process.env["HOME"]!, ".claude", "skills", SHIPPED_SKILL), { force: true });
    const r = await runAllChecks();
    const skills = r.checks.find((c) => c.name === "skills-link");
    expect(skills?.status).toBe("fail");
    expect(skills?.detail).toContain(SHIPPED_SKILL);
  });

  it("skills-link passes with a user-override real dir at a shipped name", async () => {
    await installPrereqs();
    const link = join(process.env["HOME"]!, ".claude", "skills", SHIPPED_SKILL);
    rmSync(link, { force: true });
    mkdirSync(link, { recursive: true });
    const r = await runAllChecks();
    const skills = r.checks.find((c) => c.name === "skills-link");
    expect(skills?.status).toBe("pass");
  });

  it("skills-link answers from the package, with no checkout in sight", async () => {
    // The manifest is a package asset, so removing the checkout marker changes
    // nothing — the check that used to resolve it through the registry's `yaco`
    // entry could not have said anything here at all.
    await installPrereqs();
    rmSync(join(repoRoot, "agent-config"), { recursive: true, force: true });
    rmSync(join(process.env["YACO_HOME"]!, "projects.json"), { force: true });
    const r = await runAllChecks();
    const skills = r.checks.find((c) => c.name === "skills-link");
    expect(skills?.status).toBe("pass");
    expect(skills?.detail).toContain(PACKAGED_SKILLS_DIR);
  });

  it("agent-wrapper check fails when ${YACO_HOME}/agent-wrapper.sh is missing", async () => {
    mkdirSync(process.env["YACO_HOME"]!, { recursive: true });
    const r = await runAllChecks();
    const w = r.checks.find((c) => c.name === "agent-wrapper");
    expect(w?.status).toBe("fail");
  });

  it("agent-hook-config check fails when neither claude nor codex config has yaco entries", async () => {
    const r = await runAllChecks();
    const h = r.checks.find((c) => c.name === "agent-hook-config");
    expect(h?.status).toBe("fail");
  });

});

describe("doctor --json — envelope contract (AC 6 + AC 7)", () => {
  it("data.checks shape and data.summary {pass, fail} via subprocess", async () => {
    await installPrereqs();
    const r = runCli(["doctor", "--json"], { env: { ...process.env } });
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
    // No install — most checks fail. Subprocess captures the real exit code
    // path through process.exit().
    const r = runCli(["doctor", "--json"], { env: { ...process.env } });
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
  it("uses --repo for the task-graph check", async () => {
    await installPrereqs();
    // Point doctor at a repo whose graph is invalid — the failure detail
    // naming that repo proves the flag reached the task-graph check.
    const otherRepo = join(sandbox, "other-repo");
    mkdirSync(join(otherRepo, "plan", "tasks"), { recursive: true });
    writeFileSync(join(otherRepo, "plan", "tasks", "tasks.json"), "not json\n");
    const r = runCli(
      ["doctor", "--repo", otherRepo, "--json"],
      { env: { ...process.env } },
    );
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    const taskGraph = parsed.data.checks.find((c: any) => c.name === "task-graph");
    expect(taskGraph.status).toBe("fail");
    expect(taskGraph.detail).toContain(otherRepo);
  });

  it("fails (exit 1) when --repo points at a repo that does not exist", async () => {
    // A missing repo is bad input, not an unplanned repo — it must not be
    // laundered into the zero-state skip.
    await installPrereqs();
    const missing = join(sandbox, "no-such-repo");
    const r = runCli(
      ["doctor", "--repo", missing, "--json"],
      { env: { ...process.env } },
    );
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    const taskGraph = parsed.data.checks.find((c: any) => c.name === "task-graph");
    expect(taskGraph.status).toBe("fail");
    expect(taskGraph.detail).toContain(missing);
  });

  it("exits 0 with a task-graph skip when --repo has no tasks tree", async () => {
    await installPrereqs();
    const r = runCli(
      ["doctor", "--repo", sandbox, "--json"],
      { env: { ...process.env } },
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    const taskGraph = parsed.data.checks.find((c: any) => c.name === "task-graph");
    expect(taskGraph.status).toBe("skip");
    expect(taskGraph.detail).toContain(sandbox);
  });
});
