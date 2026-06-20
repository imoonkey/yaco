/** Wires the pure `AttentionEngine` to real filesystem readers + the SSE push.
 *
 *  Keeps the engine class free of fs/CLI concerns (so its unit tests inject
 *  fakes) while this module owns the concrete readers:
 *   - sessions: `readAllSessionsFromStateFiles` — direct state-file HOT read
 *     (carries crashed/statusEnteredAt/exitCode/spawnedBy), NOT the CLI-spawning
 *     reconcile path.
 *   - tasks: per loaded project, `loadTaskStore(resolve(path, paths.tasks))`.
 *   - pins: `getPinnedSessions(project)`.
 *   - watermarks: `getUnreadWatermarks()` (defensively widened for T5 fields).
 */

import { resolve } from 'path'
import { readYacoProjectPaths } from '@yaco/cli/core/paths'
import { loadTaskStore } from '@yaco/cli/core/task'
import { clampNotice } from '@yaco/cli/core/agent'
import { loadProjects } from './projects'
import { readAllSessionsFromStateFiles } from './agent'
import { getPinnedSessions, getUnreadWatermarks, getDismissedActGenerations, removeDismissedActGenerations } from './ui-state'
import { broadcastAttention } from './notify'
import { readEvents, type YacoEvent } from './eventsLog'
import { AttentionEngine } from './attention-engine'
import { projectAttention, type AttentionSnapshot, type LiveSession, type LiveTask, type ProjectionInput, type Watermarks } from './attention-projection'

/** Normalize a task's bound agents to the canonical `string[]` (spec §8). */
function normalizeAgents(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((a): a is string => typeof a === 'string')
  if (typeof raw === 'string' && raw) return [raw]
  return []
}

async function readTasks(): Promise<LiveTask[]> {
  const projects = await loadProjects()
  const out: LiveTask[] = []
  for (const project of projects) {
    let tasksPath: string
    try {
      tasksPath = resolve(project.path, readYacoProjectPaths(project.path).tasks)
    } catch {
      continue
    }
    let store: ReturnType<typeof loadTaskStore>
    try {
      store = loadTaskStore(tasksPath)
    } catch {
      continue // missing/invalid task store — skip this project
    }
    for (const [id, task] of Object.entries(store.tasks)) {
      // Carry every task; the projector decides which states become ACT/REVIEW
      // (only `blocked` → ACT, `done` → REVIEW). `ready`/`running`/`cancelled`
      // are inert there but cheap to pass through.
      // Line-2 for a task row: its title (or id when untitled/blank), clamped.
      const titleNotice = typeof task.title === 'string' ? clampNotice(task.title) : ''
      out.push({
        project: project.name,
        id,
        state: task.state,
        stateEnteredAt: typeof task.stateEnteredAt === 'string' ? task.stateEnteredAt : undefined,
        agents: normalizeAgents(task.agents ?? (task as { agent?: unknown }).agent),
        notice: titleNotice || clampNotice(id),
      })
    }
  }
  return out
}

async function readSessions(): Promise<LiveSession[]> {
  const projects = await loadProjects()
  const rows = await readAllSessionsFromStateFiles(projects)
  return rows.map((r) => ({
    project: r.project,
    name: r.name,
    status: r.status,
    statusEnteredAt: r.statusEnteredAt,
    exitCode: r.exitCode,
    blockReason: r.blockReason,
    spawnedBy: r.spawnedBy,
    parentSession: r.parentSession,
    notice: r.notice,
  }))
}

async function readPins(): Promise<Record<string, Set<string>>> {
  const projects = await loadProjects()
  const out: Record<string, Set<string>> = {}
  for (const project of projects) {
    const pinned = await getPinnedSessions(project.name)
    if (pinned.length > 0) out[project.name] = new Set(pinned)
  }
  return out
}

async function readWatermarks(): Promise<Watermarks> {
  // getUnreadWatermarks returns { projectReadAt, sessionReadAt } today; T5 adds
  // taskReadAt + recentClearedAt. Spread through whatever is present so this
  // works before and after T5 without a change here.
  const wm = (await getUnreadWatermarks()) as Watermarks
  return wm
}

/** Gather the global projection inputs straight from the filesystem and project
 *  the CURRENT attention snapshot (spec §4.1). Reuses the SAME readers the engine
 *  is wired with (sessions/tasks/pins/watermarks) plus the durable per-project
 *  event log, then calls the pure `projectAttention` — no engine state, no SSE,
 *  no edge detection. The attention routes call this to serve a cold mount; the
 *  engine's `attention` SSE push keeps the client fresh afterward (spec §2.1). */
export async function currentAttentionSnapshot(): Promise<AttentionSnapshot> {
  const projects = await loadProjects()
  const [sessions, tasks, pins, watermarks, dismissedActGen] = await Promise.all([
    readSessions(),
    readTasks(),
    readPins(),
    readWatermarks(),
    getDismissedActGenerations(),
  ])

  // Read events for every known project plus any project surfaced by a live
  // session/task (a project may carry events before it is in the registry).
  const projectIds = new Set<string>(projects.map((p) => p.name))
  for (const s of sessions) projectIds.add(s.project)
  for (const t of tasks) projectIds.add(t.project)
  const events: YacoEvent[] = []
  for (const projectId of projectIds) {
    for (const e of await readEvents(projectId)) events.push(e)
  }

  // Cold-feed clock (the engine uses its injectable `deps.now()`). The stored
  // tombstones are passed as-is; the engine owns pruning the persisted store.
  const input: ProjectionInput = { events, sessions, tasks, pins, watermarks, nowMs: Date.now(), dismissedActGen }
  return projectAttention(input)
}

let engine: AttentionEngine | null = null

/** Construct + boot the singleton attention engine (called from startRuntime). */
export async function startAttentionEngine(): Promise<void> {
  if (engine) return
  engine = new AttentionEngine({
    readSessions,
    readTasks,
    readPins,
    readWatermarks,
    listProjects: async () => (await loadProjects()).map((p) => p.name),
    broadcast: broadcastAttention,
    readDismissedActGen: getDismissedActGenerations,
    removeDismissedActGen: removeDismissedActGenerations,
  })
  await engine.start()
}

export function stopAttentionEngine(): void {
  engine?.stop()
  engine = null
}

/** Triggers from the watchers / ui-state. No-op before the engine boots. */
export function notifyAttentionSessionChange(): void { engine?.notifySessionChange() }
export function notifyAttentionTaskChange(): void { engine?.notifyTaskChange() }
export function notifyAttentionPinChange(): void { engine?.notifyPinChange() }
/** Ack/clear advanced an unread watermark — recompute + push a fresh snapshot so
 *  the acting client (and every other) reflects the new read/clear state at once
 *  (F2). Called by the /ack and /clear routes after mergeUnreadWatermarks. */
export function notifyAttentionWatermarkChange(): void { engine?.notifyWatermarkChange() }
