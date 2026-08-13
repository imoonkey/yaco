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
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { listSkillNames, PACKAGED_SKILLS_DIR } from "../../../src/package-root.ts";
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
const SHIPPED_SKILL: string = listSkillNames(PACKAGED_SKILLS_DIR)[0]!;

let sandbox: string;
let repoRoot: string;

/** A healthy executable: answers its version flag and exits 0. doctor now RUNS
 *  what it found, so a shim that only exists is no longer a stand-in for an
 *  installed tool. */
function makeShim(path: string): void {
  writeFileSync(path, `#!/bin/sh\necho "${basename(path)} 9.9.9"\nexit 0\n`);
  chmodSync(path, 0o755);
}

/** Present, +x, and dead on exec — the shape `which` plus an executable-bit
 *  test cannot tell from a working one. Two ways of dying, because doctor
 *  describes them differently: killed by a signal (what a dyld abort does) and
 *  a non-zero exit.
 *
 *  The signal is SIGTERM rather than SIGABRT for two reasons: SIGABRT costs a
 *  second of core-dump handling on Linux, which would race the probe's own 3s
 *  bound; and SIGTERM is the signal the bound itself kills with, so a run that
 *  came back "cannot execute — killed by SIGTERM" is also proof that a dying
 *  binary is not being mistaken for a timeout. */
function makeSignalDyingShim(path: string, message: string, childPidFile?: string): void {
  // With a pid file it forks first and records what it left behind: a binary
  // that dies on its own is killed by nobody, so nothing would clean up after
  // it unless the probe ends the whole group.
  //
  // The child's descriptors go to /dev/null because it would otherwise inherit
  // the probe's stdout pipe and hold it open — which makes `spawnSync` wait out
  // the whole bound and report a timeout instead of the crash. That is real
  // behaviour, and it is not the branch this shim is for.
  const fork = childPidFile
    ? `${SLEEP} 30 >/dev/null 2>&1 </dev/null &\necho $! > ${childPidFile}\n`
    : "";
  writeFileSync(path, `#!/bin/sh\n${fork}echo "${message}" >&2\nkill -TERM $$\n`);
  chmodSync(path, 0o755);
}

function makeFailingShim(path: string, message: string, code: number): void {
  writeFileSync(path, `#!/bin/sh\necho "${message}" >&2\nexit ${code}\n`);
  chmodSync(path, 0o755);
}

/** Resolved once at import, from the ambient $PATH, because the shims below run
 *  under a $PATH built entirely out of this sandbox — which has no `sleep` on
 *  it, and a shim that fails with "sleep: not found" would prove the opposite
 *  of what the timeout test claims. */
const SLEEP = spawnSync("sh", ["-c", "command -v sleep"], { encoding: "utf-8" }).stdout.trim();

/** Never answers — outlives the probe's bound by an order of magnitude.
 *
 *  It hangs by waiting on a child it forked, and records that child's pid: the
 *  bound has to take down what the probe started INCLUDING its descendants, and
 *  a shim that hangs in the foreground could not tell the two apart. */
function makeHangingShim(path: string, childPidFile: string): void {
  expect(SLEEP.length).toBeGreaterThan(0);
  writeFileSync(path, `#!/bin/sh\n${SLEEP} 30 &\necho $! > ${childPidFile}\nwait\n`);
  chmodSync(path, 0o755);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The recorded descendant, once the kernel has delivered the kill. Polls
 *  rather than asserting immediately — signal delivery and reaping are
 *  asynchronous, and a bare check would be testing this machine's scheduler. */
async function reapedWithin(pidFile: string, ms: number): Promise<boolean> {
  const pid = Number(readFileSync(pidFile, "utf-8").trim());
  expect(Number.isInteger(pid) && pid > 1).toBe(true);
  for (let waited = 0; waited < ms; waited += 50) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
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
  writeFileSync(join(repoRoot, "cli", "package.json"), JSON.stringify({ name: "yaco-cli" }));
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
    // The stranger's machine: `npm i -g yaco-cli` before `claude` or `codex`.
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
    expect(p?.detail).toBe(`claude=${join(bin, "claude")} (claude 9.9.9); codex not installed`);
  });
});

/** The bug this file grew for: on the operator's laptop `/usr/local/bin/tmux`
 *  is a 2015 Homebrew symlink into a Cellar whose libevent dylib is gone. It
 *  exists, it is +x, and every exec of it dies with a dyld error — and doctor
 *  reported `PASS tmux — /usr/local/bin/tmux`, because the check was `which()`
 *  plus nothing. */
describe("runAllChecks — a command that is present but cannot execute", () => {
  const DYLD = "dyld[99081]: Library not loaded: /usr/local/opt/libevent/lib/libevent-2.0.5.dylib";

  /** A $PATH built entirely from planted shims — never the inherited one, which
   *  on a developer machine carries a real tmux, git and provider CLI and would
   *  make every assertion here a statement about that machine. */
  function shimPath(): string {
    const bin = join(sandbox, "probe-bin");
    mkdirSync(bin, { recursive: true });
    for (const c of ["yaco", "tmux", "git", "claude", "codex"]) makeShim(join(bin, c));
    const whichPath = spawnSync("which", ["which"], { encoding: "utf-8" }).stdout.trim();
    expect(whichPath.length).toBeGreaterThan(0);
    symlinkSync(whichPath, join(bin, "which"));
    process.env["PATH"] = bin;
    return bin;
  }

  it("reports the version tmux PRINTED, not merely its path", async () => {
    // Worth having on its own: skew between two installed tmux binaries has
    // already produced a fabricated test result on this project.
    await installPrereqs();
    const bin = shimPath();
    const tmux = join(bin, "tmux");
    writeFileSync(tmux, "#!/bin/sh\necho 'tmux 3.6a'\n");
    chmodSync(tmux, 0o755);
    const r = await runAllChecks();
    const t = r.checks.find((c) => c.name === "tmux");
    expect(t?.status).toBe("pass");
    expect(t?.detail).toBe(`${tmux} (tmux 3.6a)`);
  });

  it("fails tmux when the binary is there but dies on exec, quoting what it said", async () => {
    await installPrereqs();
    const bin = shimPath();
    const tmux = join(bin, "tmux");
    makeSignalDyingShim(tmux, DYLD);
    const r = await runAllChecks();
    const t = r.checks.find((c) => c.name === "tmux");
    expect(t?.status).toBe("fail");
    // The path alone names nothing — what the binary SAID is the diagnosis.
    expect(t?.detail).toBe(`${tmux}: cannot execute — killed by SIGTERM: ${DYLD}`);
    expect(r.summary.fail).toBeGreaterThan(0);
  });

  it("still fails tmux, with the $PATH hint, when it is absent altogether", async () => {
    // The zero state must not change shape just because the check grew a probe.
    await installPrereqs();
    const bin = shimPath();
    rmSync(join(bin, "tmux"), { force: true });
    const r = await runAllChecks();
    const t = r.checks.find((c) => c.name === "tmux");
    expect(t?.status).toBe("fail");
    expect(t?.detail).toBe("tmux not on $PATH — agent sessions will not start");
  });

  it("fails git and names the exit status and what it printed", async () => {
    await installPrereqs();
    const bin = shimPath();
    const git = join(bin, "git");
    makeFailingShim(git, "git: symbol lookup error", 127);
    const r = await runAllChecks();
    const g = r.checks.find((c) => c.name === "git");
    expect(g?.status).toBe("fail");
    expect(g?.detail).toBe(`${git}: cannot execute — exit 127: git: symbol lookup error`);
  });

  it("fails tmux on a hang, reporting the timeout as itself", async () => {
    // Bounded: a binary that never answers must neither hang the doctor run nor
    // be laundered into "cannot execute" — the remedies differ.
    await installPrereqs();
    const bin = shimPath();
    makeHangingShim(join(bin, "tmux"), join(sandbox, "tmux-child.pid"));
    const started = Date.now();
    const r = await runAllChecks();
    const t = r.checks.find((c) => c.name === "tmux");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(t?.status).toBe("fail");
    expect(t?.detail).toBe(`${join(bin, "tmux")}: \`tmux -V\` did not answer within 3000ms`);
  });

  it("leaves nothing running behind a probe that died on its own", async () => {
    // Nobody kills a binary that crashes by itself, so whatever it forked
    // outlives the check unless the probe ends the group it created. The
    // timeout path cannot cover this: there is no timeout here.
    await installPrereqs();
    const bin = shimPath();
    const pidFile = join(sandbox, "crash-orphan.pid");
    makeSignalDyingShim(join(bin, "tmux"), "dyld boom", pidFile);
    const r = await runAllChecks();
    expect(r.checks.find((c) => c.name === "tmux")?.detail).toContain("cannot execute");
    expect(await reapedWithin(pidFile, 5_000)).toBe(true);
  });

  it("leaves nothing running behind a timed-out probe", async () => {
    // A bound that returns on time while the binary's children go on running is
    // honest about the report and not about the machine — and doctor is the
    // command people run when the machine is already misbehaving.
    await installPrereqs();
    const bin = shimPath();
    const pidFile = join(sandbox, "orphan.pid");
    makeHangingShim(join(bin, "tmux"), pidFile);
    const r = await runAllChecks();
    expect(r.checks.find((c) => c.name === "tmux")?.detail).toContain("did not answer");
    expect(await reapedWithin(pidFile, 5_000)).toBe(true);
  });
});

/** A provider is judged by the same probe and reported differently, because
 *  `yaco install` throws on any FAILING check and a provider's state must never
 *  block an install. Unusable is UNAVAILABLE, not a failure — but the detail
 *  has to say which of the two it is. */
describe("runAllChecks — a provider that is present but cannot execute", () => {
  function providerPath(): string {
    const bin = join(sandbox, "provider-bin");
    mkdirSync(bin, { recursive: true });
    for (const c of ["yaco", "tmux", "git"]) makeShim(join(bin, c));
    const whichPath = spawnSync("which", ["which"], { encoding: "utf-8" }).stdout.trim();
    symlinkSync(whichPath, join(bin, "which"));
    process.env["PATH"] = bin;
    return bin;
  }

  it("skips (never fails) when the only installed provider cannot run, and says so", async () => {
    await installPrereqs();
    const bin = providerPath();
    const claude = join(bin, "claude");
    makeFailingShim(claude, "node: bad option: --version", 9);
    const r = await runAllChecks();
    const p = r.checks.find((c) => c.name === "providers");
    expect(p?.status).toBe("skip");
    // The two situations told apart in words, each naming its own remedy's premise.
    expect(p?.detail).toBe(
      `no usable provider (claude=${claude} installed but cannot execute: ` +
        "exit 9: node: bad option: --version; codex not installed) — " +
        "install one before starting agents",
    );
    // Install must still complete: a skip counts in neither bucket.
    expect(r.summary.fail).toBe(0);
  });

  it("passes when another provider works, and still names the broken one", async () => {
    await installPrereqs();
    const bin = providerPath();
    const codex = join(bin, "codex");
    makeShim(join(bin, "claude"));
    makeSignalDyingShim(codex, "dyld: Library not loaded: libnode.dylib");
    const r = await runAllChecks();
    const p = r.checks.find((c) => c.name === "providers");
    expect(p?.status).toBe("pass");
    expect(p?.detail).toBe(
      `claude=${join(bin, "claude")} (claude 9.9.9); ` +
        `codex=${codex} installed but cannot execute: ` +
        "killed by SIGTERM: dyld: Library not loaded: libnode.dylib",
    );
    expect(r.summary.fail).toBe(0);
  });

  it("reports a provider that hangs as a timeout, and does not count it as found", async () => {
    await installPrereqs();
    const bin = providerPath();
    const pidFile = join(sandbox, "claude-child.pid");
    makeHangingShim(join(bin, "claude"), pidFile);
    const r = await runAllChecks();
    const p = r.checks.find((c) => c.name === "providers");
    expect(p?.status).toBe("skip");
    expect(p?.detail).toContain(
      `claude=${join(bin, "claude")} installed but did not answer \`--version\` within 3000ms`,
    );
    expect(r.summary.fail).toBe(0);
    // A provider is a Node program: the one likeliest to hang is also the one
    // likeliest to have forked something before it did.
    expect(await reapedWithin(pidFile, 5_000)).toBe(true);
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

  // `yaco install` throws on any failing doctor check, so what this check calls
  // a failure decides what can lock a user out of installing. A task carrying a
  // blockReason it should have shed is stale data, not breakage: the graph
  // loads, `yaco task validate` reports it, and the next write to that task
  // drops it. It must not take `yaco install` down with it.
  it("passes task-graph on a stale blockReason and names it instead of failing", async () => {
    await installPrereqs();
    writeFileSync(
      join(tasksDir(), "tasks.json"),
      JSON.stringify({
        stale: {
          title: "stale",
          state: "ready",
          depends: [],
          parent: null,
          acceptCriteria: ["x"],
          blockReason: "human-review",
        },
      }) + "\n",
    );
    const r = await runAllChecks();
    const tg = r.checks.find((c) => c.name === "task-graph");
    expect(tg?.status).toBe("pass");
    expect(tg?.detail).toContain("1 task(s) carry a stale blockReason");
    expect(r.summary.fail).toBe(0);
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

  it("skills-link names the alphabetically-first three missing links, then the count", async () => {
    // More missing than the detail shows, so *which* three it names is a
    // choice — and it is the manifest listing that makes it. The links are
    // removed in a scrambled order, and the five names are spread across the
    // manifest, so neither removal order nor adjacency can produce this answer
    // by accident. That the listing itself is ascending however the directory
    // was built is pinned in `test/unit/package-root.test.ts`; the manifest is
    // a package asset, so it is not a directory a test can rebuild.
    await installPrereqs();
    const shipped = listSkillNames(PACKAGED_SKILLS_DIR);
    expect(shipped.length).toBeGreaterThanOrEqual(18);
    const missing = [1, 5, 9, 13, 17].map((i) => shipped[i]!);
    for (const i of [3, 0, 4, 2, 1]) {
      rmSync(join(process.env["HOME"]!, ".claude", "skills", missing[i]!), { force: true });
    }

    const r = await runAllChecks();
    const skills = r.checks.find((c) => c.name === "skills-link");
    expect(skills?.status).toBe("fail");
    expect(skills?.detail).toContain(
      `5 skill link(s) missing (${missing.slice(0, 3).join(", ")}, +2 more)`,
    );
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
