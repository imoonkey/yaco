/** Route benchmark for the channel message-read cutover.
 *
 *  Measures what the app pays for one `/last n`, on both routes, on synthetic
 *  logs sized to the local provider-log corpus. Reports two numbers per route:
 *
 *    - route median: wall time for the complete answer;
 *    - starvation: the worst delay an already-queued unrelated task suffers,
 *      sampled with a 5 ms timer that runs for the whole call. This is the gate
 *      the design names — an in-process read must not starve the loop longer
 *      than the subprocess route it replaces.
 *
 *  Run:  node --experimental-strip-types test/bench/message-read-bench.mjs
 *  (from `cli/`; needs `npm run build` first — it spawns `bin/yaco.mjs`.)
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI_ENTRY = join(CLI_ROOT, "bin", "yaco.mjs");

const { encodeClaudeCwd } = await import(join(CLI_ROOT, "src/lib/core/project/encode.ts"));
const { readMessageRows } = await import(
  join(CLI_ROOT, "src/lib/core/agent/providers/message-read.ts")
);

const SESSION_PATH = "/tmp/yaco-bench-proj";
const SESSION_ID = "sess-bench";
const HANDLE = "bench";
const N = 3;
const REPEATS = 15;

// Sizes from the local corpus of 3,449 provider logs. The last fixture is the
// shape that matters most and is the least obvious: the largest real log is
// 38 MB in only 854 physical lines, sixteen of them over a megabyte. A batching
// scheme counted in lines looks fine on the small-record fixtures and does
// nothing at all on this one.
const SIZES = [
  { label: "p50   240 KB", bytes: 240 * 1024, record: 640 },
  { label: "p95   2.4 MB", bytes: 2.4 * 1024 * 1024, record: 640 },
  { label: "p99   6.1 MB", bytes: 6.1 * 1024 * 1024, record: 640 },
  { label: "max    38 MB", bytes: 38 * 1024 * 1024, record: 640 },
  { label: "max    38 MB (854 real-shaped records)", bytes: 38 * 1024 * 1024, record: "real" },
];

const sandbox = mkdtempSync(join(tmpdir(), "yaco-msg-bench-"));
const sessionsDir = join(sandbox, "sessions");
const logDir = join(sandbox, ".claude", "projects", encodeClaudeCwd(SESSION_PATH));
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

const state = {
  handle: HANDLE,
  provider: "claude",
  sessionPath: SESSION_PATH,
  pid: 1,
  sessionId: SESSION_ID,
  status: "idle",
  createdAt: new Date(0).toISOString(),
};
writeFileSync(join(sessionsDir, `${HANDLE}.json`), JSON.stringify(state));
const logPath = join(logDir, `${SESSION_ID}.jsonl`);
const childEnv = { ...process.env, HOME: sandbox, YACO_AGENT_SESSIONS_DIR: sessionsDir, NO_COLOR: "1" };
process.env.HOME = sandbox;

const prose = (i) =>
  JSON.stringify({
    type: "assistant",
    timestamp: new Date(i * 1000).toISOString(),
    message: { content: [{ type: "text", text: `answer ${i}` }] },
  });

const bulk = (i, payload) =>
  JSON.stringify({
    type: i % 2 ? "user" : "assistant",
    timestamp: new Date(i * 1000).toISOString(),
    message: {
      content: [
        i % 2
          ? { type: "tool_result", content: payload }
          : { type: "tool_use", name: "Bash", input: { cmd: payload } },
      ],
    },
  });

/** A log of roughly `bytes`, shaped like a real turn stream: mostly tool calls
 *  and results, with assistant prose every ~20 records.
 *
 *  `record` is either a fixed payload size or "real" — the observed shape of
 *  the largest log in the corpus: 854 records whose sizes run p50 1.3 KB,
 *  p95 46 KB, p99 1.2 MB, max 1.36 MB. */
function writeLog(bytes, record) {
  const out = [];
  let size = 0;
  if (record === "real") {
    for (let i = 0; size < bytes; i++) {
      // Every 33rd record is a megabyte-class tool result; every 20th is prose.
      const payload = i % 33 === 0 ? 1_360_000 : i % 7 === 3 ? 46_000 : 1_270;
      const line = i % 20 === 19 ? prose(i) : bulk(i, "x".repeat(payload));
      out.push(line);
      size += line.length + 1;
    }
  } else {
    const filler = "x".repeat(record);
    for (let i = 0; size < bytes; i++) {
      const line = i % 20 === 19 ? prose(i) : bulk(i, `${filler}${i}`);
      out.push(line);
      size += line.length + 1;
    }
  }
  writeFileSync(logPath, `${out.join("\n")}\n`);
  return { lines: out.length, bytes: size };
}

/** Worst gap seen by a 5 ms timer running across `fn`. */
async function withStarvationProbe(fn) {
  const PERIOD = 5;
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - PERIOD);
    last = now;
  }, PERIOD);
  const started = performance.now();
  const value = await fn();
  const elapsed = performance.now() - started;
  clearInterval(timer);
  return { elapsed, worst, value };
}

/** The retired route: one metadata sweep plus one spawn per kept row, spawned
 *  the way `app/server` spawns — asynchronously, so the loop stays free while
 *  the child runs and the starvation probe measures what the app really paid. */
function capture(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CLI_ENTRY, "agent", "messages", HANDLE, ...args, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("close", (code) =>
      code === 0 ? resolve(JSON.parse(out.trim()).data) : reject(new Error(`exit ${code}: ${err}`)),
    );
    proc.on("error", reject);
  });
}

async function subprocessRoute() {
  const meta = await capture(["--role", "assistant", "--type", "text"]);
  const picked = meta.slice(-N);
  const rows = [];
  for (const m of picked) {
    rows.push({ index: m.index, text: (await capture(["--index", String(m.index)])).text });
  }
  return rows;
}

/** The cutover route: one in-process read. */
async function inProcessRoute() {
  const rows = await readMessageRows(state, { role: "assistant", type: "text" });
  if (!rows.ok) throw new Error(`${rows.code}: ${rows.message}`);
  return rows.value.slice(-N).map((r) => ({ index: r.index, text: r.text }));
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)];
const ms = (x) => `${x.toFixed(1)}ms`;

console.log(`n=${N} messages per call, ${REPEATS} repeats per cell\n`);
console.log(
  ["log", "lines", "route", "median", "p95", "starvation p95", "starvation max"].join(" | "),
);
console.log(["---", "---", "---", "---", "---", "---", "---"].join(" | "));

for (const size of SIZES) {
  const { lines } = writeLog(size.bytes, size.record);
  for (const [name, run] of [
    ["subprocess (1+n spawns)", async () => subprocessRoute()],
    ["in-process (1 read)", inProcessRoute],
  ]) {
    const elapsed = [];
    const worst = [];
    let rows = null;
    for (let i = 0; i < REPEATS; i++) {
      const r = await withStarvationProbe(run);
      elapsed.push(r.elapsed);
      worst.push(r.worst);
      rows = r.value;
    }
    if (rows.length !== N) throw new Error(`route ${name} returned ${rows.length} rows`);
    console.log(
      [
        size.label,
        String(lines),
        name,
        ms(median(elapsed)),
        ms(p95(elapsed)),
        ms(p95(worst)),
        ms(Math.max(...worst)),
      ].join(" | "),
    );
  }
}

rmSync(sandbox, { recursive: true, force: true });
