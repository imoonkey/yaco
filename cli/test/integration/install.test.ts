/** Integration test for tools/install.sh — full bootstrap from a clean state.
 *
 *  Verifies AC 1 (no bare `yaco install` line in tools/install.sh) and AC 8
 *  (tools/install.sh from no $BIN_DIR/yaco end-to-end succeeds: builds,
 *  installs, chains to yaco install, exits 0).
 *
 *  Hermetic: HOME, YACO_HOME, YACO_BIN_DIR all point at sandbox paths.
 *  PATH is shimmed for tmux/git/claude/codex.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const INSTALL_SH = join(REPO_ROOT, "tools", "install.sh");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-install-integ-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function makeShim(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

function withShimmedEnv(): NodeJS.ProcessEnv {
  const shimBin = join(sandbox, "shim-bin");
  mkdirSync(shimBin, { recursive: true });
  for (const c of ["tmux", "git", "claude", "codex"]) {
    makeShim(join(shimBin, c));
  }
  const binDir = join(sandbox, "bin");
  mkdirSync(binDir, { recursive: true });
  return {
    ...process.env,
    HOME: join(sandbox, "home"),
    YACO_HOME: join(sandbox, "yaco"),
    YACO_BIN_DIR: binDir,
    YACO_REPO_ROOT: REPO_ROOT,
    // Shim bin first so doctor's PATH-based checks are hermetic; binDir after
    // it so the freshly-installed yaco is also discoverable to doctor's
    // `which yaco` lookup.
    PATH: `${shimBin}:${binDir}:${process.env["PATH"] ?? ""}`,
  };
}

describe("tools/install.sh — static contract", () => {
  it("contains no bare `yaco install` invocation (AC 1)", () => {
    const body = readFileSync(INSTALL_SH, "utf-8");
    // Must use "$BIN_DIR/yaco" install (absolute form), never a bare token.
    const lines = body.split("\n");
    for (const line of lines) {
      if (/^[[:space:]]*yaco install/.test(line)) {
        throw new Error(`bare 'yaco install' found in install.sh: ${line}`);
      }
      // Equivalent JS-regex form: leading whitespace then "yaco install".
      if (/^\s*yaco install\b/.test(line)) {
        throw new Error(`bare 'yaco install' found in install.sh: ${line}`);
      }
    }
    // And the absolute-path form must be present.
    expect(body).toMatch(/"\$BIN_DIR\/yaco" install/);
  });

  it("passes bash -n syntax check", () => {
    const r = spawnSync("bash", ["-n", INSTALL_SH], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });
});

describe("tools/install.sh — end-to-end bootstrap (AC 8)", () => {
  /** The one case that runs the artifact the bootstrap just produced, because
   *  `tools/install.sh` ends with `exec "$BIN_DIR/yaco" install`. It was parked
   *  through `cli-sqlite-hop`, whose whole cost this was: the artifact then was
   *  `bun build --compile`, and Bun cannot load `node:sqlite`, so the binary
   *  built and exited 1 before reaching main. The assertions are the ones that
   *  were parked, unchanged — all they ever needed was a runnable `$BIN_DIR/yaco`.
   */
  it("from a clean $BIN_DIR (no yaco), builds + installs + exits 0", () => {
    const env = withShimmedEnv();
    // Sanity: $BIN_DIR/yaco does not exist yet.
    expect(existsSync(join(env["YACO_BIN_DIR"]!, "yaco"))).toBe(false);

    const r = spawnSync("bash", [INSTALL_SH, "--cli-only", "--skip-doctor"], {
      env,
      encoding: "utf-8",
      timeout: 90_000,
    });

    if (r.status !== 0) {
      // surface what went wrong so the failure is debuggable in CI logs
      console.error("install.sh stdout:\n", r.stdout);
      console.error("install.sh stderr:\n", r.stderr);
    }
    expect(r.status).toBe(0);

    // Post-conditions: yaco binary, wrapper, registry, global links.
    expect(existsSync(join(env["YACO_BIN_DIR"]!, "yaco"))).toBe(true);
    expect(existsSync(join(env["YACO_HOME"]!, "agent-wrapper.sh"))).toBe(true);
    expect(existsSync(join(env["YACO_HOME"]!, "projects.json"))).toBe(true);
    expect(existsSync(join(env["HOME"]!, ".claude", "skills"))).toBe(true);
    // Purely additive: install never claims a global instruction file.
    expect(existsSync(join(env["HOME"]!, ".claude", "CLAUDE.md"))).toBe(false);
  }, 120_000);

  it("installs the tarball, so the executable is not a link into this checkout", () => {
    // The point of packing: what lands on the user's PATH is the published
    // artifact. A symlink back to `cli/` would test a different thing from the
    // one npm ships, and would keep working after a packaging mistake.
    const env = withShimmedEnv();
    const r = spawnSync("bash", [INSTALL_SH, "--cli-only", "--skip-doctor"], {
      env,
      encoding: "utf-8",
      timeout: 90_000,
    });
    expect(r.status).toBe(0);

    const installed = realpathSync(join(env["YACO_BIN_DIR"]!, "yaco"));
    expect(installed).toContain(join("lib", "node_modules", "@yaco", "cli"));
    expect(installed.startsWith(REPO_ROOT)).toBe(false);
    // And the hook it wrote names the prefix's executable, not the package's
    // own launcher, because the bootstrap exports $YACO_BIN_DIR.
    const settings = JSON.parse(
      readFileSync(join(env["HOME"]!, ".claude", "settings.json"), "utf-8"),
    );
    const commands: string[] = Object.values(settings.hooks ?? {})
      .flatMap((groups) => groups as { hooks?: { command?: string }[] }[])
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command ?? "");
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.split(" ")[0]).toBe(join(env["YACO_BIN_DIR"]!, "yaco"));
    }
  }, 120_000);

  it("refuses a $YACO_BIN_DIR that is not a prefix's bin/", () => {
    // npm --global writes executables to <prefix>/bin and nowhere else, so a
    // bin dir named anything else would silently install somewhere the caller
    // never asked for — and the hook command would name a yaco that is not the
    // one just installed.
    const env = withShimmedEnv();
    env["YACO_BIN_DIR"] = join(sandbox, "tools");
    const r = spawnSync("bash", [INSTALL_SH, "--cli-only", "--skip-doctor"], {
      env,
      encoding: "utf-8",
      timeout: 60_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("must end in /bin");
    expect(existsSync(join(sandbox, "tools"))).toBe(false);
  }, 90_000);
});

describe("tools/install.sh — public fresh clone with no plan/", () => {
  it("bootstraps and runs the closing doctor to exit 0", () => {
    // Export HEAD the way the public tree ships it — plan/ is untracked, so
    // the archive is the public repository byte for byte. This is the README's
    // first-run command, doctor included: the end-to-end test above passes
    // --skip-doctor and runs against this checkout, which HAS a plan/, so
    // neither of them covers the flow an outside user actually runs.
    const clone = join(sandbox, "fresh-clone");
    mkdirSync(clone, { recursive: true });
    const exported = spawnSync(
      "bash",
      ["-c", `git -C "${REPO_ROOT}" archive HEAD | tar -x -C "${clone}"`],
      { encoding: "utf-8" },
    );
    expect(exported.status).toBe(0);
    expect(existsSync(join(clone, "plan"))).toBe(false);
    expect(existsSync(join(clone, "tools", "install.sh"))).toBe(true);
    // The pack reads the root lockfile, so a public clone must carry one.
    expect(existsSync(join(clone, "package-lock.json"))).toBe(true);

    const env = { ...withShimmedEnv(), YACO_REPO_ROOT: clone };
    const r = spawnSync("bash", [join(clone, "tools", "install.sh"), "--cli-only"], {
      env,
      encoding: "utf-8",
      timeout: 90_000,
    });
    if (r.status !== 0) {
      console.error("install.sh stdout:\n", r.stdout);
      console.error("install.sh stderr:\n", r.stderr);
    }
    expect(r.status).toBe(0);
    // The closing doctor ran, saw no task graph, and reported it as a skip —
    // which is why the exit code is 0.
    expect(r.stderr).toContain("SKIP task-graph");
    expect(r.stderr).toContain(join(clone, "plan", "tasks"));
    expect(r.stdout).toContain("ran yaco doctor");
  }, 120_000);
});

describe("tools/install.sh — dependency bootstrap from a never-installed clone", () => {
  /** `git clone && tools/install.sh`, byte for byte: the whole tree, including
   *  the root workspace manifest and npm lockfile, and no `node_modules`
   *  anywhere. That root manifest is exactly what makes this different from the
   *  published-subset case above — a dependency install run inside `cli/`
   *  discovers the monorepo workspace through it. A trimmed archive cannot
   *  stand in: with the other workspace members absent, the root stops being a
   *  workspace and the discovery never happens. */
  function fullClone(): string {
    const clone = join(sandbox, "clone");
    mkdirSync(clone, { recursive: true });
    const exported = spawnSync(
      "bash",
      ["-c", `git -C "${REPO_ROOT}" archive HEAD | tar -x -C "${clone}"`],
      { encoding: "utf-8" },
    );
    expect(exported.status).toBe(0);
    expect(existsSync(join(clone, "package-lock.json"))).toBe(true);
    expect(existsSync(join(clone, "node_modules"))).toBe(false);
    expect(existsSync(join(clone, "cli", "node_modules"))).toBe(false);
    return clone;
  }

  function bootstrap(clone: string): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync("bash", [join(clone, "tools", "install.sh"), "--cli-only", "--skip-doctor"], {
      env: { ...withShimmedEnv(), YACO_REPO_ROOT: clone },
      encoding: "utf-8",
      timeout: 90_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("installs what the build needs, then builds", () => {
    const clone = fullClone();
    const r = bootstrap(clone);
    if (r.status !== 0) console.error("install.sh stdout:\n", r.stdout, "\nstderr:\n", r.stderr);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("installing cli dependencies");
    // The two ways this has actually broken: the build cannot resolve the
    // dependency, or the install that was supposed to supply it walked up to
    // the monorepo workspace and died migrating the npm lockfile.
    expect(r.stderr).not.toContain("Could not resolve");
    expect(r.stderr).not.toContain("lockfile is frozen");
    expect(existsSync(join(sandbox, "bin", "yaco"))).toBe(true);
  }, 120_000);

  it("re-runs without reinstalling", () => {
    const clone = fullClone();
    expect(bootstrap(clone).status).toBe(0);

    // Already installed: the pack probe succeeds, so nothing is fetched.
    const again = bootstrap(clone);
    expect(again.status).toBe(0);
    expect(again.stdout).not.toContain("installing cli dependencies");
  }, 180_000);

  it("refuses to reinstall over a populated node_modules, and prunes nothing", () => {
    // `npm ci --workspace cli` deletes every workspace it was not asked about,
    // so on a developer machine the remedial install would silently take out
    // the app's dependency tree — minutes of native compilation, removed to fix
    // a problem the script cannot even diagnose. The bootstrap install is for a
    // clone that has never been installed; anything else is reported.
    const clone = fullClone();
    expect(bootstrap(clone).status).toBe(0);

    const otherWorkspaceDep = join(clone, "node_modules", "not-ours");
    mkdirSync(otherWorkspaceDep, { recursive: true });
    writeFileSync(join(otherWorkspaceDep, "marker"), "someone else's install\n");
    // Break the build so the probe fails with dependencies present.
    writeFileSync(join(clone, "cli", "src", "main.ts"), "\nthis is not valid typescript (((\n", {
      flag: "a",
    });

    const r = bootstrap(clone);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("installing cli dependencies");
    expect(r.stderr).toContain("dependencies already present");
    expect(r.stderr).toContain("npm ci");
    expect(existsSync(join(otherWorkspaceDep, "marker"))).toBe(true);
  }, 180_000);

  it("reports the build failure that asked for the install, not the install's own", () => {
    // The probe cannot say *why* the pack failed, so a source error selects the
    // install branch too. On a machine that cannot reach a registry the install
    // then fails, and its error is a red herring — the cause has to survive.
    const clone = fullClone();
    writeFileSync(join(clone, "cli", "src", "main.ts"), "\nthis is not valid typescript (((\n", {
      flag: "a",
    });

    const r = spawnSync("bash", [join(clone, "tools", "install.sh"), "--cli-only", "--skip-doctor"], {
      env: {
        ...withShimmedEnv(),
        YACO_REPO_ROOT: clone,
        // No reachable registry and no warm cache, so the remedial install
        // cannot quietly succeed.
        npm_config_registry: "http://127.0.0.1:9/",
        npm_config_cache: join(sandbox, "empty-npm-cache"),
        npm_config_fetch_retries: "0",
        npm_config_fetch_timeout: "5000",
      },
      encoding: "utf-8",
      timeout: 120_000,
    });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not install the cli dependencies");
    // The pack's own failure, kept verbatim underneath the install's.
    expect(r.stderr).toContain("the build failure that asked for them was:");
    expect(r.stderr).toContain("@yaco/cli");
  }, 180_000);
});

// One-shot afterAll guard against any stray sandbox.
afterAll(() => {
  if (sandbox && existsSync(sandbox)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
