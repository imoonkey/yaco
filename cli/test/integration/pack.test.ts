/** The tarball, end to end: pack it, install it into a clean prefix, and use it.
 *
 *  Everything else in the suite runs the package from the checkout it was built
 *  in, where a wrong path can still resolve by accident — a missing packaged
 *  asset is a sibling directory away, and `src/` is right there. This file is
 *  the one that removes the checkout: `npm pack` produces exactly the bytes an
 *  `npm install -g @yaco/cli` delivers, and every assertion below is made
 *  against the installed copy, from a working directory with no yaco above it.
 *
 *  It is a gate step (`npm run test:pack`), not just a test, because the failure
 *  it catches is invisible from a source run and only visible to a user.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CLI_DIR = resolve(import.meta.dirname, "../..");
const REPO_ROOT = resolve(CLI_DIR, "..");
const MANIFEST = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf-8"));
const EXPORT_SPECIFIERS = Object.keys(MANIFEST.exports as Record<string, unknown>);

let sandbox: string;
let prefix: string;
let home: string;
let installedPackage: string;
let tarballEntries: string[];
/** HOME's contents the instant the tarball finished installing — captured
 *  before any test can dirty it, which is the only honest way to ask what the
 *  install itself wrote. */
let homeAfterInstall: string[];

/** `yaco` as an installed user runs it: the launcher on the prefix's bin, an
 *  isolated HOME/YACO_HOME, and a cwd with no checkout anywhere above it — and
 *  no $YACO_REPO_ROOT either, so nothing points at one from the side. This is
 *  the whole situation under test; every assertion below is made from inside it. */
function runInstalled(args: string[], input?: string) {
  const env = { ...process.env };
  delete env["YACO_PATH"];
  delete env["YACO_BIN_DIR"];
  delete env["YACO_REPO_ROOT"];
  return spawnSync(join(prefix, "bin", "yaco"), args, {
    cwd: join(sandbox, "nowhere"),
    encoding: "utf-8",
    input,
    env: {
      ...env,
      HOME: home,
      YACO_HOME: join(sandbox, "yaco"),
      // The prefix's bin first and no other `yaco` — an installed user's PATH.
      // It keeps the developer's own installation out of the assertions below,
      // which is otherwise what `which yaco` finds. The running Node's
      // directory has to be on it too: the launcher's shebang is
      // `#!/usr/bin/env node`, so a PATH without it resolves whatever old
      // system Node exists and the floor guard correctly refuses to run. The
      // shims make doctor's remaining `which` lookups hermetic, so a machine
      // without a provider CLI does not turn an install assertion into a
      // statement about that machine.
      PATH: [join(prefix, "bin"), dirname(process.execPath), join(sandbox, "shims"), "/usr/bin", "/bin"].join(":"),
    },
    timeout: 60_000,
  });
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-pack-"));
  prefix = join(sandbox, "prefix");
  home = join(sandbox, "home");
  for (const d of ["stage", "home", "home-no-agent", "nowhere", "prefix"]) {
    mkdirSync(join(sandbox, d), { recursive: true });
  }
  // A bare directory to name as a session cwd. Deliberately not a checkout:
  // nothing in this sandbox may stand in for a package asset.
  mkdirSync(join(sandbox, "repo"), { recursive: true });
  mkdirSync(join(sandbox, "shims"), { recursive: true });
  for (const command of ["tmux", "git", "claude", "codex"]) {
    const path = join(sandbox, "shims", command);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }

  const packed = spawnSync(
    "npm",
    ["pack", "--workspace", "@yaco/cli", "--pack-destination", join(sandbox, "stage")],
    { cwd: REPO_ROOT, encoding: "utf-8", timeout: 300_000 },
  );
  if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.stderr}`);

  const tarballs = readdirSync(join(sandbox, "stage")).filter((f) => f.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  const tarball = join(sandbox, "stage", tarballs[0]!);

  tarballEntries = spawnSync("tar", ["-tzf", tarball], { encoding: "utf-8" })
    .stdout.split("\n")
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ""));

  const installed = spawnSync(
    "npm",
    ["install", "--global", "--prefix", prefix, tarball],
    { cwd: sandbox, encoding: "utf-8", env: { ...process.env, HOME: home }, timeout: 300_000 },
  );
  if (installed.status !== 0) {
    throw new Error(`npm install of the tarball failed:\n${installed.stderr}`);
  }
  installedPackage = join(prefix, "lib", "node_modules", "@yaco", "cli");
  homeAfterInstall = readdirSync(home);
}, 600_000);

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe("npm pack contains only intended files", () => {
  it("ships the launcher, both artifacts, the wrapper, the manifest and the license", () => {
    expect(tarballEntries).toContain("bin/yaco.mjs");
    // The launcher statically imports this before it touches the bundle, so a
    // `files` entry narrowed to the launcher alone would ship a package whose
    // every invocation dies on a missing module.
    expect(tarballEntries).toContain("bin/node-floor.mjs");
    expect(tarballEntries).toContain("dist/yaco.mjs");
    expect(tarballEntries).toContain("dist/package-root.js");
    expect(tarballEntries).toContain("scripts/agent-wrapper.sh");
    // The skills, mirrored in from the repo's agent-config/global at build time.
    // Without them the package is a CLI and none of the behaviour it drives —
    // and `npm pack` drops a symlinked directory silently, so this is the only
    // assertion that can tell a real copy from one.
    const shipped = tarballEntries
      .filter((p) => p.startsWith("agent-config/global/skills/"))
      .map((p) => p.split("/")[3]!);
    // Compared against the repo's tree, not the mirror inside the package: the
    // mirror is what the tarball was made from, so comparing them would only
    // ask whether tar dropped something, never whether the mirror is complete.
    expect([...new Set(shipped)].sort()).toEqual(
      readdirSync(join(REPO_ROOT, "agent-config", "global", "skills"), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(),
    );
    expect(tarballEntries).toContain("agent-config/global/skills/implement/SKILL.md");
    expect(tarballEntries).toContain("package.json");
    expect(tarballEntries).toContain("LICENSE");
    // Every exports-map target, both the JS and its declarations.
    for (const specifier of EXPORT_SPECIFIERS) {
      const target = (MANIFEST.exports[specifier] as Record<string, string>)["default"]!;
      expect(tarballEntries).toContain(target.replace(/^\.\//, ""));
      expect(tarballEntries).toContain(
        (MANIFEST.exports[specifier] as Record<string, string>)["types"]!.replace(/^\.\//, ""),
      );
    }
  });

  it("ships no TypeScript source and no tests", () => {
    // Not decoration: the `development` condition points at `src/**.ts`, and a
    // consumer who sets it must fail loudly rather than resolve a `.ts` file
    // that plain Node refuses under node_modules.
    const source = tarballEntries.filter(
      (p) => (p.startsWith("src/") || p.startsWith("test/")) || (p.endsWith(".ts") && !p.endsWith(".d.ts")),
    );
    expect(source).toEqual([]);
  });
});

describe("an installed tarball, with no checkout above it", () => {
  it("runs the command through the launcher on the prefix's bin", () => {
    const r = runInstalled(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("yaco <area> <command>");
  });

  it("reports the real package version, not 0.0.0", () => {
    const r = runInstalled(["doctor", "--json"]);
    const version = JSON.parse(r.stdout).data.checks.find(
      (c: { name: string }) => c.name === "version",
    );
    expect(version.detail).toBe(MANIFEST.version);
  });

  it("imports every exports-map entry under plain Node with no conditions set", () => {
    // `node_modules` as cwd so bare-specifier resolution finds the installed
    // package, and no `--conditions`: exactly what a published consumer does.
    const program = EXPORT_SPECIFIERS.map(
      (s) => `if (Object.keys(await import(${JSON.stringify(`@yaco/cli${s.slice(1)}`)})).length === 0) throw new Error(${JSON.stringify(s)});`,
    ).join("\n");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: join(prefix, "lib", "node_modules"),
      encoding: "utf-8",
      timeout: 60_000,
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("resolves the wrapper and writes hook commands naming the installed executable", () => {
    const r = runInstalled(["install", "--cli-only", "--skip-doctor", "--json"]);
    expect(r.stderr).not.toContain("cannot locate");
    expect(r.status).toBe(0);

    // The wrapper came out of the package, not out of any checkout.
    expect(readFileSync(join(sandbox, "yaco", "agent-wrapper.sh"), "utf-8")).toBe(
      readFileSync(join(installedPackage, "scripts", "agent-wrapper.sh"), "utf-8"),
    );

    // No $YACO_BIN_DIR is set here, which is the `npm i -g` user's situation:
    // the hook gets the executable npm put on their PATH. `tools/install.sh`
    // sets $YACO_BIN_DIR explicitly and arrives at the same file by rung 2 —
    // install.test.ts covers that arm.
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
    const commands: string[] = Object.values(settings.hooks ?? {})
      .flatMap((groups) => groups as { hooks?: { command?: string }[] }[])
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command ?? "");
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const executable = command.split(" ")[0]!;
      expect(executable).toBe(join(prefix, "bin", "yaco"));
      expect(existsSync(executable)).toBe(true);
      expect(executable).not.toContain(CLI_DIR);
    }
  });

  it("configures the machine and exits 0 with no checkout to configure it from", () => {
    // The install a user gets from `npm i -g @yaco/cli` alone: doctor included,
    // because install throws on any failing check and that is what a package
    // user's first command would hit. What is skipped here is skipped because
    // there is nothing to do, not because it was turned off.
    const r = runInstalled(["install", "--cli-only", "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);

    const doctor = JSON.parse(r.stdout).data.doctor;
    const status = (name: string) =>
      doctor.checks.find((c: { name: string }) => c.name === name).status;
    expect(status("skills-link")).toBe("pass");
    expect(status("registry")).toBe("skip");
    expect(status("task-graph")).toBe("skip");
    expect(doctor.summary.fail).toBe(0);

    // No repo to register, so none was invented out of the cwd.
    expect(existsSync(join(sandbox, "yaco", "projects.json"))).toBe(false);
  });

  it("plants every shipped skill, resolving inside the installed package", () => {
    const packagedSkills = join(installedPackage, "agent-config", "global", "skills");
    const shipped = readdirSync(packagedSkills, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(shipped.length).toBeGreaterThan(0);

    const container = join(home, ".claude", "skills");
    expect(lstatSync(container).isDirectory()).toBe(true);
    for (const name of shipped) {
      const link = join(container, name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      // Inside the installed package, and actually there — a link that resolves
      // to a checkout would work on the machine that built it and nowhere else.
      expect(readlinkSync(link)).toBe(join(packagedSkills, name));
      expect(realpathSync(link).startsWith(realpathSync(installedPackage))).toBe(true);
      expect(existsSync(join(link, "SKILL.md"))).toBe(true);
    }
    expect(readdirSync(container).sort()).toEqual(shipped);
  });

  it("fires the hook command it installed", () => {
    // The hook contract: read stdin, update state, exit 0 whatever happens.
    const r = runInstalled(
      ["agent", "hook-event", "SessionStart"],
      JSON.stringify({ session_id: "pack-smoke", cwd: join(sandbox, "repo") }),
    );
    expect(r.status).toBe(0);
  });
});

describe("the install a stranger runs before they have an agent CLI", () => {
  /** A `$PATH` with genuinely no provider on it: the prefix's bin, and one
   *  synthetic directory holding exactly what the install needs — `node` for
   *  the launcher's `#!/usr/bin/env node`, `which` for doctor's probe, and
   *  shims for `tmux` and `git`.
   *
   *  Built up rather than subtracted from: `dirname(process.execPath)` is the
   *  obvious way to supply `node` and it is wrong here — on the machine this
   *  was written on it carries a `codex` next to the `node` — and any inherited
   *  directory can do the same. A `$PATH` that quietly still has a provider on
   *  it would make the exit code below a statement about this machine. */
  function pathWithNoProvider(): string {
    const bin = join(sandbox, "bin-no-agent");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "node"));
    const whichPath = spawnSync("which", ["which"], { encoding: "utf-8" }).stdout.trim();
    expect(whichPath.length).toBeGreaterThan(0);
    symlinkSync(whichPath, join(bin, "which"));
    for (const command of ["tmux", "git"]) {
      const path = join(bin, command);
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o755);
    }
    return [join(prefix, "bin"), bin].join(":");
  }

  /** The documented first command, run the documented way — the tarball npm
   *  ships, installed into a prefix, invoked through the launcher on its bin. */
  function runStrangerInstall(args: string[], path: string) {
    const env = { ...process.env };
    delete env["YACO_PATH"];
    delete env["YACO_BIN_DIR"];
    delete env["YACO_REPO_ROOT"];
    return spawnSync(join(prefix, "bin", "yaco"), args, {
      cwd: join(sandbox, "nowhere"),
      encoding: "utf-8",
      env: {
        ...env,
        HOME: join(sandbox, "home-no-agent"),
        YACO_HOME: join(sandbox, "yaco-no-agent"),
        PATH: path,
      },
      timeout: 60_000,
    });
  }

  it("exits 0, and says which agent CLI is missing", () => {
    const path = pathWithNoProvider();
    // The premise, asserted rather than assumed. If either of these resolves,
    // everything below proves nothing.
    for (const provider of ["claude", "codex"]) {
      const probe = spawnSync("/bin/sh", ["-c", `command -v ${provider}`], {
        encoding: "utf-8",
        env: { PATH: path },
      });
      expect(probe.stdout.trim()).toBe("");
      expect(probe.status).not.toBe(0);
    }

    // Text mode first, because it is what the stranger actually reads: install
    // prints every doctor line, and the missing provider has to be among them.
    const text = runStrangerInstall(["install", "--cli-only"], path);
    expect(text.status).toBe(0);
    expect(text.stderr).toContain("doctor: SKIP providers");
    expect(text.stderr).toContain("claude");
    expect(text.stderr).toContain("codex");

    const r = runStrangerInstall(["install", "--cli-only", "--json"], path);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);

    const doctor = JSON.parse(r.stdout).data.doctor;
    const providers = doctor.checks.find((c: { name: string }) => c.name === "providers");
    expect(providers.status).toBe("skip");
    expect(providers.detail).toContain("claude");
    expect(providers.detail).toContain("codex");
    expect(providers.detail).toContain("install one before starting agents");
    // Nothing else failed either — the whole documented first command works on
    // a machine that has no agent on it yet.
    expect(doctor.summary.fail).toBe(0);
  }, 120_000);
});

describe("installing the tarball has no side effects", () => {
  it("touches nothing under HOME but npm's own cache", () => {
    // Snapshotted in beforeAll: a later test deliberately runs `yaco install`,
    // which does write to HOME. That is the point of the split — installation
    // is inert, and configuring the machine is a separate, explicit command.
    expect(homeAfterInstall.filter((entry) => entry !== ".npm")).toEqual([]);
  });

  it("declares no install-time lifecycle script", () => {
    const installed = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf-8"));
    for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
      expect(installed.scripts?.[hook]).toBeUndefined();
    }
  });

  it("installs one executable and writes nothing else into the prefix's bin", () => {
    expect(readdirSync(join(prefix, "bin"))).toEqual(["yaco"]);
  });
});
