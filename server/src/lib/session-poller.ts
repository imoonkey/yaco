import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { Project } from './projects'
import { getSessionsForProject, type MultmuxSession } from './multmux'
import type { ProgressEntry } from './scanner'

const POLL_INTERVAL = 5_000

let projects: Project[] = []
let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollInFlight = false

const lastStatusBySession = new Map<string, 'processing' | 'idle'>()
const cachedSessionsByProject = new Map<string, MultmuxSession[]>()

function sessionKey(project: string, name: string): string {
  return `${project}:${name}`
}

export function startSessionPoller(projectList: Project[]): void {
  projects = projectList
  schedulePoll()
}

export function stopSessionPoller(): void {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
}

export function getCachedMultmuxSessions(projectName?: string): MultmuxSession[] {
  if (projectName) return cachedSessionsByProject.get(projectName) ?? []
  const all: MultmuxSession[] = []
  const seen = new Set<string>()
  for (const sessions of cachedSessionsByProject.values()) {
    for (const s of sessions) {
      if (seen.has(s.name)) continue
      seen.add(s.name)
      all.push(s)
    }
  }
  return all
}

/** Returns true if the cache has been populated at least once */
export function hasCachedSessions(): boolean {
  return cachedSessionsByProject.size > 0
}

function schedulePoll(): void {
  pollTimer = setTimeout(poll, POLL_INTERVAL)
}

async function poll(): Promise<void> {
  if (pollInFlight) { schedulePoll(); return }
  pollInFlight = true

  try {
    await Promise.all(projects.map(pollProject))
  } finally {
    pollInFlight = false
    schedulePoll()
  }
}

async function pollProject(project: Project): Promise<void> {
  let sessions: MultmuxSession[]
  try {
    sessions = await getSessionsForProject(project)
  } catch {
    // Failed — keep previous state, emit nothing
    return
  }

  // Note: getSessionsForProject returns [] on failure (catches internally).
  // We treat that as "success with 0 sessions" which is correct for the
  // transition logic — if multmux is genuinely not running, there are no sessions.

  const currentKeys = new Set<string>()

  for (const session of sessions) {
    const key = sessionKey(project.name, session.name)
    currentKeys.add(key)
    const prev = lastStatusBySession.get(key)
    lastStatusBySession.set(key, session.status)

    // Only notify on processing → idle transition (not first sight)
    if (prev === 'processing' && session.status === 'idle') {
      await writeSessionIdleEntry(project, session)
    }
  }

  // Remove disappeared sessions from this project
  for (const [key] of lastStatusBySession) {
    if (key.startsWith(`${project.name}:`) && !currentKeys.has(key)) {
      lastStatusBySession.delete(key)
    }
  }

  cachedSessionsByProject.set(project.name, sessions)
}

async function writeSessionIdleEntry(project: Project, session: MultmuxSession): Promise<void> {
  const todoDir = join(project.path, 'doc', 'todo')
  const progressFile = join(todoDir, 'progress.json')

  const entry: ProgressEntry = {
    id: `session-idle-${session.name}-${Date.now()}`,
    agent: session.provider as 'claude' | 'codex',
    type: 'session_idle' as ProgressEntry['type'],
    message: `${session.name} finished processing`,
    timestamp: new Date().toISOString(),
    status: 'active',
  }

  try {
    if (!existsSync(todoDir)) await mkdir(todoDir, { recursive: true })

    let entries: ProgressEntry[] = []
    if (existsSync(progressFile)) {
      const raw = await readFile(progressFile, 'utf-8')
      entries = JSON.parse(raw)
    }
    entries.push(entry)
    await writeFile(progressFile, JSON.stringify(entries, null, 2), 'utf-8')
  } catch (err) {
    console.error(`[session-poller] failed to write session_idle entry for ${session.name}:`, err)
  }
}
