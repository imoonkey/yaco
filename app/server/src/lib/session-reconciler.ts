import { loadProjects, type Project } from './projects'
import type { MultmuxSession } from './multmux'
import { fetchAllSessionsFromCli } from './multmux'
import { dispatch as dispatchNotification, emitRefresh } from './notify'
import { appendEvent } from './eventsLog'

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
        await emitSessionIdle(project, session)
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

/** Emit a `session_idle` event to YACO events.jsonl and dispatch the corresponding
 *  notification. Replaces the legacy repo-local progress.json write — events.jsonl
 *  is the durable source, notifications-store is the projected inbox cache. */
async function emitSessionIdle(project: Project, session: MultmuxSession): Promise<void> {
  const ts = new Date().toISOString()
  const eventId = `session-idle-${session.name}-${Date.now()}`

  try {
    await appendEvent(project.name, {
      id: eventId,
      ts,
      kind: 'session_idle',
      sessionId: session.name,
      payload: {
        agent: session.provider,
        message: `${session.name} finished processing`,
      },
    })
  } catch (err) {
    console.error(`[session-reconciler] failed to append session_idle event for ${session.name}:`, err)
  }

  try {
    await dispatchNotification({
      id: `progress:${project.name}::${eventId}`,
      kind: 'progress',
      title: `[IDLE] ${project.name}`,
      message: `${session.name} finished processing`,
      timestamp: ts,
      project: project.name,
      workstream: '',
      progressType: 'session_idle',
      sessionName: session.name,
    })
  } catch (err) {
    console.error(`[session-reconciler] failed to dispatch session_idle notification for ${session.name}:`, err)
  }
}
