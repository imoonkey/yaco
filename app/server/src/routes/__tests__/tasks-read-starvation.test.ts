import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { readTaskList } from '@yaco/cli/core/task'
import { isErr } from '@yaco/cli/core/result'
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
 *  Two fixtures, because a task graph is input-controlled: one the size of this
 *  repository's graph and one ten times larger. When the repository's own
 *  `plan/tasks` is present it is the source of both (a worktree checkout does
 *  not carry it — `plan/` is a separate repository — so a synthetic tree of the
 *  same shape stands in, and the run says which it used).
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

/** A project root whose task tree is `factor` copies of the source files, ids
 *  renamed per copy so the graph has no duplicates. */
function seedProject(bodies: string[], factor: number): { root: string; tasks: number } {
  const root = mkdtempSync(join(tmpdir(), 'yaco-starvation-'))
  roots.push(root)
  let n = 0
  let tasks = 0
  for (let rep = 0; rep < factor; rep++) {
    for (const body of bodies) {
      const dir = join(root, 'plan/tasks', `g${n % 12}`, `b${n}`)
      mkdirSync(dir, { recursive: true })
      const graph = JSON.parse(body) as Record<string, unknown>
      const renamed = Object.fromEntries(Object.entries(graph).map(([k, v]) => [`r${n}-${k}`, v]))
      writeFileSync(join(dir, 'tasks.json'), JSON.stringify(renamed, null, 2) + '\n')
      tasks += Object.keys(renamed).length
      n++
    }
  }
  return { root, tasks }
}

/** The route as it was: the app's own child environment builder, then the
 *  spawned CLI, then the envelope parse. */
function subprocessRoute(cwd: string): Promise<void> {
  const env = buildChildProcessEnv()
  return new Promise((resolve, reject) => {
    execFile(
      CLI_BIN,
      ['task', 'list', '--workset', 'all', '--json'],
      { cwd, env, maxBuffer: 64 * 1024 * 1024 },
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

async function measure(route: () => Promise<void>, rounds: number): Promise<Measured> {
  await route() // warm: the first call pays module load and page cache
  const gaps: number[] = []
  const walls: number[] = []
  for (let i = 0; i < rounds; i++) {
    const r = await invoke(route)
    gaps.push(r.worstGap)
    walls.push(r.wall)
  }
  return { starvationP95: quantile(gaps, 0.95), medianWall: quantile(walls, 0.5) }
}

let bodies: string[]
let source: 'repository' | 'synthetic'

beforeAll(() => {
  ({ bodies, source } = sourceFiles())
})

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!cliBuilt)('GET /:project — in process vs the complete subprocess route', () => {
  for (const [label, factor, rounds] of [
    ['the repository-sized graph', 1, 12],
    ['a ten-times graph', 10, 5],
  ] as const) {
    it(`starves a queued callback no longer than the subprocess route on ${label}`, async () => {
      const { root, tasks } = seedProject(bodies, factor)
      const subprocess = await measure(() => subprocessRoute(root), rounds)
      const inProcess = await measure(() => inProcessRoute(root), rounds)

      // Recorded: this is the harness behind the QA artifact's numbers.
      // eslint-disable-next-line no-console
      console.log(
        `[read-cutover] ${label} — ${bodies.length * factor} files, ${tasks} tasks (${source} source)\n` +
          `  before  subprocess  starvation p95=${subprocess.starvationP95.toFixed(2)}ms  median wall=${subprocess.medianWall.toFixed(1)}ms\n` +
          `  after   in process  starvation p95=${inProcess.starvationP95.toFixed(2)}ms  median wall=${inProcess.medianWall.toFixed(1)}ms`,
      )

      // The design's gate.
      expect(inProcess.starvationP95).toBeLessThanOrEqual(subprocess.starvationP95)
      // And the reason the cutover exists.
      expect(inProcess.medianWall).toBeLessThan(subprocess.medianWall)
      // Anti-vacuity: a route that did nothing would win both.
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
