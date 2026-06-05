import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { appendEvent, readEvents, type YacoEvent } from '../src/lib/eventsLog'
import { projectEventsFile } from '@yaco/cli/core/paths'

const ORIGINAL_YACO_HOME = process.env.YACO_HOME

let fixtureRoot: string

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'yaco-events-test-'))
  process.env.YACO_HOME = fixtureRoot
})

afterEach(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
  if (ORIGINAL_YACO_HOME === undefined) delete process.env.YACO_HOME
  else process.env.YACO_HOME = ORIGINAL_YACO_HOME
})

const REQUIRED_FIELDS = ['id', 'ts', 'kind', 'projectId'] as const
const ALLOWED_FIELDS = new Set(['id', 'ts', 'kind', 'projectId', 'taskId', 'sessionId', 'payload'])

function assertSchemaShape(event: YacoEvent): void {
  for (const f of REQUIRED_FIELDS) {
    expect(event).toHaveProperty(f)
    expect(typeof event[f]).toBe('string')
    expect((event[f] as string).length).toBeGreaterThan(0)
  }
  expect(new Date(event.ts).toISOString()).toBe(event.ts)
  for (const key of Object.keys(event)) {
    expect(ALLOWED_FIELDS.has(key)).toBe(true)
  }
  if (event.taskId !== undefined) {
    expect(event.taskId).toMatch(/^[a-z0-9][a-z0-9-]*$/)
  }
}

describe('eventsLog.appendEvent', () => {
  it('writes a single NDJSON line under projectEventsFile()', async () => {
    const event = await appendEvent('workflow', { kind: 'session_idle', sessionId: 'w-foo' })
    assertSchemaShape(event)

    const file = projectEventsFile('workflow')
    expect(file).toBe(join(fixtureRoot, 'projects', 'workflow', 'events.jsonl'))
    expect(existsSync(file)).toBe(true)

    const raw = await readFile(file, 'utf-8')
    expect(raw.endsWith('\n')).toBe(true)
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed).toEqual(event)
    expect(parsed.projectId).toBe('workflow')
  })

  it('assigns id (uuid) and ts (ISO) when caller omits them', async () => {
    const a = await appendEvent('workflow', { kind: 'dispatched' })
    const b = await appendEvent('workflow', { kind: 'dispatched' })
    expect(a.id).not.toBe(b.id)
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(Date.parse(a.ts)).not.toBeNaN()
  })

  it('preserves caller-supplied id/ts/payload/taskId/sessionId', async () => {
    const event = await appendEvent('workflow', {
      id: 'evt_fixed',
      ts: '2026-05-27T00:00:00.000Z',
      kind: 'human_review_requested',
      taskId: 'yc-events-jsonl',
      sessionId: 'w-yc-events-jsonl',
      payload: { reason: 'requireHumanReview' },
    })
    expect(event.id).toBe('evt_fixed')
    expect(event.ts).toBe('2026-05-27T00:00:00.000Z')
    expect(event.taskId).toBe('yc-events-jsonl')
    expect(event.sessionId).toBe('w-yc-events-jsonl')
    expect(event.payload).toEqual({ reason: 'requireHumanReview' })
  })

  it('appends without truncating prior lines', async () => {
    await appendEvent('workflow', { kind: 'dispatched', taskId: 'a' })
    await appendEvent('workflow', { kind: 'session_idle', sessionId: 'w-a' })
    await appendEvent('workflow', { kind: 'verified', taskId: 'a' })
    const raw = await readFile(projectEventsFile('workflow'), 'utf-8')
    expect(raw.split('\n').filter(Boolean)).toHaveLength(3)
  })

  it('rejects taskId that violates the schema slug pattern', async () => {
    await expect(
      appendEvent('workflow', { kind: 'dispatched', taskId: 'NotASlug' }),
    ).rejects.toThrow(/taskId/)
  })

  it('rejects missing kind', async () => {
    await expect(
      appendEvent('workflow', { kind: '' as string }),
    ).rejects.toThrow(/kind/)
  })

  it('stamps projectId from the first arg and rejects callers that try to pass it in input', async () => {
    const event = await appendEvent('workflow', { kind: 'dispatched' })
    expect(event.projectId).toBe('workflow')

    // EventInput must omit `projectId` so the writer remains the single source of truth.
    // @ts-expect-error projectId is not assignable to EventInput
    await appendEvent('workflow', { kind: 'dispatched', projectId: 'someone-else' })

    // Runtime: writer-supplied projectId always wins regardless of what TS would have accepted.
    const all = await readEvents('workflow')
    for (const e of all) expect(e.projectId).toBe('workflow')
  })

  it('concurrent appends to the same file all persist as valid NDJSON', async () => {
    const N = 20
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendEvent('workflow', { kind: 'session_idle', sessionId: `w-${i}` }),
      ),
    )
    const raw = await readFile(projectEventsFile('workflow'), 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(N)
    for (const line of lines) {
      const parsed = JSON.parse(line)
      assertSchemaShape(parsed)
    }
  })
})

describe('eventsLog.readEvents', () => {
  it('returns [] when no events.jsonl exists for the project', async () => {
    expect(await readEvents('never-written')).toEqual([])
  })

  it('round-trips appended events in order', async () => {
    const a = await appendEvent('workflow', { kind: 'dispatched', taskId: 'a' })
    const b = await appendEvent('workflow', { kind: 'session_idle', sessionId: 'w-a' })
    const c = await appendEvent('workflow', { kind: 'verified', taskId: 'a' })
    const out = await readEvents('workflow')
    expect(out.map(e => e.id)).toEqual([a.id, b.id, c.id])
    for (const e of out) assertSchemaShape(e)
  })

  it('filters by kind when options.kinds is provided', async () => {
    await appendEvent('workflow', { kind: 'dispatched', taskId: 'a' })
    await appendEvent('workflow', { kind: 'session_idle', sessionId: 'w-a' })
    await appendEvent('workflow', { kind: 'verified', taskId: 'a' })
    const idle = await readEvents('workflow', { kinds: ['session_idle'] })
    expect(idle).toHaveLength(1)
    expect(idle[0].kind).toBe('session_idle')
  })

  it('limit returns the most recent N events', async () => {
    for (let i = 0; i < 5; i++) {
      await appendEvent('workflow', { kind: 'session_idle', sessionId: `w-${i}` })
    }
    const last2 = await readEvents('workflow', { limit: 2 })
    expect(last2).toHaveLength(2)
    expect(last2[1].sessionId).toBe('w-4')
  })

  it('skips malformed lines without throwing', async () => {
    const file = projectEventsFile('workflow')
    await mkdir(join(fixtureRoot, 'projects', 'workflow'), { recursive: true })
    await writeFile(file, [
      JSON.stringify({ id: 'a', ts: '2026-05-27T00:00:00.000Z', kind: 'dispatched', projectId: 'workflow' }),
      '{ not valid json',
      JSON.stringify({ id: 'c', ts: '2026-05-27T00:00:01.000Z', kind: 'verified', projectId: 'workflow' }),
      '',
    ].join('\n'), 'utf-8')
    const out = await readEvents('workflow')
    expect(out.map(e => e.id)).toEqual(['a', 'c'])
  })
})

describe('projectEventsFile path resolution under YACO_HOME', () => {
  it('writes events under the YACO_HOME override, not under ~/.yaco', async () => {
    await appendEvent('demo', { kind: 'dispatched', taskId: 'foo' })
    const file = projectEventsFile('demo')
    expect(file.startsWith(fixtureRoot)).toBe(true)
    expect(file.endsWith(join('projects', 'demo', 'events.jsonl'))).toBe(true)
    expect(existsSync(file)).toBe(true)
  })

  it('creates the projects/<id>/ parent dir lazily on first write', async () => {
    expect(existsSync(join(fixtureRoot, 'projects'))).toBe(false)
    await appendEvent('workflow', { kind: 'session_idle', sessionId: 'w-foo' })
    expect(existsSync(join(fixtureRoot, 'projects', 'workflow'))).toBe(true)
  })
})
