import { describe, it, expect, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

import { readTaskList } from 'yaco-cli/core/task'
import { isErr } from 'yaco-cli/core/result'
import { buildChildProcessEnv } from '../../lib/ssh-auth'

/** The event-loop gate for the task-GET read cutover, and the harness that
 *  produced the route medians in `plan/all/cli-node-sdk/qa-task-read-cutover.md`.
 *
 *  The design's condition is specific: an already-queued unrelated request must
 *  be starved no longer by the in-process read than by *the complete subprocess
 *  route it replaces*. "Complete" is why this test lives here and not in `cli`:
 *  the old route was `buildChildProcessEnv()` — whose `spawnSync('ssh-add')`
 *  blocks this process on every request — followed by `execFile` of the yaco
 *  binary and an envelope parse. Both halves are real production code, imported
 *  here rather than reconstructed.
 *
 *  The statistic is the **worst** gap within one invocation, p95 across
 *  invocations. Pooling every gap and taking p95 of that pool is what an
 *  earlier version of this gate did, and it hides the very thing it measures:
 *  one 50 ms stall among four hundred ordinary 1 ms timer gaps does not reach
 *  the 95th percentile. A queued request waits for the worst gap, not the
 *  typical one.
 *
 *  Four fixtures, because a task graph is input-controlled in two dimensions.
 *  Size: this repository's graph, and ten times it. Topology: the directory
 *  store the CLI writes by default — the one this repository uses — and the
 *  single `.json` file a `yaco.toml` may point at. The condition is asserted
 *  on the directory store at both sizes, where it holds by 3-7x. It is not
 *  asserted on the single file at either size, for the reason measured and
 *  written out above that block.
 *
 *  When the repository's own `plan/tasks` is present it is the source of all
 *  four; a worktree checkout and CI do not carry it — `plan/` is a separate
 *  repository — so a generated tree of the same scale stands in. **Which one
 *  ran is in every test's name**, not only in a console line, because a run on
 *  the stand-in measures something smaller than production and must not be
 *  readable as one that measured the real store. `[repository data]` claims
 *  exactly one thing — the fixtures were seeded from whatever `plan/tasks` this
 *  checkout holds. It is not a claim that the graph is current or complete;
 *  `[synthetic data]` is the one that is decidable, and it is the one that was
 *  being reported silently.
 */

const CLI_BIN = fileURLToPath(new URL('../../../../../cli/bin/yaco.mjs', import.meta.url))
const CLI_BUNDLE = fileURLToPath(new URL('../../../../../cli/dist/yaco.mjs', import.meta.url))
const REPO_TASKS = fileURLToPath(new URL('../../../../../plan/tasks', import.meta.url))

/** `npm test` in this package alone can run before the CLI is built; the repo's
 *  `scripts/verify.sh` builds it first. Skipping loudly beats a false red. */
const cliBuilt = existsSync(CLI_BIN) && existsSync(CLI_BUNDLE)

/** One bundle file's worth of tasks. Used only when the repository's own graph
 *  is not in this checkout. */
function syntheticFile(index: number): string {
  const graph: Record<string, unknown> = {}
  for (let t = 0; t < 8; t++) {
    graph[`f${index}-t${t}`] = {
      parent: null,
      depends: [],
      state: 'ready',
      workset: 'active',
      title: `Task ${index}/${t}`,
      description: 'd'.repeat(900),
      acceptCriteria: ['criterion one', 'criterion two', 'criterion three'],
      scope: ['cli/src/**', 'app/server/src/**'],
    }
  }
  return JSON.stringify(graph, null, 2) + '\n'
}

function sourceFiles(): { bodies: string[]; source: 'repository' | 'synthetic' } {
  if (existsSync(REPO_TASKS)) {
    const bodies = readdirSync(REPO_TASKS, { withFileTypes: true, recursive: true })
      .filter(e => e.isFile() && e.name === 'tasks.json')
      .map(e => readFileSync(join(e.parentPath, e.name), 'utf-8'))
    if (bodies.length > 0) return { bodies, source: 'repository' }
  }
  return { bodies: Array.from({ length: 60 }, (_, i) => syntheticFile(i)), source: 'synthetic' }
}

const roots: string[] = []

type Topology = 'directory' | 'single file'

/** A project root holding `factor` copies of the source graph, ids renamed per
 *  copy so there are no duplicates — spread over a directory of bundle files,
 *  or collapsed into one `tasks.json` a `yaco.toml` points at. */
function seedProject(
  bodies: string[],
  factor: number,
  topology: Topology,
): { root: string; tasks: number; files: number } {
  const root = mkdtempSync(join(tmpdir(), 'yaco-starvation-'))
  roots.push(root)
  const copies: Record<string, unknown>[] = []
  let n = 0
  for (let rep = 0; rep < factor; rep++) {
    for (const body of bodies) {
      const graph = JSON.parse(body) as Record<string, unknown>
      copies.push(Object.fromEntries(Object.entries(graph).map(([k, v]) => [`r${n}-${k}`, v])))
      n++
    }
  }
  const tasks = copies.reduce((sum, g) => sum + Object.keys(g).length, 0)

  if (topology === 'single file') {
    mkdirSync(join(root, 'plan'), { recursive: true })
    writeFileSync(join(root, 'yaco.toml'), '[paths]\ntasks = "tasks.json"\n')
    const merged = Object.assign({}, ...copies) as Record<string, unknown>
    writeFileSync(join(root, 'plan/tasks.json'), JSON.stringify(merged, null, 2) + '\n')
    return { root, tasks, files: 1 }
  }

  copies.forEach((graph, i) => {
    const dir = join(root, 'plan/tasks', `g${i % 12}`, `b${i}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify(graph, null, 2) + '\n')
  })
  return { root, tasks, files: copies.length }
}

/** The route as it was: the app's own child environment builder, then the
 *  spawned CLI, then the envelope parse. */
function subprocessRoute(cwd: string): Promise<void> {
  const env = buildChildProcessEnv()
  return new Promise((resolve, reject) => {
    execFile(
      CLI_BIN,
      ['task', 'list', '--workset', 'all', '--json'],
      { cwd, env, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const raw = (stdout || stderr).trim()
        if (!raw) return reject(err ?? new Error('no envelope'))
        const parsed = JSON.parse(raw) as { ok: boolean }
        return parsed.ok ? resolve() : reject(new Error(raw.slice(0, 200)))
      },
    )
  })
}

/** The route as it is. */
async function inProcessRoute(repoRoot: string): Promise<void> {
  const result = await readTaskList({ repoRoot, workset: 'all' })
  if (isErr(result)) throw new Error(`${result.code}: ${result.message}`)
}

/** The longest a self-rescheduling timer was kept waiting during one call —
 *  what a request already sitting in the queue experiences — plus the call's
 *  own wall time. The closing interval counts: a fully blocking route lets no
 *  beat fire at all, and counting only the beats that happened would score it
 *  zero. */
async function invoke(route: () => Promise<void>): Promise<{ worstGap: number; wall: number }> {
  let last = performance.now()
  let worstGap = 0
  let running = true
  const beat = (): void => {
    const now = performance.now()
    worstGap = Math.max(worstGap, now - last)
    last = now
    if (running) setTimeout(beat, 0)
  }
  setTimeout(beat, 0)
  await new Promise(r => setTimeout(r, 5))
  worstGap = 0
  last = performance.now()

  const started = performance.now()
  await route()
  const wall = performance.now() - started
  running = false
  return { worstGap: Math.max(worstGap, performance.now() - last), wall }
}

const quantile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
}

interface Measured { starvationP95: number; medianWall: number }

const summarize = (samples: { worstGap: number; wall: number }[]): Measured => ({
  starvationP95: quantile(samples.map(s => s.worstGap), 0.95),
  medianWall: quantile(samples.map(s => s.wall), 0.5),
})

/** Resolved at module load, not in `beforeAll`, so the source is available
 *  while the test names are being built. */
const { bodies, source } = sourceFiles()

/** Seed one fixture, measure both routes over it **interleaved**, and print the
 *  row the QA artifact's tables are made of.
 *
 *  Interleaved because the design says so, and for a reason this suite has
 *  already been bitten by: run every sample of one route and then every sample
 *  of the other, and each route's numbers belong to a different slice of the
 *  host's day. On a box running other workers that difference is larger than
 *  the effect being measured. Pairs alternate order too (AB, BA, AB…), so
 *  neither route is always the one running on a cache the other just warmed. */
async function compareRoutes(
  topology: Topology,
  factor: number,
  rounds: number,
  label: string,
): Promise<{ subprocess: Measured; inProcess: Measured; tasks: number }> {
  const { root, tasks, files } = seedProject(bodies, factor, topology)
  const routes = {
    subprocess: () => subprocessRoute(root),
    inProcess: () => inProcessRoute(root),
  }
  // Warm both: the first call of each pays module load and page cache.
  await routes.subprocess()
  await routes.inProcess()

  const samples = { subprocess: [] as { worstGap: number; wall: number }[], inProcess: [] as { worstGap: number; wall: number }[] }
  for (let i = 0; i < rounds; i++) {
    const order: (keyof typeof routes)[] =
      i % 2 === 0 ? ['subprocess', 'inProcess'] : ['inProcess', 'subprocess']
    for (const which of order) samples[which].push(await invoke(routes[which]))
  }

  const subprocess = summarize(samples.subprocess)
  const inProcess = summarize(samples.inProcess)
  // eslint-disable-next-line no-console
  console.log(
    `[read-cutover] ${label} — ${files} file(s), ${tasks} tasks (${source} source), ${rounds} interleaved pairs\n` +
      `  before  subprocess  starvation p95=${subprocess.starvationP95.toFixed(2)}ms  median wall=${subprocess.medianWall.toFixed(1)}ms\n` +
      `  after   in process  starvation p95=${inProcess.starvationP95.toFixed(2)}ms  median wall=${inProcess.medianWall.toFixed(1)}ms`,
  )
  return { subprocess, inProcess, tasks }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const sizeName = (factor: number): string => (factor === 1 ? 'repository-sized' : 'ten-times')

describe.skipIf(!cliBuilt)('GET /:project — in process vs the complete subprocess route', () => {
  for (const [factor, rounds] of [
    [1, 10],
    [10, 4],
  ] as const) {
    const label = `a ${sizeName(factor)} directory store`
    it(`starves a queued callback no longer than the subprocess route on ${label} [${source} data]`, async () => {
      const { subprocess, inProcess, tasks } = await compareRoutes('directory', factor, rounds, label)

      // The design's condition, unqualified.
      expect(inProcess.starvationP95).toBeLessThanOrEqual(subprocess.starvationP95)
      expect(inProcess.medianWall).toBeLessThan(subprocess.medianWall)
      // Anti-vacuity: a route that did nothing would win both.
      expect(tasks).toBeGreaterThan(100)
      expect(subprocess.starvationP95).toBeGreaterThan(0)
    })
  }

  /** The topology where the design's condition is NOT met — at either size —
   *  recorded rather than asserted.
   *
   *  A single `tasks.json` is one `JSON.parse` of the whole graph, and no
   *  chunking divides it. The subprocess route's parent parses the same graph
   *  too, but from the CLI's *compact* envelope rather than the pretty-printed
   *  file, so it does strictly less work. The two land within noise of each
   *  other.
   *
   *  Nothing about the stall is asserted, and that is deliberate. Two measured
   *  facts, both in `plan/all/starvation-single-file-limit/qa-single-file-limit.md`:
   *
   *  **1. On this topology the in-process stall is not an implementation
   *  property.** Share of each route's own wall time spent inside its single
   *  worst unyielding chunk, median of 8 invocations, two runs:
   *
   *    repository-sized directory     subprocess  9-10%    in process 18-22%
   *    repository-sized single file   subprocess 12%       in process 58-66%
   *    ten-times directory            subprocess  8-9%     in process  8-9%
   *    ten-times single file          subprocess 10%       in process 46-48%
   *
   *  The subprocess route's worst chunk is `spawnSync('ssh-add')` plus one
   *  compact-envelope parse — 15-17 ms at repository size on *either* topology,
   *  because it does not depend on how the store is laid out. The in-process
   *  route's worst chunk *is* the parse of the store, and one file is one
   *  `JSON.parse` that nothing divides. So the comparison here reduces to
   *  whether one parse of a pretty-printed file exceeds `ssh-add` plus one
   *  parse of the compact envelope of the same data — a question about the
   *  input's size against a constant in the route being retired, not about
   *  whether this route yields. It already yields everything it can: the
   *  remaining 34-42% is the asynchronous read.
   *
   *  **2. The gap is in the tail, not the typical case.** With 10 and 4 rounds
   *  `quantile(…, 0.95)` selects the maximum sample. At repository size on one
   *  file the in-process route's *typical* worst chunk is the smaller of the two
   *  (11.7-12.5 ms against 15.7-16.6 ms median); its maximum is the larger
   *  (20.5-39.9 against 17.4-24.5 ms). The extra is a GC tail on a 0.84 MB
   *  parse, which the subprocess route pays inside its child. **That tail is
   *  real starvation** — GC in this process blocks this event loop — so what
   *  fails here is a tail on work item 1 says the implementation cannot divide,
   *  not a measurement artefact. It is the same limit, seen in the statistic
   *  that is most sensitive to it.
   *  **The repository-sized case has joined the ten-times one.** It met the
   *  condition by 3-7x when the graph was smaller; at 505 tasks it does not,
   *  and the in-process side is the larger one in 7 of 7 runs. That is a limit
   *  to state, not a threshold to loosen.
   *
   *  What is asserted is what the numbers do separate — the route is several
   *  times faster in wall time, 8-10x at repository size — and the stall is
   *  printed by `compareRoutes` so the parity is on the record rather than
   *  implied.
   *
   *  **What this costs, stated rather than waved at.** Blocking added *after*
   *  the read — anywhere in the caller — still turns the two directory fixtures
   *  red, and `cli/test/integration/task/read-starvation.integration.ts` still
   *  bounds the chunked reader against the synchronous walk it replaced without
   *  going through a spawn at all. What no longer has a gate is **synchronous
   *  per-file work inside the reader that scales with the tasks in one file** —
   *  a deep validation pass, a hash, an accidentally quadratic duplicate scan.
   *  A directory bundle holds ~7 tasks and the work is divided across the
   *  chunked read; one file runs it over all 505 in a single turn. Both
   *  directory fixtures and the CLI gate use directory trees only, so that class
   *  regresses green. Closing it needs a gate whose bound is not a millisecond
   *  threshold, and the ratio that would supply one is not stable across the two
   *  sizes (a bare parse of the file is 0.7x the route's stall at repository
   *  size and 1.8x at ten times). That is a gate to design, not a number to pick
   *  here. -> `plan/all/starvation-single-file-limit/qa-single-file-limit.md` §7.
   *
   *  Resolving the unmet condition is a design decision, written up in
   *  `plan/all/cli-node-sdk/qa-task-read-cutover.md` §2 and stated as a limit
   *  in `doc/main/cli/read-path.md`. */
  for (const [factor, rounds] of [
    [1, 10],
    [10, 4],
  ] as const) {
    const label = `a ${sizeName(factor)} single file store`
    it(`is faster on ${label}, where the stall is recorded rather than bounded [${source} data]`, async () => {
      const { subprocess, inProcess, tasks } = await compareRoutes('single file', factor, rounds, label)

      expect(inProcess.medianWall).toBeLessThan(subprocess.medianWall)
      // Anti-vacuity: a route that did nothing would win.
      expect(tasks).toBeGreaterThan(100)
      expect(subprocess.starvationP95).toBeGreaterThan(0)
    })
  }
})

describe.skipIf(cliBuilt)('starvation gate', () => {
  it('is skipped because cli/dist is not built — run `npm run build` in cli/', () => {
    expect(cliBuilt).toBe(false)
  })
})
