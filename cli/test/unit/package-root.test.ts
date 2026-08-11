/** Package assets and self-invocation, from a source run and from the artifact.
 *
 *  `src/package-root.ts` sits one level below the package root and every asset
 *  is a real sibling of the manifest. That offset is the whole mechanism: the
 *  emitted `dist/package-root.js` and the copy esbuild inlines into
 *  `dist/yaco.mjs` hold it too, so one expression is correct in all three
 *  layouts. Asserting it here is what makes that claim checkable.
 *
 *  The second half runs the built artifact, because the source run cannot see
 *  the failure mode this exists to prevent — a bundler moves the base of
 *  `import.meta.url` from the source file to the output file, silently
 *  retargeting every relative asset path. It used to build a `bun --compile`
 *  binary, whose package root was a virtual filesystem that existed nowhere;
 *  the three assertions below were written against that and inverted by
 *  `cli-sqlite-hop` when the binary stopped running. They are back, and they
 *  now assert the opposite outcome, which is the point of the rewrite: the
 *  wrapper resolves without a checkout to fall back on, the hook command names
 *  the artifact, and the version is the manifest's rather than `0.0.0`.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PACKAGE_ROOT, packagedAssetPath, yacoExecutable } from "../../src/package-root.ts";
import { readAgentWrapperScript } from "../../src/lib/core/agent/lifecycle.ts";
import { runCli } from "../helpers/cli-process.ts";

const MANIFEST_VERSION = JSON.parse(
  readFileSync(packagedAssetPath("package.json"), "utf-8"),
).version as string;

describe("package assets from source", () => {
  it("resolves the manifest to this package's own", () => {
    const manifest = JSON.parse(readFileSync(packagedAssetPath("package.json"), "utf-8"));
    expect(manifest.name).toBe("@yaco/cli");
  });

  it("resolves the wrapper to the script the lifecycle reads", () => {
    const wrapper = packagedAssetPath("scripts", "agent-wrapper.sh");
    expect(readFileSync(wrapper, "utf-8")).toBe(readAgentWrapperScript());
  });

  it("keeps the resolver exactly one level below the package root", () => {
    // `../` is only the package root while this module stays one level down.
    // The emitted (`dist/package-root.js`) and bundled (`dist/yaco.mjs`)
    // layouts hold the same offset, so this assertion is what makes the one
    // expression correct in all three.
    expect(existsSync(packagedAssetPath("src", "package-root.ts"))).toBe(true);
    expect(resolve(PACKAGE_ROOT, "src")).toBe(resolve(import.meta.dirname, "../../src"));
  });

  it("names this package's own launcher when no override is set", () => {
    const saved = { path: process.env["YACO_PATH"], bin: process.env["YACO_BIN_DIR"] };
    delete process.env["YACO_PATH"];
    delete process.env["YACO_BIN_DIR"];
    try {
      expect(yacoExecutable()).toBe(packagedAssetPath("bin", "yaco.mjs"));
    } finally {
      if (saved.path !== undefined) process.env["YACO_PATH"] = saved.path;
      if (saved.bin !== undefined) process.env["YACO_BIN_DIR"] = saved.bin;
    }
  });
});

/** The same three questions, asked of the artifact.
 *
 *  Every path here runs `bin/yaco.mjs` over the esbuild bundle, from a working
 *  directory with no yaco checkout above it, against a `$YACO_REPO_ROOT` that
 *  deliberately holds no `cli/scripts/`. That combination is what makes the
 *  assertions mean something: the deleted fallback chain would have gone
 *  looking in exactly those two places and found nothing, so anything the
 *  artifact still resolves, it resolved from its own package root — through the
 *  copy of the expression esbuild inlined, which is the one that silently
 *  retargets if the output ever moves off `dist/`.
 */
describe("package assets from the built artifact", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "yaco-artifact-assets-"));
    // A repo root with the skills skeleton install wants and nothing else —
    // in particular no `cli/scripts/agent-wrapper.sh` to be rescued by.
    mkdirSync(join(sandbox, "repo", "agent-config", "global", "skills", "alpha"), {
      recursive: true,
    });
    mkdirSync(join(sandbox, "home"), { recursive: true });
    mkdirSync(join(sandbox, "nowhere"), { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function run(args: string[]) {
    const env = { ...process.env };
    delete env["YACO_PATH"];
    delete env["YACO_BIN_DIR"];
    env["HOME"] = join(sandbox, "home");
    env["YACO_HOME"] = join(sandbox, "yaco");
    env["YACO_REPO_ROOT"] = join(sandbox, "repo");
    return runCli(args, { cwd: join(sandbox, "nowhere"), env });
  }

  it("installs the wrapper from the package, with no checkout to fall back on", () => {
    const r = run(["install", "--cli-only", "--skip-doctor", "--json"]);
    expect(r.stderr).not.toContain("cannot locate");
    expect(r.status).toBe(0);
    const installed = readFileSync(join(sandbox, "yaco", "agent-wrapper.sh"), "utf-8");
    expect(installed).toBe(
      readFileSync(packagedAssetPath("scripts", "agent-wrapper.sh"), "utf-8"),
    );
  });

  it("writes hook commands naming the artifact, never a bare `yaco`", () => {
    expect(run(["install", "--cli-only", "--skip-doctor", "--json"]).status).toBe(0);
    const settings = JSON.parse(
      readFileSync(join(sandbox, "home", ".claude", "settings.json"), "utf-8"),
    );
    const commands: string[] = Object.values(settings.hooks ?? {})
      .flatMap((groups) => groups as { hooks?: { command?: string }[] }[])
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command ?? "");
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toMatch(/^\/.*\/bin\/yaco\.mjs agent hook-event [A-Za-z]+$/);
      expect(existsSync(command.split(" ")[0]!)).toBe(true);
    }
  });

  it("reports the real package version, not 0.0.0", () => {
    const r = run(["doctor", "--json"]);
    const version = JSON.parse(r.stdout).data.checks.find(
      (c: { name: string }) => c.name === "version",
    );
    expect(version.detail).toBe(MANIFEST_VERSION);
    expect(version.detail).not.toBe("0.0.0");
  });
});
