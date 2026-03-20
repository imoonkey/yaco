import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { loadProjects, type Project } from './projects'
import { querySessionsForProject, type MultmuxSession } from './multmux'
import { withFileLock, type ProgressEntry } from './scanner'
import { emitRefresh } from './notify'

const POLL_INTERVAL = 3_000
/** Require N consecutive idle polls before firing notification. */
const IDLE_DEBOUNCE_COUNT = 2
/** Minimum time (ms) a session must be "processing" before an idle transition
 *  can trigger a notification. Filters out user typing at the prompt, which
 *  multmux misclassifies as "processing" because the idle prompt regex
 *  no longer matches when there are characters after ❯. */
const MIN_PROCESSING_MS = 15_000

let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollInFlight = false
let firstPollDone = false

const lastStatusBySession = new Map<string, 'processing' | 'idle'>()
const processingStartBySession = new Map<string, number>()
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

  const now = Date.now()
  const currentKeys = new Set<string>()

  for (const session of sessions) {
    const key = sessionKey(project.name, session.name)
    currentKeys.add(key)
    const prev = lastStatusBySession.get(key)
    lastStatusBySession.set(key, session.status)

    // Claude sessions use the Stop hook for idle detection — skip polling-based detection.
    // Only Codex sessions need the polling heuristic.
    if (session.provider === 'claude') continue

    if (session.status === 'processing') {
      // Record when processing started (only on idle→processing edge)
      if (prev !== 'processing') {
        processingStartBySession.set(key, now)
      }
      idleStreakBySession.set(key, 0)
    } else {
      // idle — check if we should count toward notification
      const processingStart = processingStartBySession.get(key)
      const processingDuration = processingStart ? now - processingStart : 0
      const wasRealWork = processingDuration >= MIN_PROCESSING_MS

      const prevStreak = idleStreakBySession.get(key) ?? 0
      const streak = (prev === 'processing' && wasRealWork) ? 1
        : (prevStreak > 0 ? prevStreak + 1 : 0)
      idleStreakBySession.set(key, streak)

      if (streak === IDLE_DEBOUNCE_COUNT) {
        await writeSessionIdleEntry(project, session)
      }
    }
  }

  for (const [key] of lastStatusBySession) {
    if (key.startsWith(`${project.name}:`) && !currentKeys.has(key)) {
      lastStatusBySession.delete(key)
      processingStartBySession.delete(key)
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
