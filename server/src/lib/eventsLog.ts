import { appendFile, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { projectEventsFile } from './yacoHome'

/** One line of `~/.yaco/projects/<id>/events.jsonl`. Immutable once appended.
 *  See projects/active/yaco-core/final/schemas/event.schema.json. */
export interface YacoEvent {
  id: string
  ts: string
  kind: string
  projectId: string
  taskId?: string
  sessionId?: string
  payload?: Record<string, unknown>
}

/** Input shape accepted by `appendEvent(projectId, input)`. `projectId` is
 *  supplied as the first arg (and stamped onto the event by the writer), so
 *  callers must NOT pass it inside `input`. `id` and `ts` are optional —
 *  the writer assigns a uuid v4 / ISO now when omitted. */
export type EventInput = Omit<YacoEvent, 'id' | 'ts' | 'projectId'> & Partial<Pick<YacoEvent, 'id' | 'ts'>>

const TASK_ID_RE = /^[a-z0-9][a-z0-9-]*$/

function validate(event: YacoEvent): void {
  if (!event.id) throw new Error('eventsLog: event.id is required')
  if (!event.ts) throw new Error('eventsLog: event.ts is required')
  if (!event.kind) throw new Error('eventsLog: event.kind is required')
  if (!event.projectId) throw new Error('eventsLog: event.projectId is required')
  if (event.taskId !== undefined && !TASK_ID_RE.test(event.taskId)) {
    throw new Error(`eventsLog: taskId "${event.taskId}" violates schema pattern ${TASK_ID_RE}`)
  }
}

/** Serialize one writer at a time per file so concurrent appends don't interleave bytes. */
const writeLocks = new Map<string, Promise<void>>()

async function withWriteLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(file) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((r) => { release = r })
  writeLocks.set(file, next)
  try {
    await prev
    return await fn()
  } finally {
    release()
    if (writeLocks.get(file) === next) writeLocks.delete(file)
  }
}

/** Append a single event line to `~/.yaco/projects/<projectId>/events.jsonl`.
 *  Assigns `id` (uuid v4) and `ts` (ISO) if the caller omitted them. */
export async function appendEvent(projectId: string, input: EventInput): Promise<YacoEvent> {
  const event: YacoEvent = {
    id: input.id ?? randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
    kind: input.kind,
    projectId,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
  }
  validate(event)

  const file = projectEventsFile(projectId)
  await withWriteLock(file, async () => {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, JSON.stringify(event) + '\n', 'utf-8')
  })
  return event
}

export interface ReadEventsOptions {
  /** Only return events whose `kind` is in this set. */
  kinds?: string[]
  /** Cap the number of events returned (most-recent N, after filtering). */
  limit?: number
}

/** Read events.jsonl for a project. Returns [] when the file does not exist.
 *  Malformed lines are skipped with a warning so a single bad write can't poison the stream. */
export async function readEvents(projectId: string, options: ReadEventsOptions = {}): Promise<YacoEvent[]> {
  const file = projectEventsFile(projectId)
  if (!existsSync(file)) return []

  let raw: string
  try {
    raw = await readFile(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const kindFilter = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null
  const out: YacoEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      console.warn(`[eventsLog] skipping malformed line in ${file}:`, err)
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const ev = parsed as YacoEvent
    if (!ev.id || !ev.ts || !ev.kind || !ev.projectId) continue
    if (kindFilter && !kindFilter.has(ev.kind)) continue
    out.push(ev)
  }

  if (options.limit !== undefined && options.limit >= 0 && out.length > options.limit) {
    return out.slice(out.length - options.limit)
  }
  return out
}
