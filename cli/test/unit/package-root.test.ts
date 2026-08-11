/** Package assets and self-invocation, under a source run and under a compiled
 *  single-file artifact.
 *
 *  Both halves are needed because they fail in opposite directions. From
 *  source, `src/package-root.ts` sits one level below the package root and
 *  every asset is a real sibling of the manifest — the property the emitted and
 *  bundled layouts also have to keep, which is why the offset is asserted here
 *  rather than assumed. From a compiled artifact there is no real package root
 *  at all: the modules are served from a virtual filesystem, so the same
 *  expression names a path that exists nowhere. That is exactly the shape that
 *  once broke `yaco agent start` after a fresh `tools/install.sh`, so the
 *  artifact is really built and really run here rather than simulated.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PACKAGE_ROOT, packagedAssetPath, selfExecutablePath } from "../../src/package-root.ts";
import { readAgentWrapperScript } from "../../src/lib/core/agent/lifecycle.ts";
import { BUN_BIN } from "../helpers/cli-process.ts";

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

  it("reports no self executable — the runtime was handed an entry point", () => {
    expect(selfExecutablePath()).toBeNull();
  });
});

describe("package assets from a compiled artifact", () => {
  let sandbox: string;
  let artifact: string;
  let yacoHome: string;
  let repoRoot: string;
  /** A cwd with no yaco checkout above it and a PATH holding nothing, so the
   *  wrapper's discovery chain cannot quietly succeed through the environment
   *  the test itself runs in. */
  let emptyCwd: string;

  function runArtifact(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(artifact, args, {
      cwd: emptyCwd,
      encoding: "utf-8",
      env: {
        HOME: join(sandbox, "home"),
        YACO_HOME: yacoHome,
        PATH: join(sandbox, "empty-bin"),
        NO_COLOR: "1",
      },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "yaco-artifact-"));
    artifact = join(sandbox, "bin", "yaco");
    yacoHome = join(sandbox, "yaco-home");
    emptyCwd = join(sandbox, "elsewhere");
    repoRoot = join(sandbox, "repo");
    for (const dir of [emptyCwd, join(sandbox, "bin"), join(sandbox, "empty-bin"), join(sandbox, "home"), yacoHome]) {
      mkdirSync(dir, { recursive: true });
    }
    mkdirSync(join(repoRoot, "agent-config", "global", "skills", "alpha"), { recursive: true });
    mkdirSync(join(repoRoot, "cli", "scripts"), { recursive: true });
    writeFileSync(join(repoRoot, "cli", "scripts", "agent-wrapper.sh"), "#!/bin/bash\n# fixture wrapper\n");

    // `--compile` is a bun-only build, and under Vitest the host runtime is
    // node — so the compiler has to be named rather than inherited.
    const built = spawnSync(
      BUN_BIN,
      ["build", packagedAssetPath("src", "main.ts"), "--compile", "--outfile", artifact],
      { encoding: "utf-8" },
    );
    if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("still finds the wrapper, through the checkout the caller names", () => {
    const { status, stdout, stderr } = runArtifact([
      "install", "--cli-only", "--skip-doctor", "--repo", repoRoot, "--dry-run", "--json",
    ]);
    expect(stderr).not.toContain("cannot locate agent-wrapper.sh");
    expect(status).toBe(0);
    expect(JSON.parse(stdout).data.actions).toContain(`write ${join(yacoHome, "agent-wrapper.sh")}`);
  });

  it("writes hook commands naming itself, not a bare `yaco` that is on no PATH", () => {
    const { status } = runArtifact([
      "install", "--cli-only", "--skip-doctor", "--repo", repoRoot, "--json",
    ]);
    expect(status).toBe(0);
    const settings = JSON.parse(
      readFileSync(join(sandbox, "home", ".claude", "settings.json"), "utf-8"),
    );
    // Neither $YACO_BIN_DIR nor a `yaco` on PATH is available here, so the
    // artifact has only itself to name. Before it could, this degraded to the
    // literal "yaco" and every hook fire failed silently.
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
      `${artifact} agent hook-event SessionStart`,
    );
  });

  it("cannot read its own manifest, so the version falls back", () => {
    // The accepted state of this plateau, pinned rather than left to be
    // rediscovered: a single-file artifact has no readable package root. The
    // Node package (`cli-dual-artifact-package`) is what makes this the real
    // version, and this assertion is where that change becomes visible.
    const { stdout } = runArtifact(["doctor", "--json"]);
    const version = JSON.parse(stdout).data.checks.find((c: { name: string }) => c.name === "version");
    expect(version.detail).toBe("0.0.0");
  });
});
