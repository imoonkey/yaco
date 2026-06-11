import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { uiStateDir } from '@yaco/cli/core/paths'

const UI_STATE_DIR = uiStateDir()

let writeLock: Promise<void> = Promise.resolve()

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock
  let release!: () => void
  writeLock = new Promise<void>((r) => { release = r })
  try {
    await prev
    return await fn()
  } finally {
    release()
  }
}

function assertSafeName(name: string): void {
  if (
    !name ||
    name.startsWith('.') ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`ui-state: invalid file name "${name}"`)
  }
}

export async function readJson<T>(name: string, defaultValue: T): Promise<T> {
  assertSafeName(name)
  try {
    const raw = await readFile(join(UI_STATE_DIR, name), 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return defaultValue
  }
}

export async function writeJson<T>(name: string, data: T): Promise<void> {
  assertSafeName(name)
  await withLock(async () => {
    await mkdir(UI_STATE_DIR, { recursive: true })
    await writeFile(join(UI_STATE_DIR, name), JSON.stringify(data, null, 2), 'utf-8')
  })
}

const PINNED_FILE = 'pinned-sessions.json'
type PinnedMap = Record<string, string[]>

export async function getPinnedSessions(project: string): Promise<string[]> {
  const map = await readJson<unknown>(PINNED_FILE, {})
  if (!map || typeof map !== 'object' || Array.isArray(map)) return []
  const entry = (map as Record<string, unknown>)[project]
  if (!Array.isArray(entry) || !entry.every((s) => typeof s === 'string')) return []
  return entry as string[]
}

export async function setPinnedSessions(project: string, sessions: string[]): Promise<void> {
  await withLock(async () => {
    await mkdir(UI_STATE_DIR, { recursive: true })
    const file = join(UI_STATE_DIR, PINNED_FILE)
    let map: PinnedMap = {}
    try {
      const parsed = JSON.parse(await readFile(file, 'utf-8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (Array.isArray(v) && v.every((s) => typeof s === 'string')) {
            map[k] = v as string[]
          }
        }
      }
    } catch {
      map = {}
    }
    if (sessions.length === 0) {
      delete map[project]
    } else {
      map[project] = sessions
    }
    await writeFile(file, JSON.stringify(map, null, 2), 'utf-8')
  })
}

const WATERMARKS_FILE = 'unread-watermarks.json'

/** Monotonic ack/clear watermarks (spec §5.3). Every map is `key → server-time
 *  ms`; a watermark only ever advances (`max`), never goes backwards.
 *   - `projectReadAt`   — ack a whole project up to a server timestamp.
 *   - `sessionReadAt`   — ack a session key (`<proj>::<name>`) up to a ts.
 *   - `taskReadAt`      — ack a task key (`<proj>::<id>`) up to a ts.
 *   - `recentClearedAt` — clear a project's read/resolved/FYI history up to a ts. */
export type UnreadWatermarks = {
  projectReadAt: Record<string, number>
  sessionReadAt: Record<string, number>
  taskReadAt: Record<string, number>
  recentClearedAt: Record<string, number>
}

/** A partial set of watermark maps — what ack/clear/PUT hand to the max-merge. */
export type UnreadWatermarksPatch = Partial<UnreadWatermarks>

const WATERMARK_KEYS = ['projectReadAt', 'sessionReadAt', 'taskReadAt', 'recentClearedAt'] as const

export function validNumberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

function emptyWatermarks(): UnreadWatermarks {
  return { projectReadAt: {}, sessionReadAt: {}, taskReadAt: {}, recentClearedAt: {} }
}

/** Defensively widen whatever is on disk to the full shape. Files written before
 *  T5 carry only `projectReadAt`/`sessionReadAt`; the new maps default to `{}`. */
export async function getUnreadWatermarks(): Promise<UnreadWatermarks> {
  const raw = await readJson<unknown>(WATERMARKS_FILE, {})
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyWatermarks()
  const obj = raw as Record<string, unknown>
  return {
    projectReadAt: validNumberMap(obj.projectReadAt),
    sessionReadAt: validNumberMap(obj.sessionReadAt),
    taskReadAt: validNumberMap(obj.taskReadAt),
    recentClearedAt: validNumberMap(obj.recentClearedAt),
  }
}

/** Merge a watermark patch into the stored file MONOTONICALLY: for every key, the
 *  stored value becomes `max(existing, incoming)` and non-finite / lower incoming
 *  values are dropped. A watermark can never go backwards (spec §5.3, H8/H9), so
 *  a client PUTting an older value — or a clock-skewed ack — cannot lower it.
 *  Read-modify-write runs under the shared `writeJson` lock. Returns the merged
 *  watermarks so callers can stamp the persisted values back to the client. */
export async function mergeUnreadWatermarks(patch: UnreadWatermarksPatch): Promise<UnreadWatermarks> {
  return withLock(async () => {
    await mkdir(UI_STATE_DIR, { recursive: true })
    const file = join(UI_STATE_DIR, WATERMARKS_FILE)
    let current = emptyWatermarks()
    try {
      const parsed = JSON.parse(await readFile(file, 'utf-8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>
        current = {
          projectReadAt: validNumberMap(obj.projectReadAt),
          sessionReadAt: validNumberMap(obj.sessionReadAt),
          taskReadAt: validNumberMap(obj.taskReadAt),
          recentClearedAt: validNumberMap(obj.recentClearedAt),
        }
      }
    } catch {
      current = emptyWatermarks()
    }

    for (const mapKey of WATERMARK_KEYS) {
      const incoming = validNumberMap(patch[mapKey])
      const target = current[mapKey]
      for (const [k, v] of Object.entries(incoming)) {
        const existing = target[k]
        if (existing === undefined || v > existing) target[k] = v
      }
    }

    await writeFile(file, JSON.stringify(current, null, 2), 'utf-8')
    return current
  })
}
