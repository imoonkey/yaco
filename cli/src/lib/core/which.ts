/** The one `$PATH` lookup in the CLI.
 *
 *  `doctor` (is `yaco`/`tmux`/`git`/a provider installed?), `agent status`
 *  (the provider line of the status footer) and `agent start` (the refusal
 *  before a session is created) all ask the same question, and they must all
 *  get the same answer: a machine where `doctor` reports `claude: not found`
 *  is exactly the machine where `yaco claude` must refuse. Three private
 *  copies of this is how they drift.
 *
 *  The absolute path, not a boolean, because `doctor` reports it.
 */
import { spawnSync } from "child_process";

const TIMEOUT_MS = 3000;

/** The absolute path `which` resolves `cmd` to, or null when it is not on
 *  `$PATH` (or `which` itself could not be run).
 *
 *  `env` is passed explicitly so a mutation of `process.env.PATH` — which is
 *  how the tests build a machine with and without a provider — reaches the
 *  child; a runtime that caches its start-up environment would otherwise
 *  answer for the wrong `$PATH`. */
export function which(cmd: string): string | null {
  const r = spawnSync("which", [cmd], {
    encoding: "utf-8",
    env: { ...process.env },
    timeout: TIMEOUT_MS,
  });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out.length > 0 ? out : null;
}
