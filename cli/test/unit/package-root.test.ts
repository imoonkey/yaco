/** Package assets and self-invocation, from a source run.
 *
 *  `src/package-root.ts` sits one level below the package root and every asset
 *  is a real sibling of the manifest — the property the emitted and bundled
 *  layouts also have to keep, which is why the offset is asserted here rather
 *  than assumed.
 *
 *  There used to be a second half that really built a `bun build --compile`
 *  single-file artifact and ran it, because there the package root resolves to
 *  a path that exists nowhere and that is what once broke `yaco agent start`
 *  after a fresh `tools/install.sh`. `cli-sqlite-hop` ended that artifact: Bun
 *  cannot load `node:sqlite`, so the compiled binary no longer starts, and no
 *  build on this plateau produces a runnable one. `cli-dual-artifact-package`
 *  owns what replaces it — `bin/yaco.mjs` over `dist/`, whose package root is a
 *  real directory — and its acceptance already carries "package assets and
 *  self-invocation work". The three assertions that died with the artifact were:
 *  the wrapper is still found through a caller-named checkout, hook commands
 *  name the artifact rather than a bare `yaco`, and the version degrades to
 *  `0.0.0` because the manifest is unreadable.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PACKAGE_ROOT, packagedAssetPath, selfExecutablePath } from "../../src/package-root.ts";
import { readAgentWrapperScript } from "../../src/lib/core/agent/lifecycle.ts";

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
