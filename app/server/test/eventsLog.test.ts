import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { appendEvent, readEvents, type YacoEvent } from '../src/lib/eventsLog'
import { projectEventsFile } from 'yaco-cli/core/paths'

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
    await plant([
      JSON.stringify({ id: 'a', ts: '2026-05-27T00:00:00.000Z', kind: 'dispatched', projectId: 'workflow' }),
      '{ not valid json',
      JSON.stringify({ id: 'c', ts: '2026-05-27T00:00:01.000Z', kind: 'verified', projectId: 'workflow' }),
      '',
    ])
    const out = await readEvents('workflow')
    expect(out.map(e => e.id)).toEqual(['a', 'c'])
  })
})

/** Write `lines` verbatim as the `workflow` project's events.jsonl. Used to plant
 *  content `appendEvent` would never produce — a malformed line. */
async function plant(lines: string[]): Promise<string> {
  const file = projectEventsFile('workflow')
  await mkdir(join(fixtureRoot, 'projects', 'workflow'), { recursive: true })
  await writeFile(file, lines.join('\n'), 'utf-8')
  return file
}

const GOOD = (id: string) =>
  JSON.stringify({ id, ts: '2026-05-27T00:00:00.000Z', kind: 'dispatched', projectId: 'workflow' })

describe('eventsLog.readEvents — malformed-line warning', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('reports one single-line warning naming the file and the 1-based line number', async () => {
    const file = await plant([GOOD('a'), '{ not valid json', GOOD('c'), ''])

    await readEvents('workflow')

    expect(warn).toHaveBeenCalledTimes(1)
    const [msg, ...extra] = warn.mock.calls[0]!
    expect(extra).toEqual([]) // no Error argument — an Error prints its stack
    expect(msg).toContain(file)
    expect(msg).toContain('line 2')
    expect(msg).not.toContain('\n') // one console line, not a multi-line stack
    expect(msg).not.toMatch(/SyntaxError|\bat \S+:\d+/)
  })

  it('warns once per malformed line, each carrying its own line number', async () => {
    await plant([GOOD('a'), 'nope', GOOD('c'), '}{', ''])

    await readEvents('workflow')

    expect(warn.mock.calls.map(c => c[0])).toEqual([
      expect.stringContaining('line 2'),
      expect.stringContaining('line 4'),
    ])
  })

  it('bounds the snippet so one corrupt line cannot dump a file into the log', async () => {
    const file = await plant([`{"payload":"${'A'.repeat(5000)}`, GOOD('c'), ''])

    await readEvents('workflow')

    const msg = warn.mock.calls[0]![0] as string
    expect(msg.length).toBeLessThan(file.length + 200)
    expect(msg).toContain('…') // truncation is visible, not silent
    expect(msg).toContain('AAA') // the head of the line is still shown
  })

  it('neutralizes control bytes so a corrupt line cannot emit an escape sequence', async () => {
    // The observed corruption: a terminal OSC background-color reply prepended to an event.
    await plant([`\u001b]11;rgb:0000/0000/0000\u0007${GOOD('a')}`, GOOD('c'), ''])

    const out = await readEvents('workflow')

    expect(out.map(e => e.id)).toEqual(['c'])
    expect(warn.mock.calls[0]!.join(' ')).not.toMatch(/[\u0000-\u001f\u007f]/)
  })

  it('stays silent when every line parses', async () => {
    await plant([GOOD('a'), GOOD('c'), ''])

    await readEvents('workflow')

    expect(warn).not.toHaveBeenCalled()
  })
})

describe('eventsLog.appendEvent — idempotent by id', () => {
  it('a re-appended caller-supplied id is a no-op (no duplicate generation)', async () => {
    const gen = 'session_crashed:workflow::w-foo:2026-06-11T00:00:00.000Z'
    const first = await appendEvent('workflow', { id: gen, kind: 'session_crashed', sessionId: 'w-foo' })
    const second = await appendEvent('workflow', { id: gen, kind: 'session_crashed', sessionId: 'w-foo' })
    expect(second).toEqual(first) // returns the existing event verbatim

    const all = await readEvents('workflow')
    expect(all.filter((e) => e.id === gen)).toHaveLength(1) // written exactly once
  })

  it('omitted ids stay unique — two appends produce two distinct events', async () => {
    await appendEvent('workflow', { kind: 'session_idle', sessionId: 'w-foo' })
    await appendEvent('workflow', { kind: 'session_idle', sessionId: 'w-foo' })
    const all = await readEvents('workflow')
    expect(all).toHaveLength(2)
    expect(all[0]!.id).not.toBe(all[1]!.id)
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
