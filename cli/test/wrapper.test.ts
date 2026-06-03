import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { WRAPPER_V2_SCRIPT } from "../src/hooks.ts";

describe("wrapper v2 script content", () => {
  it("starts with shebang", () => {
    expect(WRAPPER_V2_SCRIPT.startsWith("#!/bin/bash\n")).toBe(true);
  });

  it("does NOT reference MULTMUX_SESSION_SUFFIX", () => {
    expect(WRAPPER_V2_SCRIPT).not.toContain("MULTMUX_SESSION_SUFFIX");
  });

  it("honors MULTMUX_STATE_DIR override (parameterized state-dir resolver)", () => {
    // The override stays as an explicit test/escape hatch; the default is
    // ${YACO_HOME:-$HOME/.yaco}/sessions and the env var takes precedence.
    expect(WRAPPER_V2_SCRIPT).toContain('${MULTMUX_STATE_DIR:-${YACO_HOME:-$HOME/.yaco}/sessions}');
  });

  it("uses YACO_HOME-rooted global path", () => {
    expect(WRAPPER_V2_SCRIPT).toContain('${YACO_HOME:-$HOME/.yaco}/sessions');
    // Old root must not leak back in.
    expect(WRAPPER_V2_SCRIPT).not.toContain('$HOME/.multmux/sessions');
  });

  it("uses tmux exact-match syntax (=) to prevent prefix matching", () => {
    expect(WRAPPER_V2_SCRIPT).toContain('has-session -t "=$sn"');
    expect(WRAPPER_V2_SCRIPT).toContain('display-message -p -t "=$sn"');
    expect(WRAPPER_V2_SCRIPT).not.toMatch(/has-session -t "\$sn"/);
  });

  it("sets up EXIT trap that deletes state file", () => {
    expect(WRAPPER_V2_SCRIPT).toContain("trap");
    expect(WRAPPER_V2_SCRIPT).toContain("EXIT");
    expect(WRAPPER_V2_SCRIPT).toContain("rm -f");
  });

  it("uses double-rm to handle async hook race", () => {
    expect(WRAPPER_V2_SCRIPT).toContain("sleep");
    const rmCount = (WRAPPER_V2_SCRIPT.match(/rm -f/g) || []).length;
    expect(rmCount).toBeGreaterThanOrEqual(2);
  });

  it("runs command via $@", () => {
    expect(WRAPPER_V2_SCRIPT).toContain('"$@"');
  });
});

describe("wrapper v2 script execution", () => {
  const createdAt = "2026-04-10T00:00:00.000Z";
  let tmpDir: string;
  let wrapperPath: string;
  let mockBinDir: string;

  function defaultChildEnv(fakeHome: string): Record<string, string> {
    const env: Record<string, string> = {
      ...process.env,
      PATH: `${mockBinDir}:${process.env.PATH}`,
      HOME: fakeHome,
    };
    // Make sure ambient env can't push state-dir resolution off the default
    // ${HOME}/.yaco/sessions branch we're exercising.
    delete env.MULTMUX_STATE_DIR;
    delete env.YACO_HOME;
    return env;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "multmux-wrapper-test-"));
    wrapperPath = join(tmpDir, "wrapper-v2.sh");
    writeFileSync(wrapperPath, WRAPPER_V2_SCRIPT, { mode: 0o755 });

    mockBinDir = join(tmpDir, "bin");
    mkdirSync(mockBinDir);
    writeFileSync(
      join(mockBinDir, "tmux"),
      '#!/bin/bash\nif [ "$1" = "display-message" ]; then echo "test"; fi\nif [ "$1" = "has-session" ]; then exit 0; fi\n',
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes state file when wrapped command exits", () => {
    const fakeHome = join(tmpDir, "fakehome");
    const fakeSessionsDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(fakeSessionsDir, { recursive: true });
    const stateFile = join(fakeSessionsDir, "test.json");
    writeFileSync(stateFile, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);

    const { execSync } = require("child_process");
    execSync(`bash ${wrapperPath} test ${createdAt} true`, {
      encoding: "utf-8",
      env: defaultChildEnv(fakeHome),
      timeout: 5000,
    });

    expect(existsSync(stateFile)).toBe(false);
  });

  it("deletes state file when wrapped command fails", () => {
    const fakeHome = join(tmpDir, "fakehome");
    const fakeSessionsDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(fakeSessionsDir, { recursive: true });
    const stateFile = join(fakeSessionsDir, "test.json");
    writeFileSync(stateFile, `{"status":"processing","sessionId":"","createdAt":"${createdAt}"}`);

    const { execSync } = require("child_process");
    try {
      execSync(`bash ${wrapperPath} test ${createdAt} false`, {
        encoding: "utf-8",
        env: defaultChildEnv(fakeHome),
        timeout: 5000,
      });
    } catch {
      // expected — `false` exits with code 1
    }

    expect(existsSync(stateFile)).toBe(false);
  });

  it("passes through command arguments", () => {
    const fakeHome = join(tmpDir, "fakehome");
    const fakeSessionsDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(fakeSessionsDir, { recursive: true });
    const stateFile = join(fakeSessionsDir, "test.json");
    writeFileSync(stateFile, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);
    const outFile = join(tmpDir, "out.txt");

    const { execSync } = require("child_process");
    execSync(`bash ${wrapperPath} test ${createdAt} bash -c 'echo hello > ${outFile}'`, {
      encoding: "utf-8",
      env: defaultChildEnv(fakeHome),
      timeout: 5000,
    });

    expect(readFileSync(outFile, "utf-8").trim()).toBe("hello");
  });

  it("cleans up orphaned .tmp files on exit", () => {
    const fakeHome = join(tmpDir, "fakehome");
    const fakeSessionsDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(fakeSessionsDir, { recursive: true });
    const stateFile = join(fakeSessionsDir, "test.json");
    writeFileSync(stateFile, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);
    writeFileSync(join(fakeSessionsDir, "test.json.12345.tmp"), '{"status":"idle"}');
    writeFileSync(join(fakeSessionsDir, "test.json.99999.tmp"), '{"status":"idle"}');

    const { execSync } = require("child_process");
    execSync(`bash ${wrapperPath} test ${createdAt} true`, {
      encoding: "utf-8",
      env: defaultChildEnv(fakeHome),
      timeout: 10000,
    });

    expect(existsSync(stateFile)).toBe(false);
    expect(existsSync(join(fakeSessionsDir, "test.json.12345.tmp"))).toBe(false);
    expect(existsSync(join(fakeSessionsDir, "test.json.99999.tmp"))).toBe(false);
  });

  it("does not delete state file of a prefix-matching session", () => {
    const fakeHome = join(tmpDir, "fakehome");
    const fakeSessionsDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(fakeSessionsDir, { recursive: true });

    // "test" is dead, but "test-2" is alive — prefix match must not cross-delete
    const stateFile = join(fakeSessionsDir, "test.json");
    const prefixMatchFile = join(fakeSessionsDir, "test-2.json");
    writeFileSync(stateFile, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);
    writeFileSync(prefixMatchFile, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);

    // Mock: exact match "=test" → dead (exit 1), "=test-2" → alive (exit 0)
    writeFileSync(
      join(mockBinDir, "tmux"),
      '#!/bin/bash\n'
        + 'if [ "$1" = "has-session" ]; then\n'
        + '  name="${3#=}"\n'
        + '  if [ "$name" = "test" ]; then exit 1; fi\n'
        + '  if [ "$name" = "test-2" ]; then exit 0; fi\n'
        + '  exit 1\n'
        + 'fi\n'
        + 'if [ "$1" = "display-message" ]; then echo "test"; fi\n',
      { mode: 0o755 },
    );

    const { execSync } = require("child_process");
    execSync(`bash ${wrapperPath} test ${createdAt} true`, {
      encoding: "utf-8",
      env: defaultChildEnv(fakeHome),
      timeout: 5000,
    });

    expect(existsSync(stateFile)).toBe(false);
    expect(existsSync(prefixMatchFile)).toBe(true);
  });

  it("does not delete a newer state file when the same handle is reused", () => {
    const fakeHome = join(tmpDir, "fakehome");
    const fakeSessionsDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(fakeSessionsDir, { recursive: true });
    const stateFile = join(fakeSessionsDir, "test.json");
    writeFileSync(
      stateFile,
      '{"status":"idle","sessionId":"","createdAt":"2026-04-10T00:00:01.000Z"}',
    );

    const { execSync } = require("child_process");
    execSync(`bash ${wrapperPath} test ${createdAt} true`, {
      encoding: "utf-8",
      env: defaultChildEnv(fakeHome),
      timeout: 10000,
    });

    expect(existsSync(stateFile)).toBe(true);
    expect(readFileSync(stateFile, "utf-8")).toContain('"createdAt":"2026-04-10T00:00:01.000Z"');
  });

  it("honors MULTMUX_STATE_DIR override (wins over YACO_HOME and default)", () => {
    const fakeHome = join(tmpDir, "fakehome-override");
    // Decoy file at default ${HOME}/.yaco/sessions — must remain untouched.
    const decoyDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(decoyDir, { recursive: true });
    const decoy = join(decoyDir, "test.json");
    writeFileSync(decoy, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);

    // Real state file lives under MULTMUX_STATE_DIR.
    const overrideDir = join(tmpDir, "override-state");
    mkdirSync(overrideDir, { recursive: true });
    const real = join(overrideDir, "test.json");
    writeFileSync(real, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);

    const { execSync } = require("child_process");
    execSync(`bash ${wrapperPath} test ${createdAt} true`, {
      encoding: "utf-8",
      env: { ...defaultChildEnv(fakeHome), MULTMUX_STATE_DIR: overrideDir },
      timeout: 5000,
    });

    expect(existsSync(real)).toBe(false);
    expect(existsSync(decoy)).toBe(true);
  });

  it("honors YACO_HOME override when MULTMUX_STATE_DIR is unset", () => {
    const fakeHome = join(tmpDir, "fakehome-yaco");
    // Decoy file at default ${HOME}/.yaco/sessions — must remain untouched
    // because YACO_HOME takes precedence over the homedir fallback.
    const decoyDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(decoyDir, { recursive: true });
    const decoy = join(decoyDir, "test.json");
    writeFileSync(decoy, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);

    const yacoRoot = join(tmpDir, "yaco-override");
    const realDir = join(yacoRoot, "sessions");
    mkdirSync(realDir, { recursive: true });
    const real = join(realDir, "test.json");
    writeFileSync(real, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);

    const { execSync } = require("child_process");
    execSync(`bash ${wrapperPath} test ${createdAt} true`, {
      encoding: "utf-8",
      env: { ...defaultChildEnv(fakeHome), YACO_HOME: yacoRoot },
      timeout: 5000,
    });

    expect(existsSync(real)).toBe(false);
    expect(existsSync(decoy)).toBe(true);
  });
});
