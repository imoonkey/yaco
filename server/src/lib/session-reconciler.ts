import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { loadProjects, type Project } from './projects'
import type { MultmuxSession } from './multmux'
import { fetchAllSessionsFromCli } from './multmux'
import { withFileLock, type ProgressEntry } from './scanner'
import { emitRefresh } from './notify'

const RECONCILE_INTERVAL = 60_000
/** Require N consecutive idle reconcile passes before firing notification. */
const IDLE_DEBOUNCE_COUNT = 2
/** Minimum time (ms) a session must be "processing" before an idle transition
 *  can trigger a notification. */
const MIN_PROCESSING_MS = 15_000

let reconcileTimer: ReturnType<typeof setTimeout> | null = null
let reconcileInFlight = false

const lastStatusBySession = new Map<string, 'starting' | 'processing' | 'idle'>()
const processingStartBySession = new Map<string, number>()
const idleStreakBySession = new Map<string, number>()

let lastSessionSnapshot = ''

function sessionKey(project: string, name: string): string {
  return `${project}:${name}`
}

export function startSessionReconciler(): void {
  // Run first reconcile immediately to populate cache, then schedule recurring.
  // Intentionally not awaited — runs in background.
  void reconcile()
}

export function stopSessionReconciler(): void {
  if (reconcileTimer) { clearTimeout(reconcileTimer); reconcileTimer = null }
}

function scheduleReconcile(): void {
  reconcileTimer = setTimeout(reconcile, RECONCILE_INTERVAL)
}

async function reconcile(): Promise<void> {
  if (reconcileInFlight) return
  reconcileInFlight = true

  try {
    const projects = await loadProjects()
    const allSessions = await fetchAllSessionsFromCli(projects)

    const sessionsByProject = new Map<string, MultmuxSession[]>()
    for (const session of allSessions) {
      const list = sessionsByProject.get(session.project) ?? []
      list.push(session)
      sessionsByProject.set(session.project, list)
    }

    for (const project of projects) {
      const projectSessions = sessionsByProject.get(project.name) ?? []
      await detectIdleTransitions(projectSessions, project)
    }

    // Emit refresh only if snapshot drifted (missed watcher events)
    const snapshot = JSON.stringify(allSessions)
    if (snapshot !== lastSessionSnapshot) {
      lastSessionSnapshot = snapshot
      emitRefresh('sessions')
    }

    pruneStaleKeys(projects)
  } catch (err) {
    console.error('[session-reconciler] reconcile failed:', err)
  } finally {
    reconcileInFlight = false
    scheduleReconcile()
  }
}

/** Detect processing→idle transitions and write session_idle progress entries. */
async function detectIdleTransitions(sessions: MultmuxSession[], project: Project): Promise<void> {
  const now = Date.now()
  const currentKeys = new Set<string>()

  for (const session of sessions) {
    const key = sessionKey(project.name, session.name)
    currentKeys.add(key)
    const prev = lastStatusBySession.get(key)
    lastStatusBySession.set(key, session.status)

    if (session.status === 'processing') {
      if (prev !== 'processing') {
        processingStartBySession.set(key, now)
      }
      idleStreakBySession.set(key, 0)
    } else {
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

  // Clean up keys for sessions that disappeared from this project
  for (const [key] of lastStatusBySession) {
    if (key.startsWith(`${project.name}:`) && !currentKeys.has(key)) {
      lastStatusBySession.delete(key)
      processingStartBySession.delete(key)
      idleStreakBySession.delete(key)
    }
  }
}

/** Remove tracking state for projects that no longer exist. */
function pruneStaleKeys(projects: Project[]): void {
  const projectNames = new Set(projects.map(p => p.name))
  for (const [key] of lastStatusBySession) {
    const projectName = key.split(':')[0]
    if (!projectNames.has(projectName)) {
      lastStatusBySession.delete(key)
      processingStartBySession.delete(key)
      idleStreakBySession.delete(key)
    }
  }
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
        type: 'session_idle',
        message: `${session.name} finished processing`,
        timestamp: new Date().toISOString(),
        status: 'active',
        sessionName: session.name,
      })
      await writeFile(progressFile, JSON.stringify(entries, null, 2), 'utf-8')
    })
  } catch (err) {
    console.error(`[session-reconciler] failed to write session_idle entry for ${session.name}:`, err)
  }
}
