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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
 *  isolated HOME/YACO_HOME, and a cwd with no checkout anywhere above it. */
function runInstalled(args: string[], input?: string) {
  const env = { ...process.env };
  delete env["YACO_PATH"];
  delete env["YACO_BIN_DIR"];
  return spawnSync(join(prefix, "bin", "yaco"), args, {
    cwd: join(sandbox, "nowhere"),
    encoding: "utf-8",
    input,
    env: {
      ...env,
      HOME: home,
      YACO_HOME: join(sandbox, "yaco"),
      YACO_REPO_ROOT: join(sandbox, "repo"),
      // The prefix's bin first and no other `yaco` — an installed user's PATH.
      // It keeps the developer's own installation out of the assertions below,
      // which is otherwise what `which yaco` finds. The running Node's
      // directory has to be on it too: the launcher's shebang is
      // `#!/usr/bin/env node`, so a PATH without it resolves whatever old
      // system Node exists and the floor guard correctly refuses to run.
      PATH: `${join(prefix, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
    },
    timeout: 60_000,
  });
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-pack-"));
  prefix = join(sandbox, "prefix");
  home = join(sandbox, "home");
  for (const d of ["stage", "home", "nowhere", "prefix"]) {
    mkdirSync(join(sandbox, d), { recursive: true });
  }
  // A repo root with the skills skeleton `yaco install` wants, and nothing that
  // could stand in for a package asset.
  mkdirSync(join(sandbox, "repo", "agent-config", "global", "skills", "alpha"), {
    recursive: true,
  });

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
    expect(tarballEntries).toContain("dist/yaco.mjs");
    expect(tarballEntries).toContain("dist/package-root.js");
    expect(tarballEntries).toContain("scripts/agent-wrapper.sh");
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

  it("fires the hook command it installed", () => {
    // The hook contract: read stdin, update state, exit 0 whatever happens.
    const r = runInstalled(
      ["agent", "hook-event", "SessionStart"],
      JSON.stringify({ session_id: "pack-smoke", cwd: join(sandbox, "repo") }),
    );
    expect(r.status).toBe(0);
  });
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
