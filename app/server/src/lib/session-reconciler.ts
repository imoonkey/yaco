import { loadProjects } from './projects'
import { fetchAllSessionsFromCli } from './agent'
import { emitRefresh } from './notify'

const RECONCILE_INTERVAL = 60_000

let reconcileTimer: ReturnType<typeof setTimeout> | null = null
let reconcileInFlight = false
let lastSessionSnapshot = ''

export function startSessionReconciler(): void {
  // Run first reconcile immediately to populate the snapshot cache, then schedule
  // recurring. Intentionally not awaited — runs in background.
  void reconcile()
}

export function stopSessionReconciler(): void {
  if (reconcileTimer) { clearTimeout(reconcileTimer); reconcileTimer = null }
}

function scheduleReconcile(): void {
  reconcileTimer = setTimeout(reconcile, RECONCILE_INTERVAL)
}

/** 60s liveness GC + safety net. `fetchAllSessionsFromCli` is the app's single
 *  mutation point: `--reconcile` GCs confirmed-dead tombstones (crash-safe — a
 *  `crashed` tombstone is preserved), cleans orphan breadcrumbs, and persists
 *  stale-status corrections. We then emit a `sessions` refresh iff the snapshot
 *  drifted, covering any missed fs-watch event.
 *
 *  Attention EDGE production (idle/blocked/crashed/task) lives in the
 *  change-driven `attention-engine` (which subscribes to its own 60s safety
 *  tick); this loop no longer detects transitions or dispatches notifications. */
async function reconcile(): Promise<void> {
  if (reconcileInFlight) return
  reconcileInFlight = true

  try {
    const projects = await loadProjects()
    const allSessions = await fetchAllSessionsFromCli(projects)

    // Emit refresh only if the snapshot drifted (covers missed watcher events).
    const snapshot = JSON.stringify(allSessions)
    if (snapshot !== lastSessionSnapshot) {
      lastSessionSnapshot = snapshot
      emitRefresh('sessions')
    }
  } catch (err) {
    console.error('[session-reconciler] reconcile failed:', err)
  } finally {
    reconcileInFlight = false
    scheduleReconcile()
  }
}
