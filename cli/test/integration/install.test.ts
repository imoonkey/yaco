/** Integration test for tools/install.sh — full bootstrap from a clean state.
 *
 *  Verifies AC 1 (no bare `yaco install` line in tools/install.sh) and AC 8
 *  (tools/install.sh from no $BIN_DIR/yaco end-to-end succeeds: builds,
 *  installs, chains to yaco install, exits 0).
 *
 *  Hermetic: HOME, YACO_HOME, YACO_BIN_DIR all point at sandbox paths.
 *  PATH is shimmed for tmux/git/claude/codex.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
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

const REPO_ROOT = resolve(import.meta.dir, "../../..");
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
    expect(existsSync(join(env["HOME"]!, ".claude", "CLAUDE.md"))).toBe(true);
  }, 120_000);
});

// One-shot afterAll guard against any stray sandbox.
afterAll(() => {
  if (sandbox && existsSync(sandbox)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
