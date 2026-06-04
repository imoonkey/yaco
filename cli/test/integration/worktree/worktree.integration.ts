/** End-to-end CLI integration: spawns `yaco worktree ...` on a real git
 *  repo in a tmpdir, asserts on the envelope, on filesystem state, and on
 *  git refs. PR mode is exercised against a fake `gh` script on PATH so we
 *  never touch the real GitHub.
 *
 *  Covers acceptance criteria #2–#7 from the yc-worktree-ts task spec:
 *  parity with the shell helpers, envelope shape for both merge modes,
 *  cleanup safety, cross-repo isolation, and gh stdout containment.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../../../src/main.ts");

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runYaco(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): RunResult {
  const r = spawnSync("bun", ["run", BIN, ...args], {
    encoding: "utf-8",
    cwd,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? -1,
  };
}

function git(cwd: string, ...args: string[]): RunResult {
  const r = spawnSync("git", args, { encoding: "utf-8", cwd });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? -1,
  };
}

function mkRepo(prefix = "yaco-wt-int-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  // mkdtemp on macOS resolves through /var → /private/var; canonicalize so
  // comparisons against git-derived absolute paths line up.
  const realRoot = spawnSync("realpath", [root], { encoding: "utf-8" }).stdout?.trim() || root;
  expect(git(realRoot, "init", "--initial-branch=main").status).toBe(0);
  expect(git(realRoot, "config", "user.email", "test@test.invalid").status).toBe(0);
  expect(git(realRoot, "config", "user.name", "Test").status).toBe(0);
  // Commit a .gitignore so the worktree dir isn't tracked, and seed history.
  writeFileSync(join(realRoot, ".gitignore"), ".worktrees/\n");
  expect(git(realRoot, "add", ".gitignore").status).toBe(0);
  expect(git(realRoot, "commit", "-m", "initial").status).toBe(0);
  return realRoot;
}

function parseJson(line: string): {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
} {
  return JSON.parse(line.endsWith("\n") ? line.slice(0, -1) : line);
}

/** Install a fake `gh` binary on PATH that echoes a canned URL. */
function installFakeGh(opts: { url?: string; exitCode?: number; extraStdout?: string } = {}): {
  pathPrefix: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "yaco-fake-gh-"));
  const url = opts.url ?? "https://github.com/acme/widgets/pull/42";
  const exitCode = opts.exitCode ?? 0;
  const extra = opts.extraStdout ?? "";
  // The fake gh ignores args and prints the URL + an extra line that
  // mimics gh's chatter. We want to prove that this stdout does NOT leak
  // into the dispatcher's stdout — only data.url survives.
  const script = `#!/usr/bin/env bash
${extra ? `echo '${extra.replace(/'/g, "'\\''")}'` : ""}
echo '${url}'
exit ${exitCode}
`;
  const path = join(dir, "gh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return {
    pathPrefix: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("yaco worktree create", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("creates .worktrees/<slug>/ and branch task/<slug>", () => {
    const r = runYaco(repo, ["worktree", "create", "foo", "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const env = parseJson(r.stdout);
    expect(env.ok).toBe(true);
    const d = env.data as {
      slug: string;
      branch: string;
      path: string;
      base: string;
      reused: boolean;
    };
    expect(d.slug).toBe("foo");
    expect(d.branch).toBe("task/foo");
    expect(d.base).toBe("main");
    expect(d.reused).toBe(false);
    expect(d.path).toBe(join(repo, ".worktrees", "foo"));
    expect(existsSync(d.path)).toBe(true);
    expect(git(repo, "rev-parse", "--verify", "task/foo").status).toBe(0);
  });

  it("is idempotent — second create reuses without error", () => {
    const first = runYaco(repo, ["worktree", "create", "foo", "--json"]);
    expect(first.status).toBe(0);
    const second = runYaco(repo, ["worktree", "create", "foo", "--json"]);
    expect(second.status).toBe(0);
    const d = parseJson(second.stdout).data as { reused: boolean };
    expect(d.reused).toBe(true);
  });

  it("rejects an invalid slug with USAGE exit 2", () => {
    const r = runYaco(repo, ["worktree", "create", "BAD SLUG", "--json"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    const env = parseJson(r.stderr);
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("USAGE");
  });

  it("honors --base", () => {
    // Create a 'develop' branch with its own commit and verify --base targets it.
    expect(git(repo, "checkout", "-b", "develop").status).toBe(0);
    writeFileSync(join(repo, "develop.txt"), "x\n");
    expect(git(repo, "add", "develop.txt").status).toBe(0);
    expect(git(repo, "commit", "-m", "develop").status).toBe(0);
    const developSha = git(repo, "rev-parse", "develop").stdout.trim();
    expect(git(repo, "checkout", "main").status).toBe(0);

    const r = runYaco(repo, ["worktree", "create", "from-dev", "--base", "develop", "--json"]);
    expect(r.status).toBe(0);
    const branchSha = git(repo, "rev-parse", "task/from-dev").stdout.trim();
    expect(branchSha).toBe(developSha);
  });

  it("works from a linked worktree cwd (resolves to primary root)", () => {
    expect(runYaco(repo, ["worktree", "create", "child", "--json"]).status).toBe(0);
    const childDir = join(repo, ".worktrees", "child");
    // Invoking from the child worktree should still create siblings under
    // the primary repo's .worktrees, not under child/.worktrees.
    const r = runYaco(childDir, ["worktree", "create", "sibling", "--json"]);
    expect(r.status).toBe(0);
    const d = parseJson(r.stdout).data as { path: string };
    expect(d.path).toBe(join(repo, ".worktrees", "sibling"));
  });
});

describe("yaco worktree merge --mode local", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("fast-forwards base when worktree branch is descendant", () => {
    expect(runYaco(repo, ["worktree", "create", "ff", "--json"]).status).toBe(0);
    const wt = join(repo, ".worktrees", "ff");
    writeFileSync(join(wt, "new.txt"), "hi\n");
    expect(git(wt, "add", "new.txt").status).toBe(0);
    expect(git(wt, "commit", "-m", "ff commit").status).toBe(0);

    const before = git(repo, "rev-parse", "main").stdout.trim();
    const r = runYaco(repo, ["worktree", "merge", "ff", "--mode", "local", "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const env = parseJson(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({
      mode: "local",
      slug: "ff",
      branch: "task/ff",
      base: "main",
      merged: true,
    });
    const after = git(repo, "rev-parse", "main").stdout.trim();
    expect(after).not.toBe(before);
    expect(existsSync(join(repo, "new.txt"))).toBe(true);
  });

  it("rebases worktree onto an advanced base, then fast-forwards (no conflict)", () => {
    // Fixture: worktree edits file A; base advances by editing file B. Rebase
    // replays the worktree's commit on top of the new base, then ff-merge
    // pulls the result into the primary checkout.
    expect(runYaco(repo, ["worktree", "create", "advanced", "--json"]).status).toBe(0);
    const wt = join(repo, ".worktrees", "advanced");

    writeFileSync(join(wt, "feature.txt"), "feature\n");
    expect(git(wt, "add", "feature.txt").status).toBe(0);
    expect(git(wt, "commit", "-m", "feature commit").status).toBe(0);

    // Advance base independently — touches a different file so rebase has
    // no conflict to resolve.
    writeFileSync(join(repo, "base.txt"), "base\n");
    expect(git(repo, "add", "base.txt").status).toBe(0);
    expect(git(repo, "commit", "-m", "base advance").status).toBe(0);

    const before = git(repo, "rev-parse", "main").stdout.trim();
    const r = runYaco(repo, ["worktree", "merge", "advanced", "--mode", "local", "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const env = parseJson(r.stdout);
    expect(env.data).toEqual({
      mode: "local",
      slug: "advanced",
      branch: "task/advanced",
      base: "main",
      merged: true,
    });
    const after = git(repo, "rev-parse", "main").stdout.trim();
    expect(after).not.toBe(before);
    // Both files made it onto main after rebase + ff-merge.
    expect(existsSync(join(repo, "feature.txt"))).toBe(true);
    expect(existsSync(join(repo, "base.txt"))).toBe(true);
  });

  it("surfaces real rebase conflicts as CONFLICT (exit 1) and aborts the rebase", () => {
    // Seed a tracked file both branches will modify on the same line.
    writeFileSync(join(repo, "shared.txt"), "original\n");
    expect(git(repo, "add", "shared.txt").status).toBe(0);
    expect(git(repo, "commit", "-m", "seed shared.txt").status).toBe(0);

    expect(runYaco(repo, ["worktree", "create", "clash", "--json"]).status).toBe(0);
    const wt = join(repo, ".worktrees", "clash");

    writeFileSync(join(wt, "shared.txt"), "branch edit\n");
    expect(git(wt, "add", "shared.txt").status).toBe(0);
    expect(git(wt, "commit", "-m", "branch edit").status).toBe(0);

    writeFileSync(join(repo, "shared.txt"), "main edit\n");
    expect(git(repo, "add", "shared.txt").status).toBe(0);
    expect(git(repo, "commit", "-m", "main edit").status).toBe(0);

    const r = runYaco(repo, ["worktree", "merge", "clash", "--mode", "local", "--json"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    const env = parseJson(r.stderr);
    expect(env.error!.code).toBe("CONFLICT");
    expect(env.error!.message).toMatch(/rebase/);

    // The worktree must be left clean — the in-progress rebase was aborted.
    const rebaseDir = git(repo, "rev-parse", "--git-path", "rebase-merge").stdout.trim();
    expect(existsSync(join(wt, rebaseDir))).toBe(false);
    expect(git(wt, "status", "--porcelain").stdout.trim()).toBe("");
  });

  it("refuses dirty worktree (CONFLICT exit 1)", () => {
    expect(runYaco(repo, ["worktree", "create", "dirty", "--json"]).status).toBe(0);
    const wt = join(repo, ".worktrees", "dirty");
    writeFileSync(join(wt, "uncommitted.txt"), "wip\n");

    const r = runYaco(repo, ["worktree", "merge", "dirty", "--mode", "local", "--json"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    const env = parseJson(r.stderr);
    expect(env.error!.code).toBe("CONFLICT");
    expect(env.error!.message).toMatch(/uncommitted/);
  });
});

describe("yaco worktree merge --mode pr", () => {
  let repo: string;
  let fakeGh: ReturnType<typeof installFakeGh> | null = null;
  beforeEach(() => {
    repo = mkRepo();
  });
  afterEach(() => {
    if (fakeGh) {
      fakeGh.cleanup();
      fakeGh = null;
    }
    rmSync(repo, { recursive: true, force: true });
  });

  it("captures PR URL in envelope.data.url; gh stdout never leaks to caller", () => {
    expect(runYaco(repo, ["worktree", "create", "prx", "--json"]).status).toBe(0);
    const wt = join(repo, ".worktrees", "prx");
    writeFileSync(join(wt, "feat.txt"), "feat\n");
    expect(git(wt, "add", "feat.txt").status).toBe(0);
    expect(git(wt, "commit", "-m", "feat").status).toBe(0);
    // Local 'origin' so `git push -u origin task/prx` succeeds without network.
    const origin = mkdtempSync(join(tmpdir(), "yaco-wt-origin-"));
    expect(git(origin, "init", "--bare", "--initial-branch=main").status).toBe(0);
    expect(git(repo, "remote", "add", "origin", origin).status).toBe(0);

    fakeGh = installFakeGh({
      url: "https://github.com/acme/widgets/pull/77",
      extraStdout: "Creating pull request for task/prx into main in acme/widgets\nremote chatter here",
    });

    const r = runYaco(
      repo,
      ["worktree", "merge", "prx", "--mode", "pr", "--json"],
      { PATH: `${fakeGh.pathPrefix}:${process.env["PATH"] ?? ""}` },
    );
    expect(r.status).toBe(0);

    // Stdout must be EXACTLY one envelope line — nothing from gh.
    const trimmed = r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout;
    expect(trimmed.split("\n").length).toBe(1);
    const env = parseJson(trimmed);
    expect(env.ok).toBe(true);
    const d = env.data as { mode: string; url: string; slug: string; branch: string; base: string };
    expect(d.mode).toBe("pr");
    expect(d.slug).toBe("prx");
    expect(d.branch).toBe("task/prx");
    expect(d.base).toBe("main");
    expect(d.url).toBe("https://github.com/acme/widgets/pull/77");
    expect(d.url).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/);
    // gh's chatter must NOT have ended up in stdout.
    expect(r.stdout).not.toContain("Creating pull request");
    expect(r.stdout).not.toContain("remote chatter");

    rmSync(origin, { recursive: true, force: true });
  });

  it("surfaces gh failure as IO error envelope (exit 1)", () => {
    expect(runYaco(repo, ["worktree", "create", "prfail", "--json"]).status).toBe(0);
    const wt = join(repo, ".worktrees", "prfail");
    writeFileSync(join(wt, "f.txt"), "x\n");
    expect(git(wt, "add", "f.txt").status).toBe(0);
    expect(git(wt, "commit", "-m", "f").status).toBe(0);
    const origin = mkdtempSync(join(tmpdir(), "yaco-wt-origin-"));
    expect(git(origin, "init", "--bare", "--initial-branch=main").status).toBe(0);
    expect(git(repo, "remote", "add", "origin", origin).status).toBe(0);

    fakeGh = installFakeGh({ url: "", exitCode: 1 });

    const r = runYaco(
      repo,
      ["worktree", "merge", "prfail", "--mode", "pr", "--json"],
      { PATH: `${fakeGh.pathPrefix}:${process.env["PATH"] ?? ""}` },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    const env = parseJson(r.stderr);
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("IO");

    rmSync(origin, { recursive: true, force: true });
  });
});

describe("yaco worktree cleanup", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("removes .worktrees/<slug> and deletes task/<slug>", () => {
    expect(runYaco(repo, ["worktree", "create", "rm-me", "--json"]).status).toBe(0);
    // Branch points at main (no new commits), so it's merged-into-HEAD and
    // `git branch -d` will accept it.
    const r = runYaco(repo, ["worktree", "cleanup", "rm-me", "--json"]);
    expect(r.status).toBe(0);
    const d = parseJson(r.stdout).data as { removed: { worktree: boolean; branch: boolean } };
    expect(d.removed).toEqual({ worktree: true, branch: true });
    expect(existsSync(join(repo, ".worktrees", "rm-me"))).toBe(false);
    expect(git(repo, "rev-parse", "--verify", "task/rm-me").status).not.toBe(0);
  });

  it("refuses unmerged branch (CONFLICT exit 1) without --force", () => {
    expect(runYaco(repo, ["worktree", "create", "unmerged", "--json"]).status).toBe(0);
    const wt = join(repo, ".worktrees", "unmerged");
    writeFileSync(join(wt, "x.txt"), "x\n");
    expect(git(wt, "add", "x.txt").status).toBe(0);
    expect(git(wt, "commit", "-m", "unmerged commit").status).toBe(0);

    const r = runYaco(repo, ["worktree", "cleanup", "unmerged", "--json"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    const env = parseJson(r.stderr);
    expect(env.error!.code).toBe("CONFLICT");
    // Worktree dir was removed (clean-removable), but branch -d refused —
    // matches the shell helper's tolerant per-step semantics.
    expect(git(repo, "rev-parse", "--verify", "task/unmerged").status).toBe(0);
  });

  it("--force succeeds on unmerged branch", () => {
    expect(runYaco(repo, ["worktree", "create", "force-rm", "--json"]).status).toBe(0);
    const wt = join(repo, ".worktrees", "force-rm");
    writeFileSync(join(wt, "x.txt"), "x\n");
    expect(git(wt, "add", "x.txt").status).toBe(0);
    expect(git(wt, "commit", "-m", "unmerged").status).toBe(0);

    const r = runYaco(repo, ["worktree", "cleanup", "force-rm", "--force", "--json"]);
    expect(r.status).toBe(0);
    expect(existsSync(join(repo, ".worktrees", "force-rm"))).toBe(false);
    expect(git(repo, "rev-parse", "--verify", "task/force-rm").status).not.toBe(0);
  });

  it("tolerates already-cleaned state", () => {
    // No create — cleanup of a non-existent slug should still succeed (no dir, no branch).
    const r = runYaco(repo, ["worktree", "cleanup", "ghost", "--json"]);
    expect(r.status).toBe(0);
    const d = parseJson(r.stdout).data as { removed: { worktree: boolean; branch: boolean } };
    expect(d.removed).toEqual({ worktree: false, branch: false });
  });
});

describe("yaco worktree — cross-repo isolation", () => {
  let repoA: string;
  let repoB: string;
  beforeEach(() => {
    repoA = mkRepo("yaco-wt-int-A-");
    repoB = mkRepo("yaco-wt-int-B-");
  });
  afterEach(() => {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  });

  it("same slug succeeds independently in each repo", () => {
    const a = runYaco(repoA, ["worktree", "create", "shared", "--json"]);
    const b = runYaco(repoB, ["worktree", "create", "shared", "--json"]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    const da = parseJson(a.stdout).data as { path: string };
    const db = parseJson(b.stdout).data as { path: string };
    expect(da.path).toBe(join(repoA, ".worktrees", "shared"));
    expect(db.path).toBe(join(repoB, ".worktrees", "shared"));
    expect(existsSync(da.path)).toBe(true);
    expect(existsSync(db.path)).toBe(true);
    // Each repo owns its own task/shared branch.
    expect(git(repoA, "rev-parse", "--verify", "task/shared").status).toBe(0);
    expect(git(repoB, "rev-parse", "--verify", "task/shared").status).toBe(0);
  });
});

describe("yaco worktree create — provision hook", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkRepo("yaco-wt-int-prov-");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("runs scripts/worktree-provision.sh on first create, passing worktree path as $1", () => {
    // Commit a provision script that touches a sentinel file inside $1.
    mkdirSync(join(repo, "scripts"), { recursive: true });
    const script = `#!/usr/bin/env bash
set -euo pipefail
echo "provisioned $1" > "$1/.provisioned"
`;
    const scriptPath = join(repo, "scripts", "worktree-provision.sh");
    writeFileSync(scriptPath, script);
    chmodSync(scriptPath, 0o755);
    expect(git(repo, "add", "scripts/worktree-provision.sh").status).toBe(0);
    expect(git(repo, "commit", "-m", "add provision hook").status).toBe(0);

    const r = runYaco(repo, ["worktree", "create", "prov", "--json"]);
    expect(r.status).toBe(0);
    // Sentinel proves provision ran and received the worktree path.
    const sentinel = join(repo, ".worktrees", "prov", ".provisioned");
    expect(existsSync(sentinel)).toBe(true);
  });

  it("skips when the script is not executable", () => {
    mkdirSync(join(repo, "scripts"), { recursive: true });
    const scriptPath = join(repo, "scripts", "worktree-provision.sh");
    writeFileSync(scriptPath, "#!/usr/bin/env bash\nexit 99\n");
    // No chmod +x — script must be skipped.
    expect(git(repo, "add", "scripts/worktree-provision.sh").status).toBe(0);
    expect(git(repo, "commit", "-m", "non-exec provision").status).toBe(0);

    const r = runYaco(repo, ["worktree", "create", "skip", "--json"]);
    expect(r.status).toBe(0);
  });

  it("surfaces non-zero provision exit as IO error (exit 1)", () => {
    mkdirSync(join(repo, "scripts"), { recursive: true });
    const scriptPath = join(repo, "scripts", "worktree-provision.sh");
    writeFileSync(scriptPath, "#!/usr/bin/env bash\necho 'boom' >&2\nexit 42\n");
    chmodSync(scriptPath, 0o755);
    expect(git(repo, "add", "scripts/worktree-provision.sh").status).toBe(0);
    expect(git(repo, "commit", "-m", "failing provision").status).toBe(0);

    const r = runYaco(repo, ["worktree", "create", "boom", "--json"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    const env = parseJson(r.stderr);
    expect(env.error!.code).toBe("IO");
    expect(env.error!.message).toMatch(/provision/);
  });
});

describe("yaco worktree — strict per-subcommand flag validation", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkRepo("yaco-wt-int-flags-");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function expectUsage(args: string[], snippet: RegExp): void {
    const r = runYaco(repo, args);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    const env = parseJson(r.stderr);
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("USAGE");
    expect(env.error!.message).toMatch(snippet);
  }

  it("create rejects --mode", () => {
    expectUsage(["worktree", "create", "foo", "--mode", "local", "--json"], /--mode/);
  });

  it("create rejects --force", () => {
    expectUsage(["worktree", "create", "foo", "--force", "--json"], /--force/);
  });

  it("cleanup rejects --base", () => {
    expectUsage(["worktree", "cleanup", "foo", "--base", "dev", "--json"], /--base/);
  });

  it("cleanup rejects --mode", () => {
    expectUsage(["worktree", "cleanup", "foo", "--mode", "pr", "--json"], /--mode/);
  });

  it("merge rejects --force", () => {
    expectUsage(["worktree", "merge", "foo", "--force", "--json"], /--force/);
  });
});
