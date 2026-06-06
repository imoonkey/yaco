import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/** Tests for app/server's `yaco task <subcommand>` integration:
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
 */

let testProjectPath: string
let stubScript: string
let stubLog: string

vi.mock('../../lib/projects', () => ({
  loadProjects: () => Promise.resolve([{ name: 'test-project', path: testProjectPath }]),
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

beforeEach(() => {
  testProjectPath = mkdtempSync(join(tmpdir(), 'workflow-task-cli-test-'))
  mkdirSync(join(testProjectPath, 'plan/tasks'), { recursive: true })
  // Pre-seed tasks.json so GET paths work; mutations are stubbed so the
  // file is never actually written.
  writeFileSync(join(testProjectPath, 'plan/tasks/tasks.json'), '{}')

  const stubDir = mkdtempSync(join(tmpdir(), 'workflow-task-cli-stub-'))
  stubScript = join(stubDir, 'yaco')
  stubLog = join(stubDir, 'argv.log')
  writeFileSync(stubLog, '')
})

afterEach(() => {
  rmSync(testProjectPath, { recursive: true, force: true })
  if (stubScript) rmSync(join(stubScript, '..'), { recursive: true, force: true })
})

describe('GET /:project — CLI list boundary', () => {
  it('calls yaco task list --workset all and returns every workset', async () => {
    writeStub(
      {
        ok: true,
        data: {
          tasks: {
            A1: { title: 'archived', state: 'done', workset: 'archive' },
            B1: { title: 'backlog', state: 'ready', workset: 'backlog' },
            D1: { title: 'active', state: 'ready', workset: 'active' },
          },
        },
      },
      0,
      'stdout',
    )

    const res = await taskRoutes.request('/test-project', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      tasks: {
        A1: { title: 'archived', state: 'done', workset: 'archive' },
        B1: { title: 'backlog', state: 'ready', workset: 'backlog' },
        D1: { title: 'active', state: 'ready', workset: 'active' },
      },
    })
    expect(readFileSync(stubLog, 'utf-8').trim()).toBe('task list --workset all --json')
  })

  it('maps task list CLI failures to HTTP errors', async () => {
    writeStub({ ok: false, error: { code: 'INVALID', message: 'bad graph' } }, 1, 'stderr')
    const res = await taskRoutes.request('/test-project', { method: 'GET' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('bad graph')
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
