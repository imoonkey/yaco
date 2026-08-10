/** The frozen golden-matrix case list.
 *
 *  `{ALPHA}` / `{BETA}` expand to the sandbox project roots at run time, so the
 *  list itself carries no machine-specific path and its digest is stable. The
 *  digest is recorded in every captured matrix: two matrices are only comparable
 *  when they were produced by the same case list.
 *
 *  Ordering-sensitive cases are marked. They are the ones whose stdout is
 *  allowed to differ between the pre-ordering and post-ordering matrices; every
 *  other field of every case must match exactly. */

import { createHash } from "node:crypto";

export interface GoldenCase {
  id: string;
  argv: string[];
  /** Working directory for the child: a project root or the sandbox root. */
  cwd: "alpha" | "beta" | "root";
  /** True when this case reads a directory whose order the sort changes. */
  orderSensitive: boolean;
}

export const CASES: readonly GoldenCase[] = [
  { id: "help", argv: ["--help"], cwd: "root", orderSensitive: false },
  { id: "version-flag", argv: ["--version"], cwd: "root", orderSensitive: false },
  { id: "paths-runtime-json", argv: ["paths", "runtime", "--json"], cwd: "root", orderSensitive: false },
  { id: "agent-providers-json", argv: ["agent", "providers", "--json"], cwd: "root", orderSensitive: false },

  { id: "agent-list-all-text", argv: ["agent", "list", "--all"], cwd: "root", orderSensitive: true },
  { id: "agent-list-all-json", argv: ["agent", "list", "--all", "--json"], cwd: "root", orderSensitive: true },
  { id: "agent-list-cwd-text", argv: ["agent", "list"], cwd: "alpha", orderSensitive: true },
  { id: "agent-list-path-json", argv: ["agent", "list", "--path", "{BETA}", "--json"], cwd: "root", orderSensitive: true },
  { id: "agent-list-reconcile-json", argv: ["agent", "list", "--all", "--reconcile", "--json"], cwd: "root", orderSensitive: true },
  { id: "agent-list-empty-text", argv: ["agent", "list", "--path", "{BETA}/nowhere"], cwd: "root", orderSensitive: false },

  { id: "agent-history-text", argv: ["agent", "history", "--path", "{ALPHA}"], cwd: "root", orderSensitive: true },
  { id: "agent-history-json", argv: ["agent", "history", "--path", "{ALPHA}", "--json"], cwd: "root", orderSensitive: true },
  { id: "agent-summaries-text", argv: ["agent", "summaries", "--path", "{ALPHA}"], cwd: "root", orderSensitive: true },
  { id: "agent-summaries-json", argv: ["agent", "summaries", "--path", "{ALPHA}", "--json"], cwd: "root", orderSensitive: true },

  { id: "agent-messages-text", argv: ["agent", "messages", "zeta-3"], cwd: "root", orderSensitive: false },
  { id: "agent-messages-json", argv: ["agent", "messages", "zeta-3", "--json"], cwd: "root", orderSensitive: false },

  // `doctor` reports the package version — the one intentional output delta the
  // Node port is allowed, so the baseline has to carry its pre-port value.
  { id: "doctor-json", argv: ["doctor", "--json"], cwd: "root", orderSensitive: false },
  { id: "install-dry-run-json", argv: ["install", "--dry-run", "--json"], cwd: "root", orderSensitive: false },

  { id: "task-list-json", argv: ["task", "list", "--json"], cwd: "root", orderSensitive: false },
  { id: "task-list-text", argv: ["task", "list"], cwd: "root", orderSensitive: false },
  { id: "task-get-json", argv: ["task", "get", "t-mike", "--json"], cwd: "root", orderSensitive: false },

  { id: "agent-status-text", argv: ["agent", "status", "zeta-3"], cwd: "root", orderSensitive: false },
  { id: "agent-status-json", argv: ["agent", "status", "zeta-3", "--json"], cwd: "root", orderSensitive: false },
  { id: "agent-status-absent-json", argv: ["agent", "status", "absent-x", "--json"], cwd: "root", orderSensitive: false },

  { id: "err-usage-json", argv: ["agent", "status", "--json"], cwd: "root", orderSensitive: false },
  { id: "err-invalid-name-json", argv: ["agent", "status", "=absent", "--json"], cwd: "root", orderSensitive: false },
  { id: "err-unknown-area-json", argv: ["bogus", "--json"], cwd: "root", orderSensitive: false },
  { id: "err-unknown-flag-json", argv: ["agent", "history", "--nope", "--json"], cwd: "root", orderSensitive: false },
  { id: "err-not-found-json", argv: ["task", "get", "t-absent", "--json"], cwd: "root", orderSensitive: false },
  { id: "err-internal-json", argv: ["agent", "capture", "absent-x", "--json"], cwd: "root", orderSensitive: false },
  { id: "err-env-json", argv: ["worktree", "merge", "absent", "--json"], cwd: "root", orderSensitive: false },
];

/** Identity of the case list. A matrix comparison is only meaningful across
 *  captures that share it. */
export const CASES_DIGEST = createHash("sha256").update(JSON.stringify(CASES)).digest("hex").slice(0, 16);
