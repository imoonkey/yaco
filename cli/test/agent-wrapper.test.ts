/** Tests for cli/scripts/agent-wrapper.sh.
 *
 *  The wrapper is the sole shell artifact in the agent runtime — its EXIT
 *  trap must run even if the tmux pane dies abruptly, which TS can't observe
 *  from outside. These tests verify the trap behavior end-to-end by execing
 *  the script in a sandbox with mock tmux.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

const WRAPPER_PATH = resolve(import.meta.dir, "../scripts/agent-wrapper.sh");
const WRAPPER_SCRIPT = readFileSync(WRAPPER_PATH, "utf-8");

describe("agent-wrapper.sh content", () => {
  it("starts with shebang", () => {
    expect(WRAPPER_SCRIPT.startsWith("#!/bin/bash\n")).toBe(true);
  });

  it("uses YACO_AGENT_SESSIONS_DIR as the override env var", () => {
    expect(WRAPPER_SCRIPT).toContain('${YACO_AGENT_SESSIONS_DIR:-${YACO_HOME:-$HOME/.yaco}/sessions}');
  });

  it("uses YACO_HOME-rooted default state path", () => {
    expect(WRAPPER_SCRIPT).toContain('${YACO_HOME:-$HOME/.yaco}/sessions');
    expect(WRAPPER_SCRIPT).not.toContain('$HOME/.multmux/sessions');
  });

  it("uses tmux exact-match syntax (=) to prevent prefix matching", () => {
    expect(WRAPPER_SCRIPT).toContain('has-session -t "=$sn"');
    expect(WRAPPER_SCRIPT).toContain('display-message -p -t "=$sn"');
  });

  it("sets up EXIT trap that deletes state file", () => {
    expect(WRAPPER_SCRIPT).toContain("trap");
    expect(WRAPPER_SCRIPT).toContain("EXIT");
    expect(WRAPPER_SCRIPT).toContain("rm -f");
  });

  it("uses double-rm to handle async hook race", () => {
    expect(WRAPPER_SCRIPT).toContain("sleep");
    const rmCount = (WRAPPER_SCRIPT.match(/rm -f/g) || []).length;
    expect(rmCount).toBeGreaterThanOrEqual(2);
  });

  it("runs command via $@", () => {
    expect(WRAPPER_SCRIPT).toContain('"$@"');
  });

  it("exports YACO_AGENT_HANDLE for lineage capture and clears the web marker", () => {
    expect(WRAPPER_SCRIPT).toContain('export YACO_AGENT_HANDLE="$sn"');
    expect(WRAPPER_SCRIPT).toContain("unset YACO_AGENT_SPAWNED_BY");
  });
});

describe("agent-wrapper.sh execution", () => {
  const createdAt = "2026-04-10T00:00:00.000Z";
  let tmpDir: string;
  let mockBinDir: string;

  function defaultChildEnv(fakeHome: string): Record<string, string> {
    const env: Record<string, string> = {
      ...process.env,
      PATH: `${mockBinDir}:${process.env.PATH}`,
      HOME: fakeHome,
    };
    delete env.YACO_AGENT_SESSIONS_DIR;
    delete env.YACO_HOME;
    return env;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "yaco-wrapper-test-"));
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

    execSync(`bash ${WRAPPER_PATH} test ${createdAt} true`, {
      encoding: "utf-8",
      env: defaultChildEnv(fakeHome),
      timeout: 5000,
    });

    expect(existsSync(stateFile)).toBe(false);
  });

  it("passes through command arguments", () => {
    const fakeHome = join(tmpDir, "fakehome");
    const fakeSessionsDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(fakeSessionsDir, { recursive: true });
    const stateFile = join(fakeSessionsDir, "test.json");
    writeFileSync(stateFile, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);
    const outFile = join(tmpDir, "out.txt");

    execSync(`bash ${WRAPPER_PATH} test ${createdAt} bash -c 'echo hello > ${outFile}'`, {
      encoding: "utf-8",
      env: defaultChildEnv(fakeHome),
      timeout: 5000,
    });

    expect(readFileSync(outFile, "utf-8").trim()).toBe("hello");
  });

  it("exports the handle and clears the web marker for the wrapped process", () => {
    const fakeHome = join(tmpDir, "fakehome");
    const fakeSessionsDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(fakeSessionsDir, { recursive: true });
    writeFileSync(
      join(fakeSessionsDir, "test.json"),
      `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`,
    );
    const outFile = join(tmpDir, "env.txt");

    execSync(
      `bash ${WRAPPER_PATH} test ${createdAt} bash -c 'echo "H=$YACO_AGENT_HANDLE S=\${YACO_AGENT_SPAWNED_BY-unset}" > ${outFile}'`,
      {
        encoding: "utf-8",
        env: { ...defaultChildEnv(fakeHome), YACO_AGENT_SPAWNED_BY: "user:web" },
        timeout: 5000,
      },
    );

    expect(readFileSync(outFile, "utf-8").trim()).toBe("H=test S=unset");
  });

  it("does not delete state file of a prefix-matching session", () => {
    const fakeHome = join(tmpDir, "fakehome");
    const fakeSessionsDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(fakeSessionsDir, { recursive: true });

    const stateFile = join(fakeSessionsDir, "test.json");
    const prefixMatchFile = join(fakeSessionsDir, "test-2.json");
    writeFileSync(stateFile, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);
    writeFileSync(prefixMatchFile, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);

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

    execSync(`bash ${WRAPPER_PATH} test ${createdAt} true`, {
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

    execSync(`bash ${WRAPPER_PATH} test ${createdAt} true`, {
      encoding: "utf-8",
      env: defaultChildEnv(fakeHome),
      timeout: 10000,
    });

    expect(existsSync(stateFile)).toBe(true);
    expect(readFileSync(stateFile, "utf-8")).toContain('"createdAt":"2026-04-10T00:00:01.000Z"');
  });

  it("honors YACO_AGENT_SESSIONS_DIR override (wins over YACO_HOME and default)", () => {
    const fakeHome = join(tmpDir, "fakehome-override");
    const decoyDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(decoyDir, { recursive: true });
    const decoy = join(decoyDir, "test.json");
    writeFileSync(decoy, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);

    const overrideDir = join(tmpDir, "override-state");
    mkdirSync(overrideDir, { recursive: true });
    const real = join(overrideDir, "test.json");
    writeFileSync(real, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);

    execSync(`bash ${WRAPPER_PATH} test ${createdAt} true`, {
      encoding: "utf-8",
      env: { ...defaultChildEnv(fakeHome), YACO_AGENT_SESSIONS_DIR: overrideDir },
      timeout: 5000,
    });

    expect(existsSync(real)).toBe(false);
    expect(existsSync(decoy)).toBe(true);
  });

  it("honors YACO_HOME override when YACO_AGENT_SESSIONS_DIR is unset", () => {
    const fakeHome = join(tmpDir, "fakehome-yaco");
    const decoyDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(decoyDir, { recursive: true });
    const decoy = join(decoyDir, "test.json");
    writeFileSync(decoy, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);

    const yacoRoot = join(tmpDir, "yaco-override");
    const realDir = join(yacoRoot, "sessions");
    mkdirSync(realDir, { recursive: true });
    const real = join(realDir, "test.json");
    writeFileSync(real, `{"status":"idle","sessionId":"","createdAt":"${createdAt}"}`);

    execSync(`bash ${WRAPPER_PATH} test ${createdAt} true`, {
      encoding: "utf-8",
      env: { ...defaultChildEnv(fakeHome), YACO_HOME: yacoRoot },
      timeout: 5000,
    });

    expect(existsSync(real)).toBe(false);
    expect(existsSync(decoy)).toBe(true);
  });
});

describe("agent-wrapper.sh crash contract", () => {
  const createdAt = "2026-04-10T00:00:00.000Z";
  let tmpDir: string;
  let mockBinDir: string;
  let sessionsDir: string;

  /** Mock tmux that reports the session alive (has-session 0, display "test"). */
  function writeMockTmux(): void {
    writeFileSync(
      join(mockBinDir, "tmux"),
      '#!/bin/bash\nif [ "$1" = "display-message" ]; then echo "test"; fi\nif [ "$1" = "has-session" ]; then exit 0; fi\n',
      { mode: 0o755 },
    );
  }

  /** Run the wrapper with a command that exits `code`, tolerating the non-zero
   *  exit (execSync throws on it). YACO_BIN is set explicitly per test. */
  function runWrapper(code: number, yacoBin: string, extraEnv: Record<string, string> = {}): void {
    try {
      execSync(`bash ${WRAPPER_PATH} test ${createdAt} bash -c 'exit ${code}'`, {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${mockBinDir}:${process.env.PATH}`,
          YACO_AGENT_SESSIONS_DIR: sessionsDir,
          YACO_BIN: yacoBin,
          ...extraEnv,
        },
        timeout: 10000,
        stdio: "pipe",
      });
    } catch {
      /* non-zero exit from the wrapped command is expected */
    }
  }

  function stateFile(): string {
    return join(sessionsDir, "test.json");
  }

  function writeStateFile(json: string): void {
    writeFileSync(stateFile(), json);
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "yaco-wrapper-crash-"));
    mockBinDir = join(tmpDir, "bin");
    sessionsDir = join(tmpDir, "sessions");
    mkdirSync(mockBinDir);
    mkdirSync(sessionsDir);
    writeMockTmux();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("invokes `yaco agent mark-crashed` with exit code + createdAt on non-zero exit", () => {
    writeStateFile(`{"handle":"test","status":"processing","sessionId":"","createdAt":"${createdAt}"}`);
    const markFile = join(tmpDir, "mark.txt");
    // Mock yaco records its mark-crashed invocation, then exits 0 (so no fallback).
    const mockYaco = join(mockBinDir, "yaco");
    writeFileSync(
      mockYaco,
      `#!/bin/bash\nif [ "$1" = "agent" ] && [ "$2" = "mark-crashed" ]; then echo "$@" > "${markFile}"; fi\nexit 0\n`,
      { mode: 0o755 },
    );

    runWrapper(7, mockYaco);

    expect(existsSync(markFile)).toBe(true);
    const recorded = readFileSync(markFile, "utf-8").trim();
    expect(recorded).toBe(`agent mark-crashed test --exit 7 --created-at ${createdAt}`);
  });

  it("fail-closed fallback tombstones a valid crashed state when mark-crashed cannot run", () => {
    writeStateFile(
      `{"handle":"test","provider":"claude","sessionPath":"/p","pid":42,"sessionId":"s1","status":"processing","createdAt":"${createdAt}"}`,
    );

    runWrapper(139, join(mockBinDir, "does-not-exist-yaco"));

    expect(existsSync(stateFile())).toBe(true);
    const parsed = JSON.parse(readFileSync(stateFile(), "utf-8"));
    expect(parsed.status).toBe("crashed");
    expect(parsed.exitCode).toBe(139);
    expect(typeof parsed.statusEnteredAt).toBe("string");
    expect(parsed.statusEnteredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.createdAt).toBe(createdAt);
    expect(parsed.provider).toBe("claude");
    expect(parsed.pid).toBe(42);
  });

  it("fallback drops a stale blockReason and preserves lineage fields", () => {
    writeStateFile(
      `{"handle":"test","provider":"codex","sessionPath":"/p","pid":42,"sessionId":"s1","status":"blocked","createdAt":"${createdAt}","blockReason":"question","spawnedBy":"agent","parentSession":"boss"}`,
    );

    runWrapper(1, join(mockBinDir, "nope-yaco"));

    const parsed = JSON.parse(readFileSync(stateFile(), "utf-8"));
    expect(parsed.status).toBe("crashed");
    expect(parsed.exitCode).toBe(1);
    expect(parsed.blockReason).toBeUndefined();
    expect(parsed.spawnedBy).toBe("agent");
    expect(parsed.parentSession).toBe("boss");
    expect(parsed.statusEnteredAt).toBeDefined();
  });

  it("clean exit (0) deletes the state file even when YACO_BIN is broken", () => {
    writeStateFile(`{"handle":"test","status":"processing","sessionId":"","createdAt":"${createdAt}"}`);

    runWrapper(0, join(mockBinDir, "broken-yaco"));

    expect(existsSync(stateFile())).toBe(false);
  });

  it("a generation-matching kill sentinel deletes (intentional kill, not a crash)", () => {
    writeStateFile(`{"handle":"test","status":"processing","sessionId":"","createdAt":"${createdAt}"}`);
    writeFileSync(join(sessionsDir, ".killing-test"), createdAt);

    // Non-zero (SIGTERM-style) exit + broken yaco: if mis-classified as a crash,
    // the fallback would tombstone. The matching sentinel must force a clean delete.
    runWrapper(143, join(mockBinDir, "broken-yaco"));

    expect(existsSync(stateFile())).toBe(false);
  });

  it("a stale (wrong-generation) sentinel does NOT suppress a future crash (R1)", () => {
    writeStateFile(`{"handle":"test","status":"processing","sessionId":"","createdAt":"${createdAt}"}`);
    // Sentinel from a DIFFERENT (older) generation.
    writeFileSync(join(sessionsDir, ".killing-test"), "2020-01-01T00:00:00.000Z");

    runWrapper(139, join(mockBinDir, "broken-yaco"));

    expect(existsSync(stateFile())).toBe(true);
    const parsed = JSON.parse(readFileSync(stateFile(), "utf-8"));
    expect(parsed.status).toBe("crashed");
    expect(parsed.exitCode).toBe(139);
  });
});
