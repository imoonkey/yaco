import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const UI_STATE_DIR = join(homedir(), '.workflow', 'ui-state')

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
