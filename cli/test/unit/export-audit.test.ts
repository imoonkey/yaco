/** The export eligibility gate.
 *
 *  Every `package.json#exports` entry is audited through its transitive
 *  production import closure, walked with the TypeScript compiler (see
 *  `test/helpers/export-closure.ts` for why a regex scan is not enough).
 *  Nothing is grandfathered: an entry that already ships must still pass.
 *
 *  The rule numbers are the design's Export eligibility rules
 *  (`plan/all/cli-node-sdk/final/design.md`):
 *
 *    1-3  structural — enforced in full.
 *    4    caller deadlines and cleanup for external work — behavioural, and
 *         vacuous today: no eligible closure contains a subprocess, a network
 *         request, a lock or a retry, which the census and the mutation ban
 *         are what keep true.
 *    5    enforced for everything decidable from syntax — any unbounded `…Sync`
 *         operation — with one tracked debt, named below.
 *    6    enforced as its one static tripwire: no export publishes an error
 *         type other than `CliError`.
 *
 *  What is left to each admitted read's own interface and concurrency tests is
 *  the part no syntax can settle: that a deadline is honoured, that a walk is
 *  actually bounded, that a failure carries the right code.
 *
 *  The last describe block audits the auditor: a gate nobody has watched fail
 *  is not known to work, so every shape that could defeat it — a re-export, a
 *  type-only import, a lazy `import()`, a computed key, `globalThis`, an alias
 *  of `process` or of a synchronous primitive, a string-keyed member, a
 *  polling loop — is planted against the identical walker and its verdict
 *  asserted.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  AMBIENT_ENV_ALLOWLIST,
  CLI_ROOT,
  closureOf,
  emittedPathFor,
  exportedErrorClasses,
  exportedNames,
  packageExports,
  scanFile,
  scanSqliteUse,
  type ClosureFile,
} from "../helpers/export-closure.ts";

interface ExpectedExport {
  /** Every file the export can reach. Checked in so that widening a closure is
   *  a visible diff rather than an invisible new edge. */
  files: string[];
  /** Every specifier the walk could not follow into first-party source. A new
   *  package dependency inside an export closure is a distribution decision. */
  externals: string[];
  /** Every name the entry publishes, grouped by the file it comes from. This
   *  is what keeps a mutation out of a barrel: the file census cannot see it,
   *  because the module is already in the closure for its read half — and the
   *  published name alone cannot either, since a same-named writer added to an
   *  already-reachable file would leave both intact. */
  names: Record<string, string[]>;
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
    names: {
      "src/lib/core/paths/project-registry.ts": [
        "Project",
        "ProjectRecord",
        "addProject",
        "ensureYacoHome",
        "projectsRegistryPath",
        "readProjects",
        "removeProject",
        "writeProjects",
      ],
      "src/lib/core/paths/toml.ts": [
        "ParsedTomlSections",
        "parseScopedToml",
      ],
      "src/lib/core/paths/yaco-home.ts": [
        "agentWrapperPath",
        "channelScopeDir",
        "channelsDir",
        "getYacoHome",
        "originsDir",
        "projectEventsFile",
        "projectsFile",
        "sessionsDir",
        "shellSessionsDir",
        "uiStateDir",
      ],
      "src/lib/core/paths/yaco-paths.ts": [
        "DEFAULT_PROJECT_PATHS",
        "YacoProjectPaths",
        "readYacoProjectPaths",
      ],
    },
  },
  "./core/result": {
    files: ["src/lib/core/result.ts"],
    externals: [],
    names: {
      "src/lib/core/result.ts": [
        "Err",
        "Ok",
        "Result",
        "err",
        "isErr",
        "isOk",
        "map",
        "ok",
        "unwrap",
      ],
    },
  },
  "./core/errors": {
    files: ["src/lib/core/errors.ts", "src/lib/core/result.ts"],
    externals: [],
    names: {
      "src/lib/core/errors.ts": [
        "CliError",
        "ErrCode",
        "exitCodeFor",
        "toErr",
      ],
    },
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
      "src/lib/core/task/read.ts",
      "src/lib/core/task/store.ts",
      "src/lib/core/task/validation.ts",
    ],
    externals: ["node:fs", "node:fs/promises", "node:os", "node:path"],
    // No writer, no lock, no link mutation: task mutation is one authority and
    // it stays behind the CLI subprocess boundary.
    names: {
      "src/lib/core/task/graph.ts": [
        "ValidationProblems",
        "ValidationReport",
        "checkCycles",
        "childrenOf",
        "collectParentChain",
        "hasChildren",
        "rollup",
        "validateGraph",
        "validateRefs",
        "validateState",
      ],
      "src/lib/core/task/model.ts": [
        "BLOCK_REASONS",
        "BlockReason",
        "DEFAULT_TASK_LOCK_TIMEOUT_MS",
        "DEFAULT_WORKSET",
        "ESTIMATES",
        "Estimate",
        "PRIORITIES",
        "Priority",
        "SLUG_RE",
        "STATES",
        "State",
        "TERMINAL",
        "Task",
        "TaskGraph",
        "WORKSETS",
        "Workset",
        "isState",
        "isWorkset",
      ],
      // The composed read `app/server` calls in process: explicit repo root
      // in, `Result` out, and the same function `yaco task list` renders.
      "src/lib/core/task/read.ts": [
        "TaskListData",
        "TaskListInput",
        "TaskWorksetFilter",
        "readTaskList",
      ],
      "src/lib/core/task/store.ts": [
        "TaskStore",
        "defaultTaskFileFor",
        "defaultTaskFileForId",
        "formatJson",
        "loadTaskStore",
        "loadTasks",
        "resolveTasksPathForSessionPath",
        "sourceForNewTask",
        "sourceForTask",
      ],
      "src/lib/core/task/validation.ts": [
        "isAcceptCriteriaBlank",
        "validateTypes",
      ],
    },
  },
  // The pure session projection, the provider identity table, and the one
  // project-history read. History is what puts a filesystem and a database in
  // this closure at all: `providers/history.ts` for the merge and the two
  // bounded provider scans, `codex-thread-window.ts` for the judged query,
  // `origin-read.ts` for the window's origin lookup — and no writer beside any
  // of them. It reaches neither `session-state.ts` (a mutation module; the live
  // sessions are an explicit input) nor `providers/index.ts` (the TUI registry
  // reaches tmux, hooks and the lifecycle; the history readers have their own
  // two-entry lookup, and a test fails closed when a registered provider is
  // missing from it).
  "./core/agent": {
    files: [
      "src/lib/core/agent/index.ts",
      "src/lib/core/agent/model.ts",
      "src/lib/core/agent/origin-read.ts",
      "src/lib/core/agent/projection.ts",
      "src/lib/core/agent/provider-catalog.ts",
      "src/lib/core/agent/providers/codex-thread-window.ts",
      "src/lib/core/agent/providers/history.ts",
      "src/lib/core/agent/providers/prompt-label.ts",
      "src/lib/core/agent/providers/provider-home.ts",
      "src/lib/core/agent/words.ts",
      "src/lib/core/errors.ts",
      "src/lib/core/paths/yaco-home.ts",
      "src/lib/core/project/encode.ts",
      "src/lib/core/result.ts",
    ],
    externals: [
      "node:crypto",
      "node:fs",
      "node:fs/promises",
      "node:os",
      "node:path",
      // The judged synchronous admission — see RULE_5_SQLITE below.
      "node:sqlite",
    ],
    names: {
      "src/lib/core/agent/model.ts": [
        "NOTICE_MAX",
        "clampNotice",
      ],
      // Provider identity only. The registry that owns behaviour reaches tmux,
      // hook installation and the session lifecycle, and is not exportable.
      "src/lib/core/agent/provider-catalog.ts": [
        "ProviderCatalogEntry",
        "providerCatalog",
      ],
      "src/lib/core/agent/projection.ts": [
        "AgentSessionRow",
        "ProjectRef",
        "ProjectableSessionState",
        "isPathDescendantOrEqual",
        "normalizeProjectPath",
        "resolveProjectForPath",
        "toSessionRow",
      ],
      // One read verb, the shape of its live-session input, the window's
      // default, and the reader registry as the only answer to which reader a
      // provider uses. No provider scan is published on its own: a caller that
      // could reach one could scan a provider without the window.
      "src/lib/core/agent/providers/history.ts": [
        "DEFAULT_HISTORY_LIMIT",
        "HistoryLiveSession",
        "historyReaderForProvider",
        "readProjectHistory",
      ],
      "src/lib/core/agent/providers/types.ts": [
        "HistorySession",
        "HistoryWindow",
      ],
    },
  },
  // The one message-inventory read. Its closure reaches the provider log-path
  // and line-classification half of `providers/output.ts`; the polling tailer
  // that used to sit in that file lives in `providers/follow.ts`, which nothing
  // exported reaches.
  "./core/agent/messages": {
    files: [
      "src/lib/core/agent/model.ts",
      "src/lib/core/agent/providers/message-read.ts",
      "src/lib/core/agent/providers/messages.ts",
      "src/lib/core/agent/providers/output.ts",
      "src/lib/core/agent/providers/provider-home.ts",
      "src/lib/core/agent/words.ts",
      "src/lib/core/errors.ts",
      "src/lib/core/project/encode.ts",
      "src/lib/core/result.ts",
    ],
    externals: ["node:crypto", "node:fs", "node:fs/promises", "node:os", "node:path"],
    // One read verb plus the shape of its inputs and rows. No writer, no
    // follower, no provider registry: the TUI registry reaches tmux and the
    // session lifecycle, so the message-capable providers are listed here.
    names: {
      "src/lib/core/agent/model.ts": [
        "validateName",
      ],
      "src/lib/core/agent/providers/message-read.ts": [
        "MessageFilter",
        "MessagesRange",
        "messagesForProvider",
        "readMessageRows",
      ],
      "src/lib/core/agent/providers/types.ts": [
        "MessageFull",
        "MessageRole",
      ],
    },
  },
  // The one session-summary read. Its closure reaches the provider log-path
  // half of `providers/output.ts` and the label-collapsing rules it shares with
  // the history list; it reaches neither `history.ts` (whose provider scans are
  // unbounded) nor `session-state.ts` (a mutation module) — the sessions are
  // explicit inputs, so it never enumerates them.
  "./core/agent/summaries": {
    files: [
      "src/lib/core/agent/model.ts",
      "src/lib/core/agent/providers/codex-thread.ts",
      "src/lib/core/agent/providers/output.ts",
      "src/lib/core/agent/providers/prompt-label.ts",
      "src/lib/core/agent/providers/provider-home.ts",
      "src/lib/core/agent/providers/summary-read.ts",
      "src/lib/core/agent/words.ts",
      "src/lib/core/errors.ts",
      "src/lib/core/project/encode.ts",
      "src/lib/core/result.ts",
    ],
    externals: [
      "node:crypto",
      "node:fs",
      "node:fs/promises",
      "node:os",
      "node:path",
      // The judged synchronous admission — see RULE_5_SQLITE below.
      "node:sqlite",
    ],
    // One read verb plus the shape of its input and rows, and the summarizer
    // registry as the only answer to which reader a provider uses.
    names: {
      "src/lib/core/agent/providers/summary-read.ts": [
        "SessionSummary",
        "SummaryTarget",
        "readSessionSummaries",
        "summarizerForProvider",
      ],
    },
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
    names: {
      "src/lib/core/worktree/convention.ts": [
        "worktreeBranch",
        "worktreePath",
      ],
      "src/lib/core/worktree/slug.ts": [
        "validateSlug",
      ],
    },
  },
};

/** Rule 5 owes nothing.
 *
 *  It owed exactly one thing: `loadTaskStore` walked the task tree with a
 *  synchronous recursive `readdir` while `app/server` called it in process.
 *  The design's Phase-2 cutover 1 retired it — `store.ts` reads through
 *  `fs/promises` in bounded chunks now, and `readTaskList` is the composed read
 *  both the CLI and the app go through.
 *
 *  The list stays, empty, because it is the shape of the check rather than a
 *  waiver: a new synchronous traversal in any exported closure fails "still
 *  owes exactly the tracked rule-5 debt", and admitting one means writing it
 *  down here with the task that retires it. */
const RULE_5_DEBT: string[] = [];

/** Rule 5's judged synchronous admissions — the opposite of a debt.
 *
 *  A debt is owed and has a task that retires it. These are permanent, and each
 *  one is here because rule 5 admits it *against a measurement*: "`node:sqlite`
 *  has no asynchronous interface, so a query is admitted only with a measured
 *  stall bound on a realistically large database."
 *
 *  Keyed by exact site rather than by adding `DatabaseSync` to the walker's
 *  bounded-name list, because the name is a database handle and not an
 *  operation: `BOUNDED_SYNC` would admit `.all()` over a whole table, anywhere,
 *  invisibly. What is admitted is not the import — it is `prepares`, the exact
 *  queries measured, checked against the module's AST, with every *read* of an
 *  unbounded execution member in that module rejected. Changing the SQL, adding
 *  a second query, or reaching `all` through a variable, a `.bind`, a `.call` or
 *  a computed key all fail. Rejecting the member read rather than the call is
 *  what makes an admitted module necessarily tiny — see `codex-thread.ts`. */
interface SqliteAdmission {
  /** The measurement, and the command that reproduces it. */
  bound: string;
  /** Every SQL string the admitted module prepares, whitespace-normalized —
   *  the human-legible half, so a reader can see what the bound is a bound on. */
  prepares: string[];
  /** The checked-in JavaScript the measured module compiles to. This is the pin
   *  an enumeration of forbidden constructs cannot be: an admission says "*this
   *  code* costs 0.3 ms", and that sentence is only true of this code. */
  emitted: string;
  /** The harness `bound` is reproducible from. Per admission, not one global
   *  name: an admission nobody can re-run is a waiver wearing its clothes, and
   *  the two judged queries are measured by two different benches. */
  bench: string;
}

const RULE_5_SQLITE: Record<string, SqliteAdmission> = {
  "src/lib/core/agent/providers/codex-thread.ts import DatabaseSync": {
    bound:
      "point lookup on the `threads` primary key (SEARCH threads USING INDEX " +
      "sqlite_autoindex_threads_1 (id=?)) on an 11.1 MB, 2 297-row database: " +
      "0.3 ms p50 and max over 40 warm samples, open and close included. " +
      "Reproduce with `node test/bench/summary-stall.ts --sqlite-probe --home ~`.",
    prepares: ["SELECT title, first_user_message FROM threads WHERE id = ?"],
    emitted: "test/fixtures/rule5-sqlite/codex-thread.emit.js",
    bench: "test/bench/summary-stall.ts",
  },
  // The history window's query. It is a *statement* bound rather than a scan
  // bound, and the probe prints the plan that makes that so: Codex's composite
  // `cwd` indexes order by its millisecond columns while this reads the
  // second-resolution `updated_at`, so SQLite filters through an index and
  // sorts the matches in a temp B-tree. `LIMIT` bounds what crosses into
  // JavaScript — and therefore the per-row rollout tail-reads — not the rows
  // examined. Measured whole, which is what the admission has to be.
  "src/lib/core/agent/providers/codex-thread-window.ts import DatabaseSync": {
    bound:
      "the newest 201 non-archived threads of the busiest cwd (SEARCH threads " +
      "USING INDEX idx_threads_archived_cwd_recency_at_ms (archived=? AND cwd=?) / " +
      "USE TEMP B-TREE FOR ORDER BY, 587 rows matched) on an 11.1 MB, 2 301-row " +
      "database: 3.0 ms p50, 5.4 ms p95, 8.3 ms max over 40 warm samples, open " +
      "and close included. " +
      "Reproduce with `node test/bench/history-stall.ts --sqlite-probe --home ~`.",
    prepares: [
      "SELECT id, title, first_user_message, created_at, updated_at, git_branch, rollout_path " +
      "FROM threads WHERE cwd = ? AND archived = 0 ORDER BY updated_at DESC, id ASC LIMIT ?",
    ],
    emitted: "test/fixtures/rule5-sqlite/codex-thread-window.emit.js",
    bench: "test/bench/history-stall.ts",
  },
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
  /** Every finding across every closure, deduplicated by identity rather than
   *  by file: one module reached from two exports is one defect. */
  const allViolations = (): { key: string; report: string; rule: number }[] => {
    const byKey = new Map<string, { key: string; report: string; rule: number }>();
    for (const [subpath, closure] of closures) {
      for (const file of closure.files) {
        for (const v of scanOf(file).violations) {
          const key = `${v.path}:${v.line} ${v.detail}`;
          if (byKey.has(key)) continue;
          byKey.set(key, {
            key: `${v.path} ${v.detail}`,
            rule: v.rule,
            report: `${subpath}: ${v.path}:${v.line} rule ${v.rule}: ${v.detail}\n  via ${describeChain(file)}`,
          });
        }
      }
    }
    return [...byKey.values()];
  };

  it("has no violation in any exported closure", () => {
    const offenders = allViolations()
      .filter((v) => !(v.rule === 5 && (RULE_5_DEBT.includes(v.key) || v.key in RULE_5_SQLITE)))
      .map((v) => v.report);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("owes exactly the tracked rule-5 debt and admits exactly the judged sites", () => {
    // Both lists at once, because what the scan reports is one set: a new
    // synchronous traversal has to be written down as one or the other, and a
    // site that disappears has to be struck off.
    const found = allViolations()
      .filter((v) => v.rule === 5)
      .map((v) => v.key)
      .sort();
    expect(found).toEqual([...RULE_5_DEBT, ...Object.keys(RULE_5_SQLITE)].sort());
  });

  it("admits exactly the queries that were measured, and no unbounded one", () => {
    const sites = Object.entries(RULE_5_SQLITE);
    if (sites.length === 0) return;

    for (const [site, admission] of sites) {
      // Anti-vacuity: an admission is a measurement, and a measurement nobody
      // can re-run is a waiver wearing its clothes.
      expect(existsSync(resolve(CLI_ROOT, admission.bench)), admission.bench).toBe(true);
      expect(admission.bound, site).toMatch(/\d/);
      expect(admission.bound, `${site}: bound must name its reproduction`).toContain(admission.bench);
      // What was measured is a point query. A second query, an edited one, or an
      // unbounded execution anywhere in the module is a different cost that the
      // file census cannot see — the module is already in the closure for the
      // query that *was* judged.
      const file = site.slice(0, site.indexOf(" "));
      const use = scanSqliteUse(resolve(CLI_ROOT, file));
      expect(use.prepared, `${file}: prepared SQL`).toEqual(admission.prepares);
      // The admission is of *this code*, so this is the pin that means it: the
      // JavaScript Node runs. A failure here is not a test to update — it is a
      // re-judgement and a re-measurement, because the module carrying a
      // measured stall bound has changed. Regenerate the fixture only after
      // re-running `--sqlite-probe`.
      expect(use.emitted.join("\n") + "\n", `${file}: emitted JavaScript`).toBe(
        readFileSync(resolve(CLI_ROOT, admission.emitted), "utf-8"),
      );
      // Proof the emit came from `tsconfig.build.json` rather than the typecheck
      // config: only the build rewrites a relative specifier's extension. Without
      // this, a change confined to the build config could alter what ships while
      // the pin above stayed green — the emit it compares would be one nobody
      // runs.
      expect(
        use.emitted.filter((line) => line.includes("./provider-home")),
        `${file}: emit must be the build's, with relative specifiers rewritten`,
      ).toEqual(['import { codexDbPath } from "./provider-home.js";']);
    }
  });
});

describe("rule 6 — one error vocabulary", () => {
  for (const entry of packageExports()) {
    it(`publishes no second error type from ${entry.subpath}`, () => {
      // An in-process caller that has to learn a second error class is how a
      // second failure vocabulary spreads into the app.
      expect(exportedErrorClasses(entry.source)).toEqual(
        entry.subpath === "./core/errors" ? ["CliError"] : [],
      );
    });
  }
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
      expect(exportedNames(entry.source)).toEqual(expected.names);
    });
  }
});

describe("provider catalog — static metadata, no I/O, no ambient state", () => {
  // The design admits the catalog "before start" only as static metadata. Both
  // halves of that are decidable here: a module that reaches no specifier at
  // all cannot call `node:fs`, and the scan reads its environment surface.
  const entry = "src/lib/core/agent/provider-catalog.ts";

  it("reaches nothing but itself, so it can call no filesystem API", () => {
    const closure = closureOf(entry);
    expect(closure.files.map((f) => f.path)).toEqual([entry]);
    expect(closure.externals).toEqual([]);
  });

  it("reads no environment name and owns nothing about the process", () => {
    const scan = scanFile(resolve(CLI_ROOT, entry));
    expect(scan.envReads).toEqual([]);
    expect(scan.violations).toEqual([]);
  });
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

  it("reads an allowlisted environment name through an erased wrapper", () => {
    const { root } = plant({
      "index.ts":
        `export const a = process.env["HOME" as const];\n` +
        `export const b = process.env[("YACO_HOME")];\n` +
        `export const c = (process.env as Record<string, string>)["HOME"];\n` +
        `export const d = process.env!.YACO_AGENT_SESSIONS_DIR;\n` +
        // Erased declarations name members without reading them.
        `export type Exit = typeof process.exit;\n` +
        `export type Log = typeof console.log;\n` +
        // A heritage clause is not erased: it runs at module initialization.
        `export class A extends (console.log("x"), Object) {}\n`,
    });
    try {
      const scan = scanFile(join(root, "index.ts"), root);
      expect(scan.envReads.map((r) => r.name)).toEqual([
        "HOME",
        "YACO_HOME",
        "HOME",
        "YACO_AGENT_SESSIONS_DIR",
      ]);
      expect(scan.violations.map((v) => v.detail)).toEqual(["console.log"]);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  it("treats console the same way as process", () => {
    const { root } = plant({
      "index.ts":
        `export const a = () => (console as typeof console).log("x");\n` +
        `export const b = () => console["error"]("x");\n` +
        `const out = console;\n` +
        `export const c = () => out.warn("x");\n`,
    });
    try {
      expect(detailsOf(root)).toEqual([
        "2:console.log",
        "2:console.error",
        "2:console referenced outside a member access",
      ]);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  it("is not evaded by string-keyed members, destructuring, or aliasing process", () => {
    const { root } = plant({
      "index.ts":
        `export const a = () => process["exit"](1);\n` +
        `const { stdout } = process;\n` +
        `export const b = () => stdout.write("x");\n` +
        `const runtime = process;\n` +
        `export const c = () => runtime.exit(1);\n` +
        `const viaGlobal = globalThis.process;\n` +
        `export const e = () => viaGlobal.exit(1);\n` +
        `const viaKey = globalThis["process"];\n` +
        `export const f = () => viaKey.exit(1);\n` +
        `const which = "std" + "err";\n` +
        `export const d = () => process[which];\n`,
    });
    try {
      expect(detailsOf(root)).toEqual([
        "2:process.exit",
        "2:process referenced outside a member access",
        "2:process referenced outside a member access",
        "2:process referenced outside a member access",
        "2:process referenced outside a member access",
        "2:process[<computed member>]",
      ]);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  it("flags a polling loop but not a bounded loop of awaits", () => {
    const { root } = plant({
      "index.ts":
        `export const poll = async (probe: () => Promise<boolean>) => {\n` +
        `  while (true) { if (await probe()) return; }\n` +
        `};\n` +
        // The same loop spelled to dodge a `true` check.
        `export const poll1 = async (probe: () => Promise<boolean>) => {\n` +
        `  while (1) { if (await probe()) return; }\n` +
        `};\n` +
        `export const pollDo = async (probe: () => Promise<boolean>) => {\n` +
        `  do { if (await probe()) return; } while (true);\n` +
        `};\n` +
        `export const pollNeg = async (probe: () => Promise<boolean>) => {\n` +
        `  while (-1) { if (await probe()) return; }\n` +
        `};\n` +
        // Erased wrappers: every one of these still runs `while (truthy)`.
        `export const pollAs = async (probe: () => Promise<boolean>) => {\n` +
        `  while (true as boolean) { if (await probe()) return; }\n` +
        `};\n` +
        `export const pollSatisfies = async (probe: () => Promise<boolean>) => {\n` +
        `  while (1 satisfies number) { if (await probe()) return; }\n` +
        `};\n` +
        `export const pollBang = async (probe: () => Promise<boolean>) => {\n` +
        `  while (1!) { if (await probe()) return; }\n` +
        `};\n` +
        `export const backoff = async (probe: () => Promise<boolean>) => {\n` +
        `  for (let i = 0; i < 5; i++) {\n` +
        `    if (await probe()) return;\n` +
        `    await new Promise((r) => setTimeout(r, 50));\n` +
        `  }\n` +
        `};\n` +
        // Rule 5's chunked reader is a loop of awaits and is not a poll.
        `export const chunked = async (chunks: string[][], read: (f: string) => Promise<string>) => {\n` +
        `  const out: string[] = [];\n` +
        `  for (const chunk of chunks) out.push(...(await Promise.all(chunk.map(read))));\n` +
        `  return out;\n` +
        `};\n`,
    });
    try {
      expect(detailsOf(root)).toEqual(Array(8).fill("3:polling loop"));
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  it("sees a writer republished under a reader's name", () => {
    // Name and file census both stay intact; only the origin changes.
    expect(exportedNames("test/fixtures/alias-export.ts")).toEqual({
      "src/lib/core/task/store.ts": ["loadTasks=saveTasks"],
      "test/fixtures/alias-export.ts": [
        "ConfigError",
        "ConfigFailure",
        "ConfigFault",
      ],
    });
  });

  it("sees an error type other than CliError", () => {
    // ConfigFault's heritage clause never spells `Error` and ConfigFailure is
    // not a class declaration at all; both publish an error constructor.
    expect(exportedErrorClasses("test/fixtures/alias-export.ts")).toEqual([
      "ConfigError",
      "ConfigFailure",
      "ConfigFault",
    ]);
  });

  it("is not evaded by aliasing or string-keying a synchronous primitive", () => {
    const { root } = plant({
      "index.ts":
        `import { spawnSync as run } from "node:child_process";\n` +
        `import * as cp from "node:child_process";\n` +
        `export const a = () => run("git", ["status"]);\n` +
        `export const b = () => cp["execSync"]("git status");\n` +
        `export const c = () => (cp as typeof cp)["execSync"]("git status");\n`,
    });
    try {
      expect(detailsOf(root)).toEqual([
        "3:import spawnSync",
        "3:execSync()",
        "3:execSync()",
      ]);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  describe("the rule-5 SQLite admission", () => {
    // The admission pins the JavaScript the measured module compiles to, so what
    // has to be demonstrated is not that the scan recognizes each construct — it
    // is that *no* edit to that module survives. Each case below is one an
    // earlier version of the check did not detect, applied to a copy of the
    // admitted module. The last two are the reasons this pin exists: code inside
    // a string is invisible to any name-based rule, and a declaration's
    // `const`/`using` mode is invisible to a syntax-tree walk.
    const ADMITTED = "src/lib/core/agent/providers/codex-thread.ts";
    const baseline = scanSqliteUse(resolve(CLI_ROOT, ADMITTED)).emitted;

    /** The admitted module with `edit` applied, scanned in place of it. */
    const edited = (edit: (source: string) => string): string[] => {
      const source = readFileSync(resolve(CLI_ROOT, ADMITTED), "utf-8");
      const dir = mkdtempSync(join(tmpdir(), "yaco-rule5-"));
      try {
        const file = join(dir, "codex-thread.ts");
        writeFileSync(file, edit(source));
        return scanSqliteUse(file, dir).emitted;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    /** Insert `code` just above the `db.close()` the query is wrapped in. */
    const inject = (code: string) => (source: string): string =>
      source.replace("    } finally {\n      db.close();", `      ${code}\n    } finally {\n      db.close();`);

    const UNBOUNDED = "SELECT * FROM threads";
    const UNPINNED_EDITS: [name: string, edit: (source: string) => string][] = [
      ["a direct unbounded call", inject(`db.prepare("${UNBOUNDED}").all();`)],
      ["an aliased statement", inject(`const s = db.prepare("${UNBOUNDED}"); s.all();`)],
      ["a rebound method", inject(`const s = db.prepare("${UNBOUNDED}"); s.all.bind(s)();`)],
      ["a string-keyed member", inject(`db.prepare("${UNBOUNDED}")["all"]();`)],
      ["destructuring", inject(`const { all } = db.prepare("${UNBOUNDED}"); all.call(db);`)],
      ["reflection", inject(`Reflect.get(db, "exec").call(db, "${UNBOUNDED}");`)],
      // The escape that defeated every denylist: `Function` reached without
      // naming it, running a query the parser never sees because it is a string.
      ["the Function constructor", inject(
        `const run = (() => {}).constructor("return arguments[0].prepare('${UNBOUNDED}').all()"); run(db);`,
      )],
      ["an extra import", (source) =>
        `import { readFile } from "node:fs/promises";\n${source}\nexport const leak = readFile;`],
      ["an edited query", (source) =>
        source.replace("SELECT title, first_user_message FROM threads WHERE id = ?", UNBOUNDED)],
      ["a query it cannot read", (source) =>
        source.replace(
          '"SELECT title, first_user_message FROM threads WHERE id = ?"',
          "`SELECT ${column} FROM threads WHERE id = ?`",
        )],
      // `const` / `let` / `using` / `await using` live in a declaration list's
      // `flags`, not in a child token, so a syntax-tree walk cannot see this at
      // all — the two forms summarized identically while emitting different
      // programs. `using` on a plain row throws at runtime, and this module's
      // outer catch would turn that into "no row", silently costing the summary
      // read its database inputs.
      ["a using declaration in place of const", (source) =>
        source
          .replace("      const row = db", "      using row = db")
          .replace(
            "        .get(sessionId) as { title: string | null; first_user_message: string | null } | undefined;",
            "        .get(sessionId) as any;",
          )],
    ];

    it("matches the checked-in emit of the module as it stands", () => {
      const admission = RULE_5_SQLITE[`${ADMITTED} import DatabaseSync`]!;
      expect(baseline.join("\n") + "\n").toBe(
        readFileSync(resolve(CLI_ROOT, admission.emitted), "utf-8"),
      );
    });

    for (const [name, edit] of UNPINNED_EDITS) {
      it(`fails on ${name}`, () => {
        // Every edit changes the emit — which is the whole claim, and it holds
        // for the constructs no rule was ever written against as much as for
        // the rest, because none of them is something the pin has to recognize.
        expect(edited(edit), name).not.toEqual(baseline);
      });
    }

    it("is not disturbed by an edit that changes nothing executable", () => {
      // A pin that fires on a comment gets regenerated without being read.
      expect(edited((source) => source.replace("import { existsSync }", "// a note\nimport { existsSync }")))
        .toEqual(baseline);
    });
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
