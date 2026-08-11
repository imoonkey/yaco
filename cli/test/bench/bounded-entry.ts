/** Runs the bounded prototype in a child process and prints its row count.
 *
 *  This exists to separate two changes the benchmark would otherwise confound.
 *  The bounded prototype does two things at once: it caps the provider scans at
 *  the history window, and it runs inside the server. Only the second one is
 *  the cutover. Spawning the same bounded reader gives the harness a control
 *  route where the scan is bounded but the work still happens in a child — so a
 *  wall-time win can be attributed to whichever change actually produced it.
 *
 *  Usage: node bounded-entry.ts <projectPath> <limit> <chunk> */

import { boundedHistory } from "./history-bounded-prototype.ts";

const [projectPath, limit, chunk] = process.argv.slice(2);
if (!projectPath || !limit || !chunk) throw new Error("usage: bounded-entry.ts <projectPath> <limit> <chunk>");
const rows = await boundedHistory(projectPath, Number(limit), Number(chunk));
process.stdout.write(JSON.stringify({ ok: true, data: { rows } }));
