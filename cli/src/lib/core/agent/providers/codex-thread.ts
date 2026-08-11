/** The one `node:sqlite` query an exported closure is allowed to run.
 *
 *  It lives alone in this module so the export audit's rule about it can be
 *  fail-closed rather than clever. `node:sqlite` is synchronous, so rule 5
 *  admits a query only against a measured stall bound, and what the audit has to
 *  prevent is a *different* query inheriting that measurement — `.all()` over
 *  the whole table costs nothing like a primary-key lookup.
 *
 *  Enumerating the dangerous spellings loses that race by construction — review
 *  defeated three successive versions of the check, the last of them with
 *  `const { all } = statement` and `Reflect.get(statement, "all")`, both of
 *  which read a property without a property-access node. So the audit
 *  constrains this module's *syntax* instead: no destructuring, no `Reflect` /
 *  `eval` / `Function` / `Proxy`, no member named `all` / `run` / `exec` /
 *  `iterate` / `call` / `bind` / `apply`, no computed member it cannot name, and
 *  a pinned import list so a statement cannot be handed to a helper it does not
 *  read.
 *
 *  A module doing anything else could not live under those rules — which is
 *  exactly why the query does not simply sit in `summary-read.ts`, whose reader
 *  maps its inputs with `Promise.all`. The rule and this file's existence are
 *  one decision, not two.
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
