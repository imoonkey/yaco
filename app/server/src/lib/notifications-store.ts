import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { uiStateDir } from './yacoHome'
import type { ProgressType } from './scanner'

export interface NotificationItem {
  id: string
  kind: 'progress'
  title: string
  message: string
  project: string
  workstream: string
  progressType: ProgressType
  sessionName: string
  timestamp: number
  read: boolean
}

const MAX_NOTIFICATIONS = 50
const NOTIFICATIONS_FILE = join(uiStateDir(), 'notifications.json')

let mutex: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutex.then(fn, fn)
  mutex = next.catch(() => {})
  return next
}

async function readAll(): Promise<NotificationItem[]> {
  let raw: string
  try {
    raw = await readFile(NOTIFICATIONS_FILE, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`notifications-store: expected array at ${NOTIFICATIONS_FILE}, got ${typeof parsed}`)
  }
  return parsed as NotificationItem[]
}

async function writeAll(items: NotificationItem[]): Promise<void> {
  await mkdir(dirname(NOTIFICATIONS_FILE), { recursive: true })
  await writeFile(NOTIFICATIONS_FILE, JSON.stringify(items, null, 2), 'utf-8')
}

export async function list(): Promise<NotificationItem[]> {
  return withLock(() => readAll())
}

export async function append(
  item: Omit<NotificationItem, 'read' | 'timestamp'> & { timestamp?: number },
): Promise<NotificationItem> {
  return withLock(async () => {
    const items = await readAll()
    const existing = items.find(n => n.id === item.id)
    if (existing) return existing

    const persisted: NotificationItem = {
      id: item.id,
      kind: item.kind,
      title: item.title,
      message: item.message,
      project: item.project,
      workstream: item.workstream,
      progressType: item.progressType,
      sessionName: item.sessionName,
      timestamp: item.timestamp ?? Date.now(),
      read: false,
    }
    const next = [persisted, ...items].slice(0, MAX_NOTIFICATIONS)
    await writeAll(next)
    return persisted
  })
}

export async function markRead(id: string): Promise<boolean> {
  return withLock(async () => {
    const items = await readAll()
    const target = items.find(n => n.id === id)
    if (!target || target.read) return false
    target.read = true
    await writeAll(items)
    return true
  })
}

export async function markAllRead(): Promise<number> {
  return withLock(async () => {
    const items = await readAll()
    let count = 0
    for (const n of items) {
      if (!n.read) {
        n.read = true
        count++
      }
    }
    if (count > 0) await writeAll(items)
    return count
  })
}

export async function clearAll(): Promise<void> {
  return withLock(async () => {
    await writeAll([])
  })
}
