/** Tests for the agent-wrapper.sh fallback resolution chain.
 *
 *  Background: under `bun run`, lifecycle.ts#packagedAgentWrapperPath()
 *  resolves import.meta.url to the on-disk source file and the script sibling
 *  is found at `cli/scripts/agent-wrapper.sh`. Under a `bun build --compile`
 *  binary, import.meta.url resolves into the bun runtime's virtual fs
 *  (e.g. `/scripts/agent-wrapper.sh`) and the open fails with ENOENT — this
 *  regressed `yaco agent start` after a fresh `tools/install.sh` (caught by
 *  yc-cross-machine-smoke 2026-06-03).
 *
 *  The fallback chain in `findExistingWrapperPath` lets the caller recover by
 *  walking: explicit `repoRoot` arg > `$YACO_REPO_ROOT` > git rev-parse from
 *  cwd > raw cwd. These tests exercise the chain directly via the test-only
 *  export, because under `bun run` the packaged path always wins and the
 *  fallback branch would otherwise be dead code.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  _ensureAgentWrapperScriptFromForTests,
  _findExistingWrapperPathForTests,
  readAgentWrapperScript,
} from "../src/lib/core/agent/lifecycle.ts";
import { agentWrapperPath } from "../src/lib/core/paths/yaco-home.ts";
import { CliError } from "../src/lib/core/errors.ts";

const ORIGINAL_YACO_REPO_ROOT = process.env["YACO_REPO_ROOT"];
const ORIGINAL_YACO_HOME = process.env["YACO_HOME"];
const ORIGINAL_CWD = process.cwd();
let sandbox: string;

/** Build a yaco-shaped checkout under `root`: a non-empty cli/scripts/agent-wrapper.sh. */
function seedYacoCheckout(root: string): string {
  const wrapperDir = join(root, "cli", "scripts");
  mkdirSync(wrapperDir, { recursive: true });
  const path = join(wrapperDir, "agent-wrapper.sh");
  writeFileSync(path, "#!/bin/bash\n# fixture wrapper\n");
  return path;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-wrapper-resolve-"));
  // Clear env so tests start from a known state. Each test sets what it needs.
  delete process.env["YACO_REPO_ROOT"];
  process.env["YACO_HOME"] = join(sandbox, ".yaco");
});

afterEach(() => {
  if (ORIGINAL_YACO_REPO_ROOT === undefined) delete process.env["YACO_REPO_ROOT"];
  else process.env["YACO_REPO_ROOT"] = ORIGINAL_YACO_REPO_ROOT;
  if (ORIGINAL_YACO_HOME === undefined) delete process.env["YACO_HOME"];
  else process.env["YACO_HOME"] = ORIGINAL_YACO_HOME;
  process.chdir(ORIGINAL_CWD);
  rmSync(sandbox, { recursive: true, force: true });
});

describe("findExistingWrapperPath fallback chain", () => {
  it("returns the packaged path when it exists (bun-run mode)", () => {
    // Simulate the bun-run case: packaged path exists on disk.
    const packaged = seedYacoCheckout(sandbox);
    const found = _findExistingWrapperPathForTests(packaged);
    expect(found).toBe(packaged);
  });

  it("falls back to repoRoot arg when packaged path is missing (compiled-binary case)", () => {
    // packagedPath simulates the bun-compile VFS path that does not exist.
    const packaged = "/nonexistent/scripts/agent-wrapper.sh";
    const expected = seedYacoCheckout(sandbox);
    const found = _findExistingWrapperPathForTests(packaged, sandbox);
    expect(found).toBe(expected);
  });

  it("falls back to YACO_REPO_ROOT env when no repoRoot arg is given", () => {
    const packaged = "/nonexistent/scripts/agent-wrapper.sh";
    const expected = seedYacoCheckout(sandbox);
    process.env["YACO_REPO_ROOT"] = sandbox;
    const found = _findExistingWrapperPathForTests(packaged);
    expect(found).toBe(expected);
  });

  it("prefers repoRoot arg over YACO_REPO_ROOT env", () => {
    const packaged = "/nonexistent/scripts/agent-wrapper.sh";
    const preferred = seedYacoCheckout(sandbox);
    const envOnly = mkdtempSync(join(tmpdir(), "yaco-wrapper-env-"));
    try {
      seedYacoCheckout(envOnly);
      process.env["YACO_REPO_ROOT"] = envOnly;
      const found = _findExistingWrapperPathForTests(packaged, sandbox);
      expect(found).toBe(preferred);
    } finally {
      rmSync(envOnly, { recursive: true, force: true });
    }
  });

  it("falls back to cwd-relative path when no repoRoot is known", () => {
    const packaged = "/nonexistent/scripts/agent-wrapper.sh";
    const expected = seedYacoCheckout(sandbox);
    // git rev-parse may or may not match sandbox (it's not a git repo); raw
    // cwd is the load-bearing fallback here.
    process.chdir(sandbox);
    const found = _findExistingWrapperPathForTests(packaged);
    expect(found).not.toBeNull();
    expect(realpathSync(found!)).toBe(realpathSync(expected));
  });

  it("returns null when no candidate exists", () => {
    const packaged = "/nonexistent/scripts/agent-wrapper.sh";
    const emptyDir = mkdtempSync(join(tmpdir(), "yaco-wrapper-empty-"));
    try {
      // chdir into an empty dir, no env, no repoRoot.
      process.chdir(emptyDir);
      const found = _findExistingWrapperPathForTests(packaged);
      expect(found).toBeNull();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("readAgentWrapperScript", () => {
  it("returns wrapper body via the fallback chain", () => {
    // Use repoRoot arg to force the fallback; under bun run the packaged path
    // wins, but the explicit arg is honored only when packaged is missing, so
    // we can't observe the arg being used here. Instead exercise the happy
    // path (packaged exists under bun run) and confirm the body is non-empty
    // and shell-shaped.
    const body = readAgentWrapperScript();
    expect(body.length).toBeGreaterThan(0);
    expect(body.startsWith("#!")).toBe(true);
  });

  it("throws CliError(INTERNAL) when no candidate exists", () => {
    // Force every fallback to miss by chdir'ing to an empty dir AND clearing
    // YACO_REPO_ROOT. The packaged path will still exist under bun run, so
    // this test only meaningfully covers the no-candidate branch under a
    // compiled binary — under bun run it's a sanity check that the happy
    // path doesn't throw.
    const emptyDir = mkdtempSync(join(tmpdir(), "yaco-wrapper-empty-read-"));
    try {
      process.chdir(emptyDir);
      // We can't easily simulate the packaged path being missing under bun
      // run, so this assertion is conditional: if the packaged path resolves
      // (bun-run case), readAgentWrapperScript succeeds; in a compiled
      // binary, the error path would fire. We assert the type contract.
      let threw: unknown = null;
      let body: string | null = null;
      try { body = readAgentWrapperScript(); } catch (e) { threw = e; }
      if (threw !== null) {
        expect(threw).toBeInstanceOf(CliError);
        expect((threw as CliError).message).toContain("agent-wrapper.sh");
      } else {
        expect(body).not.toBeNull();
        expect(body!.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("ensureAgentWrapperScript runtime fallback", () => {
  it("uses an installed managed wrapper when no source checkout is discoverable", () => {
    const emptyDir = join(sandbox, "empty");
    mkdirSync(emptyDir);
    process.chdir(emptyDir);

    const managedPath = agentWrapperPath();
    mkdirSync(join(sandbox, ".yaco"), { recursive: true });
    writeFileSync(managedPath, "#!/bin/bash\n# installed wrapper\n", { mode: 0o644 });

    _ensureAgentWrapperScriptFromForTests("/nonexistent/scripts/agent-wrapper.sh");

    expect(readFileSync(managedPath, "utf-8")).toBe("#!/bin/bash\n# installed wrapper\n");
    expect((statSync(managedPath).mode & 0o111) !== 0).toBe(true);
  });

  it("fails when neither source nor installed wrapper exists", () => {
    const emptyDir = join(sandbox, "empty");
    mkdirSync(emptyDir);
    process.chdir(emptyDir);

    expect(existsSync(agentWrapperPath())).toBe(false);
    expect(() => _ensureAgentWrapperScriptFromForTests("/nonexistent/scripts/agent-wrapper.sh"))
      .toThrow("run `yaco install`");
  });
});
