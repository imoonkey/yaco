/** The one `node:sqlite` query an exported closure is allowed to run.
 *
 *  It lives alone in this module so the export audit's rule about it can be
 *  fail-closed rather than clever. `node:sqlite` is synchronous, so rule 5
 *  admits a query only against a measured stall bound, and what the audit has to
 *  prevent is a *different* query inheriting that measurement — `.all()` over
 *  the whole table costs nothing like a primary-key lookup.
 *
 *  Listing the constructs a module may not contain cannot be made complete.
 *  Review found four successive versions of the check incomplete, the last
 *  because `(() => {}).constructor("… .all()")` reaches `Function` without
 *  naming it and runs a query the parser never sees, since it lives in a string.
 *
 *  So the audit pins **the JavaScript this module compiles to** — what Node
 *  actually runs — and asserts the file still compiles to it. Any edit at all
 *  fails, and failing means "re-judge and re-measure", which is what should
 *  happen when the code carrying a measured stall bound changes. A syntax-tree
 *  summary was tried first and had its own gap: `const` and `using` live in a
 *  declaration list's flags rather than in a child token, so the two summarized
 *  identically while emitting different programs.
 *
 *  That is only livable for a module that does one thing, which is exactly why
 *  the query does not simply sit in `summary-read.ts`. This file's existence
 *  and the shape of that rule are one decision, not two.
 *
 *  -> See: `RULE_5_SQLITE` in `test/unit/export-audit.test.ts`,
 *  `test/bench/summary-stall.ts --sqlite-probe`. */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { codexDbPath } from "./provider-home.ts";

/** What Codex's thread index knows about one session's opening prompt. */
export interface CodexThreadRow {
  title: string | null;
  first: string | null;
}

/** `title` and `first_user_message` for one thread, or null when the database
 *  is absent, unreadable, or holds no such row.
 *
 *  A point lookup on the `threads` primary key — `SEARCH threads USING INDEX
 *  sqlite_autoindex_threads_1 (id=?)` — measuring 0.3 ms at the p50 and the
 *  maximum over 40 warm samples on an 11.1 MB, 2 297-row database, open and
 *  close included. */
export function codexThreadRow(sessionId: string): CodexThreadRow | null {
  if (!existsSync(codexDbPath())) return null;
  try {
    const db = new DatabaseSync(codexDbPath(), { readOnly: true });
    try {
      const row = db
        .prepare("SELECT title, first_user_message FROM threads WHERE id = ?")
        .get(sessionId) as { title: string | null; first_user_message: string | null } | undefined;
      return row ? { title: row.title ?? null, first: row.first_user_message ?? null } : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
