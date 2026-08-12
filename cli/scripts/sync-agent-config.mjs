/** Mirror `agent-config/global/` into the package, so the skills ship in the tarball.
 *
 *  `yaco install` plants one `~/.claude/skills/<name>` symlink per shipped skill and
 *  the manifest is that directory's listing, so an `npm i -g yaco-cli` with no
 *  skills inside it delivers a CLI and none of the behaviour the CLI exists to drive.
 *  npm cannot pack a path outside the package directory, so the tree is copied in.
 *
 *  A checked-in `cli/agent-config -> ../agent-config` symlink would have avoided the
 *  copy, and was rejected: `npm pack` drops a symlinked directory from the tarball
 *  without a word, which ships exactly the broken package this file prevents.
 *
 *  Copying, never merging: the destination is removed first so a skill deleted
 *  upstream cannot survive in the package as a stale link target.
 */
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(CLI_DIR, "..", "agent-config", "global");
const DESTINATION = join(CLI_DIR, "agent-config");

rmSync(DESTINATION, { recursive: true, force: true });
cpSync(SOURCE, join(DESTINATION, "global"), { recursive: true });

process.stdout.write(`synced ${SOURCE} -> ${join(DESTINATION, "global")}\n`);
