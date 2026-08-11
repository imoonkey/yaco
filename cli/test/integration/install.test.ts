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
  it("from a clean $BIN_DIR (no yaco), builds + installs + exits 0", () => {
    const env = withShimmedEnv();
    // Sanity: $BIN_DIR/yaco does not exist yet.
    expect(existsSync(join(env["YACO_BIN_DIR"]!, "yaco"))).toBe(false);

    const r = spawnSync("bash", [INSTALL_SH, "--cli-only", "--skip-doctor"], {
      env,
      encoding: "utf-8",
      // bun build can take a while; allow 90s.
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
});

describe("tools/install.sh — public fresh clone with no plan/", () => {
  it("bootstraps and runs the closing doctor to exit 0", () => {
    // Export HEAD the way the public tree ships it — everything install.sh
    // needs, and no plan/ (the release history is scrubbed of it). This is the
    // README's first-run command, doctor included: the previous end-to-end
    // test passes --skip-doctor and runs against this checkout, which HAS a
    // plan/, so neither of them covers the flow an outside user actually runs.
    const clone = join(sandbox, "fresh-clone");
    mkdirSync(clone, { recursive: true });
    const exported = spawnSync(
      "bash",
      ["-c", `git -C "${REPO_ROOT}" archive HEAD tools cli agent-config | tar -x -C "${clone}"`],
      { encoding: "utf-8" },
    );
    expect(exported.status).toBe(0);
    expect(existsSync(join(clone, "plan"))).toBe(false);
    expect(existsSync(join(clone, "tools", "install.sh"))).toBe(true);

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

  it("re-runs without reinstalling, and repairs either shape of interrupted install", () => {
    const clone = fullClone();
    expect(bootstrap(clone).status).toBe(0);

    // Already installed: nothing to fetch.
    const again = bootstrap(clone);
    expect(again.status).toBe(0);
    expect(again.stdout).not.toContain("installing cli dependencies");

    // Two residues an interrupted install leaves, and every readiness signal
    // short of asking the bundler has mistaken one of them for a finished
    // install: an empty node_modules, and a package present but incomplete —
    // its manifest written, its entry point never extracted.
    const deps = join(clone, "cli", "node_modules");
    const damage = [
      () => {
        rmSync(deps, { recursive: true, force: true });
        mkdirSync(deps, { recursive: true });
      },
      () => {
        const manifest = readFileSync(join(deps, "smol-toml", "package.json"), "utf-8");
        rmSync(join(deps, "smol-toml"), { recursive: true, force: true });
        mkdirSync(join(deps, "smol-toml"), { recursive: true });
        writeFileSync(join(deps, "smol-toml", "package.json"), manifest);
      },
    ];
    for (const breakIt of damage) {
      breakIt();
      const repaired = bootstrap(clone);
      if (repaired.status !== 0) console.error("install.sh stderr:\n", repaired.stderr);
      expect(repaired.status).toBe(0);
      expect(repaired.stdout).toContain("installing cli dependencies");
      expect(repaired.stderr).not.toContain("Could not resolve");
    }
  }, 180_000);

  it("reports the build failure that asked for the install, not the install's own", () => {
    // The probe cannot say *why* the bundle failed, so a source error selects
    // the install branch too. On a machine that cannot reach a registry the
    // install then fails, and its error is a red herring — the cause has to
    // survive.
    const clone = fullClone();
    expect(bootstrap(clone).status).toBe(0);
    writeFileSync(join(clone, "cli", "src", "main.ts"), "\nthis is not valid typescript (((\n", { flag: "a" });
    rmSync(join(clone, "cli", "node_modules"), { recursive: true, force: true });

    const r = spawnSync("bash", [join(clone, "tools", "install.sh"), "--cli-only", "--skip-doctor"], {
      env: {
        ...withShimmedEnv(),
        YACO_REPO_ROOT: clone,
        // No reachable registry and no warm cache, so the remedial install
        // cannot quietly succeed.
        BUN_CONFIG_REGISTRY: "http://127.0.0.1:9/",
        BUN_INSTALL_CACHE_DIR: join(sandbox, "empty-bun-cache"),
      },
      encoding: "utf-8",
      timeout: 90_000,
    });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not install the cli dependencies");
    expect(r.stderr).toContain("Expected");
    expect(r.stderr).toContain("cli/src/main.ts");
  }, 120_000);
});

// One-shot afterAll guard against any stray sandbox.
afterAll(() => {
  if (sandbox && existsSync(sandbox)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
