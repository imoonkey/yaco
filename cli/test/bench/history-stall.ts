/** Event-loop stall benchmark for the history read — the evidence export
 *  eligibility rule 5 demands before `node:sqlite` may run inside the server.
 *
 *  The question is not how fast the read is. It is how long an *unrelated*
 *  request that is already queued waits because of it. So the harness serves
 *  real HTTP requests from the same process throughout, and reports the latency
 *  distribution of the requests that overlapped each route:
 *
 *    subprocess  the route today — spawn `yaco agent history --json`, parse the
 *                envelope. The parent's event loop is free while the child runs.
 *    in-process  the candidate — call the CLI read directly.
 *
 *  The bound comes from the design's *Concurrency and event-loop safety*
 *  section: "an already-queued unrelated request is starved no longer by the
 *  in-process read than by the complete subprocess route it replaces … compare
 *  their p95 starvation". So the verdict is `in-process p95 <= subprocess p95`,
 *  measured on the same fixture in the same process under the same load.
 *
 *  Usage:
 *    node cli/test/bench/history-stall.ts [--scale 1|10] [--iterations N]
 *         [--concurrency N] [--root DIR] [--home DIR] [--keep] [--json FILE]
 *
 *  `--home` measures a real provider home instead of a synthetic fixture; it is
 *  read-only and needs `--project` to say which project to read.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture, FIXTURE_PROJECT, SCALES, type FixtureScale } from "./history-fixture.ts";
import { boundedHistory } from "./history-bounded-prototype.ts";
import {
  claudeHistory,
  codexHistory,
  DEFAULT_HISTORY_LIMIT,
  finalizeHistory,
} from "../../src/lib/core/agent/providers/history.ts";

const CLI_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
   *  incomplete baseline, kept only to show what that discovery is worth. */
  bareSpawn: boolean;
}

function parseOptions(argv: string[]): Options {
  const o: Options = {
    scale: "1",
    iterations: 12,
    concurrency: 4,
    root: join(tmpdir(), "yaco-history-bench"),
    home: null,
    project: FIXTURE_PROJECT,
    keep: false,
    json: null,
    bareSpawn: false,
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
    else if (arg === "--keep") o.keep = true;
    else if (arg === "--bare-spawn") o.bareSpawn = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!o.home && !SCALES[o.scale]) throw new Error(`unknown --scale ${o.scale} (have ${Object.keys(SCALES)})`);
  return o;
}

// -- instruments --

/** One latency sample, tagged with the route that was running when it started. */
interface Sample {
  window: string;
  ms: number;
}

interface Stats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function stats(values: number[]): Stats {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s.at(-1)! };
}

/** The load: an HTTP server plus a client that keeps `concurrency` requests in
 *  flight. Each request does one small async file read, so it is exactly the
 *  kind of cheap unrelated request the history route shares a process with. */
class UnrelatedLoad {
  readonly samples: Sample[] = [];
  /** Event-loop lag of an already-queued 1 ms timer, sampled continuously. */
  readonly lag: Sample[] = [];
  window = "idle";
  #server = createServer((_req, res) => {
    readFile(this.#payloadPath, "utf-8").then((body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
  });
  #payloadPath: string;
  #running = false;
  #url = "";

  constructor(payloadPath: string) {
    this.#payloadPath = payloadPath;
  }

  async start(concurrency: number): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    const address = this.#server.address();
    if (typeof address === "string" || address === null) throw new Error("no server address");
    this.#url = `http://127.0.0.1:${address.port}/`;
    this.#running = true;
    for (let i = 0; i < concurrency; i++) void this.#client();
    this.#tick();
    // Let the load reach steady state before the first route runs.
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.samples.length = 0;
    this.lag.length = 0;
  }

  async stop(): Promise<void> {
    this.#running = false;
    await new Promise<void>((resolve, reject) =>
      this.#server.close((err) => (err ? reject(err) : resolve())));
  }

  async #client(): Promise<void> {
    while (this.#running) {
      const window = this.window;
      const started = process.hrtime.bigint();
      try {
        const res = await fetch(this.#url);
        await res.text();
      } catch {
        continue;
      }
      this.samples.push({ window, ms: Number(process.hrtime.bigint() - started) / 1e6 });
    }
  }

  #tick(): void {
    const window = this.window;
    const started = process.hrtime.bigint();
    setTimeout(() => {
      if (!this.#running) return;
      // Lag is the delay beyond the 1 ms the timer asked for.
      this.lag.push({ window, ms: Math.max(0, Number(process.hrtime.bigint() - started) / 1e6 - 1) });
      this.#tick();
    }, 1);
  }
}

// -- routes --

interface RouteResult {
  rows: number;
  wallMs: number;
}

type Route = () => Promise<RouteResult>;

/** The candidate: the CLI read called directly, live sessions supplied by the
 *  caller (the app already holds them), exactly as an admitted export would be. */
function inProcessRoute(projectPath: string): Route {
  return async () => {
    const started = process.hrtime.bigint();
    const perProvider = await Promise.all([
      claudeHistory().list(projectPath, []),
      codexHistory().list(projectPath, []),
    ]);
    const window = finalizeHistory(perProvider.flat(), []);
    return { rows: window.returned, wallMs: Number(process.hrtime.bigint() - started) / 1e6 };
  };
}

/** The most favourable in-process form this cutover could ship: provider scans
 *  capped at the history window, every fan-out chunked with a loop yield, and
 *  the origin index read asynchronously. See `history-bounded-prototype.ts`. */
function boundedRoute(projectPath: string): Route {
  return async () => {
    const started = process.hrtime.bigint();
    const rows = await boundedHistory(projectPath, DEFAULT_HISTORY_LIMIT);
    return { rows: rows.length, wallMs: Number(process.hrtime.bigint() - started) / 1e6 };
  };
}

/** What `app/server` pays synchronously before *every* CLI spawn.
 *  `spawnOutput` (`app/server/src/lib/agent.ts`) passes `buildChildProcessEnv()`,
 *  and on Linux that is `spawnSync('ssh-add', ['-l'])` plus the clipboard
 *  cookie scan (`lib/ssh-auth.ts`, `lib/clipboard-env.ts`). It is replicated
 *  here rather than imported because the app's sources use extensionless
 *  specifiers that plain Node cannot resolve. Leaving it out would credit the
 *  subprocess route with a clean event loop it does not have — the design names
 *  this "the measured 6-12 ms synchronous child-environment discovery … one
 *  component of the baseline". */
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

/** The route it would replace, complete: the app's synchronous child-environment
 *  discovery, then spawn the built CLI, drain stdout, parse the envelope. The
 *  launcher is the entry point — `dist/yaco.mjs` exports `main` and never calls
 *  it, so spawning the bundle prints nothing. */
function subprocessRoute(projectPath: string, env: NodeJS.ProcessEnv, envDiscovery: boolean): Route {
  const bundle = join(CLI_ROOT, "bin", "yaco.mjs");
  return () =>
    new Promise((resolve, reject) => {
      const started = process.hrtime.bigint();
      if (envDiscovery) appChildEnvDiscovery();
      const child = spawn(process.execPath, [bundle, "agent", "history", "--path", projectPath, "--json"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (c: string) => { out += c; });
      child.stderr.on("data", (c: string) => { err += c; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`yaco agent history exited ${code}: ${err.slice(0, 400)}`));
        const envelope = JSON.parse(out) as { ok: boolean; data?: { rows?: unknown[] } };
        resolve({
          rows: envelope.data?.rows?.length ?? 0,
          wallMs: Number(process.hrtime.bigint() - started) / 1e6,
        });
      });
    });
}

// -- run --

function report(load: UnrelatedLoad, window: string): { request: Stats; lag: Stats } {
  return {
    request: stats(load.samples.filter((s) => s.window === window).map((s) => s.ms)),
    lag: stats(load.lag.filter((s) => s.window === window).map((s) => s.ms)),
  };
}

function fmt(s: Stats): string {
  return `n=${String(s.n).padStart(5)}  p50=${s.p50.toFixed(1).padStart(7)}  p95=${
    s.p95.toFixed(1).padStart(7)}  p99=${s.p99.toFixed(1).padStart(7)}  max=${s.max.toFixed(1).padStart(8)}`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  let home: string;
  let yacoHome: string;
  let scale: FixtureScale | null = null;
  let cleanup: (() => void) | null = null;

  if (options.home) {
    home = options.home;
    yacoHome = process.env["YACO_HOME"] ?? join(home, ".yaco");
  } else {
    scale = SCALES[options.scale]!;
    console.log(`building fixture (scale ${options.scale}) under ${options.root} …`);
    const built = buildFixture(options.root, scale);
    home = built.home;
    yacoHome = built.yacoHome;
    if (!options.keep) cleanup = () => rmSync(options.root, { recursive: true, force: true });
  }

  const loadDir = mkdtempSync(join(tmpdir(), "yaco-bench-load-"));
  const payloadPath = join(loadDir, "payload.json");
  writeFileSync(payloadPath, JSON.stringify({ ok: true, note: "unrelated request payload" }));

  // The in-process route reads `HOME`/`YACO_HOME` at call time; the subprocess
  // route gets the same two values in the child environment. Nothing else about
  // the process environment changes, and neither route writes.
  const previousHome = process.env["HOME"];
  const previousYacoHome = process.env["YACO_HOME"];
  process.env["HOME"] = home;
  process.env["YACO_HOME"] = yacoHome;
  const childEnv = { ...process.env, HOME: home, YACO_HOME: yacoHome };

  const routes: [string, Route][] = [
    ["subprocess", subprocessRoute(options.project, childEnv, !options.bareSpawn)],
    ["in-process", inProcessRoute(options.project)],
    ["bounded", boundedRoute(options.project)],
  ];

  const load = new UnrelatedLoad(payloadPath);
  await load.start(options.concurrency);

  const walls: Record<string, number[]> = Object.fromEntries(routes.map(([name]) => [name, [] as number[]]));
  const rows: Record<string, number> = {};

  try {
    // One warm-up of each route before any sample counts: the first SQLite open
    // and the first JSONL read pay page-cache costs a steady server does not.
    for (const [, route] of routes) await route();
    load.samples.length = 0;
    load.lag.length = 0;

    // Interleaved, so machine load drifts across both routes rather than into
    // one of them, with an idle gap between runs to re-establish the floor.
    for (let i = 0; i < options.iterations; i++) {
      for (const [name, route] of routes) {
        load.window = name;
        const result = await route();
        load.window = "idle";
        walls[name]!.push(result.wallMs);
        rows[name] = result.rows;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  } finally {
    await load.stop();
    if (previousHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = previousHome;
    if (previousYacoHome === undefined) delete process.env["YACO_HOME"];
    else process.env["YACO_HOME"] = previousYacoHome;
    rmSync(loadDir, { recursive: true, force: true });
    cleanup?.();
  }

  const idle = report(load, "idle");
  const results = routes.map(([name]) => ({ name, ...report(load, name), wall: stats(walls[name]!), rows: rows[name] ?? 0 }));

  console.log(`
fixture      ${options.home ? `real home ${options.home}` : `synthetic scale ${options.scale} — ${JSON.stringify(scale)}`}
project      ${options.project}
load         ${options.concurrency} concurrent HTTP requests, ${options.iterations} interleaved iterations per route
baseline     subprocess spawn ${options.bareSpawn ? "WITHOUT" : "with"} the app's synchronous child-environment discovery
`);
  console.log("unrelated request latency (ms)");
  console.log(`  idle        ${fmt(idle.request)}`);
  for (const r of results) console.log(`  ${r.name.padEnd(11)} ${fmt(r.request)}   rows=${r.rows}`);
  console.log("\nqueued-timer lag (ms)");
  console.log(`  idle        ${fmt(idle.lag)}`);
  for (const r of results) console.log(`  ${r.name.padEnd(11)} ${fmt(r.lag)}`);
  console.log("\nroute wall time (ms)");
  for (const r of results) console.log(`  ${r.name.padEnd(11)} ${fmt(r.wall)}`);

  const sub = results.find((r) => r.name === "subprocess")!;
  const candidates = results.filter((r) => r.name !== "subprocess");
  const pass = candidates.every((c) => c.request.p95 <= sub.request.p95);
  console.log(`
bound        candidate p95 request latency <= subprocess p95 (design: Concurrency and event-loop safety)
             subprocess p95 = ${sub.request.p95.toFixed(1)} ms`);
  for (const c of candidates) {
    console.log(`             ${c.name.padEnd(11)} p95 = ${c.request.p95.toFixed(1)} ms  ->  ${
      c.request.p95 <= sub.request.p95 ? "within bound" : `${(c.request.p95 / sub.request.p95).toFixed(0)}x over`}`);
  }
  console.log(`verdict      ${pass ? "PASS — eligible to move in-process" : "FAIL — stays a subprocess"}`);

  if (options.json) {
    writeFileSync(options.json, JSON.stringify({
      fixture: options.home ? { real: options.home } : { scale: options.scale, ...scale },
      project: options.project,
      concurrency: options.concurrency,
      envDiscovery: !options.bareSpawn,
      iterations: options.iterations,
      idle,
      routes: results,
      verdict: pass ? "pass" : "fail",
    }, null, 2) + "\n");
  }
  if (!pass) process.exitCode = 1;
}

await main();
