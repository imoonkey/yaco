/** Tests for `yaco init links` — direct runInitLinks calls plus subprocess
 *  coverage for exit codes and dispatcher wiring.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runInitLinks } from "../../../src/commands/init.ts";

import { runCli } from "../../helpers/cli-process.ts";

const TMP_ROOTS: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yaco-init-"));
  TMP_ROOTS.push(dir);
  return dir;
}

function withClaudeMd(dir: string): string {
  writeFileSync(join(dir, "CLAUDE.md"), "# project root\n", "utf-8");
  return dir;
}

function runYaco(
  args: string[],
  cwd?: string,
): { stdout: string; stderr: string; status: number } {
  const r = runCli(args, { env: { ...process.env, NO_COLOR: "1" }, cwd, timeout: 20_000 });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? -1,
  };
}

afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

describe("runInitLinks (pure)", () => {
  it("creates all four symlinks when CLAUDE.md exists", () => {
    const dir = withClaudeMd(tempDir());
    const result = runInitLinks(dir);
    expect(result.cwd).toBe(resolve(dir));
    expect(result.links.map((l) => l.path.split("/").pop())).toEqual([
      ".agents",
      ".codex",
      "AGENTS.md",
      "GEMINI.md",
    ]);
    expect(result.links.every((l) => l.action === "created")).toBe(true);

    for (const name of [".agents", ".codex", "AGENTS.md", "GEMINI.md"]) {
      const st = lstatSync(join(dir, name));
      expect(st.isSymbolicLink()).toBe(true);
    }
    expect(readlinkSync(join(dir, ".agents"))).toBe(".claude");
    expect(readlinkSync(join(dir, ".codex"))).toBe(".claude");
    expect(readlinkSync(join(dir, "AGENTS.md"))).toBe("CLAUDE.md");
    expect(readlinkSync(join(dir, "GEMINI.md"))).toBe("CLAUDE.md");
  });

  it("auto-creates .claude/ if missing", () => {
    const dir = withClaudeMd(tempDir());
    runInitLinks(dir);
    const st = lstatSync(join(dir, ".claude"));
    expect(st.isDirectory()).toBe(true);
  });

  it("is idempotent: a second run replaces existing symlinks without error", () => {
    const dir = withClaudeMd(tempDir());
    runInitLinks(dir);
    const second = runInitLinks(dir);
    expect(second.links.every((l) => l.action === "replaced")).toBe(true);
    expect(lstatSync(join(dir, ".agents")).isSymbolicLink()).toBe(true);
  });

  it("throws ENV when CLAUDE.md is missing", () => {
    const dir = tempDir();
    expect(() => runInitLinks(dir)).toThrow(/no CLAUDE.md found/);
    let code: string | undefined;
    try {
      runInitLinks(dir);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("ENV");
  });

  it("treats a symlink CLAUDE.md as satisfying the precondition", () => {
    const dir = tempDir();
    // CLAUDE.md is itself a symlink to a target that may not exist yet —
    // the original shell helper accepted this; we mirror the behavior.
    symlinkSync("README.md", join(dir, "CLAUDE.md"));
    expect(() => runInitLinks(dir)).not.toThrow();
  });

  it("refuses to overwrite a regular file at a target path", () => {
    const dir = withClaudeMd(tempDir());
    writeFileSync(join(dir, "AGENTS.md"), "real content\n", "utf-8");
    let code: string | undefined;
    let msg = "";
    try {
      runInitLinks(dir);
    } catch (e) {
      const err = e as { code?: string; message: string };
      code = err.code;
      msg = err.message;
    }
    expect(code).toBe("IO");
    expect(msg).toContain("AGENTS.md");
    expect(msg).toContain("non-symlink");
  });

  it("refuses to overwrite a directory at a target path", () => {
    const dir = withClaudeMd(tempDir());
    mkdirSync(join(dir, ".agents"));
    let code: string | undefined;
    try {
      runInitLinks(dir);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("IO");
  });
});

describe("yaco init — dispatcher", () => {
  it("`yaco init` returns help via dispatcher", () => {
    const dir = tempDir();
    const r = runYaco(["init"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("yaco init");
    expect(r.stdout).toContain("links");
  });

  it("`yaco init links` from cwd containing CLAUDE.md exits 0", () => {
    const dir = withClaudeMd(tempDir());
    const r = runYaco(["init", "links"], dir);
    expect(r.status).toBe(0);
    expect(lstatSync(join(dir, ".agents")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, "AGENTS.md")).isSymbolicLink()).toBe(true);
  });

  it("`yaco init links` honors --cwd flag", () => {
    const dir = withClaudeMd(tempDir());
    const other = tempDir();
    const r = runYaco(["init", "links", "--cwd", dir], other);
    expect(r.status).toBe(0);
    expect(lstatSync(join(dir, ".codex")).isSymbolicLink()).toBe(true);
  });

  it("`yaco init links` exits 3 when CLAUDE.md is missing", () => {
    const dir = tempDir();
    const r = runYaco(["init", "links"], dir);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("no CLAUDE.md found");
  });

  it("`yaco init links` exits 1 when a non-symlink occupies a target path", () => {
    const dir = withClaudeMd(tempDir());
    writeFileSync(join(dir, "GEMINI.md"), "real\n", "utf-8");
    const r = runYaco(["init", "links"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("GEMINI.md");
  });

  it("`yaco init links --json` failure shape on missing CLAUDE.md", () => {
    const dir = tempDir();
    const r = runYaco(["init", "links", "--json"], dir);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    const parsed = JSON.parse(r.stderr);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("ENV");
    expect(parsed.error.message).toContain("no CLAUDE.md found");
  });

  it("`yaco init links --json` success shape includes the four link actions", () => {
    const dir = withClaudeMd(tempDir());
    const r = runYaco(["init", "links", "--json"], dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.data.links)).toBe(true);
    expect(parsed.data.links).toHaveLength(4);
    const names = parsed.data.links.map((l: { path: string }) =>
      l.path.split("/").pop(),
    );
    expect(names).toEqual([".agents", ".codex", "AGENTS.md", "GEMINI.md"]);
  });

  it("`yaco init nope` rejects unknown subcommand with USAGE", () => {
    const dir = tempDir();
    const r = runYaco(["init", "nope"], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown subcommand");
  });

  it("`yaco init links --bogus` rejects unknown flag with USAGE", () => {
    const dir = withClaudeMd(tempDir());
    const r = runYaco(["init", "links", "--bogus"], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("USAGE");
  });
});
