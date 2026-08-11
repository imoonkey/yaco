import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/** Tests for app/server's task routes:
 *
 *  Mutations still spawn `yaco task <subcommand> --json`, so for those:
 *    - the `{ok,data}/{ok,error}` envelope is strict-parsed on success
 *    - CliError codes map to the right HTTP status (USAGE/INVALID→400,
 *      NOT_FOUND→404, CONFLICT/LOCK→409, INTERNAL/IO→500)
 *    - data.warnings / data.task survive the round-trip
 *
 *  We don't mock `child_process.execFile`. Instead, we point YACO_PATH at
 *  a per-test shell stub that prints scripted envelopes and exits with
 *  the matching CLI exit code. This exercises the full spawn → stdout/
 *  stderr → envelope-parse → HTTP-map pipeline, which is exactly the
 *  surface that regressed during the multmux→yaco cutover.
 *
 *  The GET reads in process instead. Its cases therefore run against a real
 *  task tree on disk and assert the same response bodies and statuses the
 *  scripted envelopes used to produce — plus the thing that is now true and
 *  was not before: the stub is never invoked at all.
 */

let testProjectPath: string
let otherProjectPath: string
let stubScript: string
let stubLog: string

vi.mock('../../lib/projects', () => ({
  loadProjects: () => Promise.resolve([
    { name: 'test-project', path: testProjectPath },
    { name: 'other-project', path: otherProjectPath },
  ]),
}))

vi.mock('../../lib/notify', () => ({
  emitRefresh: vi.fn(),
}))

vi.mock('../../lib/worktree', () => ({
  getWorktreeStatuses: () => Promise.resolve(new Map()),
}))

vi.mock('../../lib/constants', async (orig) => {
  const actual = await orig<typeof import('../../lib/constants')>()
  return {
    ...actual,
    get YACO_PATH() { return stubScript },
    YACO_TASK_COMMAND_TIMEOUT_MS: 5_000,
  }
})

vi.mock('../../lib/ssh-auth', () => ({
  buildChildProcessEnv: () => ({ PATH: process.env.PATH ?? '' }),
}))

const { taskRoutes } = await import('../tasks')

/** Write a bash stub at `path` that emits the scripted envelope verbatim
 *  to stdout (success) or stderr (failure), exits with the requested code,
 *  and appends the raw argv to `stubLog` so tests can assert what was sent. */
function writeStub(envelope: object, exitCode: number, channel: 'stdout' | 'stderr'): void {
  const body = JSON.stringify(envelope).replace(/'/g, `'\\''`)
  const redirect = channel === 'stdout' ? '' : '1>&2'
  const script = `#!/usr/bin/env bash
echo "$@" >> '${stubLog}'
printf '%s\\n' '${body}' ${redirect}
exit ${exitCode}
`
  writeFileSync(stubScript, script)
  chmodSync(stubScript, 0o755)
}

/** Write a task graph into a project's default tasks tree. */
function seedTasks(projectPath: string, graph: Record<string, unknown>, sub = ''): void {
  const dir = join(projectPath, 'plan/tasks', sub)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify(graph, null, 2) + '\n')
}

beforeEach(() => {
  testProjectPath = mkdtempSync(join(tmpdir(), 'workflow-task-cli-test-'))
  otherProjectPath = mkdtempSync(join(tmpdir(), 'workflow-task-cli-other-'))
  // Pre-seed tasks.json so GET paths work; mutations are stubbed so the
  // file is never actually written.
  seedTasks(testProjectPath, {})
  seedTasks(otherProjectPath, {})

  const stubDir = mkdtempSync(join(tmpdir(), 'workflow-task-cli-stub-'))
  stubScript = join(stubDir, 'yaco')
  stubLog = join(stubDir, 'argv.log')
  writeFileSync(stubLog, '')
})

afterEach(() => {
  rmSync(testProjectPath, { recursive: true, force: true })
  rmSync(otherProjectPath, { recursive: true, force: true })
  if (stubScript) rmSync(join(stubScript, '..'), { recursive: true, force: true })
})

/** Everything the stub was asked to run. Empty means nothing spawned. */
const spawnedArgv = (): string => readFileSync(stubLog, 'utf-8').trim()

describe('GET /:project — in-process task list', () => {
  it('returns every workset, in the body the spawned list produced', async () => {
    // Byte-for-byte the fixture the subprocess route was asserted against.
    seedTasks(testProjectPath, {
      A1: { title: 'archived', state: 'done', workset: 'archive' },
      B1: { title: 'backlog', state: 'ready', workset: 'backlog' },
      D1: { title: 'active', state: 'ready', workset: 'active' },
    })

    const res = await taskRoutes.request('/test-project', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      tasks: {
        A1: { title: 'archived', state: 'done', workset: 'archive' },
        B1: { title: 'backlog', state: 'ready', workset: 'backlog' },
        D1: { title: 'active', state: 'ready', workset: 'active' },
      },
    })
  })

  it('spawns nothing at all', async () => {
    seedTasks(testProjectPath, { D1: { title: 'active', state: 'ready', workset: 'active' } })
    const res = await taskRoutes.request('/test-project', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(spawnedArgv()).toBe('')
  })

  it('defaults a task with no workset to active, as the CLI loader does', async () => {
    seedTasks(testProjectPath, { L1: { title: 'legacy', state: 'ready', agent: 'claude' } })
    const res = await taskRoutes.request('/test-project', { method: 'GET' })
    expect(await res.json()).toEqual({
      tasks: { L1: { title: 'legacy', state: 'ready', agents: ['claude'], workset: 'active' } },
    })
  })

  it('reads nested bundle files, not just the root tasks.json', async () => {
    seedTasks(testProjectPath, { root: { title: 'r', state: 'ready', workset: 'active' } })
    seedTasks(testProjectPath, { nested: { title: 'n', state: 'ready', workset: 'active' } }, 'cli')
    const body = await (await taskRoutes.request('/test-project', { method: 'GET' })).json()
    expect(Object.keys(body.tasks).sort()).toEqual(['nested', 'root'])
  })

  it('maps a task-graph failure to the same HTTP error the envelope did', async () => {
    writeFileSync(join(testProjectPath, 'plan/tasks/tasks.json'), '{ not json')
    const res = await taskRoutes.request('/test-project', { method: 'GET' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/is not valid JSON/)
    expect(spawnedArgv()).toBe('')
  })

  it('maps a rejected yaco.toml path to 500, as the ENV envelope did', async () => {
    writeFileSync(join(testProjectPath, 'yaco.toml'), '[paths]\ntasks = "/etc"\n')
    const res = await taskRoutes.request('/test-project', { method: 'GET' })
    expect(res.status).toBe(500)
  })

  it('keeps concurrent reads of two repo roots isolated', async () => {
    seedTasks(testProjectPath, { ONE: { title: 'one', state: 'ready', workset: 'active' } })
    seedTasks(otherProjectPath, { TWO: { title: 'two', state: 'ready', workset: 'active' } })

    // Interleaved, and repeated: a reader that leaned on cwd or on a shared
    // module-level root would cross exactly here.
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        taskRoutes.request(i % 2 === 0 ? '/test-project' : '/other-project', { method: 'GET' }),
      ),
    )
    const bodies = await Promise.all(responses.map(r => r.json()))
    for (const [i, body] of bodies.entries()) {
      expect(Object.keys(body.tasks)).toEqual([i % 2 === 0 ? 'ONE' : 'TWO'])
    }
  })

  it("does not let one project's broken graph fail another's concurrent read", async () => {
    writeFileSync(join(testProjectPath, 'plan/tasks/tasks.json'), '{ not json')
    seedTasks(otherProjectPath, { TWO: { title: 'two', state: 'ready', workset: 'active' } })

    const [broken, fine] = await Promise.all([
      taskRoutes.request('/test-project', { method: 'GET' }),
      taskRoutes.request('/other-project', { method: 'GET' }),
    ])
    expect(broken.status).toBe(400)
    expect(fine.status).toBe(200)
    expect(Object.keys((await fine.json()).tasks)).toEqual(['TWO'])
  })
})

describe('PUT /:project/:taskId — envelope success', () => {
  it('returns the task body and 200 on {ok:true,data:{task}}', async () => {
    writeStub(
      {
        ok: true,
        data: {
          id: 'T1',
          action: 'create',
          task: { title: 'Stub', state: 'ready' },
          warnings: [],
          tasksFile: '/stub/path',
        },
      },
      0,
      'stdout',
    )

    const res = await taskRoutes.request('/test-project/T1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Stub', description: 'd', acceptCriteria: 'yes' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ title: 'Stub', state: 'ready' })
  })
})

describe('PATCH /:project/:taskId — error → HTTP mapping', () => {
  it('USAGE → 400', async () => {
    writeStub({ ok: false, error: { code: 'USAGE', message: 'bad flag' } }, 2, 'stderr')
    const res = await taskRoutes.request('/test-project/T1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'ready' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('bad flag')
  })

  it('INVALID → 400 (validation), preserves error.details', async () => {
    writeStub(
      {
        ok: false,
        error: { code: 'INVALID', message: 'leaf needs acceptCriteria', details: { id: 'T1' } },
      },
      1,
      'stderr',
    )
    const res = await taskRoutes.request('/test-project/T1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'ready' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('leaf needs acceptCriteria')
    expect(body.details).toEqual({ id: 'T1' })
  })

  it('NOT_FOUND → 404', async () => {
    writeStub({ ok: false, error: { code: 'NOT_FOUND', message: "task 'T9' not found" } }, 1, 'stderr')
    const res = await taskRoutes.request('/test-project/T9', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'done' }),
    })
    expect(res.status).toBe(404)
  })

  it('CONFLICT → 409', async () => {
    writeStub({ ok: false, error: { code: 'CONFLICT', message: 'cannot remove running' } }, 1, 'stderr')
    const res = await taskRoutes.request('/test-project/T1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(409)
  })

  it('LOCK → 409 (lock contention surfaces as a structured envelope, not 500 timeout)', async () => {
    writeStub(
      {
        ok: false,
        error: {
          code: 'LOCK',
          message: 'failed to acquire /tmp/tasks.json.lock.d within 10000ms',
          details: { lockPath: '/tmp/tasks.json.lock.d' },
        },
      },
      4,
      'stderr',
    )
    const res = await taskRoutes.request('/test-project/T1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/failed to acquire/)
  })

  it('INTERNAL → 500', async () => {
    writeStub({ ok: false, error: { code: 'INTERNAL', message: 'kaboom' } }, 5, 'stderr')
    const res = await taskRoutes.request('/test-project/T1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(500)
  })
})

describe('DELETE + archive — envelope round-trip', () => {
  it('DELETE returns {deleted:true} on {ok:true}', async () => {
    writeStub({ ok: true, data: { id: 'T1', removed: true, tasksFile: '/stub' } }, 0, 'stdout')
    const res = await taskRoutes.request('/test-project/T1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true })
  })

  it('POST .../archive returns {archived:true} on success', async () => {
    writeStub({ ok: true, data: { archivedCount: 1, workset: 'archive' } }, 0, 'stdout')
    const res = await taskRoutes.request('/test-project/T1/archive', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ archived: true })
  })

  it('DELETE surfaces NOT_FOUND as 404', async () => {
    writeStub({ ok: false, error: { code: 'NOT_FOUND', message: 'gone' } }, 1, 'stderr')
    const res = await taskRoutes.request('/test-project/T1', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
