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
