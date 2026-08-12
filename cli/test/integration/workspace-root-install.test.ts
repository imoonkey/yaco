/** The mechanism `installWorkspaceDeps` depends on, exercised against real npm.
 *
 *  The unit tests pin *where* npm is invoked, with a shim standing in for it.
 *  That is the whole of the CLI's behaviour but none of the reason for it: the
 *  claim being made is that a root install links `packages/*` into
 *  `node_modules` and a member install does not, and only npm can settle that.
 *
 *  Hermetic and network-free: the fixture workspace declares no external
 *  dependency, so npm resolves entirely from the manifests on disk. It is a
 *  fixture rather than this repo — running a real install against the checkout
 *  would rewrite the tree the suite is running out of.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInstall } from "../../src/commands/install.ts";

const ORIG = {
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

/** The shape that matters, and nothing else: a workspace root whose globs cover
 *  a member that imports a `packages/*` sibling nobody declares — this repo's
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
  // A checkout that owns its repository: `.git` a directory, not a worktree's
  // `gitdir:` file. Without it the install skips as a linked worktree.
  mkdirSync(join(root, ".git"), { recursive: true });
}

/** Is `<root>/node_modules/fixture-sidecar` the workspace link npm writes? */
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
  mkdirSync(process.env["YACO_BIN_DIR"]!, { recursive: true });
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe("the workspace-root install links packages/*", () => {
  it("`yaco install` leaves the sibling package resolvable from the app member", async () => {
    const r = await runInstall({
      cliOnly: false,
      skipHooks: true,
      noRegistry: true,
      skipLinks: true,
      skipDoctor: true,
      dryRun: false,
      force: false,
      json: false,
      repoRoot,
    });

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
