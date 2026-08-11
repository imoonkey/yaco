/** Unit tests for `yaco install` — direct runInstall() calls.
 *
 *  Every test runs in an isolated tmpdir with $HOME, $YACO_HOME, $YACO_BIN_DIR,
 *  $YACO_REPO_ROOT all pointing at sandbox paths. No real-home modifications.
 *
 *  The one subprocess test here (`fresh clone exits 0`) is a subprocess because
 *  the assertion is about the real exit code, not to escape a module mock:
 *  `vi.mock` is file-scoped, so lifecycle-guards.test.ts's mocks cannot reach
 *  here and the real lifecycle.ts runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { PACKAGE_ROOT, PACKAGED_SKILLS_DIR } from "../../../src/package-root.ts";
import { runInstall, type InstallReport } from "../../../src/commands/install.ts";
import { runCli } from "../../helpers/cli-process.ts";

/** The manifest is the package's own skills listing, so the fixtures are the
 *  skills this package actually ships — there is no way to stage a different
 *  one, and asserting against the real names is what makes these tests agree
 *  with what an installed user gets. */
const SHIPPED_SKILLS: string[] = readdirSync(PACKAGED_SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const SKILL_A = SHIPPED_SKILLS[0]!;
const SKILL_B = SHIPPED_SKILLS[1]!;

function shippedSkill(name: string): string {
  return join(PACKAGED_SKILLS_DIR, name);
}

const ORIG = {
  HOME: process.env["HOME"],
  YACO_HOME: process.env["YACO_HOME"],
  YACO_BIN_DIR: process.env["YACO_BIN_DIR"],
  YACO_REPO_ROOT: process.env["YACO_REPO_ROOT"],
  PATH: process.env["PATH"],
};

let sandbox: string;
let repoRoot: string;
let binDir: string;

function makeShim(path: string): void {
  mkdirSync(join(path, "..", "."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-install-unit-"));
  process.env["HOME"] = join(sandbox, "home");
  process.env["YACO_HOME"] = join(sandbox, "yaco");
  process.env["YACO_BIN_DIR"] = join(sandbox, "bin");
  binDir = process.env["YACO_BIN_DIR"]!;
  mkdirSync(binDir, { recursive: true });
  // Stage a fake YACO repo root carrying the marker that makes it a checkout —
  // the skills source the package ships a mirror of. Install reads the mirror,
  // not this; what this decides is whether there is a repo to register.
  repoRoot = join(sandbox, "repo");
  mkdirSync(join(repoRoot, "agent-config", "global", "skills"), { recursive: true });
  // Minimal valid tasks graph so the doctor's task-graph check passes when
  // tests opt into running doctor (skipDoctor: false).
  mkdirSync(join(repoRoot, "plan", "tasks"), { recursive: true });
  writeFileSync(join(repoRoot, "plan", "tasks", "tasks.json"), "{}\n");
  process.env["YACO_REPO_ROOT"] = repoRoot;
  // Make doctor's PATH-based checks (tmux, git, claude, codex, yaco) hermetic
  // by prepending a shim bin onto PATH.
  const shimBin = join(sandbox, "shim-bin");
  mkdirSync(shimBin, { recursive: true });
  for (const c of ["yaco", "tmux", "git", "claude", "codex"]) {
    makeShim(join(shimBin, c));
  }
  process.env["PATH"] = `${shimBin}:${ORIG.PATH ?? ""}`;
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function baseOpts(overrides: Partial<Parameters<typeof runInstall>[0]> = {}): Parameters<typeof runInstall>[0] {
  return {
    cliOnly: true,
    skipHooks: false,
    noRegistry: false,
    skipLinks: false,
    skipDoctor: true,
    dryRun: false,
    force: false,
    json: false,
    ...overrides,
  };
}

describe("runInstall — basic shape", () => {
  it("returns a report with resolved paths and a non-empty action list", () => {
    const r: InstallReport = runInstall(baseOpts());
    expect(r.repoRoot).toBe(repoRoot);
    expect(r.binDir).toBe(binDir);
    expect(r.yacoHome).toBe(process.env["YACO_HOME"]!);
    expect(r.dryRun).toBe(false);
    expect(r.actions.length).toBeGreaterThan(0);
  });

  it("does not let a defaulted bin dir outrank the yaco actually being run", () => {
    // `--bin-dir` and $YACO_BIN_DIR are the caller saying where yaco lives.
    // The default, `~/.local/bin`, is a guess — and treating a guess as an
    // override is how `npm i -g @yaco/cli` into an nvm prefix, followed by
    // `yaco install`, wrote every hook command back to a stale binary a much
    // older bootstrap had left in ~/.local/bin.
    delete process.env["YACO_BIN_DIR"];
    const stale = join(process.env["HOME"]!, ".local", "bin");
    mkdirSync(stale, { recursive: true });
    makeShim(join(stale, "yaco"));
    // The one on PATH is the one being run (the shim bin, prepended above).
    const onPath = join(sandbox, "shim-bin", "yaco");

    runInstall(baseOpts({ binDir: undefined }));

    const settings = JSON.parse(
      readFileSync(join(process.env["HOME"]!, ".claude", "settings.json"), "utf-8"),
    );
    const commands: string[] = Object.values(settings.hooks ?? {})
      .flatMap((groups) => groups as { hooks?: { command?: string }[] }[])
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command ?? "");
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.split(" ")[0]).toBe(onPath);
    }
    expect(commands.join("\n")).not.toContain(join(stale, "yaco"));
  });

  it("writes ${YACO_HOME}/agent-wrapper.sh and makes it executable", () => {
    runInstall(baseOpts());
    const path = join(process.env["YACO_HOME"]!, "agent-wrapper.sh");
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, "utf-8");
    expect(body).toContain("YACO_AGENT_SESSIONS_DIR");
    const st = lstatSync(path);
    expect((st.mode & 0o111)).not.toBe(0);
  });

  it("creates ~/.claude/skills as a real dir with one link per shipped skill", () => {
    runInstall(baseOpts());
    const home = process.env["HOME"]!;
    const container = join(home, ".claude", "skills");
    expect(lstatSync(container).isDirectory()).toBe(true);
    expect(lstatSync(container).isSymbolicLink()).toBe(false);
    expect(SHIPPED_SKILLS.length).toBeGreaterThan(0);
    for (const name of SHIPPED_SKILLS) {
      expect(readlinkSync(join(container, name))).toBe(shippedSkill(name));
    }
    expect(readlinkSync(join(home, ".agents", "skills"))).toBe(container);
    // Install is purely additive: it claims no global instruction file.
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(false);
  });

  it("points every skill link inside the package, never at the checkout", () => {
    // The property the whole packaging change exists for: an `npm i -g` user has
    // no checkout, so a target outside the package is a link that resolves on
    // the machine it was built on and nowhere else.
    const r = runInstall(baseOpts());
    const container = join(process.env["HOME"]!, ".claude", "skills");
    for (const name of SHIPPED_SKILLS) {
      const target = readlinkSync(join(container, name));
      expect(target.startsWith(PACKAGE_ROOT)).toBe(true);
      expect(target.startsWith(repoRoot)).toBe(false);
      expect(existsSync(target)).toBe(true);
    }
    expect(r.actions.filter((a) => a.startsWith("symlink skill "))).toHaveLength(
      SHIPPED_SKILLS.length,
    );
  });

  it("upserts {id: yaco, path: repoRoot} into the registry", () => {
    runInstall(baseOpts());
    const reg = JSON.parse(
      readFileSync(join(process.env["YACO_HOME"]!, "projects.json"), "utf-8"),
    );
    expect(reg).toEqual([{ id: "yaco", path: repoRoot }]);
  });
});

describe("runInstall — idempotency (AC 2)", () => {
  it("re-running yaco install twice leaves no diff in ${YACO_HOME}", () => {
    runInstall(baseOpts());
    const home = process.env["YACO_HOME"]!;
    const snapshot = () =>
      JSON.stringify({
        wrapper: readFileSync(join(home, "agent-wrapper.sh"), "utf-8"),
        registry: readFileSync(join(home, "projects.json"), "utf-8"),
      });
    const before = snapshot();
    runInstall(baseOpts());
    expect(snapshot()).toBe(before);
  });

  it("does not relink an already-correct symlink", () => {
    runInstall(baseOpts());
    const link = join(process.env["HOME"]!, ".claude", "skills", SKILL_A);
    const beforeM = lstatSync(link).mtimeMs;
    // tiny delay to make any rewrite detectable in mtime
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    runInstall(baseOpts());
    // No change → mtime unchanged.
    expect(lstatSync(link).mtimeMs).toBe(beforeM);
  });
});

describe("runInstall --dry-run (AC 3)", () => {
  it("prints actions to stderr without touching the filesystem", () => {
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      runInstall(baseOpts({ dryRun: true }));
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(captured.join("")).toContain("plan: ");
    expect(existsSync(join(process.env["YACO_HOME"]!, "agent-wrapper.sh"))).toBe(false);
    expect(existsSync(join(process.env["HOME"]!, ".claude", "skills"))).toBe(false);
  });
});

describe("runInstall — hook merge semantics (AC 4)", () => {
  it("preserves unrelated user hooks while adding yaco entries", () => {
    const claudeDir = join(process.env["HOME"]!, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const userSettings = {
      theme: "dark",
      hooks: {
        SessionStart: [
          {
            matcher: "my-custom-marker",
            hooks: [{ type: "command", command: "/usr/local/bin/my-hook" }],
          },
        ],
      },
    };
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(userSettings));

    runInstall(baseOpts());

    const after = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8"));
    expect(after.theme).toBe("dark");
    const sessionStart = after.hooks.SessionStart;
    const userHook = sessionStart.find((g: any) => g.matcher === "my-custom-marker");
    expect(userHook).toBeDefined();
    expect(userHook.hooks[0].command).toBe("/usr/local/bin/my-hook");
    const yacoHook = sessionStart.find((g: any) =>
      g.hooks?.some((h: any) => /agent hook-event/.test(h.command)));
    expect(yacoHook).toBeDefined();
    expect(yacoHook.hooks[0].command).toMatch(/hook-event/);
  });
});

describe("runInstall — legacy bin cleanup (AC 5)", () => {
  it("removes $BIN_DIR/mt and $BIN_DIR/multmux when they are symlinks", () => {
    symlinkSync("/old/multmux", join(binDir, "mt"));
    symlinkSync("/old/multmux", join(binDir, "multmux"));
    expect(existsSync(join(binDir, "mt"))).toBe(false); // dangling — existsSync is false
    expect(lstatSync(join(binDir, "mt")).isSymbolicLink()).toBe(true);

    runInstall(baseOpts());

    expect(() => lstatSync(join(binDir, "mt"))).toThrow();
    expect(() => lstatSync(join(binDir, "multmux"))).toThrow();
  });

  it("does not touch a regular file at $BIN_DIR/mt", () => {
    writeFileSync(join(binDir, "mt"), "real binary\n");
    runInstall(baseOpts());
    expect(existsSync(join(binDir, "mt"))).toBe(true);
    expect(readFileSync(join(binDir, "mt"), "utf-8")).toBe("real binary\n");
  });
});

describe("runInstall — error paths", () => {
  it("IO when a regular file blocks a target symlink path", () => {
    const claudeDir = join(process.env["HOME"]!, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "skills"), "real content\n");
    let code: string | undefined;
    try {
      runInstall(baseOpts());
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("IO");
  });
});

describe("runInstall — additive install (no global-rules takeover)", () => {
  const preExisting = "# my own global rules\n";

  function seedUserClaudeMd(): string {
    const path = join(process.env["HOME"]!, ".claude", "CLAUDE.md");
    mkdirSync(join(process.env["HOME"]!, ".claude"), { recursive: true });
    writeFileSync(path, preExisting);
    return path;
  }

  it("leaves a pre-existing ~/.claude/CLAUDE.md byte-identical", () => {
    const path = seedUserClaudeMd();
    runInstall(baseOpts());
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(preExisting);
  });

  it("--force still leaves a pre-existing ~/.claude/CLAUDE.md alone", () => {
    const path = seedUserClaudeMd();
    runInstall(baseOpts({ force: true }));
    expect(readFileSync(path, "utf-8")).toBe(preExisting);
  });

  it("never creates ~/.codex/AGENTS.md", () => {
    runInstall(baseOpts());
    expect(existsSync(join(process.env["HOME"]!, ".codex", "AGENTS.md"))).toBe(false);
  });
});

describe("runInstall --skip-hooks", () => {
  it("writes the wrapper but does not touch ~/.claude/settings.json", () => {
    runInstall(baseOpts({ skipHooks: true }));
    expect(existsSync(join(process.env["YACO_HOME"]!, "agent-wrapper.sh"))).toBe(true);
    expect(existsSync(join(process.env["HOME"]!, ".claude", "settings.json"))).toBe(false);
  });
});

describe("runInstall --no-registry", () => {
  it("does not write projects.json", () => {
    runInstall(baseOpts({ noRegistry: true }));
    expect(existsSync(join(process.env["YACO_HOME"]!, "projects.json"))).toBe(false);
  });
});

describe("runInstall — global-link safety", () => {
  it("refuses to retarget ~/.claude/skills when it points elsewhere — throws CONFLICT", () => {
    // Pre-seed the global link pointing at a stale path (simulating the
    // worktree footgun: an earlier `yaco install` from .worktrees/<slug>/
    // pointed skills at the worktree's agent-config, and we now run
    // install from a different repoRoot).
    const home = process.env["HOME"]!;
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const stalePath = join(repoRoot, "..", "elsewhere", "agent-config", "global", "skills");
    symlinkSync(stalePath, join(claudeDir, "skills"));
    let code: string | undefined;
    let msg = "";
    try {
      runInstall(baseOpts());
    } catch (e) {
      code = (e as { code?: string }).code;
      msg = (e as Error).message;
    }
    expect(code).toBe("CONFLICT");
    expect(msg).toContain("already points at");
    expect(msg).toContain("--force");
    expect(msg).toContain("--skip-links");
    // Stale link is unchanged.
    expect(readlinkSync(join(claudeDir, "skills"))).toBe(stalePath);
  });

  it("--force converts a different-target link into the per-skill dir", () => {
    const home = process.env["HOME"]!;
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    symlinkSync("/some/old/skills", join(claudeDir, "skills"));
    runInstall(baseOpts({ force: true }));
    const container = join(claudeDir, "skills");
    expect(lstatSync(container).isDirectory()).toBe(true);
    expect(readlinkSync(join(container, SKILL_A))).toBe(shippedSkill(SKILL_A));
  });

  it("--skip-links leaves all global links untouched (even when stale)", () => {
    const home = process.env["HOME"]!;
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const stalePath = "/some/old/skills";
    symlinkSync(stalePath, join(claudeDir, "skills"));
    runInstall(baseOpts({ skipLinks: true }));
    // Stale link preserved verbatim — install did NOT touch it.
    expect(readlinkSync(join(claudeDir, "skills"))).toBe(stalePath);
    // And install did NOT create the other links either.
    expect(existsSync(join(home, ".agents", "skills"))).toBe(false);
  });

  it("migrates a RELATIVE legacy whole-dir symlink without --force (cwd-independent)", () => {
    const home = process.env["HOME"]!;
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    // Relative link that correctly resolves to OUR skillsDir from the link's
    // own directory — must be treated as ours regardless of process cwd.
    symlinkSync(relative(claudeDir, PACKAGED_SKILLS_DIR), join(claudeDir, "skills"));
    runInstall(baseOpts());
    const container = join(claudeDir, "skills");
    expect(lstatSync(container).isSymbolicLink()).toBe(false);
    expect(readlinkSync(join(container, SKILL_A))).toBe(shippedSkill(SKILL_A));
  });

  it("migrates a legacy whole-dir symlink to per-skill links without --force", () => {
    const home = process.env["HOME"]!;
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    // Pre-v0.1 layout: the whole dir symlinked at OUR canonical skillsDir.
    symlinkSync(PACKAGED_SKILLS_DIR, join(claudeDir, "skills"));
    runInstall(baseOpts());
    const container = join(claudeDir, "skills");
    expect(lstatSync(container).isSymbolicLink()).toBe(false);
    expect(lstatSync(container).isDirectory()).toBe(true);
    expect(readlinkSync(join(container, SKILL_B))).toBe(shippedSkill(SKILL_B));
  });

  it("merges into an existing real dir, keeping the user's own skills", () => {
    const home = process.env["HOME"]!;
    const mine = join(home, ".claude", "skills", "mine");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "SKILL.md"), "user skill\n");
    runInstall(baseOpts());
    expect(readFileSync(join(mine, "SKILL.md"), "utf-8")).toBe("user skill\n");
    expect(readlinkSync(join(home, ".claude", "skills", SKILL_A))).toBe(shippedSkill(SKILL_A));
  });

  it("keeps a same-name user skill (real dir) and still installs the rest", () => {
    const home = process.env["HOME"]!;
    const userOwned = join(home, ".claude", "skills", SKILL_A);
    mkdirSync(userOwned, { recursive: true });
    writeFileSync(join(userOwned, "SKILL.md"), "my own\n");
    const r = runInstall(baseOpts());
    // The user's own is untouched — a real dir is never clobbered.
    expect(lstatSync(userOwned).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(userOwned, "SKILL.md"), "utf-8")).toBe("my own\n");
    // The rest are still linked; the skip is reported in actions.
    expect(readlinkSync(join(home, ".claude", "skills", SKILL_B))).toBe(shippedSkill(SKILL_B));
    expect(r.actions.some((a) => a.includes(`keep ${SKILL_A}`))).toBe(true);
  });

  it("replaces a dangling same-name skill link", () => {
    const home = process.env["HOME"]!;
    const container = join(home, ".claude", "skills");
    mkdirSync(container, { recursive: true });
    symlinkSync(join(sandbox, "gone", SKILL_A), join(container, SKILL_A));
    runInstall(baseOpts());
    expect(readlinkSync(join(container, SKILL_A))).toBe(shippedSkill(SKILL_A));
  });

  it("skips a same-name link to a live foreign target without --force, retargets with it", () => {
    const home = process.env["HOME"]!;
    const container = join(home, ".claude", "skills");
    mkdirSync(container, { recursive: true });
    const foreign = join(sandbox, "other-skills", SKILL_A);
    mkdirSync(foreign, { recursive: true });
    symlinkSync(foreign, join(container, SKILL_A));
    const r = runInstall(baseOpts());
    expect(readlinkSync(join(container, SKILL_A))).toBe(foreign);
    expect(r.actions.some((a) => a.includes(`skip ${SKILL_A}`))).toBe(true);
    runInstall(baseOpts({ force: true }));
    expect(readlinkSync(join(container, SKILL_A))).toBe(shippedSkill(SKILL_A));
  });
});

describe("runInstall — registry safety (HIGH 5)", () => {
  it("refuses to overwrite a malformed projects.json — throws ENV", () => {
    mkdirSync(process.env["YACO_HOME"]!, { recursive: true });
    const path = join(process.env["YACO_HOME"]!, "projects.json");
    const corrupt = "{not valid json[";
    writeFileSync(path, corrupt);
    let code: string | undefined;
    let msg = "";
    try {
      runInstall(baseOpts());
    } catch (e) {
      code = (e as { code?: string }).code;
      msg = (e as Error).message;
    }
    expect(code).toBe("ENV");
    expect(msg).toContain("projects.json");
    expect(msg).toContain("refusing to overwrite");
    // The corrupt file is unchanged.
    expect(readFileSync(path, "utf-8")).toBe(corrupt);
  });

  it("refuses to rebind \"yaco\" to a different path — throws CONFLICT", () => {
    // Pre-seed the registry with yaco at a different path (simulating the
    // worktree footgun: `yaco install` ran from .worktrees/<slug> and
    // re-registered the project at the worktree root).
    mkdirSync(process.env["YACO_HOME"]!, { recursive: true });
    const regPath = join(process.env["YACO_HOME"]!, "projects.json");
    const existingPath = "/some/other/yaco/checkout";
    writeFileSync(regPath, JSON.stringify([{ id: "yaco", path: existingPath }]));
    let code: string | undefined;
    let msg = "";
    try {
      runInstall(baseOpts());
    } catch (e) {
      code = (e as { code?: string }).code;
      msg = (e as Error).message;
    }
    expect(code).toBe("CONFLICT");
    expect(msg).toContain("already registers");
    expect(msg).toContain(existingPath);
    expect(msg).toContain(repoRoot);
    expect(msg).toContain("--force");
    // Registry file is unchanged.
    const reg = JSON.parse(readFileSync(regPath, "utf-8"));
    expect(reg).toEqual([{ id: "yaco", path: existingPath }]);
  });

  it("--force overwrites a different-path yaco entry", () => {
    mkdirSync(process.env["YACO_HOME"]!, { recursive: true });
    const regPath = join(process.env["YACO_HOME"]!, "projects.json");
    writeFileSync(
      regPath,
      JSON.stringify([
        { id: "yaco", path: "/some/other/yaco/checkout" },
        { id: "other-project", path: "/keep/me" },
      ]),
    );
    runInstall(baseOpts({ force: true }));
    const reg = JSON.parse(readFileSync(regPath, "utf-8"));
    expect(reg).toEqual([
      { id: "yaco", path: repoRoot },
      { id: "other-project", path: "/keep/me" },
    ]);
  });

  it("same-path re-registration is a no-op (idempotent — no --force needed)", () => {
    runInstall(baseOpts());
    const regPath = join(process.env["YACO_HOME"]!, "projects.json");
    const before = readFileSync(regPath, "utf-8");
    // Re-run install from the same repoRoot — should NOT throw CONFLICT.
    runInstall(baseOpts());
    expect(readFileSync(regPath, "utf-8")).toBe(before);
  });

  it("symlink alias of the same checkout is no-op, not CONFLICT", () => {
    // First install at canonical repoRoot.
    runInstall(baseOpts());
    const regPath = join(process.env["YACO_HOME"]!, "projects.json");
    const before = readFileSync(regPath, "utf-8");
    // Create a symlink that points at the same repo root.
    const aliasDir = join(process.env["HOME"]!, "..", "alias-link");
    try {
      symlinkSync(repoRoot, aliasDir);
    } catch {
      // Some sandboxes refuse symlink creation; skip if so.
      return;
    }
    try {
      // Re-run install with the symlink as --repo. realpath on both sides
      // should resolve them equal → silent no-op, NOT a CONFLICT.
      runInstall(baseOpts({ repoRoot: aliasDir }));
      expect(readFileSync(regPath, "utf-8")).toBe(before);
    } finally {
      try { unlinkSync(aliasDir); } catch { /* best effort */ }
    }
  });
});

describe("runInstall — canonical hook command (HIGH 4)", () => {
  it("writes hooks pointing at <binDir>/yaco agent hook-event <Event>", () => {
    // Stage a yaco binary at binDir/yaco so the lifecycle resolver picks it.
    writeFileSync(join(binDir, "yaco"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "yaco"), 0o755);
    runInstall(baseOpts());

    const settings = JSON.parse(
      readFileSync(join(process.env["HOME"]!, ".claude", "settings.json"), "utf-8"),
    );
    const sessionStart = settings.hooks.SessionStart;
    const yacoEntry = sessionStart.find((g: any) =>
      g.hooks?.some((h: any) => /agent hook-event/.test(h.command)));
    expect(yacoEntry).toBeDefined();
    const cmd = yacoEntry.hooks[0].command;
    // Canonical form: absolute path to the installed executable + `agent
    // hook-event <Event>`. Never a runtime plus a source path — neither the
    // runtime nor the checkout is guaranteed to be reachable at hook-fire time.
    expect(cmd).toBe(`${join(binDir, "yaco")} agent hook-event SessionStart`);
    expect(cmd).not.toMatch(/^(bun|node) /);
  });
});

describe("runInstall --json — stderr discipline (MEDIUM 6)", () => {
  it("emits no stderr chatter when --json is set", () => {
    // Stage a binary so doctor's binary check has something to find.
    writeFileSync(join(binDir, "yaco"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "yaco"), 0o755);
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      // Need to make doctor pass for runInstall to return; the in-process
      // doctor call would normally print per-check status to stderr but with
      // --json that chatter must be suppressed.
      runInstall(baseOpts({
        json: true,
        skipDoctor: false,
        // PATH was already seeded with the shim bin in beforeEach so all 11
        // doctor checks pass.
      }));
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(captured.join("")).toBe("");
  });

  it("dry-run --json suppresses plan: lines on stderr too", () => {
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      runInstall(baseOpts({ json: true, dryRun: true }));
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(captured.join("")).toBe("");
  });
});

describe("runInstall --repo (HIGH 2 wire-through)", () => {
  /** A second fake repo — the checkout install is pointed at via --repo. */
  function stageOtherRepo(): string {
    // Stage a yaco binary so the binary check passes.
    writeFileSync(join(binDir, "yaco"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "yaco"), 0o755);
    const otherRepo = join(sandbox, "other-repo");
    mkdirSync(join(otherRepo, "agent-config", "global", "skills"), { recursive: true });
    return otherRepo;
  }

  it("threads --repo into the trailing doctor task-graph check", () => {
    const otherRepo = stageOtherRepo();
    // A present-but-broken graph in otherRepo: the failure detail naming that
    // repo proves doctor ran against --repo, not cwd.
    mkdirSync(join(otherRepo, "plan", "tasks"), { recursive: true });
    writeFileSync(join(otherRepo, "plan", "tasks", "tasks.json"), "not json\n");
    let code: string | undefined;
    let report: any;
    try {
      runInstall(baseOpts({ repoRoot: otherRepo, skipDoctor: false }));
    } catch (e) {
      code = (e as { code?: string }).code;
      report = (e as { details?: any }).details;
    }
    expect(code).toBe("INVALID");
    const taskGraph = report.checks.find((c: any) => c.name === "task-graph");
    expect(taskGraph.status).toBe("fail");
    expect(taskGraph.detail).toContain(otherRepo);
  });

  it("installs green against a repo with no plan/ (fresh clone)", () => {
    const otherRepo = stageOtherRepo();
    // No plan/ in otherRepo at all — the public fresh-clone shape.
    const report = runInstall(baseOpts({ repoRoot: otherRepo, skipDoctor: false }));
    const taskGraph = report.doctor!.checks.find((c) => c.name === "task-graph");
    expect(taskGraph?.status).toBe("skip");
    expect(taskGraph?.detail).toContain(otherRepo);
    expect(report.doctor!.summary.fail).toBe(0);
  });
});

describe("runInstall — no checkout at all (the `npm i -g @yaco/cli` user)", () => {
  /** Everything the package needs, and nothing a checkout would have provided:
   *  a directory that is simply where the user happened to be standing. */
  function stageNoCheckout(): string {
    writeFileSync(join(binDir, "yaco"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "yaco"), 0o755);
    const nowhere = join(sandbox, "nowhere");
    mkdirSync(nowhere, { recursive: true });
    return nowhere;
  }

  it("plants every skill link and registers nothing", () => {
    const nowhere = stageNoCheckout();
    const r = runInstall(baseOpts({ repoRoot: nowhere }));

    const container = join(process.env["HOME"]!, ".claude", "skills");
    for (const name of SHIPPED_SKILLS) {
      expect(readlinkSync(join(container, name))).toBe(shippedSkill(name));
    }
    // No repo to register — and the skip is reported, not silent.
    expect(existsSync(join(process.env["YACO_HOME"]!, "projects.json"))).toBe(false);
    expect(r.actions.some((a) => a.startsWith("skipped registry:"))).toBe(true);
  });

  it("runs the closing doctor to zero failures, skipping the repo-scoped checks", () => {
    const nowhere = stageNoCheckout();
    const r = runInstall(baseOpts({ repoRoot: nowhere, skipDoctor: false }));

    const status = (name: string) =>
      r.doctor!.checks.find((c) => c.name === name)?.status;
    // Nothing to check: no registry was written, and a directory that is not a
    // repo has no task graph.
    expect(status("registry")).toBe("skip");
    expect(status("task-graph")).toBe("skip");
    // The skills came out of the package, so this one is answerable and passes.
    expect(status("skills-link")).toBe("pass");
    expect(r.doctor!.summary.fail).toBe(0);
  });
});

describe("yaco install — fresh clone exits 0 (release blocker)", () => {
  it("subprocess install against a plan-less repo exits 0", () => {
    // The exact flow tools/install.sh runs after building the binary:
    // `yaco install` against a freshly cloned checkout that has no plan/.
    writeFileSync(join(binDir, "yaco"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "yaco"), 0o755);
    const freshClone = join(sandbox, "fresh-clone");
    mkdirSync(join(freshClone, "agent-config", "global", "skills"), { recursive: true });
    expect(existsSync(join(freshClone, "plan"))).toBe(false);
    const r = runCli(
      ["install", "--cli-only", "--repo", freshClone, "--json"],
      { env: { ...process.env } },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    const taskGraph = parsed.data.doctor.checks.find((c: any) => c.name === "task-graph");
    expect(taskGraph.status).toBe("skip");
    expect(parsed.data.doctor.summary.fail).toBe(0);
  });
});
