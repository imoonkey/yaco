import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { loadProjects, type Project } from './projects'
import { querySessionsForProject, type MultmuxSession } from './multmux'
import { withFileLock, type ProgressEntry } from './scanner'
import { emitRefresh } from './notify'

const POLL_INTERVAL = 3_000
/** Require N consecutive idle polls before firing notification.
 *  Filters out brief status flickers from multmux's regex-based detection.
 *  At 3s poll interval, 2 polls = 6s worst-case latency. */
const IDLE_DEBOUNCE_COUNT = 2

let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollInFlight = false
let firstPollDone = false

const lastStatusBySession = new Map<string, 'processing' | 'idle'>()
const idleStreakBySession = new Map<string, number>()
const cachedSessionsByProject = new Map<string, MultmuxSession[]>()

function sessionKey(project: string, name: string): string {
  return `${project}:${name}`
}

export function startSessionPoller(): void {
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

export function hasCachedSessions(): boolean {
  return firstPollDone
}

function schedulePoll(): void {
  pollTimer = setTimeout(poll, POLL_INTERVAL)
}

let lastSessionSnapshot = ''

async function poll(): Promise<void> {
  if (pollInFlight) return
  pollInFlight = true

  try {
    const projects = await loadProjects()
    await Promise.all(projects.map(pollProject))
    firstPollDone = true

    // Emit refresh signal if session list changed
    const snapshot = JSON.stringify(getCachedMultmuxSessions())
    if (snapshot !== lastSessionSnapshot) {
      lastSessionSnapshot = snapshot
      emitRefresh('sessions')
    }
  } finally {
    pollInFlight = false
    schedulePoll()
  }
}

async function pollProject(project: Project): Promise<void> {
  let sessions: MultmuxSession[]
  try {
    sessions = await querySessionsForProject(project)
  } catch {
    return
  }

  const currentKeys = new Set<string>()

  for (const session of sessions) {
    const key = sessionKey(project.name, session.name)
    currentKeys.add(key)
    const prev = lastStatusBySession.get(key)
    lastStatusBySession.set(key, session.status)

    if (session.status === 'idle') {
      // Start counting idle streak only from a processing→idle edge
      const prevStreak = idleStreakBySession.get(key) ?? 0
      const streak = prev === 'processing' ? 1 : (prevStreak > 0 ? prevStreak + 1 : 0)
      idleStreakBySession.set(key, streak)

      // Fire notification exactly when streak reaches threshold
      if (streak === IDLE_DEBOUNCE_COUNT) {
        await writeSessionIdleEntry(project, session)
      }
    } else {
      idleStreakBySession.set(key, 0)
    }
  }

  for (const [key] of lastStatusBySession) {
    if (key.startsWith(`${project.name}:`) && !currentKeys.has(key)) {
      lastStatusBySession.delete(key)
      idleStreakBySession.delete(key)
    }
  }

  cachedSessionsByProject.set(project.name, sessions)
}

async function writeSessionIdleEntry(project: Project, session: MultmuxSession): Promise<void> {
  const todoDir = join(project.path, 'doc', 'todo')
  const progressFile = join(todoDir, 'progress.json')

  try {
    if (!existsSync(todoDir)) await mkdir(todoDir, { recursive: true })

    await withFileLock(progressFile, async () => {
      let entries: ProgressEntry[] = []
      if (existsSync(progressFile)) {
        const raw = await readFile(progressFile, 'utf-8')
        entries = JSON.parse(raw)
      }
      entries.push({
        id: `session-idle-${session.name}-${Date.now()}`,
        agent: session.provider as 'claude' | 'codex',
        type: 'session_idle' as ProgressEntry['type'],
        message: `${session.name} finished processing`,
        timestamp: new Date().toISOString(),
        status: 'active',
      })
      await writeFile(progressFile, JSON.stringify(entries, null, 2), 'utf-8')
    })
  } catch (err) {
    console.error(`[session-poller] failed to write session_idle entry for ${session.name}:`, err)
  }
}
