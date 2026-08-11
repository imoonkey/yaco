/** Event-loop stall benchmark for the history read — the evidence export
 *  eligibility rule 5 demands before `node:sqlite` may run inside the server.
 *
 *  The question is not how fast the read is. It is how long an *already-queued*
 *  unrelated piece of work waits because of it. So the primary instrument is the
 *  design's own — a queued timer, and how long it is starved — re-queued
 *  continuously for as long as the route runs. Each invocation contributes the
 *  worst delay it caused: one value per invocation, the same count for every
 *  route, so the distributions being compared are the same size and mean the
 *  same thing. An HTTP request chain beside it corroborates.
 *
 *  Two earlier versions of this harness got the estimand wrong, both in the
 *  subprocess route's favour, so the shape of the mistake is worth keeping:
 *  labelling every background request by the route running when it *started*
 *  put the subprocess route's one synchronous pre-spawn stall into the preceding
 *  idle bucket — the already-queued request is by construction one that started
 *  earlier. Attributing by interval overlap fixed the label but not the
 *  estimand: routes have unequal wall times, so a route that blocks once and
 *  then waits accumulates thousands of cheap samples that dilute its stall below
 *  p95, while a route that blocks in short repeated bursts does not. One
 *  worst-delay value per invocation has neither problem.
 *
 *  Routes:
 *    spawn-noop        a child that prints an empty envelope — the spawn alone
 *    subprocess        the route today — spawn `yaco agent history --json`
 *    in-process        the shipped reader called directly
 *    bounded/N         the best in-process form, chunked N at a time
 *    bounded-child/N   the same bounded reader, spawned — the control that
 *                      separates "bounded scan" from "in process"
 *
 *  The bound comes from the design's *Concurrency and event-loop safety*
 *  section: "an already-queued unrelated request is starved no longer by the
 *  in-process read than by the complete subprocess route it replaces … compare
 *  their p95 starvation".
 *
 *  This is a warm-cache steady-server measurement: every route is warmed once
 *  before any sample counts. It is not a cold-start bound.
 *
 *  One caveat on `--scale 10`: the fixture is built by this process, and at that
 *  size that is ~550 MB and 40,000 files written before the first sample. The
 *  parent's heap and native high-water mark carry into every spawn measured
 *  afterwards, so the 10x `spawn-noop` figure is not a clean read of what a
 *  server process pays to spawn — it says the benchmark process paid it. Use
 *  `--home` or `--scale 1` to attribute spawn cost, or build the fixture with
 *  `--keep` in one run and measure it in a fresh one.
 *
 *  Usage:
 *    node cli/test/bench/history-stall.ts [--scale 1|10] [--iterations N]
 *         [--concurrency N] [--root DIR] [--home DIR] [--project PATH]
 *         [--chunks 1,2,4,8,16] [--bare-spawn] [--keep] [--json FILE]
 *
 *  `--home` measures a real provider home instead of a synthetic fixture; it is
 *  read-only and needs `--project` to say which project to read.
 */

import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture, FIXTURE_PROJECT, SCALES, type FixtureScale } from "./history-fixture.ts";
import { boundedHistory } from "./history-bounded-prototype.ts";
import {
  DEFAULT_HISTORY_LIMIT,
  readProjectHistory,
} from "../../src/lib/core/agent/providers/history.ts";
import { isOk } from "../../src/lib/core/result.ts";

const CLI_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BOUNDED_ENTRY = fileURLToPath(new URL("./bounded-entry.ts", import.meta.url));

/** Milliseconds since process start. */
const T0 = process.hrtime.bigint();
const now = (): number => Number(process.hrtime.bigint() - T0) / 1e6;

// -- options --

interface Options {
  scale: string;
  iterations: number;
  concurrency: number;
  root: string;
  home: string | null;
  project: string;
  keep: boolean;
  json: string | null;
  /** Spawn without the app's synchronous child-environment discovery — the
   *  thinner baseline, kept to show what that discovery is worth. */
  bareSpawn: boolean;
  /** Chunk sizes to run the bounded prototype at, one route each. */
  chunks: number[];
  /** Time the windowed `threads` query alone — the rule-5 admission evidence. */
  sqliteProbe: boolean;
}

function parseOptions(argv: string[]): Options {
  const o: Options = {
    scale: "1",
    // p95 of a per-invocation distribution needs invocations, not samples.
    iterations: 30,
    concurrency: 4,
    root: join(tmpdir(), "yaco-history-bench"),
    home: null,
    project: FIXTURE_PROJECT,
    keep: false,
    json: null,
    bareSpawn: false,
    chunks: [1, 2, 4, 8, 16],
    sqliteProbe: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    if (arg === "--scale") o.scale = value();
    else if (arg === "--iterations") o.iterations = Number(value());
    else if (arg === "--concurrency") o.concurrency = Number(value());
    else if (arg === "--root") o.root = value();
    else if (arg === "--home") o.home = value();
    else if (arg === "--project") o.project = value();
    else if (arg === "--json") o.json = value();
    else if (arg === "--chunks") o.chunks = value().split(",").map(Number);
    else if (arg === "--keep") o.keep = true;
    else if (arg === "--bare-spawn") o.bareSpawn = true;
    else if (arg === "--sqlite-probe") o.sqliteProbe = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!o.home && !SCALES[o.scale]) throw new Error(`unknown --scale ${o.scale} (have ${Object.keys(SCALES)})`);
  // A zero or fractional chunk makes the prototype's `i += chunk` loop forever,
  // which reads as a hung benchmark rather than as bad input.
  const positive = (n: number): boolean => Number.isSafeInteger(n) && n > 0;
  if (!o.chunks.every(positive) || new Set(o.chunks).size !== o.chunks.length) {
    throw new Error(`--chunks must be distinct positive integers (got: ${o.chunks.join(",")})`);
  }
  if (!positive(o.iterations)) throw new Error(`--iterations must be a positive integer`);
  if (!positive(o.concurrency)) throw new Error(`--concurrency must be a positive integer`);
  return o;
}

// -- statistics --

interface Stats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest rank: the p-th percentile is the observation at `ceil(n*p)`,
 *  one-based. Zero-based `floor(n*p)` is the same value only when `n*p` is not
 *  an integer, and picks the *next* observation when it is — which on a
 *  20-sample run promotes p95 to the maximum. */
function stats(values: number[]): Stats {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.max(0, Math.ceil(s.length * p) - 1)]!;
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s.at(-1)! };
}

// -- background workload --

/** Keeps the process doing something other than the route under test: an HTTP
 *  server plus a client holding `concurrency` requests in flight. It is the
 *  concurrent load the acceptance asks for, and it is what makes each probe a
 *  measurement of a *contended* loop. Its own latencies are reported only as an
 *  idle floor, not as the acceptance metric. */
class BackgroundLoad {
  /** Every completed background request, as (start, end, ms). */
  readonly samples: { startMs: number; endMs: number; ms: number }[] = [];
  url = "";
  #server = createServer((_req, res) => {
    readFile(this.#payloadPath, "utf-8").then((body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
  });
  #payloadPath: string;
  #running = false;

  constructor(payloadPath: string) {
    this.#payloadPath = payloadPath;
  }

  async start(concurrency: number): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    const address = this.#server.address();
    if (typeof address === "string" || address === null) throw new Error("no server address");
    this.url = `http://127.0.0.1:${address.port}/`;
    this.#running = true;
    for (let i = 0; i < concurrency; i++) void this.#client();
    // Let the load reach steady state, and its keep-alive sockets get
    // established, before any probe is issued over them.
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.samples.length = 0;
  }

  async stop(): Promise<void> {
    this.#running = false;
    await new Promise<void>((resolve, reject) =>
      this.#server.close((err) => (err ? reject(err) : resolve())));
  }

  async #client(): Promise<void> {
    while (this.#running) {
      const started = now();
      try {
        const res = await fetch(this.url);
        await res.text();
      } catch {
        continue;
      }
      const ended = now();
      this.samples.push({ startMs: started, endMs: ended, ms: ended - started });
    }
  }
}

// -- routes --

interface RouteResult {
  rows: number;
  wallMs: number;
}

type Route = () => Promise<RouteResult>;

/** The shipped reader called directly, live sessions supplied by the caller
 *  (the app already holds them), as the admitted export is. */
function inProcessRoute(projectPath: string): Route {
  return async () => {
    const started = now();
    const window = await readProjectHistory(projectPath, []);
    return { rows: isOk(window) ? window.value.returned : 0, wallMs: now() - started };
  };
}

/** The most favourable in-process form this cutover could ship: provider scans
 *  capped at the window, every fan-out chunked with a loop yield, the origin
 *  index read asynchronously. See `history-bounded-prototype.ts`. */
function boundedRoute(projectPath: string, chunk: number): Route {
  return async () => {
    const started = now();
    const rows = await boundedHistory(projectPath, DEFAULT_HISTORY_LIMIT, chunk);
    return { rows: rows.length, wallMs: now() - started };
  };
}

/** A replica of what `app/server` pays synchronously before *every* CLI spawn.
 *  `spawnOutput` (`app/server/src/lib/agent.ts`) passes `buildChildProcessEnv()`,
 *  and on Linux the blocking part of that is `spawnSync("ssh-add", ["-l"])` plus
 *  the clipboard cookie scan (`lib/ssh-auth.ts`, `lib/clipboard-env.ts`).
 *
 *  It is a replica, not the function: the app's sources use extensionless
 *  specifiers plain Node cannot resolve. What it leaves out is everything
 *  non-blocking — the `process.env` clone, the `npm_config_*` strip, the
 *  returned-object construction, the request timeout, and `runYacoAgentJson`'s
 *  envelope parsing — and the spawned command is this checkout's launcher rather
 *  than a resolved `YACO_PATH`. So this is *the dominant synchronous cost of*
 *  the real route, not the real route. */
function appChildEnvDiscovery(): void {
  spawnSync("ssh-add", ["-l"], { stdio: ["ignore", "ignore", "ignore"] });
  const runtimeDir = process.env["XDG_RUNTIME_DIR"];
  if (!runtimeDir || process.env["XAUTHORITY"]) return;
  try {
    readdirSync(runtimeDir)
      .filter((name) => name.startsWith(".mutter-Xwaylandauth."))
      .map((name) => statSync(join(runtimeDir, name)).mtimeMs)
      .sort((a, b) => b - a);
  } catch { /* no graphical session */ }
}

/** Spawn a child, drain stdout, count the rows in its envelope. `argv[0]` is
 *  the module to run; for the CLI that is the launcher, because `dist/yaco.mjs`
 *  exports `main` and never calls it. */
function spawnRoute(argv: string[], env: NodeJS.ProcessEnv, envDiscovery: boolean): Route {
  return () =>
    new Promise((resolve, reject) => {
      const started = now();
      if (envDiscovery) appChildEnvDiscovery();
      const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (c: string) => { out += c; });
      child.stderr.on("data", (c: string) => { err += c; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`child exited ${code}: ${err.slice(0, 400)}`));
        const envelope = JSON.parse(out) as { data?: { rows?: unknown[] } };
        resolve({ rows: envelope.data?.rows?.length ?? 0, wallMs: now() - started });
      });
    });
}

// -- the rule-5 SQLite probe --

/** Time the windowed `threads` query on its own — the evidence rule 5 asks for
 *  before `node:sqlite` may run inside the server.
 *
 *  Separate from the route benchmark on purpose: the routes measure the whole
 *  read, in which this query is one component among provider file reads. An
 *  admission that says "N ms for the query" has to be reproducible as exactly
 *  that, not inferred from a route total. */
function sqliteProbe(dbPath: string, limit: number, samples = 40): void {
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const SQL = "SELECT id, title, first_user_message, created_at, updated_at, git_branch, rollout_path" +
    " FROM threads WHERE cwd = ? AND archived = 0 ORDER BY updated_at DESC, id ASC LIMIT ?";

  const opened = new DatabaseSync(dbPath, { readOnly: true });
  let rows: number;
  let plan: string;
  let cwd: string;
  let forCwd: number;
  try {
    rows = (opened.prepare("SELECT count(*) AS n FROM threads").get() as { n: number }).n;
    // The busiest cwd, so the probe measures the worst window this database
    // holds rather than an average one.
    const busiest = opened
      .prepare("SELECT cwd, count(*) AS n FROM threads WHERE archived = 0 GROUP BY cwd ORDER BY n DESC LIMIT 1")
      .get() as { cwd: string; n: number } | undefined;
    if (!busiest) throw new Error(`no non-archived threads in ${dbPath}`);
    cwd = busiest.cwd;
    forCwd = busiest.n;
    plan = (opened.prepare(`EXPLAIN QUERY PLAN ${SQL}`).all(cwd, limit) as { detail: string }[])
      .map((r) => r.detail).join(" / ");
  } finally {
    opened.close();
  }

  // Warm the page cache the way a steady server has it warm.
  for (let i = 0; i < 3; i++) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare(SQL).all(cwd, limit);
    db.close();
  }

  const times: number[] = [];
  let returned = 0;
  for (let i = 0; i < samples; i++) {
    const started = now();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    returned = (db.prepare(SQL).all(cwd, limit) as unknown[]).length;
    db.close();
    times.push(now() - started);
  }

  console.log(`
database     ${dbPath}
size         ${(statSync(dbPath).size / 1024 / 1024).toFixed(1)} MB, ${rows} rows in \`threads\`
cwd          ${cwd} — ${forCwd} non-archived threads, ${returned} returned at LIMIT ${limit}
query        ${SQL}
plan         ${plan}
cost         open + all + close, ${times.length} samples, warm`);
  console.log(`             ${fmt(stats(times))}`);
}

// -- run --

/** One invocation's starvation: the worst delay any already-queued probe
 *  suffered while the route ran. */
interface Probe {
  timerMs: number;
  httpMs: number;
}

/** Run the route with two probe chains re-queuing themselves beside it, and
 *  return the worst delay each suffered.
 *
 *  A single probe queued at the seam is not enough, and getting that wrong would
 *  favour the *in-process* side: the shipped reader is asynchronous with
 *  synchronous bursts, so a timer queued before it fires after the first burst
 *  and never sees the 100 ms of parsing that follows. Re-queuing throughout the
 *  route asks the question at every moment, and the maximum is the answer — the
 *  longest an already-queued piece of work waited because of this route.
 *
 *  One number per invocation, so every route's distribution has the same size
 *  and does not dilute a stall with however many cheap samples its wall time
 *  happened to admit. */
async function invoke(route: Route, url: string): Promise<{ result: RouteResult; probe: Probe }> {
  let running = true;
  let worstTimer = 0;
  let worstHttp = 0;

  // The chain has to be *drained*, not just stopped. The timer in flight when a
  // route resolves is the one that spanned its final synchronous burst — for the
  // shipped reader that is `finalizeHistory`, which sorts and then reads up to
  // 200 origin files synchronously. Returning without it drops exactly the
  // sample most likely to be the worst.
  let drained: () => void;
  const timersDrained = new Promise<void>((resolve) => { drained = resolve; });
  const timerChain = (): void => {
    const queuedAt = now();
    setTimeout(() => {
      worstTimer = Math.max(worstTimer, now() - queuedAt);
      if (running) timerChain();
      else drained();
    }, 0);
  };
  const httpChain = async (): Promise<void> => {
    while (running) {
      const started = now();
      try {
        const res = await fetch(url);
        await res.text();
      } catch {
        continue;
      }
      worstHttp = Math.max(worstHttp, now() - started);
    }
  };

  timerChain();
  const http = httpChain();
  const result = await route();
  running = false;
  await Promise.all([http, timersDrained]);
  return { result, probe: { timerMs: worstTimer, httpMs: worstHttp } };
}

function fmt(s: Stats): string {
  return `n=${String(s.n).padStart(4)}  p50=${s.p50.toFixed(1).padStart(7)}  p95=${
    s.p95.toFixed(1).padStart(7)}  p99=${s.p99.toFixed(1).padStart(7)}  max=${s.max.toFixed(1).padStart(8)}`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  // Everything that can leave state behind is registered before it is created,
  // so a failure part-way through fixture construction still cleans up.
  let removeFixture: (() => void) | null = null;
  let retained: string | null = null;
  let loadDir: string | null = null;
  let envMutated = false;
  const previousHome = process.env["HOME"];
  const previousYacoHome = process.env["YACO_HOME"];
  let load: BackgroundLoad | null = null;

  try {
    let home: string;
    let yacoHome: string;
    let scale: FixtureScale | null = null;

    if (options.home) {
      home = options.home;
      yacoHome = process.env["YACO_HOME"] ?? join(home, ".yaco");
    } else {
      scale = SCALES[options.scale]!;
      if (options.keep) retained = options.root;
      else removeFixture = () => rmSync(options.root, { recursive: true, force: true });
      console.log(`building fixture (scale ${options.scale}) under ${options.root} …`);
      const built = buildFixture(options.root, scale);
      home = built.home;
      yacoHome = built.yacoHome;
    }

    if (options.sqliteProbe) {
      sqliteProbe(join(home, ".codex", "state_5.sqlite"), DEFAULT_HISTORY_LIMIT + 1);
      return;
    }

    loadDir = mkdtempSync(join(tmpdir(), "yaco-bench-load-"));
    const payloadPath = join(loadDir, "payload.json");
    writeFileSync(payloadPath, JSON.stringify({ ok: true, note: "unrelated request payload" }));

    // The in-process routes read `HOME`/`YACO_HOME` at call time; the spawned
    // routes get the same two values in the child environment. Nothing else
    // about the process environment changes, and no route writes.
    envMutated = true;
    process.env["HOME"] = home;
    process.env["YACO_HOME"] = yacoHome;
    const childEnv = { ...process.env, HOME: home, YACO_HOME: yacoHome };
    const limit = String(DEFAULT_HISTORY_LIMIT);

    const routes: [string, Route][] = [
      // A child that does nothing but print an empty envelope: the price of the
      // spawn alone, with no read attached, so the ~16 ms the subprocess
      // baseline pays before any work is attributable rather than inferred.
      ["spawn-noop", spawnRoute(
        ["-e", 'process.stdout.write(JSON.stringify({data:{rows:[]}}))'],
        childEnv,
        !options.bareSpawn,
      )],
      ["subprocess", spawnRoute(
        [join(CLI_ROOT, "bin", "yaco.mjs"), "agent", "history", "--path", options.project, "--json"],
        childEnv,
        !options.bareSpawn,
      )],
      ["in-process", inProcessRoute(options.project)],
      // The chunk size is the prototype's only tuning knob and it trades wall
      // time against how long one uninterrupted run of parsing lasts. Sweeping
      // it is the difference between "this bounded reader loses" and "every
      // bounded reader loses" — only the sweep can support the second claim.
      ...options.chunks.flatMap((chunk): [string, Route][] => [
        [`bounded/${chunk}`, boundedRoute(options.project, chunk)],
        [`bounded-child/${chunk}`, spawnRoute(
          [BOUNDED_ENTRY, options.project, limit, String(chunk)],
          childEnv,
          !options.bareSpawn,
        )],
      ]),
    ];

    load = new BackgroundLoad(payloadPath);
    await load.start(options.concurrency);

    const probes: Record<string, Probe[]> = Object.fromEntries(routes.map(([n]) => [n, [] as Probe[]]));
    const walls: Record<string, number[]> = Object.fromEntries(routes.map(([n]) => [n, [] as number[]]));
    const rows: Record<string, number> = {};
    const spans: { startMs: number; endMs: number }[] = [];

    // One warm-up of each route before any sample counts: the first SQLite open
    // and the first log read pay page-cache costs a steady server does not.
    for (const [, route] of routes) await route();

    // Interleaved, so machine drift lands on every route rather than one, with
    // an idle gap between invocations to let the load re-settle.
    for (let i = 0; i < options.iterations; i++) {
      for (const [name, route] of routes) {
        const startMs = now();
        const { result, probe } = await invoke(route, load.url);
        spans.push({ startMs, endMs: now() });
        probes[name]!.push(probe);
        walls[name]!.push(result.wallMs);
        rows[name] = result.rows;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    const results = routes.map(([name]) => ({
      name,
      timer: stats(probes[name]!.map((p) => p.timerMs)),
      http: stats(probes[name]!.map((p) => p.httpMs)),
      wall: stats(walls[name]!),
      rows: rows[name] ?? 0,
    }));
    const idleFloor = stats(load.samples
      .filter((s) => !spans.some((w) => s.startMs < w.endMs && s.endMs > w.startMs))
      .map((s) => s.ms));

    console.log(`
fixture      ${options.home ? `real home ${options.home}` : `synthetic scale ${options.scale} — ${JSON.stringify(scale)}`}
project      ${options.project}
load         ${options.concurrency} concurrent background HTTP requests (idle floor p95 ${
      idleFloor.p95.toFixed(1)} ms over n=${idleFloor.n})
metric       worst delay suffered by a continuously re-queued probe while the route ran,
             one value per invocation; ${options.iterations} invocations per route
baseline     spawn ${options.bareSpawn ? "WITHOUT" : "with"} a replica of the app's synchronous child-environment discovery
`);
    console.log("worst starvation of an already-queued timer per invocation (ms) — the acceptance metric");
    for (const r of results) console.log(`  ${r.name.padEnd(17)} ${fmt(r.timer)}`);
    console.log("\nworst starvation of an already-queued request per invocation (ms) — corroborating");
    for (const r of results) console.log(`  ${r.name.padEnd(17)} ${fmt(r.http)}`);
    console.log("\nroute wall time (ms)");
    for (const r of results) console.log(`  ${r.name.padEnd(17)} ${fmt(r.wall)}   rows=${r.rows}`);

    const sub = results.find((r) => r.name === "subprocess")!;
    const inProcess = results.filter((r) =>
      r.name !== "subprocess" && r.name !== "spawn-noop" && !r.name.startsWith("bounded-child/"));
    const within = inProcess.filter((c) => c.timer.p95 <= sub.timer.p95);
    console.log(`
bound        in-process p95 timer starvation <= subprocess p95 (design: Concurrency and event-loop safety)
             ${"subprocess".padEnd(16)} p95 = ${sub.timer.p95.toFixed(1).padStart(7)} ms, wall p50 = ${
      sub.wall.p50.toFixed(0).padStart(5)} ms`);
    for (const c of inProcess) {
      console.log(`             ${c.name.padEnd(16)} p95 = ${c.timer.p95.toFixed(1).padStart(7)} ms, wall p50 = ${
        c.wall.p50.toFixed(0).padStart(5)} ms  ->  ${c.timer.p95 <= sub.timer.p95 ? "within bound" : "over bound"}`);
    }
    console.log(`verdict      ${
      within.length === 0
        ? "no in-process form is within the bound"
        : `within the bound: ${within.map((c) => c.name).join(", ")}`}`);

    if (options.json) {
      writeFileSync(options.json, JSON.stringify({
        fixture: options.home ? { real: options.home } : { scale: options.scale, ...scale },
        project: options.project,
        concurrency: options.concurrency,
        iterations: options.iterations,
        chunks: options.chunks,
        envDiscovery: !options.bareSpawn,
        idleFloor,
        routes: results,
        within: within.map((c) => c.name),
      }, null, 2) + "\n");
    }
  } finally {
    // Ordered and isolated: the environment is restored before anything that can
    // throw, and one failing step cannot suppress the rest. Otherwise a server
    // that fails to close leaves the benchmark's HOME on the process and both
    // temporary trees on disk — the failure mode this block exists to prevent.
    if (envMutated) {
      if (previousHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = previousHome;
      if (previousYacoHome === undefined) delete process.env["YACO_HOME"];
      else process.env["YACO_HOME"] = previousYacoHome;
    }
    for (const step of [
      async () => await load?.stop(),
      async () => { if (loadDir) rmSync(loadDir, { recursive: true, force: true }); },
      async () => removeFixture?.(),
    ]) {
      try {
        await step();
      } catch (e) {
        console.error(`cleanup step failed: ${(e as Error).message}`);
      }
    }
    if (retained) console.log(`fixture retained at ${retained}`);
  }
}

await main();
