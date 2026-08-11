/** `bun:sqlite` stand-in for the Vitest cohort.
 *
 *  `providers/claude.ts` statically imports `history.ts` and `project-move.ts`,
 *  so every test that touches the provider barrel pulls `bun:sqlite` into its
 *  module graph — 32 of them, none of which open a database. Node cannot
 *  resolve that specifier at all, which would block the whole barrel from
 *  migrating for a database nobody asks for.
 *
 *  `vitest.config.ts` aliases the specifier here so the graph loads. Opening a
 *  database throws: a test that really needs one is a Bun-cohort test until
 *  `cli-sqlite-hop` moves the three production users to `node:sqlite`, and this
 *  file dies with the alias in that task.
 */

export class Database {
  constructor() {
    throw new Error(
      "bun:sqlite is stubbed in the Vitest cohort. A test that opens a database belongs to " +
        "the Bun cohort (import `bun:test`) until cli-sqlite-hop lands node:sqlite.",
    );
  }
}
