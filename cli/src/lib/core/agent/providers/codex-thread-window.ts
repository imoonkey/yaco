/** The windowed `node:sqlite` query the project history read is allowed to run.
 *
 *  It lives alone in this module for the same reason `codex-thread.ts` does, and
 *  the two are deliberately not merged: an admission is a measurement, the
 *  audit pins **the JavaScript the admitted module compiles to**, and one
 *  module carrying two measured queries would make every edit to either a
 *  re-judgement of both. `node:sqlite` is synchronous, so rule 5 admits a query
 *  only against a measured stall bound, and what the audit has to prevent is a
 *  *different* query inheriting that measurement.
 *
 *  -> See: `RULE_5_SQLITE` in `test/unit/export-audit.test.ts`,
 *  `test/bench/history-stall.ts --sqlite-probe`, and `codex-thread.ts` for why
 *  the pin is an emit rather than a list of forbidden constructs. */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { codexDbPath } from "./provider-home.ts";

/** One non-archived Codex thread, as the history window reads it. */
export interface CodexThreadWindowRow {
  id: string;
  title: string | null;
  first_user_message: string | null;
  created_at: number;
  updated_at: number;
  git_branch: string | null;
  rollout_path: string | null;
}

/** The newest `limit` non-archived threads for `cwd`, newest first; empty when
 *  the database is absent or unreadable.
 *
 *  **`LIMIT` bounds what crosses into JavaScript, not what SQLite examines**, and
 *  the measured bound is a bound on the whole statement either way. Codex's
 *  composite `cwd` indexes order by its *millisecond* columns while this reads
 *  the second-resolution `updated_at`, whose own index carries neither `archived`
 *  nor `cwd` — so the plan is
 *  `SEARCH threads USING INDEX idx_threads_archived_cwd_recency_at_ms
 *  (archived=? AND cwd=?)` followed by `USE TEMP B-TREE FOR ORDER BY`: every
 *  matching row is sorted inside SQLite, and `LIMIT` takes the top of that sort.
 *  What the cap therefore buys is the *fan-out* — one rollout tail-read per
 *  returned row, 587 down to 201 on the reference home — not a smaller scan.
 *
 *  `id` breaks the `updated_at` tie: SQLite leaves the order of tied rows to the
 *  query plan, so without it both the row order and the window boundary would be
 *  undefined. */
export function codexThreadWindow(cwd: string, limit: number): CodexThreadWindowRow[] {
  if (!existsSync(codexDbPath())) return [];
  try {
    const db = new DatabaseSync(codexDbPath(), { readOnly: true });
    try {
      // `node:sqlite` types every column as `SQLOutputValue`, so the row shape
      // is the SELECT's to declare — through `unknown`, because a 7-column row
      // and an open record do not overlap enough for a direct assertion.
      return db
        .prepare(
          `SELECT id, title, first_user_message, created_at, updated_at, git_branch, rollout_path
           FROM threads WHERE cwd = ? AND archived = 0
           ORDER BY updated_at DESC, id ASC LIMIT ?`,
        )
        .all(cwd, limit) as unknown as CodexThreadWindowRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
