/** Runs the shipped project-history read in a child process and prints its rows.
 *
 *  This is the harness's `in-process-child` route. The cutover changes two
 *  things at once — the provider scans became bounded, and the read moved into
 *  the server's process — and only the second one is the cutover. Spawning the
 *  same shipped reader gives the harness a route where the scan is bounded but
 *  the work still happens in a child, so a win can be attributed to whichever
 *  change actually produced it.
 *
 *  Usage: node history-entry.ts <projectPath> <limit> */

import { readProjectHistory } from "../../src/lib/core/agent/providers/history.ts";
import { isOk } from "../../src/lib/core/result.ts";

const [projectPath, limit] = process.argv.slice(2);
if (!projectPath || !limit) throw new Error("usage: history-entry.ts <projectPath> <limit>");
const window = await readProjectHistory(projectPath, [], { limit: Number(limit) });
if (!isOk(window)) throw new Error(`${window.code}: ${window.message}`);
process.stdout.write(JSON.stringify({ ok: true, data: { rows: window.value.rows } }));
