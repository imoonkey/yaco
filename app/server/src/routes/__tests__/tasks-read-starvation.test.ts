import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
 *  store the CLI writes by default, and the single `.json` file a `yaco.toml`
 *  may point at. Three of the four meet the design's condition by 3-7x. The
 *  fourth — a multi-megabyte single file — does not, and has its own test
 *  below saying so rather than a relaxed version of this one.
 *
 *  When the repository's own `plan/tasks` is present it is the source of all
 *  four (a worktree checkout does not carry it — `plan/` is a separate
 *  repository — so a generated tree of the same scale stands in, and the run
 *  says which).
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

let bodies: string[]
let source: 'repository' | 'synthetic'

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

beforeAll(() => {
  ({ bodies, source } = sourceFiles())
})

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!cliBuilt)('GET /:project — in process vs the complete subprocess route', () => {
  for (const [topology, factor, rounds] of [
    ['directory', 1, 10],
    ['directory', 10, 4],
    ['single file', 1, 10],
  ] as const) {
    const label = `a ${factor === 1 ? 'repository-sized' : 'ten-times'} ${topology} store`
    it(`starves a queued callback no longer than the subprocess route on ${label}`, async () => {
      const { subprocess, inProcess, tasks } = await compareRoutes(topology, factor, rounds, label)

      // The design's condition, unqualified.
      expect(inProcess.starvationP95).toBeLessThanOrEqual(subprocess.starvationP95)
      expect(inProcess.medianWall).toBeLessThan(subprocess.medianWall)
      // Anti-vacuity: a route that did nothing would win both.
      expect(tasks).toBeGreaterThan(100)
      expect(subprocess.starvationP95).toBeGreaterThan(0)
    })
  }

  /** The one topology where the design's condition is NOT met, recorded rather
   *  than asserted.
   *
   *  A single multi-megabyte `tasks.json` is one `JSON.parse` of the whole
   *  graph — 28-65 ms for 7.5 MB — and no chunking divides it. The subprocess
   *  route's parent parses the same graph too, but from the CLI's *compact*
   *  envelope rather than the pretty-printed file, so it does strictly less
   *  work. The two land within noise of each other and either can win.
   *
   *  Nothing about the stall is asserted, and that is deliberate. On this
   *  topology a fully synchronous reader measures in the same range as both
   *  routes, so no threshold separates a regression from the noise: a bound
   *  here would pass without proving anything. What is asserted is what the
   *  numbers do separate — the route is several times faster — and the stall is
   *  printed above so the parity is on the record rather than implied.
   *
   *  Resolving the unmet condition is a design decision, written up in
   *  `plan/all/cli-node-sdk/qa-task-read-cutover.md` §2. */
  it('is faster on a ten-times single-file store, where the stalls are at parity', async () => {
    const label = 'a ten-times single file store'
    const { subprocess, inProcess } = await compareRoutes('single file', 10, 4, label)

    expect(inProcess.medianWall).toBeLessThan(subprocess.medianWall)
  })
})

describe.skipIf(cliBuilt)('starvation gate', () => {
  it('is skipped because cli/dist is not built — run `npm run build` in cli/', () => {
    expect(cliBuilt).toBe(false)
  })
})
