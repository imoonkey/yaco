/** The two things `installWorkspaceDeps` claims, settled against the real tools.
 *
 *  The tests in install.test.ts pin *where* npm is invoked, with a shim standing
 *  in for it. That is the whole of the CLI's behaviour but none of the reason
 *  for it. Two claims need the real thing to settle:
 *
 *  - a root install links `packages/*` into `node_modules` and a member install
 *    does not — only npm can say;
 *  - a linked worktree is excluded and a lookalike is not — only git can say,
 *    because a submodule and a `--separate-git-dir` repository carry the same
 *    `gitdir:` file a worktree does while owning their `node_modules` outright;
 *    and a repository git cannot read is excluded too, since a probe that
 *    failed is not a statement of ownership.
 *
 *  It lives in the unit project, which `scripts/verify.sh` runs, rather than in
 *  `test/integration/` which it does not — a regression test outside the gate
 *  is decoration. That is affordable because it is hermetic and fast: the
 *  fixture workspace declares no external dependency, so npm resolves entirely
 *  from manifests on disk, with audit and funding lookups off so nothing here
 *  can reach the network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInstall } from "../../../src/commands/install.ts";

const ORIG = {
  PATH: process.env["PATH"],
  HOME: process.env["HOME"],
  YACO_HOME: process.env["YACO_HOME"],
  YACO_BIN_DIR: process.env["YACO_BIN_DIR"],
  YACO_REPO_ROOT: process.env["YACO_REPO_ROOT"],
};

let sandbox: string;
let repoRoot: string;

function manifest(dir: string, body: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(body, null, 2));
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** The shape that matters, and nothing else: a workspace root whose globs cover
 *  a member and a `packages/*` sibling nobody declares — this repo's
 *  `app/server` → `yaco-codex-transcribe` relationship, reduced to manifests.
 *  `cli/package.json` naming `yaco-cli` is what makes it a yaco checkout. */
function stageWorkspace(root: string): void {
  manifest(root, {
    name: "fixture-root",
    private: true,
    workspaces: ["cli", "app/server", "packages/*"],
  });
  manifest(join(root, "cli"), { name: "yaco-cli", version: "0.0.0" });
  manifest(join(root, "app", "server"), { name: "fixture-app", version: "0.0.0", private: true });
  manifest(join(root, "packages", "sidecar"), {
    name: "fixture-sidecar",
    version: "0.0.0",
    private: true,
  });
}

/** A committed git repository, so `git worktree add` has something to check out. */
function stageRepo(root: string): void {
  git(root, "init", "--quiet", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "fixture");
}

function install(root: string) {
  return runInstall({
    cliOnly: false,
    skipHooks: true,
    noRegistry: true,
    skipLinks: true,
    skipDoctor: true,
    dryRun: false,
    force: false,
    json: false,
    repoRoot: root,
  });
}

/** Where `<root>/node_modules/fixture-sidecar` points, or undefined if npm never
 *  wrote it — the one observable that separates a root install from a member one. */
function sidecarLink(root: string): string | undefined {
  const link = join(root, "node_modules", "fixture-sidecar");
  try {
    return lstatSync(link).isSymbolicLink() ? realpathSync(link) : link;
  } catch {
    return undefined;
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-wsroot-"));
  repoRoot = join(sandbox, "repo");
  stageWorkspace(repoRoot);
  process.env["HOME"] = join(sandbox, "home");
  process.env["YACO_HOME"] = join(sandbox, "yaco");
  process.env["YACO_BIN_DIR"] = join(sandbox, "bin");
  process.env["YACO_REPO_ROOT"] = repoRoot;
  // Nothing in this file may reach the registry: with no external dependency
  // there is nothing to fetch, and audit/fund lookups are the only calls npm
  // would still make on its own.
  process.env["npm_config_audit"] = "false";
  process.env["npm_config_fund"] = "false";
  mkdirSync(process.env["YACO_BIN_DIR"]!, { recursive: true });
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete process.env["npm_config_audit"];
  delete process.env["npm_config_fund"];
  rmSync(sandbox, { recursive: true, force: true });
});

describe("the workspace-root install links packages/*", () => {
  it("`yaco install` leaves the sibling package resolvable from the app member", async () => {
    const r = await install(repoRoot);

    expect(r.actions).toContain(`npm install in ${repoRoot}`);
    expect(sidecarLink(repoRoot)).toBe(realpathSync(join(repoRoot, "packages", "sidecar")));
  }, 120_000);

  it("installing in the app member alone does NOT link it — the regression this replaced", async () => {
    // The control. `npm install` inside `app/server` is what the step used to
    // do, and it is why a clean clone could not resolve `yaco-codex-transcribe`.
    const r = spawnSync("npm", ["install"], {
      cwd: join(repoRoot, "app", "server"),
      stdio: "pipe",
      env: { ...process.env },
    });
    expect(r.status).toBe(0);
    expect(sidecarLink(repoRoot)).toBeUndefined();
  }, 120_000);
});

describe("which checkouts own their node_modules", () => {
  it("skips a linked worktree, whose node_modules is the main checkout's mirror", async () => {
    stageRepo(repoRoot);
    const worktree = join(sandbox, "wt");
    git(repoRoot, "worktree", "add", "--quiet", "--detach", worktree);

    const r = await install(worktree);

    expect(r.actions.some((a) => a.startsWith(`skipped npm install: ${worktree} is a linked worktree`)))
      .toBe(true);
    expect(sidecarLink(worktree)).toBeUndefined();
  }, 120_000);

  it("installs in a --separate-git-dir checkout, which has a `gitdir:` file and owns its tree", async () => {
    // The lookalike. `.git` here is a file holding `gitdir: …`, exactly as in a
    // linked worktree and in a submodule — and skipping it would break the case
    // this whole step exists to fix.
    const separate = join(sandbox, "separate");
    const gitDir = join(sandbox, "elsewhere.git");
    mkdirSync(separate, { recursive: true });
    stageWorkspace(separate);
    git(separate, "init", "--quiet", "--separate-git-dir", gitDir, ".");
    expect(lstatSync(join(separate, ".git")).isFile()).toBe(true);

    const r = await install(separate);

    expect(r.actions).toContain(`npm install in ${separate}`);
    expect(sidecarLink(separate)).toBe(realpathSync(join(separate, "packages", "sidecar")));
  }, 120_000);

  it("installs where there is no repository at all — an export owns whatever it has", async () => {
    // No `.git` entry, so no repository, so nothing to classify. Decided from
    // the filesystem: git is never asked, and cannot fail.
    expect(existsSync(join(repoRoot, ".git"))).toBe(false);

    const r = await install(repoRoot);

    expect(r.actions).toContain(`npm install in ${repoRoot}`);
  }, 120_000);

  // The two ways the probe can fail. Both must skip: a repository whose
  // topology cannot be read might be a worktree, and reading a failed probe as
  // ownership is exactly how a real one would walk into the write-through.

  it("skips a repository whose git metadata cannot be read", async () => {
    writeFileSync(join(repoRoot, ".git"), "this is not a gitfile\n");

    const r = await install(repoRoot);

    expect(r.actions.some((a) => a.startsWith(`skipped npm install: cannot read the git topology of ${repoRoot}`)))
      .toBe(true);
    expect(sidecarLink(repoRoot)).toBeUndefined();
  }, 120_000);

  it("skips a repository whose git answers successfully but unrecognizably", async () => {
    // A `git` that exits 0 and says something else. Two of these lines look
    // like the expected pair, and reading only the head of the output would
    // call that `self` — the one classification that reaches npm.
    stageRepo(repoRoot);
    const fakeBin = join(sandbox, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, "git"), "#!/bin/sh\nprintf '.git\\n.git\\nunexpected\\n'\nexit 0\n");
    chmodSync(join(fakeBin, "git"), 0o755);
    process.env["PATH"] = `${fakeBin}:${ORIG.PATH ?? ""}`;

    const r = await install(repoRoot);

    expect(r.actions.some((a) => a.startsWith(`skipped npm install: cannot read the git topology of ${repoRoot}`)))
      .toBe(true);
    expect(sidecarLink(repoRoot)).toBeUndefined();
  }, 120_000);

  it("skips a repository when there is no git on $PATH to ask", async () => {
    stageRepo(repoRoot);
    process.env["PATH"] = join(sandbox, "empty-bin");
    mkdirSync(process.env["PATH"], { recursive: true });

    const r = await install(repoRoot);

    expect(r.actions.some((a) => a.startsWith(`skipped npm install: cannot read the git topology of ${repoRoot}`)))
      .toBe(true);
    expect(sidecarLink(repoRoot)).toBeUndefined();
  }, 120_000);
});
