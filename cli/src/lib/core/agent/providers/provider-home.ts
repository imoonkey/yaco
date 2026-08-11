/** Where a provider keeps its own state on this machine.
 *
 *  One definition of `$HOME`-at-call-time for every provider reader, so a test
 *  that redirects `HOME` redirects all of them and none of them drifts to a
 *  module-load-time snapshot. `HOME` is one of the three ambient names an
 *  exported closure may read (`doc/main/cli/exports.md`, rule 1). */

import { homedir } from "node:os";
import { join } from "node:path";

/** Honor $HOME at call time so provider paths track test home overrides. */
export function userHome(): string {
  const env = process.env["HOME"];
  return env && env.length > 0 ? env : homedir();
}

/** Codex's thread index — the `threads` table both the history list and the
 *  session-summary read query. */
export function codexDbPath(): string {
  return join(userHome(), ".codex", "state_5.sqlite");
}
