/** The one `node:sqlite` query an exported closure is allowed to run.
 *
 *  It lives alone in this module so the export audit's rule about it can be
 *  fail-closed rather than clever. `node:sqlite` is synchronous, so rule 5
 *  admits a query only against a measured stall bound, and what the audit has to
 *  prevent is a *different* query inheriting that measurement — `.all()` over
 *  the whole table costs nothing like a primary-key lookup.
 *
 *  Matching how the statement is *called* turned out not to be enough: review
 *  defeated that check three ways in one sitting (`statement.all.bind(…)`,
 *  `statement.all.call(…)`, and a local binding shadowing the `Promise` global
 *  the check exempted). So the rule is now on *property access* — reading
 *  `all`, `run`, `exec` or `iterate` off anything at all, however it is spelled,
 *  fails the audit — and this module is small enough to live under it. That is
 *  why the query does not simply sit in `summary-read.ts`: a reader that maps
 *  its inputs with `Promise.all` cannot.
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
