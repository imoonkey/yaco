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

  it("delegates the Node floor to the launcher's comparator, keeping one copy", () => {
    // A second hand-written comparator here is how `24.15.0-rc.1` was admitted
    // by the installer and refused by the launcher: the shell copy mapped the
    // prerelease patch component to NaN, and every comparison against NaN is
    // false. `test/unit/node-floor.test.ts` is the table; this asserts the
    // installer is under it rather than beside it.
    const body = readFileSync(INSTALL_SH, "utf-8");
    expect(body).toContain("cli/bin/node-floor.mjs");
    expect(body).toContain("belowNodeFloor");
    // Comments may name the version — the prose explaining this rule does.
    // What must not exist is a second executable statement of it.
    const code = body
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(code).not.toMatch(/\d+\.\d+\.\d+/);
    expect(code).not.toMatch(/split\(["']\.["']\)/);
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

  /** The cases below share one piece of damage — a syntax error in
   *  `cli/src/main.ts` — and differ only in what is in `node_modules`.
   *
   *  A source error is the right damage because `npm pack` reifies the
   *  workspace before running `prepack`, so anything merely *missing* from
   *  `node_modules` gets silently reinstalled and the dependency branch is
   *  never reached. A syntax error is one npm cannot fix.
   *
   *  These cases end non-zero on purpose: the dependency install runs, and then
   *  the second pack fails on the source error it could never have addressed. */
  function breakTheSource(clone: string): void {
    writeFileSync(join(clone, "cli", "src", "main.ts"), "\nthis is not valid typescript (((\n", {
      flag: "a",
    });
  }

  it("reinstalls into an already-populated tree", () => {
    // An interrupted first run leaves a populated `node_modules`, and the
    // README advertises this script as the recovery path — so a populated
    // directory cannot be the state that stops it.
    const clone = fullClone();
    expect(bootstrap(clone).status).toBe(0);
    expect(existsSync(join(clone, "node_modules", "esbuild"))).toBe(true);
    // The staged install does not carry npm's hidden lock across: the merged
    // tree is not the one it describes, and its absence makes a later
    // `npm install` verify rather than trust.
    expect(existsSync(join(clone, "node_modules", ".package-lock.json"))).toBe(false);

    breakTheSource(clone);
    const r = bootstrap(clone);
    expect(r.stdout).toContain("installing cli dependencies");
  }, 300_000);

  it("reinstalls into a tree whose install never got as far as a record", () => {
    // npm replaces `node_modules` while installing, so an install killed early
    // leaves a directory with no `.package-lock.json` in it — the state a marker
    // file placed inside `node_modules` could not survive either.
    const clone = fullClone();
    mkdirSync(join(clone, "node_modules", "half-extracted"), { recursive: true });
    expect(existsSync(join(clone, "node_modules", ".package-lock.json"))).toBe(false);

    breakTheSource(clone);
    const r = bootstrap(clone);
    expect(r.stdout).toContain("installing cli dependencies");
    expect(r.stderr).not.toContain("wider than this bootstrap's");
  }, 300_000);

  it("installs dependencies without pruning a wider install, whatever npm's metadata says", () => {
    // The load-bearing property. `npm ci --workspace cli` run against the repo
    // deletes every workspace it was not asked about, which on a developer
    // machine is an app/ tree and minutes of native compilation. Deciding when
    // that is safe was the wrong question — every ownership signal tried either
    // could not survive the operation it described or failed open when missing —
    // so the install resolves in an isolated stage and is copied in.
    //
    // The metadata here is deliberately unusable: a real second workspace is
    // installed, a foreign directory is planted, and npm's hidden lock is
    // corrupted. Nothing about this tree says it is ours, and nothing needs to.
    const clone = fullClone();
    expect(bootstrap(clone).status).toBe(0);

    // `codex-transcribe` has no runtime dependencies, so this is cheap and
    // still a real second-workspace install rather than a forged one.
    const second = spawnSync(
      "npm",
      ["install", "--workspace", "packages/codex-transcribe", "--ignore-scripts", "--omit=optional"],
      { cwd: clone, encoding: "utf-8", timeout: 300_000 },
    );
    expect(second.status).toBe(0);
    const secondWorkspaceLink = join(clone, "node_modules", "@yaco", "codex-transcribe");
    expect(existsSync(secondWorkspaceLink)).toBe(true);

    const foreign = join(clone, "node_modules", "not-ours");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "marker"), "someone else's install\n");
    writeFileSync(join(clone, "node_modules", ".package-lock.json"), "{{{ corrupt\n");
    breakTheSource(clone);

    const r = bootstrap(clone);
    expect(r.stdout).toContain("installing cli dependencies");
    // Everything that was there before is still there.
    expect(existsSync(join(foreign, "marker"))).toBe(true);
    expect(existsSync(secondWorkspaceLink)).toBe(true);
    // ...except the record, which described the tree before the merge and now
    // describes nothing that exists. Leaving it would hand a later npm
    // operation metadata for the wrong tree — here, a corrupt one.
    expect(existsSync(join(clone, "node_modules", ".package-lock.json"))).toBe(false);
  }, 300_000);

  it("bootstraps from a checkout path containing a URL-significant character", () => {
    // `import()` reads its argument as a URL, so importing the shared Node-floor
    // module by bare path truncated the checkout at a `#` and died before the
    // pack. Nothing else in this file uses a path that would notice.
    const clone = join(sandbox, "repo#checkout");
    mkdirSync(clone, { recursive: true });
    expect(
      spawnSync("bash", ["-c", `git -C "${REPO_ROOT}" archive HEAD | tar -x -C "${clone}"`], {
        encoding: "utf-8",
      }).status,
    ).toBe(0);

    const r = bootstrap(clone);
    if (r.status !== 0) console.error("install.sh stderr:\n", r.stderr);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(existsSync(join(sandbox, "bin", "yaco"))).toBe(true);
  }, 300_000);

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
