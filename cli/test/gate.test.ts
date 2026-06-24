/** `yaco gate` — wrapper-level tests for the thin gate verb (T2, v1 stateless).
 *
 *  The floor/aggregation logic is `scripts/gate.sh` (T1, tested separately by
 *  scripts/gate.test.sh). These tests pin the WRAPPER's responsibilities:
 *    - getMergeBase: thin `git merge-base` wrapper.
 *    - runGate: resolve the session's working-tree root, compute the default
 *      base, drive gate.sh, parse its last stdout line, detect a dirty tree,
 *      and shape the {ok,data} result. Hermetic: a stub scripts/gate.sh gives
 *      precise control of the checks JSON + exit code; one test drives the REAL
 *      scripts/gate.sh on an empty diff to prove the wiring.
 *    - the `yaco gate` CLI envelope + exit codes.
 *
 *  Hermetic-test guard (project convention): every fixture lives under a
 *  mktemp root, asserted before any git init, and removed in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runGate } from "../src/lib/core/gate/index.ts";
import { getMergeBase } from "../src/lib/core/worktree/git.ts";

const BIN = resolve(import.meta.dir, "../src/main.ts");
const REAL_GATE_SH = resolve(import.meta.dir, "../../scripts/gate.sh");
const TMP_PREFIX = join(tmpdir(), "yaco-gate-test-");

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function git(cwd: string, ...args: string[]): RunResult {
  const r = spawnSync("git", args, { encoding: "utf-8", cwd });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

function runYaco(cwd: string, args: string[]): RunResult {
  const r = spawnSync("bun", ["run", BIN, ...args], {
    encoding: "utf-8",
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    // gate.sh streams (inherits) its verify-heavy progress to stderr; capture
    // it generously so a noisy run can't ENOBUFS the test harness itself.
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

/** Create an isolated git repo under the mktemp root, on `main`, with one
 *  commit. Hard-asserts the path is under TMP_PREFIX before any mutation. */
function mkRepo(prefix = "repo-"): string {
  const root = mkdtempSync(TMP_PREFIX + prefix);
  if (!root.startsWith(TMP_PREFIX)) {
    throw new Error(`fixture escaped temp root: ${root}`);
  }
  // Canonicalize (macOS /var → /private/var) so it lines up with git output.
  const real = spawnSync("realpath", [root], { encoding: "utf-8" }).stdout?.trim() || root;
  expect(git(real, "init", "--initial-branch=main").status).toBe(0);
  expect(git(real, "config", "user.email", "t@t.invalid").status).toBe(0);
  expect(git(real, "config", "user.name", "T").status).toBe(0);
  writeFileSync(join(real, "README.md"), "seed\n");
  expect(git(real, "add", "README.md").status).toBe(0);
  expect(git(real, "commit", "-m", "initial").status).toBe(0);
  return real;
}

/** Write a stub scripts/gate.sh that emits `json` as its sole stdout line
 *  (progress to stderr, like the real script) and exits with `exit`. The script
 *  is committed so the tree stays clean — `dirty` then isolates real uncommitted
 *  changes. `leadingNoise` adds a stray stdout line before the JSON (exercises
 *  "parse the LAST stdout line"); `bigStderr` floods stderr with ~3 MB before
 *  the JSON (exercises the no-buffer-overflow contract). */
function writeStubGate(
  repo: string,
  opts: { json: string; exit: number; leadingNoise?: boolean; bigStderr?: boolean },
): void {
  mkdirSync(join(repo, "scripts"), { recursive: true });
  const noise = opts.leadingNoise ? "echo 'stray stdout line not json'\n" : "";
  const flood = opts.bigStderr
    ? "head -c 3000000 /dev/zero | tr '\\0' 'x' >&2; echo >&2\n"
    : "";
  const script = `#!/usr/bin/env bash
echo "stub gate: base=\${1:-none}" >&2
${flood}${noise}printf '%s\\n' '${opts.json}'
exit ${opts.exit}
`;
  const path = join(repo, "scripts", "gate.sh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  commitScript(repo);
}

/** Stage + commit scripts/gate.sh so the working tree is clean (gate.sh is a
 *  tracked repo artifact in reality). */
function commitScript(repo: string): void {
  expect(git(repo, "add", "scripts/gate.sh").status).toBe(0);
  expect(git(repo, "commit", "-m", "add gate.sh").status).toBe(0);
}

const ALL_SKIP = '{"verify":"skip","doc":"skip","review":"skip","qa":"skip"}';

describe("getMergeBase", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkRepo("mb-");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns the divergence commit of a branch and main", () => {
    // main advances; a side branch diverges from the original tip.
    const forkPoint = git(repo, "rev-parse", "HEAD").stdout.trim();
    expect(git(repo, "checkout", "-b", "feat").status).toBe(0);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, "add", "f.txt");
    git(repo, "commit", "-m", "feat work");
    // advance main independently
    git(repo, "checkout", "main");
    writeFileSync(join(repo, "m.txt"), "y\n");
    git(repo, "add", "m.txt");
    git(repo, "commit", "-m", "main work");
    git(repo, "checkout", "feat");

    const base = getMergeBase(repo, "HEAD", "main");
    expect(base).toBe(forkPoint);
    // Parity with plumbing.
    expect(base).toBe(git(repo, "merge-base", "HEAD", "main").stdout.trim());
  });

  it("throws on an unknown ref", () => {
    expect(() => getMergeBase(repo, "HEAD", "does-not-exist")).toThrow();
  });
});

describe("runGate (stubbed gate.sh)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkRepo("rg-");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("clean: all-skip exit 0 → ok:true, checks skip, dirty:false", () => {
    writeStubGate(repo, { json: ALL_SKIP, exit: 0 });
    const r = runGate(repo, { base: "HEAD" });
    expect(r.ok).toBe(true);
    expect(r.data.checks).toEqual({ verify: "skip", doc: "skip", review: "skip", qa: "skip" });
    expect(r.data.dirty).toBe(false);
    expect(r.data.base).toBe("HEAD");
    expect(r.data.sha).toBe(git(repo, "rev-parse", "HEAD").stdout.trim());
  });

  it("red: verify fail exit 1 → ok:false, checks.verify=fail", () => {
    writeStubGate(repo, {
      json: '{"verify":"fail","doc":"pass","review":"pass","qa":"skip"}',
      exit: 1,
    });
    const r = runGate(repo, { base: "HEAD" });
    expect(r.ok).toBe(false);
    expect(r.data.checks.verify).toBe("fail");
  });

  it("parses the LAST stdout line when the script emits stray output", () => {
    writeStubGate(repo, { json: ALL_SKIP, exit: 0, leadingNoise: true });
    const r = runGate(repo, { base: "HEAD" });
    expect(r.ok).toBe(true);
    expect(r.data.checks.qa).toBe("skip");
  });

  it("dirty worktree → data.dirty:true; ok still reflects checks only", () => {
    writeStubGate(repo, { json: ALL_SKIP, exit: 0 });
    writeFileSync(join(repo, "uncommitted.txt"), "wip\n");
    const r = runGate(repo, { base: "HEAD" });
    expect(r.data.dirty).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("defaults base to merge-base(HEAD, main) when --base omitted", () => {
    // Diverge onto a branch so merge-base != HEAD.
    const forkPoint = git(repo, "rev-parse", "HEAD").stdout.trim();
    git(repo, "checkout", "-b", "feat");
    writeFileSync(join(repo, "g.txt"), "z\n");
    git(repo, "add", "g.txt");
    git(repo, "commit", "-m", "feat");
    writeStubGate(repo, { json: ALL_SKIP, exit: 0 });

    const r = runGate(repo, {});
    expect(r.data.base).toBe(forkPoint);
    expect(r.ok).toBe(true);
  });

  it("throws when scripts/gate.sh is absent (hard error, not a red gate)", () => {
    // No stub written.
    expect(() => runGate(repo, { base: "HEAD" })).toThrow();
  });
});

describe("runGate (real scripts/gate.sh wiring)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkRepo("real-");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    copyFileSync(REAL_GATE_SH, join(repo, "scripts", "gate.sh"));
    chmodSync(join(repo, "scripts", "gate.sh"), 0o755);
    commitScript(repo);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("empty diff (base=HEAD) → all checks skip, ok:true", () => {
    const r = runGate(repo, { base: "HEAD" });
    expect(r.ok).toBe(true);
    expect(r.data.checks).toEqual({ verify: "skip", doc: "skip", review: "skip", qa: "skip" });
    expect(r.data.dirty).toBe(false);
  });
});

describe("yaco gate (CLI envelope)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkRepo("cli-");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("clean diff via real gate.sh → {ok:true} exit 0, one stdout line", () => {
    mkdirSync(join(repo, "scripts"), { recursive: true });
    copyFileSync(REAL_GATE_SH, join(repo, "scripts", "gate.sh"));
    chmodSync(join(repo, "scripts", "gate.sh"), 0o755);
    commitScript(repo);
    const head = git(repo, "rev-parse", "HEAD").stdout.trim();

    const r = runYaco(repo, ["gate", "--base", head, "--json"]);
    expect(r.status).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.length).toBe(1);
    const env = JSON.parse(lines[0]!);
    expect(env.ok).toBe(true);
    expect(env.data.checks).toEqual({ verify: "skip", doc: "skip", review: "skip", qa: "skip" });
  });

  it("red gate → {ok:false} on stdout, exit 1", () => {
    writeStubGate(repo, {
      json: '{"verify":"fail","doc":"pass","review":"pass","qa":"skip"}',
      exit: 1,
    });
    const r = runYaco(repo, ["gate", "--json"]);
    expect(r.status).toBe(1);
    const env = JSON.parse(r.stdout.trim());
    expect(env.ok).toBe(false);
    expect(env.data.checks.verify).toBe("fail");
  });

  it("--base with no value → USAGE exit 2 on stderr", () => {
    const r = runYaco(repo, ["gate", "--base", "--json"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    const env = JSON.parse(r.stderr.trim());
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("USAGE");
  });

  it("--help → usage text, exit 0", () => {
    const r = runYaco(repo, ["gate", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("yaco gate");
  });

  it("tolerates multi-MB stderr from gate.sh (no ENOBUFS) — regression", () => {
    // gate.sh routes the full verify output to stderr; buffering it would
    // overflow spawnSync's default maxBuffer and ENOBUFS-kill a real run.
    writeStubGate(repo, { json: ALL_SKIP, exit: 0, bigStderr: true });
    const r = runYaco(repo, ["gate", "--json"]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout.trim());
    expect(env.ok).toBe(true);
    expect(env.data.checks).toEqual({ verify: "skip", doc: "skip", review: "skip", qa: "skip" });
  });

  it("hard error: not a git repo → {ok:false,error} on stderr, empty stdout, exit 3", () => {
    const bare = mkdtempSync(TMP_PREFIX + "bare-");
    try {
      const r = runYaco(bare, ["gate", "--json"]);
      expect(r.status).toBe(3); // ENV
      expect(r.stdout).toBe("");
      const env = JSON.parse(r.stderr.trim());
      expect(env.ok).toBe(false);
      expect(env.error.code).toBe("ENV");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("hard error: git repo with no scripts/gate.sh → {ok:false,error}, exit 3", () => {
    // repo (from beforeEach) has no gate.sh.
    const r = runYaco(repo, ["gate", "--base", "HEAD", "--json"]);
    expect(r.status).toBe(3); // ENV
    expect(r.stdout).toBe("");
    const env = JSON.parse(r.stderr.trim());
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("ENV");
  });
});

describe("runGate (linked worktree — gates its OWN tree)", () => {
  let primary: string;
  let wt: string;
  beforeEach(() => {
    primary = mkRepo("lw-");
    wt = primary + "-wt"; // sibling, OUTSIDE primary's tree
    // Primary's gate.sh emits ALL-PASS; if runGate ever resolved to the
    // common-dir primary instead of the linked worktree, this is what would run.
    writeStubGate(primary, {
      json: '{"verify":"pass","doc":"pass","review":"pass","qa":"pass"}',
      exit: 0,
    });
  });
  afterEach(() => {
    rmSync(primary, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });

  it("runs the linked worktree's checked-out gate.sh and reports its HEAD + dirty", () => {
    expect(git(primary, "worktree", "add", "-b", "feat", wt).status).toBe(0);
    // Diverge the linked worktree: its gate.sh emits ALL-SKIP (distinguishable
    // from the primary's ALL-PASS), committed on the feat branch.
    writeFileSync(
      join(wt, "scripts", "gate.sh"),
      `#!/usr/bin/env bash\necho "linked gate" >&2\nprintf '%s\\n' '${ALL_SKIP}'\n`,
    );
    chmodSync(join(wt, "scripts", "gate.sh"), 0o755);
    expect(git(wt, "add", "scripts/gate.sh").status).toBe(0);
    expect(git(wt, "commit", "-m", "linked gate").status).toBe(0);
    const wtHead = git(wt, "rev-parse", "HEAD").stdout.trim();
    const primaryHead = git(primary, "rev-parse", "HEAD").stdout.trim();
    expect(wtHead).not.toBe(primaryHead);
    // Make the linked worktree dirty (untracked) — primary stays clean.
    writeFileSync(join(wt, "scratch.txt"), "wip\n");

    const r = runGate(wt, { base: "HEAD" });
    // ALL-SKIP proves the LINKED script ran, not the primary's ALL-PASS.
    expect(r.data.checks).toEqual({ verify: "skip", doc: "skip", review: "skip", qa: "skip" });
    expect(r.data.sha).toBe(wtHead);
    expect(r.data.dirty).toBe(true);
    // Primary remains clean — the dirty signal is the worktree's, not the repo's.
    expect(git(primary, "status", "--porcelain").stdout.trim()).toBe("");
  });
});

/** T3 set-done gate guard: `yaco task set` refuses to mark a *leaf* `done` when
 *  the session's gate is red or its worktree is dirty. Driven end-to-end through
 *  the CLI (real exit codes + error envelope) against a STUB scripts/gate.sh —
 *  the stub returns the checks JSON instantly, so no real heavy verify runs.
 *
 *  Fixtures mirror a gate-adopting repo: a committed stub gate.sh, a committed
 *  `.gitignore` ignoring the task lock (`*.lock.d/` — else the lock dir held
 *  during the mutation would itself read as a dirty tree), and a seeded
 *  `plan/tasks/tasks.json` (the default task store layout). */
describe("set-done guard (yaco task set: leaf → done runs the gate)", () => {
  let repos: string[] = [];
  afterEach(() => {
    for (const r of repos) rmSync(r, { recursive: true, force: true });
    repos = [];
  });

  /** A leaf that is one `set {state:done}` away from terminal. */
  const LEAF_GRAPH = {
    leaf: {
      parent: null, depends: [], state: "ready", workset: "active",
      title: "L", description: "d", acceptCriteria: "x",
    },
  };

  /** Build a gate-adopting fixture repo (tracked + cleaned up via `repos`).
   *  Omit `gate` to leave the repo WITHOUT scripts/gate.sh (opt-out path). */
  function mkGuardRepo(opts: {
    gate?: { json: string; exit: number };
    tasks: Record<string, unknown>;
  }): string {
    const repo = mkRepo("guard-");
    repos.push(repo);
    if (opts.gate) writeStubGate(repo, opts.gate); // commits scripts/gate.sh
    writeFileSync(join(repo, ".gitignore"), "*.lock.d/\n");
    mkdirSync(join(repo, "plan", "tasks"), { recursive: true });
    writeFileSync(
      join(repo, "plan", "tasks", "tasks.json"),
      JSON.stringify(opts.tasks, null, 2) + "\n",
    );
    expect(git(repo, "add", "-A").status).toBe(0);
    expect(git(repo, "commit", "-m", "guard fixture").status).toBe(0);
    // Clean tree: the guard's dirty signal must isolate later changes.
    expect(git(repo, "status", "--porcelain").stdout.trim()).toBe("");
    return repo;
  }

  function setState(repo: string, id: string, state: string): RunResult {
    return runYaco(repo, ["task", "set", id, "--data", JSON.stringify({ state }), "--json"]);
  }

  function readTasks(repo: string): Record<string, { state: string }> {
    return JSON.parse(readFileSync(join(repo, "plan", "tasks", "tasks.json"), "utf-8"));
  }

  /** The error envelope lands on stderr, but runGate INHERITS gate.sh's stderr,
   *  so the stub's progress line ("stub gate: …") precedes it. Take the last
   *  JSON-looking line. */
  function errEnvelope(stderr: string): { ok: boolean; error: { code: string; message: string } } {
    const line = stderr
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .pop();
    if (!line) throw new Error(`no JSON envelope in stderr:\n${stderr}`);
    return JSON.parse(line);
  }

  it("RED gate → refuses the done transition, names the failing check, exit 1", () => {
    const repo = mkGuardRepo({
      gate: { json: '{"verify":"fail","doc":"pass","review":"skip","qa":"skip"}', exit: 1 },
      tasks: LEAF_GRAPH,
    });
    const r = setState(repo, "leaf", "done");
    expect(r.status).toBe(1);
    const env = errEnvelope(r.stderr);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("INVALID");
    expect(env.error.message).toContain("verify"); // lists which check failed
    // The refused write is NOT persisted.
    expect(readTasks(repo).leaf!.state).toBe("ready");
  });

  it("GREEN gate + clean tree → allows; leaf becomes done, exit 0", () => {
    // Also proves the `*.lock.d/` gitignore works: without it, the lock dir
    // held during the mutation would read as dirty and this would be refused.
    const repo = mkGuardRepo({ gate: { json: ALL_SKIP, exit: 0 }, tasks: LEAF_GRAPH });
    const r = setState(repo, "leaf", "done");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim()).ok).toBe(true);
    expect(readTasks(repo).leaf!.state).toBe("done");
  });

  it("GREEN gate but DIRTY tree → refuses (uncommitted changes), exit 1", () => {
    const repo = mkGuardRepo({ gate: { json: ALL_SKIP, exit: 0 }, tasks: LEAF_GRAPH });
    writeFileSync(join(repo, "scratch.txt"), "wip\n"); // untracked, not ignored → dirty
    const r = setState(repo, "leaf", "done");
    expect(r.status).toBe(1);
    const env = errEnvelope(r.stderr);
    expect(env.error.code).toBe("INVALID");
    expect(env.error.message.toLowerCase()).toContain("uncommitted");
    expect(readTasks(repo).leaf!.state).toBe("ready");
  });

  it("milestone reaching done via rollup is NOT gated (red gate, child → cancelled)", () => {
    const repo = mkGuardRepo({
      gate: { json: '{"verify":"fail","doc":"skip","review":"skip","qa":"skip"}', exit: 1 },
      tasks: {
        M: { parent: null, depends: [], state: "ready", workset: "active", title: "M", description: "d" },
        A: {
          parent: "M", depends: [], state: "ready", workset: "active",
          title: "A", description: "d", acceptCriteria: "x",
        },
      },
    });
    // A → cancelled is terminal but NOT a set-done, so the guard never fires;
    // M then rolls up to done from its now-all-terminal children — and a
    // rollup-derived done is NOT gated either. A naive "any task that became
    // done" guard would wrongly block here on the red gate.
    const r = setState(repo, "A", "cancelled");
    expect(r.status).toBe(0);
    const after = readTasks(repo);
    expect(after.A!.state).toBe("cancelled");
    expect(after.M!.state).toBe("done"); // rolled up despite the red gate
  });

  it("dormant when the repo has no scripts/gate.sh (gate is opt-in)", () => {
    const repo = mkGuardRepo({ tasks: LEAF_GRAPH }); // no gate stub
    const r = setState(repo, "leaf", "done");
    expect(r.status).toBe(0);
    expect(readTasks(repo).leaf!.state).toBe("done");
  });
});
