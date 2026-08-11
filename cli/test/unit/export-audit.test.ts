/** The export eligibility gate.
 *
 *  Every `package.json#exports` entry is audited through its transitive
 *  production import closure, walked with the TypeScript compiler (see
 *  `test/helpers/export-closure.ts` for why a regex scan is not enough).
 *  Nothing is grandfathered: an entry that already ships must still pass.
 *
 *  The rule numbers are the design's Export eligibility rules
 *  (`plan/all/cli-node-sdk/final/design.md`). Rules 1-3 are structural and are
 *  enforced in full. Rule 5 has a grep-checkable half (synchronous directory
 *  enumeration) which is enforced with one tracked debt, named below. Rules 4
 *  and 6 — caller deadlines, one error vocabulary — are behavioural, and the
 *  design assigns them to each admitted read's own interface and concurrency
 *  tests rather than to this static audit.
 *
 *  The last describe block audits the auditor: a gate nobody has watched fail
 *  is not known to work, so every shape that could defeat it — a re-export, a
 *  type-only import, a lazy `import()`, a computed key, `globalThis`, an
 *  aliased import, a string-keyed member — is planted against the identical
 *  walker and its verdict asserted.
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
  exportedNames,
  packageExports,
  scanFile,
  type ClosureFile,
} from "../helpers/export-closure.ts";

interface ExpectedExport {
  /** Every file the export can reach. Checked in so that widening a closure is
   *  a visible diff rather than an invisible new edge. */
  files: string[];
  /** Every specifier the walk could not follow into first-party source. A new
   *  package dependency inside an export closure is a distribution decision. */
  externals: string[];
  /** Every name the entry publishes. This is what keeps a mutation out of a
   *  barrel: the file census cannot see it, because the module is already in
   *  the closure for its read half. */
  names: string[];
}

const EXPECTED: Record<string, ExpectedExport> = {
  "./core/paths": {
    files: [
      "src/lib/core/errors.ts",
      "src/lib/core/paths/index.ts",
      "src/lib/core/paths/project-registry.ts",
      "src/lib/core/paths/toml.ts",
      "src/lib/core/paths/yaco-home.ts",
      "src/lib/core/paths/yaco-paths.ts",
      "src/lib/core/result.ts",
    ],
    externals: ["node:fs", "node:os", "node:path"],
    // The project registry's writers are exported deliberately: the app server
    // is the CLI's peer on that file, not a reader of it, and the design keeps
    // one implementation of the on-disk shape rather than two.
    names: [
      "DEFAULT_PROJECT_PATHS", "ParsedTomlSections", "Project", "ProjectRecord",
      "TomlParseError", "YacoProjectPaths", "addProject", "agentWrapperPath",
      "channelScopeDir", "channelsDir", "ensureYacoHome", "getYacoHome",
      "originsDir", "parseScopedToml", "projectEventsFile", "projectsFile",
      "projectsRegistryPath", "readProjects", "readYacoProjectPaths",
      "removeProject", "sessionsDir", "shellSessionsDir", "uiStateDir",
      "writeProjects",
    ],
  },
  "./core/result": {
    files: ["src/lib/core/result.ts"],
    externals: [],
    names: ["Err", "Ok", "Result", "err", "isErr", "isOk", "map", "ok", "unwrap"],
  },
  "./core/errors": {
    files: ["src/lib/core/errors.ts", "src/lib/core/result.ts"],
    externals: [],
    names: ["CliError", "ErrCode", "exitCodeFor", "toErr"],
  },
  "./core/task": {
    files: [
      "src/lib/core/errors.ts",
      "src/lib/core/paths/index.ts",
      "src/lib/core/paths/project-registry.ts",
      "src/lib/core/paths/toml.ts",
      "src/lib/core/paths/yaco-home.ts",
      "src/lib/core/paths/yaco-paths.ts",
      "src/lib/core/result.ts",
      "src/lib/core/task/graph.ts",
      "src/lib/core/task/index.ts",
      "src/lib/core/task/model.ts",
      "src/lib/core/task/store.ts",
      "src/lib/core/task/validation.ts",
    ],
    externals: ["node:fs", "node:os", "node:path"],
    // No writer, no lock, no link mutation: task mutation is one authority and
    // it stays behind the CLI subprocess boundary.
    names: [
      "BLOCK_REASONS", "BlockReason", "DEFAULT_TASK_LOCK_TIMEOUT_MS",
      "DEFAULT_WORKSET", "ESTIMATES", "Estimate", "PRIORITIES", "Priority",
      "SLUG_RE", "STATES", "State", "TERMINAL", "Task", "TaskGraph",
      "TaskStore", "ValidationProblems", "ValidationReport", "WORKSETS",
      "Workset", "checkCycles", "childrenOf", "collectParentChain",
      "defaultTaskFileFor", "defaultTaskFileForId", "formatJson", "hasChildren",
      "isAcceptCriteriaBlank", "isState", "isWorkset", "loadTaskStore",
      "loadTasks", "resolveTasksPathForSessionPath", "rollup",
      "sourceForNewTask", "sourceForTask", "validateGraph", "validateRefs",
      "validateState", "validateTypes",
    ],
  },
  "./core/agent": {
    files: [
      "src/lib/core/agent/index.ts",
      "src/lib/core/agent/model.ts",
      "src/lib/core/agent/projection.ts",
      "src/lib/core/agent/words.ts",
      "src/lib/core/errors.ts",
      "src/lib/core/result.ts",
    ],
    externals: ["node:crypto", "node:path"],
    names: [
      "AgentSessionRow", "NOTICE_MAX", "ProjectRef", "ProjectableSessionState",
      "clampNotice", "isPathDescendantOrEqual", "normalizeProjectPath",
      "resolveProjectForPath", "toSessionRow",
    ],
  },
  "./core/worktree": {
    files: [
      "src/lib/core/errors.ts",
      "src/lib/core/result.ts",
      "src/lib/core/worktree/convention.ts",
      "src/lib/core/worktree/index.ts",
      "src/lib/core/worktree/slug.ts",
    ],
    externals: ["node:path"],
    names: ["validateSlug", "worktreeBranch", "worktreePath"],
  },
};

/** Rule 5's one tracked debt, not a waiver.
 *
 *  `loadTaskStore` walks the task tree with a synchronous recursive `readdir`
 *  (`store.ts#walkTaskDir`), and `app/server` already calls it in process. The
 *  design's Phase-2 cutover 1 — task GET against an `fs/promises` chunked
 *  reader — is what retires it; that is the next task, not this one. Until
 *  then this is the single admitted site: a second one fails the audit, and
 *  when the cutover lands the entry must be deleted, which the debt's own
 *  anti-vacuity check below forces. */
const RULE_5_DEBT = ["src/lib/core/task/store.ts"];

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
    "src/lib/core/task/lock.ts",
    "src/lib/core/task/link.ts",
    "src/lib/core/task/archive.ts",
    "src/lib/core/agent/session-state.ts",
    "src/lib/core/agent/kill-sentinel.ts",
    "src/lib/core/project/move.ts",
  ],
  // Not one of the design's five names, but the module's own header states the
  // same invariant: a blocked thread in an exported read is a stalled server.
  "synchronous sleep": ["src/lib/core/sleep.ts"],
};

const closures = new Map(
  packageExports().map((entry) => [entry.subpath, closureOf(entry.source)]),
);

const describeChain = (file: ClosureFile): string => file.via.join("\n     -> ");
const scanOf = (file: ClosureFile) => scanFile(resolve(CLI_ROOT, file.path));

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
      for (const file of closure.files) {
        for (const read of scanOf(file).envReads) {
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

describe("rules 1-3 and 5 — no ambient request state, no process ownership, nothing synchronous", () => {
  const offendersOutsideDebt = (): string[] => {
    const out: string[] = [];
    for (const [subpath, closure] of closures) {
      for (const file of closure.files) {
        for (const v of scanOf(file).violations) {
          if (v.rule === 5 && RULE_5_DEBT.includes(v.path)) continue;
          out.push(
            `${subpath}: ${v.path}:${v.line} rule ${v.rule}: ${v.detail}\n  via ${describeChain(file)}`,
          );
        }
      }
    }
    return out;
  };

  it("has no violation in any exported closure", () => {
    const offenders = offendersOutsideDebt();
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("still owes exactly the tracked rule-5 debt", () => {
    // When the task-read cutover lands its asynchronous reader, this fails and
    // the debt entry is deleted — the audit will not let it linger unnoticed.
    const owing = [
      ...new Set(
        [...closures.values()]
          .flatMap((c) => c.files)
          .flatMap((f) => scanOf(f).violations)
          .filter((v) => v.rule === 5)
          .map((v) => v.path),
      ),
    ].sort();
    expect(owing).toEqual(RULE_5_DEBT);
  });
});

describe("closure census", () => {
  it("audits exactly the exports the manifest declares", () => {
    expect([...closures.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [subpath, expected] of Object.entries(EXPECTED)) {
    it(`reaches exactly the reviewed files from ${subpath}`, () => {
      expect(closures.get(subpath)?.files.map((f) => f.path) ?? []).toEqual(expected.files);
    });

    it(`leaves exactly the reviewed specifiers unwalked from ${subpath}`, () => {
      expect(closures.get(subpath)?.externals ?? []).toEqual(expected.externals);
    });

    it(`publishes exactly the reviewed names from ${subpath}`, () => {
      const entry = packageExports().find((e) => e.subpath === subpath)!;
      expect(exportedNames(entry.source)).toEqual([...expected.names].sort());
    });
  }
});

describe("no excluded subsystem is reachable from any export", () => {
  const reachable = new Set([...closures.values()].flatMap((c) => c.files).map((f) => f.path));

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
      .files.flatMap((f) => scanFile(resolve(dirname(root), f.path), root).envReads)
      .map((r) => r.name);

  const detailsOf = (root: string, file = "index.ts"): string[] =>
    scanFile(join(root, file), root).violations.map((v) => `${v.rule}:${v.detail}`);

  it("sees a fourth environment name planted behind a re-export", () => {
    // The regex-defeating shape: the barrel has no `import`, only `export from`.
    const { root, entry } = plant({
      "index.ts": `export { root } from "./hidden.ts";\n`,
      "hidden.ts": `export const root = process.env["YACO_SECRET_ROOT"] ?? "";\n`,
    });
    try {
      expect(closureOf(entry, root).files.map((f) => f.path)).toEqual([
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
      expect(closureOf(entry, root).files.map((f) => f.path)).toEqual([
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
      expect(closure.files.map((f) => f.path)).toEqual(["src/index.ts", "src/lazy.ts"]);
      expect(detailsOf(root, "lazy.ts")).toEqual(["3:import spawnSync", "3:spawnSync()"]);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  it("reports an unwalkable specifier instead of dropping it", () => {
    const { root, entry } = plant({
      "index.ts": `import { parse } from "smol-toml";\nexport const p = parse;\n`,
    });
    try {
      expect(closureOf(entry, root).externals).toEqual(["smol-toml"]);
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
      expect(scanFile(join(root, "index.ts"), root).envReads).toEqual([]);
      expect(detailsOf(root)).toEqual([
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

  it("is not evaded by string-keyed members or by destructuring process", () => {
    const { root } = plant({
      "index.ts":
        `export const a = () => process["exit"](1);\n` +
        `const { stdout } = process;\n` +
        `export const b = () => stdout.write("x");\n` +
        `const which = "std" + "err";\n` +
        `export const c = () => process[which];\n`,
    });
    try {
      expect(detailsOf(root)).toEqual([
        "2:process.exit",
        "2:process destructured",
        "2:process[<computed member>]",
      ]);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  it("is not evaded by aliasing or string-keying a synchronous primitive", () => {
    const { root } = plant({
      "index.ts":
        `import { spawnSync as run } from "node:child_process";\n` +
        `import * as cp from "node:child_process";\n` +
        `export const a = () => run("git", ["status"]);\n` +
        `export const b = () => cp["execSync"]("git status");\n`,
    });
    try {
      expect(detailsOf(root)).toEqual(["3:import spawnSync", "3:execSync()"]);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  it("flags synchronous directory enumeration as the rule-5 half it can see", () => {
    const { root } = plant({
      "index.ts":
        `import { readdirSync, readFileSync } from "node:fs";\n` +
        `export const a = (d: string) => readdirSync(d);\n` +
        `export const b = (f: string) => readFileSync(f, "utf-8");\n`,
    });
    try {
      // readFileSync is absent on purpose: rule 5 admits a single bounded read.
      expect(detailsOf(root)).toEqual(["5:import readdirSync", "5:readdirSync()"]);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });
});
