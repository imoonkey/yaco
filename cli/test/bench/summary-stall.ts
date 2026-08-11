/** Event-loop stall benchmark for the session-summary read — the evidence
 *  export eligibility rule 5 demands before `node:sqlite` and a provider log
 *  scan may run inside the server.
 *
 *  Same estimand and machinery as `history-stall.ts`, deliberately: the question
 *  is not how fast the read is, it is how long an *already-queued* unrelated
 *  piece of work waits because of it. So the instrument is a timer re-queued
 *  continuously for as long as the route runs, contributing one worst-delay
 *  value per invocation — the same count for every route, so the distributions
 *  compared are the same size and mean the same thing. (That harness is copied
 *  rather than shared because `history-stall.ts` is a validated instrument whose
 *  published numbers a refactor would put in question, and it belongs to the
 *  queued `history-read-land` cutover.)
 *
 *  Routes:
 *    spawn-noop     a child that prints an empty envelope — the spawn alone
 *    subprocess     the route today — spawn `yaco agent summaries --path`
 *    in-process     the shipped bounded reader called directly
 *    whole-file     the *previous* reader's shape — `readFile(utf-8)` + split —
 *                   called in process
 *
 *  `whole-file` is the control, and it is what makes this harness falsifiable.
 *  It reads the same logs through the same call mechanism as `in-process` and
 *  differs only in being unbounded, so:
 *
 *    - if `whole-file` and `in-process` measure the same, the harness is not
 *      seeing the thing this cutover changed, and no number it prints about the
 *      in-process route means anything;
 *    - if `whole-file` is over the bound and `in-process` is under it, the
 *      admission is about the scan being bounded, not about SQLite or about
 *      being in process — and the same run says which.
 *
 *  This is a warm-cache steady-server measurement: every route is warmed once
 *  before any sample counts. It is not a cold-start bound.
 *
 *  Usage:
 *    node cli/test/bench/summary-stall.ts [--scale 1|10] [--iterations N]
 *         [--concurrency N] [--root DIR] [--home DIR] [--project PATH]
 *         [--bare-spawn] [--keep] [--json FILE]
 *
 *  `--home` measures a real provider home instead of a synthetic fixture; it is
 *  read-only, and needs `--project` plus a `YACO_HOME` holding that home's
 *  session state files.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture, FIXTURE_PROJECT, SCALES, type FixtureScale } from "./summary-fixture.ts";
import { readSessionSummaries } from "../../src/lib/core/agent/providers/summary-read.ts";
import { resolveClaudeLogPath, resolveCodexLogPath } from "../../src/lib/core/agent/providers/output.ts";
import { extractUserText, firstMeaningfulMessage } from "../../src/lib/core/agent/providers/prompt-label.ts";
import { listByPath } from "../../src/lib/core/agent/session-state.ts";
import { isOk } from "../../src/lib/core/result.ts";
import type { SessionState } from "../../src/lib/core/agent/model.ts";

const CLI_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
  bareSpawn: boolean;
}

function parseOptions(argv: string[]): Options {
  const o: Options = {
    scale: "1",
    iterations: 30,
    concurrency: 4,
    root: join(tmpdir(), "yaco-summary-bench"),
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
  const positive = (n: number): boolean => Number.isSafeInteger(n) && n > 0;
  if (!positive(o.iterations)) throw new Error("--iterations must be a positive integer");
  if (!positive(o.concurrency)) throw new Error("--concurrency must be a positive integer");
  return o;
}

// -- statistics --

interface Stats { n: number; p50: number; p95: number; p99: number; max: number }

/** Nearest rank: the p-th percentile is the observation at `ceil(n*p)`,
 *  one-based. Zero-based `floor(n*p)` promotes p95 to the maximum whenever
 *  `n*p` is an integer, which on a 30-sample run it often is. */
function stats(values: number[]): Stats {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.max(0, Math.ceil(s.length * p) - 1)]!;
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s.at(-1)! };
}

// -- background workload --

/** Keeps the process doing something other than the route under test, so each
 *  probe measures a *contended* loop. Its own latencies are reported only as an
 *  idle floor, never as the acceptance metric. */
class BackgroundLoad {
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

interface RouteResult { rows: number; wallMs: number }
type Route = () => Promise<RouteResult>;

/** The shipped reader, sessions supplied by the caller as the app supplies them. */
function inProcessRoute(sessions: SessionState[]): Route {
  return async () => {
    const started = now();
    const result = await readSessionSummaries(sessions);
    if (!isOk(result)) throw new Error(`${result.code}: ${result.message}`);
    return { rows: result.value.length, wallMs: now() - started };
  };
}

/** The reader this cutover replaced, in its own shape: decode the whole log and
 *  split it, once per session, with no yield anywhere. Same call mechanism and
 *  the same files as `in-process`; the only difference is the bound. */
function wholeFileRoute(sessions: SessionState[]): Route {
  const label = async (session: SessionState): Promise<string | null> => {
    const path = session.provider === "claude"
      ? resolveClaudeLogPath(session)
      : await resolveCodexLogPath(session);
    if (!path) return null;
    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch {
      return null;
    }
    const texts: string[] = [];
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (session.provider === "claude") {
          if (entry.type === "user" && entry.message?.content) {
            texts.push(extractUserText(entry.message.content));
          }
        } else if (entry.type === "response_item" && entry.payload?.role === "user") {
          for (const block of entry.payload.content ?? []) {
            if (
              block.type === "input_text" && block.text &&
              !block.text.startsWith("#") && !block.text.startsWith("<")
            ) {
              texts.push(block.text);
            }
          }
        }
      } catch { continue; }
    }
    return firstMeaningfulMessage(texts, session.handle);
  };

  return async () => {
    const started = now();
    const labels = await Promise.all(sessions.map(label));
    return { rows: labels.filter((l) => l !== null).length, wallMs: now() - started };
  };
}

/** A replica of what `app/server` pays synchronously before *every* CLI spawn:
 *  `buildChildProcessEnv()`'s `spawnSync("ssh-add")` plus the clipboard cookie
 *  scan. It is the dominant synchronous cost of the real route, not the real
 *  route — see `history-stall.ts` for the full accounting. */
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
        const envelope = JSON.parse(out) as { data?: unknown[] };
        resolve({ rows: envelope.data?.length ?? 0, wallMs: now() - started });
      });
    });
}

// -- run --

/** One invocation's starvation: the worst delay an already-queued timer
 *  suffered while the route ran. The chain is drained rather than stopped, so
 *  the timer spanning the route's final synchronous burst still counts. */
async function invoke(route: Route): Promise<{ result: RouteResult; worstMs: number }> {
  let running = true;
  let worst = 0;
  let drained: () => void;
  const timersDrained = new Promise<void>((resolve) => { drained = resolve; });
  const chain = (): void => {
    const queuedAt = now();
    setTimeout(() => {
      worst = Math.max(worst, now() - queuedAt);
      if (running) chain();
      else drained();
    }, 0);
  };

  chain();
  const result = await route();
  running = false;
  await timersDrained;
  return { result, worstMs: worst };
}

function fmt(s: Stats): string {
  return `n=${String(s.n).padStart(4)}  p50=${s.p50.toFixed(1).padStart(7)}  p95=${
    s.p95.toFixed(1).padStart(7)}  p99=${s.p99.toFixed(1).padStart(7)}  max=${s.max.toFixed(1).padStart(8)}`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

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
    let fixtureBytes = 0;

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
      fixtureBytes = built.bytes;
    }

    loadDir = mkdtempSync(join(tmpdir(), "yaco-summary-load-"));
    const payloadPath = join(loadDir, "payload.json");
    writeFileSync(payloadPath, JSON.stringify({ ok: true, note: "unrelated request payload" }));

    envMutated = true;
    process.env["HOME"] = home;
    process.env["YACO_HOME"] = yacoHome;
    const childEnv = { ...process.env, HOME: home, YACO_HOME: yacoHome };

    // The sessions the in-process routes are handed are exactly the ones the
    // subprocess route enumerates for itself, read through the same function it
    // uses — otherwise the two routes would not be answering the same question.
    const sessions = listByPath(options.project);
    if (sessions.length === 0) throw new Error(`no live sessions under ${options.project}`);

    const routes: [string, Route][] = [
      ["spawn-noop", spawnRoute(
        ["-e", 'process.stdout.write(JSON.stringify({data:[]}))'],
        childEnv,
        !options.bareSpawn,
      )],
      ["subprocess", spawnRoute(
        [join(CLI_ROOT, "bin", "yaco.mjs"), "agent", "summaries", "--path", options.project, "--json"],
        childEnv,
        !options.bareSpawn,
      )],
      ["in-process", inProcessRoute(sessions)],
      ["whole-file", wholeFileRoute(sessions)],
    ];

    load = new BackgroundLoad(payloadPath);
    await load.start(options.concurrency);

    const probes: Record<string, number[]> = Object.fromEntries(routes.map(([n]) => [n, [] as number[]]));
    const walls: Record<string, number[]> = Object.fromEntries(routes.map(([n]) => [n, [] as number[]]));
    const rows: Record<string, number> = {};
    const spans: { startMs: number; endMs: number }[] = [];

    // One warm-up per route before any sample counts: the first SQLite open and
    // the first log read pay page-cache costs a steady server does not.
    for (const [, route] of routes) await route();

    for (let i = 0; i < options.iterations; i++) {
      for (const [name, route] of routes) {
        const startMs = now();
        const { result, worstMs } = await invoke(route);
        spans.push({ startMs, endMs: now() });
        probes[name]!.push(worstMs);
        walls[name]!.push(result.wallMs);
        rows[name] = result.rows;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    const results = routes.map(([name]) => ({
      name,
      timer: stats(probes[name]!),
      wall: stats(walls[name]!),
      rows: rows[name] ?? 0,
    }));
    const idleFloor = stats(load.samples
      .filter((s) => !spans.some((w) => s.startMs < w.endMs && s.endMs > w.startMs))
      .map((s) => s.ms));

    console.log(`
fixture      ${options.home ? `real home ${options.home}` : `synthetic scale ${options.scale} — ${
      JSON.stringify(scale)}, ${(fixtureBytes / 1024 / 1024).toFixed(0)} MB of logs`}
project      ${options.project}
sessions     ${sessions.length} live (${sessions.filter((s) => s.provider === "claude").length} claude, ${
      sessions.filter((s) => s.provider === "codex").length} codex)
load         ${options.concurrency} concurrent background HTTP requests (idle floor p95 ${
      idleFloor.p95.toFixed(1)} ms over n=${idleFloor.n})
metric       worst delay suffered by a continuously re-queued timer while the route ran,
             one value per invocation; ${options.iterations} invocations per route
baseline     spawn ${options.bareSpawn ? "WITHOUT" : "with"} a replica of the app's synchronous child-environment discovery
`);
    console.log("worst starvation of an already-queued timer per invocation (ms) — the acceptance metric");
    for (const r of results) console.log(`  ${r.name.padEnd(13)} ${fmt(r.timer)}`);
    console.log("\nroute wall time (ms)");
    for (const r of results) console.log(`  ${r.name.padEnd(13)} ${fmt(r.wall)}   rows=${r.rows}`);

    const sub = results.find((r) => r.name === "subprocess")!;
    const shipped = results.find((r) => r.name === "in-process")!;
    const control = results.find((r) => r.name === "whole-file")!;
    const distinguishes = control.timer.p95 > shipped.timer.p95 * 1.5;

    console.log(`
bound        in-process p95 timer starvation <= subprocess p95 (design: Concurrency and event-loop safety)
             ${"subprocess".padEnd(12)} p95 = ${sub.timer.p95.toFixed(1).padStart(7)} ms, wall p50 = ${
      sub.wall.p50.toFixed(0).padStart(6)} ms
             ${"in-process".padEnd(12)} p95 = ${shipped.timer.p95.toFixed(1).padStart(7)} ms, wall p50 = ${
      shipped.wall.p50.toFixed(0).padStart(6)} ms  ->  ${
      shipped.timer.p95 <= sub.timer.p95 ? "within bound" : "OVER BOUND"}
             ${"whole-file".padEnd(12)} p95 = ${control.timer.p95.toFixed(1).padStart(7)} ms, wall p50 = ${
      control.wall.p50.toFixed(0).padStart(6)} ms  ->  ${
      control.timer.p95 <= sub.timer.p95 ? "within bound" : "over bound"}
control      the unbounded reader ${distinguishes ? "is" : "is NOT"} separated from the bounded one${
      distinguishes ? "" : " — this harness cannot see what the cutover changed, so its in-process figure means nothing"}
verdict      ${
      shipped.timer.p95 <= sub.timer.p95 && distinguishes
        ? "admitted: bounded reader within the subprocess bound, control separated"
        : "NOT admitted"}`);

    if (rows["subprocess"] !== rows["in-process"]) {
      console.log(`\nWARNING  routes disagree on row count (subprocess ${
        rows["subprocess"]}, in-process ${rows["in-process"]}) — they are not reading the same thing`);
    }

    if (options.json) {
      writeFileSync(options.json, JSON.stringify({
        fixture: options.home ? { real: options.home } : { scale: options.scale, ...scale, bytes: fixtureBytes },
        project: options.project,
        sessions: sessions.length,
        concurrency: options.concurrency,
        iterations: options.iterations,
        envDiscovery: !options.bareSpawn,
        idleFloor,
        routes: results,
      }, null, 2) + "\n");
    }
  } finally {
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
