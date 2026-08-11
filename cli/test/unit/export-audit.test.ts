/** The export eligibility gate.
 *
 *  Every `package.json#exports` entry is audited through its transitive
 *  production import closure, walked with the TypeScript compiler (see
 *  `test/helpers/export-closure.ts` for why a regex scan is not enough).
 *  Nothing is grandfathered: an entry that already ships must still pass.
 *
 *  The rule numbers below are the design's Export eligibility rules
 *  (`plan/all/cli-node-sdk/final/design.md`). Rules 1-3 are structural and are
 *  enforced here. Rules 4-6 — deadlines, asynchronous filesystem work, one
 *  error vocabulary — are behavioural and belong to the interface and
 *  concurrency tests of each admitted read.
 *
 *  The last describe block audits the auditor: a gate nobody has watched fail
 *  is not known to work, so the two shapes that defeat a regex — a re-export
 *  and a type-only import — are planted against the identical walker and their
 *  verdicts asserted.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  AMBIENT_ENV_ALLOWLIST,
  CLI_ROOT,
  closureOf,
  emittedPathFor,
  packageExports,
  scanFile,
  type ClosureFile,
} from "../helpers/export-closure.ts";

/** Every file every export can reach, checked in so that widening a closure is
 *  a visible diff on this list rather than an invisible new edge. */
const EXPECTED_CLOSURES: Record<string, string[]> = {
  "./core/paths": [
    "src/lib/core/errors.ts",
    "src/lib/core/paths/index.ts",
    "src/lib/core/paths/project-registry.ts",
    "src/lib/core/paths/toml.ts",
    "src/lib/core/paths/yaco-home.ts",
    "src/lib/core/paths/yaco-paths.ts",
    "src/lib/core/result.ts",
  ],
  "./core/result": ["src/lib/core/result.ts"],
  "./core/errors": ["src/lib/core/errors.ts", "src/lib/core/result.ts"],
  "./core/task": [
    "src/lib/core/errors.ts",
    "src/lib/core/paths/index.ts",
    "src/lib/core/paths/project-registry.ts",
    "src/lib/core/paths/toml.ts",
    "src/lib/core/paths/yaco-home.ts",
    "src/lib/core/paths/yaco-paths.ts",
    "src/lib/core/result.ts",
    "src/lib/core/task/archive.ts",
    "src/lib/core/task/graph.ts",
    "src/lib/core/task/index.ts",
    "src/lib/core/task/link.ts",
    "src/lib/core/task/lock.ts",
    "src/lib/core/task/model.ts",
    "src/lib/core/task/store.ts",
    "src/lib/core/task/validation.ts",
  ],
  "./core/agent": [
    "src/lib/core/agent/index.ts",
    "src/lib/core/agent/model.ts",
    "src/lib/core/agent/projection.ts",
    "src/lib/core/agent/words.ts",
    "src/lib/core/errors.ts",
    "src/lib/core/result.ts",
  ],
  "./core/worktree": [
    "src/lib/core/errors.ts",
    "src/lib/core/result.ts",
    "src/lib/core/worktree/convention.ts",
    "src/lib/core/worktree/index.ts",
    "src/lib/core/worktree/slug.ts",
  ],
};

/** The subsystems the design excludes by name. Each entry names real files, and
 *  their existence is asserted: a rename that empties one of these lists would
 *  otherwise turn the check vacuous — the exact failure mode this repository
 *  has already shipped once. */
const FORBIDDEN_SUBSYSTEMS: Record<string, string[]> = {
  tmux: ["src/lib/core/agent/tmux.ts"],
  reconciliation: ["src/commands/agent/status.ts"],
  lifecycle: [
    "src/lib/core/agent/lifecycle.ts",
    "src/lib/core/worktree/create.ts",
    "src/lib/core/worktree/merge.ts",
    "src/lib/core/worktree/cleanup.ts",
    "src/lib/core/worktree/pr.ts",
    "src/lib/core/worktree/git.ts",
  ],
  usage: ["src/lib/core/agent/providers/usage.ts", "src/commands/agent/usage.ts"],
  mutation: [
    "src/lib/core/agent/session-state.ts",
    "src/lib/core/agent/kill-sentinel.ts",
    "src/lib/core/project/move.ts",
  ],
  // Not one of the design's five names, but the module's own header states the
  // same invariant: a blocked thread in an exported read is a stalled server.
  "synchronous sleep": ["src/lib/core/sleep.ts"],
};

const closures = new Map<string, ClosureFile[]>(
  packageExports().map((entry) => [entry.subpath, closureOf(entry.source)]),
);

const describeChain = (file: ClosureFile): string => file.via.join("\n     -> ");

describe("export map", () => {
  it("declares every export against an existing source entry", () => {
    for (const entry of packageExports()) {
      expect(existsSync(resolve(CLI_ROOT, entry.source)), entry.source).toBe(true);
    }
  });

  it("points published consumers at the emit of the audited source", () => {
    // The audit walks TypeScript source; consumers load `dist`. These two are
    // the same module only because `rootDir: src` / `outDir: dist` is a
    // one-to-one map — so an entry whose conditions disagree would ship an
    // unaudited module under an audited name.
    for (const entry of packageExports()) {
      expect(entry.emitted, entry.subpath).toBe(emittedPathFor(entry.source, ".js"));
      expect(entry.types, entry.subpath).toBe(emittedPathFor(entry.source, ".d.ts"));
    }
  });
});

describe("rule 1 — ambient environment surface is a closed allowlist", () => {
  it("reads no environment name outside the allowlist", () => {
    const offenders: string[] = [];
    for (const [subpath, closure] of closures) {
      for (const file of closure) {
        for (const read of scanFile(resolve(CLI_ROOT, file.path)).envReads) {
          if ((AMBIENT_ENV_ALLOWLIST as readonly string[]).includes(read.name)) continue;
          offenders.push(
            `${subpath}: ${read.path}:${read.line} reads ${read.name}\n  via ${describeChain(file)}`,
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("keeps the allowlist itself closed at three names", () => {
    // Widening the allowlist is a design change, not a test fix.
    expect([...AMBIENT_ENV_ALLOWLIST]).toEqual([
      "YACO_HOME",
      "HOME",
      "YACO_AGENT_SESSIONS_DIR",
    ]);
  });
});

describe("rules 1-3 — no ambient request state, no process ownership, nothing synchronous", () => {
  it("has no violation in any exported closure", () => {
    const offenders: string[] = [];
    for (const [subpath, closure] of closures) {
      for (const file of closure) {
        for (const v of scanFile(resolve(CLI_ROOT, file.path)).violations) {
          offenders.push(
            `${subpath}: ${v.path}:${v.line} rule ${v.rule}: ${v.detail}\n  via ${describeChain(file)}`,
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("closure census", () => {
  it("audits exactly the exports the manifest declares", () => {
    expect([...closures.keys()].sort()).toEqual(Object.keys(EXPECTED_CLOSURES).sort());
  });

  for (const [subpath, expected] of Object.entries(EXPECTED_CLOSURES)) {
    it(`reaches exactly the reviewed files from ${subpath}`, () => {
      const actual = closures.get(subpath)?.map((f) => f.path) ?? [];
      expect(actual).toEqual(expected);
    });
  }
});

describe("no excluded subsystem is reachable from any export", () => {
  const reachable = new Set(
    [...closures.values()].flat().map((f) => f.path),
  );

  for (const [subsystem, files] of Object.entries(FORBIDDEN_SUBSYSTEMS)) {
    it(`keeps ${subsystem} out of every closure`, () => {
      for (const file of files) {
        // Anti-vacuity: the ban means nothing if the file it names is gone.
        expect(existsSync(resolve(CLI_ROOT, file)), `${file} no longer exists`).toBe(true);
        expect(reachable.has(file), `${file} is reachable from an export`).toBe(false);
      }
    });
  }

  it("reaches no command module at all", () => {
    // Reconciliation, agent lifecycle, and usage all live behind the command
    // layer; nothing below `src/lib/core` may pull it in.
    const commands = [...reachable].filter(
      (p) => p.startsWith("src/commands/") || p === "src/main.ts",
    );
    expect(commands).toEqual([]);
  });
});

describe("the audit itself", () => {
  /** A throwaway `src` tree the real walker runs over unmodified. */
  const plant = (files: Record<string, string>): { root: string; entry: string } => {
    const dir = mkdtempSync(join(tmpdir(), "yaco-export-audit-"));
    for (const [rel, source] of Object.entries(files)) {
      const abs = join(dir, "src", rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, source);
    }
    return { root: join(dir, "src"), entry: "src/index.ts" };
  };

  const envNamesFrom = (root: string, entry: string): string[] =>
    closureOf(entry, root)
      .flatMap((f) => scanFile(resolve(dirname(root), f.path), root).envReads)
      .map((r) => r.name);

  it("sees a fourth environment name planted behind a re-export", () => {
    // The regex-defeating shape: the barrel has no `import`, only `export from`.
    const { root, entry } = plant({
      "index.ts": `export { root } from "./hidden.ts";\n`,
      "hidden.ts": `export const root = process.env["YACO_SECRET_ROOT"] ?? "";\n`,
    });
    try {
      expect(closureOf(entry, root).map((f) => f.path)).toEqual([
        "src/hidden.ts",
        "src/index.ts",
      ]);
      expect(envNamesFrom(root, entry)).toEqual(["YACO_SECRET_ROOT"]);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  it("counts an inline type modifier as a runtime edge and `import type` as none", () => {
    // `import { type A } from "m"` still emits `import {} from "m"` under
    // verbatimModuleSyntax, so it cannot be used to hide a module; a whole
    // `import type` statement is erased and genuinely is not an edge.
    const { root, entry } = plant({
      "index.ts":
        `import { type Inline } from "./inline.ts";\n` +
        `import type { Erased } from "./erased.ts";\n` +
        `export type Both = Inline | Erased;\n`,
      // Both hide the same thing; only the erased import actually hides it.
      "inline.ts":
        `export type Inline = string;\n` +
        `export const root = process.env["YACO_INLINE_ROOT"] ?? "";\n`,
      "erased.ts":
        `export type Erased = string;\n` +
        `export const root = process.env["YACO_ERASED_ROOT"] ?? "";\n`,
    });
    try {
      expect(closureOf(entry, root).map((f) => f.path)).toEqual([
        "src/index.ts",
        "src/inline.ts",
      ]);
      expect(envNamesFrom(root, entry)).toEqual(["YACO_INLINE_ROOT"]);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  it("follows a lazy dynamic import and flags what it reaches", () => {
    const { root, entry } = plant({
      "index.ts": `export const load = async () => (await import("./lazy.ts")).run();\n`,
      "lazy.ts":
        `import { spawnSync } from "node:child_process";\n` +
        `export const run = () => spawnSync("git", ["status"]);\n`,
    });
    try {
      const closure = closureOf(entry, root);
      expect(closure.map((f) => f.path)).toEqual(["src/index.ts", "src/lazy.ts"]);
      const violations = closure.flatMap(
        (f) => scanFile(resolve(dirname(root), f.path), root).violations,
      );
      expect(violations.map((v) => `${v.rule}:${v.detail}`)).toEqual(["3:spawnSync()"]);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  it("refuses an environment read whose name it cannot see", () => {
    const { root } = plant({
      "index.ts":
        `const key = "YACO_" + "HOME";\n` +
        `export const a = process.env[key];\n` +
        `export const b = { ...process.env };\n`,
    });
    try {
      const scan = scanFile(join(root, "index.ts"), root);
      expect(scan.envReads).toEqual([]);
      expect(scan.violations.map((v) => `${v.rule}:${v.detail}`)).toEqual([
        "1:process.env read with no literal name",
        "1:process.env read with no literal name",
      ]);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  it("is not evaded by reaching process through globalThis", () => {
    const { root } = plant({
      "index.ts":
        `export const a = globalThis.process.env["YACO_SNEAK_ROOT"];\n` +
        `export const b = () => globalThis.process.exit(1);\n`,
    });
    try {
      const scan = scanFile(join(root, "index.ts"), root);
      expect(scan.envReads.map((r) => r.name)).toEqual(["YACO_SNEAK_ROOT"]);
      expect(scan.violations.map((v) => v.detail)).toEqual(["process.exit"]);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });
});
