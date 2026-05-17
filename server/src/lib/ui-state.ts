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

export async function readJson<T>(name: string, defaultValue: T): Promise<T> {
  try {
    const raw = await readFile(join(UI_STATE_DIR, name), 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return defaultValue
  }
}

export async function writeJson<T>(name: string, data: T): Promise<void> {
  await withLock(async () => {
    await mkdir(UI_STATE_DIR, { recursive: true })
    await writeFile(join(UI_STATE_DIR, name), JSON.stringify(data, null, 2), 'utf-8')
  })
}

const PINNED_FILE = 'pinned-sessions.json'
type PinnedMap = Record<string, string[]>

export async function getPinnedSessions(project: string): Promise<string[]> {
  const map = await readJson<PinnedMap>(PINNED_FILE, {})
  return map[project] ?? []
}

export async function setPinnedSessions(project: string, sessions: string[]): Promise<void> {
  await withLock(async () => {
    await mkdir(UI_STATE_DIR, { recursive: true })
    const file = join(UI_STATE_DIR, PINNED_FILE)
    let map: PinnedMap = {}
    try {
      map = JSON.parse(await readFile(file, 'utf-8')) as PinnedMap
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
