/** End-to-end envelope-shape contract.
 *
 *  The CLI contract guarantees:
 *    --json success → stdout is exactly `{"ok":true,"data":<value>}\n`,
 *                     stderr is empty, exit code 0.
 *    --json failure → stderr is exactly `{"ok":false,"error":{...}}\n`,
 *                     stdout is empty, exit code per the canonical table.
 *
 *  These are spawned subprocess tests because main() calls process.exit().
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "child_process";
import { resolve } from "path";

const BIN = resolve(import.meta.dir, "../../src/main.ts");

function runYaco(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("bun", ["run", BIN, ...args], {
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? -1,
  };
}

describe("--json envelope (success)", () => {
  it("wraps stub area output in {ok:true, data} on stdout, stderr empty, exit 0", () => {
    const r = runYaco(["worktree", "--json"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    // Trim only the trailing newline emit() adds.
    const trimmed = r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout;
    const parsed = JSON.parse(trimmed);
    expect(parsed).toEqual({
      ok: true,
      data: {
        area: "worktree",
        status: "stub",
        note: "runtime lands in a later task",
      },
    });
    // No extra bytes beyond the single JSON line.
    expect(r.stdout).toBe(trimmed + "\n");
  });

  it("wraps the help payload in {ok:true, data} when no area is given", () => {
    const r = runYaco(["--json"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.data?.help).toBe("string");
    expect(parsed.data.help).toContain("yaco — YACO unified CLI");
  });
});

describe("--json envelope (failure)", () => {
  it("emits {ok:false, error:{code,message}} on stderr, stdout empty, exit 2 for USAGE", () => {
    const r = runYaco(["wat", "--json"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    const trimmed = r.stderr.endsWith("\n") ? r.stderr.slice(0, -1) : r.stderr;
    const parsed = JSON.parse(trimmed);
    expect(parsed).toEqual({
      ok: false,
      error: {
        code: "USAGE",
        message: expect.stringContaining("unknown area"),
      },
    });
    expect(r.stderr).toBe(trimmed + "\n");
  });
});

describe("text mode (no --json)", () => {
  it("writes the human error line to stderr with non-zero exit", () => {
    const r = runYaco(["wat"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error [USAGE]");
    expect(r.stderr).toContain("unknown area");
  });
});

describe("top-level help", () => {
  it("documents the `yaco <provider>` shortcut", () => {
    const r = runYaco(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("yaco <provider>");
    expect(r.stdout).toContain("yaco agent start");
    expect(r.stdout).toContain("Providers: claude, codex");
  });
});
