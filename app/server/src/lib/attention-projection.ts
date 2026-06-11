/** Pure attention projector (Facet B authority — server-owned, spec §2.1, §4.1).
 *
 *  Takes the durable event log + the LIVE session/task snapshot + pins + ack
 *  watermarks and projects the actionable attention state: open ACT items,
 *  unacked REVIEW items, history rows, and the rollup badges. Every function
 *  here is pure — no fs, no clock, no SSE — so the engine drives it and the unit
 *  tests pin it against the spec §12 edge table.
 *
 *  HARD RULE (R4): never import from `app/ui/src`. The client consumes the
 *  `AttentionSnapshot` shape over SSE / `GET /attention/feed`; it does not share
 *  this code.
 */

import type { YacoEvent } from './eventsLog'

// ── Taxonomy (spec §3, §5.1) ────────────────────────────────────────────────

export type AttentionTier = 'critical' | 'action' | 'handoff' | 'fyi'

export type AttentionType =
  | 'session_crashed' // critical
  | 'session_blocked' // action
  | 'task_blocked' // action
  | 'session_idle' // handoff (owned) OR fyi (delegated)
  | 'task_done' // handoff

export type OwnerClass = 'OWNED' | 'DELEGATED'

/** ACT (critical/action) is derived live; REVIEW (handoff) is derived from the
 *  durable event vs the ack watermark; FYI lives only in history. */
export type AttentionGroup = 'needs-you' | 'ready' | 'recent'

export type AttentionSubject =
  | { kind: 'session'; project: string; sessionName: string }
  | { kind: 'task'; project: string; taskId: string; sessionNames: string[] }

/** One projected attention item. There is no stored open/resolved/read flag —
 *  open-ness (ACT) and unread-ness (REVIEW) are recomputed every projection. */
export interface AttentionItem {
  /** Stable status-edge generation id (spec §4): `<type>:<proj>::<key>:<enteredAt>`. */
  generation: string
  type: AttentionType
  tier: AttentionTier
  group: AttentionGroup
  subject: AttentionSubject
  title: string
  message: string
  /** Numeric server time (ms) the generation was minted — ISO `ts` parsed once. */
  tsMs: number
  /** Count folded into this item by dedup (bound sessions on a task item). 1 normally. */
  count: number
  /** True when this projection newly surfaces the item as a runtime edge the
   *  client should toast/OS-notify. Set by the ENGINE at projection time, not
   *  here — the pure projector always emits `false` and the engine overrides for
   *  genuinely-new live edges (boot-discovered/pre-acked stay false, spec §5.1). */
  interrupt: boolean
}

/** Highest-tier color for a badge over a scope (spec §9). `null` ⇒ no badge. */
export type BadgeColor = 'red' | 'orange' | 'yellow' | null

export interface AttentionBadge {
  count: number
  color: BadgeColor
}

/** The full projected attention state pushed over SSE and served by the feed.
 *  Minimal + documented so `useAttention` (T7) and `GET /attention/feed` (T5)
 *  consume it directly. */
export interface AttentionSnapshot {
  /** Open `critical` + `action` items (red/orange) — bell "Needs you" section. */
  needsYou: AttentionItem[]
  /** Unacked `handoff` items (amber) — bell "Ready" section. */
  ready: AttentionItem[]
  /** Read/resolved/FYI history rows, newest first — bell "Recent" section. */
  recent: AttentionItem[]
  /** Per-project rollup badge = open ACT + unacked REVIEW in that project. */
  badgesByProject: Record<string, AttentionBadge>
  /** Per-session rollup badge (subtree count + worst tier) for collapsed parents. */
  badgesBySession: Record<string, AttentionBadge>
  /** Global bell badge = total actionable across all projects. */
  global: AttentionBadge
}

// ── Pure inputs ─────────────────────────────────────────────────────────────

/** Live session snapshot the projector reads (subset of `AgentSession`). */
export interface LiveSession {
  project: string
  name: string
  status: 'starting' | 'idle' | 'processing' | 'blocked' | 'crashed'
  statusEnteredAt?: string
  exitCode?: number
  blockReason?: string
  spawnedBy?: 'user:web' | 'user:terminal' | 'agent'
  parentSession?: string
}

/** Live task snapshot the projector reads. */
export interface LiveTask {
  project: string
  id: string
  state: 'ready' | 'running' | 'done' | 'blocked' | 'cancelled'
  stateEnteredAt?: string
  /** Normalized bound session handles (spec §8 — matching is over `agents`). */
  agents: string[]
}

/** Ack/clear watermarks. `taskReadAt` + `recentClearedAt` land in T5; read them
 *  defensively here (`?? {}`) so the projector works before T5. */
export interface Watermarks {
  projectReadAt: Record<string, number>
  sessionReadAt: Record<string, number>
  taskReadAt?: Record<string, number>
  recentClearedAt?: Record<string, number>
}

export interface ProjectionInput {
  events: YacoEvent[]
  sessions: LiveSession[]
  tasks: LiveTask[]
  /** project → set of pinned session names. */
  pins: Record<string, Set<string>>
  watermarks: Watermarks
}

// ── Generation ids (spec §4, §5.1) ──────────────────────────────────────────

const SESSION_KINDS = new Set(['session_idle', 'session_blocked', 'session_crashed'])
const TASK_KINDS = new Set(['task_done', 'task_blocked'])

export function sessionGenerationId(
  type: 'session_idle' | 'session_blocked' | 'session_crashed',
  project: string,
  sessionName: string,
  statusEnteredAt: string,
): string {
  return `${type}:${project}::${sessionName}:${statusEnteredAt}`
}

export function taskGenerationId(
  type: 'task_done' | 'task_blocked',
  project: string,
  taskId: string,
  stateEnteredAt: string,
): string {
  return `${type}:${project}::${taskId}:${stateEnteredAt}`
}

const TIER_BY_TYPE: Record<AttentionType, AttentionTier> = {
  session_crashed: 'critical',
  session_blocked: 'action',
  task_blocked: 'action',
  session_idle: 'handoff', // overridden to 'fyi' for delegated owners
  task_done: 'handoff',
}

// ── Owner class (spec §5.2, §5.6) ───────────────────────────────────────────

/** Two owner classes from existing data — fail-safe to OWNED (notify) when the
 *  spawn origin is missing/unknown. */
export function ownerClass(session: { spawnedBy?: string }, pinned: boolean): OwnerClass {
  if (session.spawnedBy?.startsWith('user:')) return 'OWNED'
  if (pinned) return 'OWNED'
  if (session.spawnedBy === 'agent') return 'DELEGATED'
  return 'OWNED'
}

function isPinned(pins: Record<string, Set<string>>, project: string, name: string): boolean {
  return pins[project]?.has(name) ?? false
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function tsMsOf(event: YacoEvent): number {
  const ms = Date.parse(event.ts)
  return Number.isFinite(ms) ? ms : 0
}

function badgeColorForTier(tier: AttentionTier): Exclude<BadgeColor, null> {
  if (tier === 'critical') return 'red'
  if (tier === 'action') return 'orange'
  return 'yellow' // handoff
}

const TIER_RANK: Record<Exclude<BadgeColor, null>, number> = { red: 3, orange: 2, yellow: 1 }

function worseColor(a: BadgeColor, b: BadgeColor): BadgeColor {
  if (!a) return b
  if (!b) return a
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b
}

/** events.jsonl carries a single `id` per generation; `payload` may carry the
 *  fields we need for a history-only row. The engine writes a known payload
 *  shape (see attention-engine), but the projector tolerates missing fields. */
interface EventMeta {
  sessionName?: string
  taskId?: string
  agents?: string[]
  exitCode?: number
  blockReason?: string
  /** The owner class observed when the edge was produced (used for FYI history). */
  owner?: OwnerClass
}

function metaOf(event: YacoEvent): EventMeta {
  const p = (event.payload ?? {}) as Record<string, unknown>
  return {
    sessionName: typeof p.sessionName === 'string' ? p.sessionName : event.sessionId,
    taskId: typeof p.taskId === 'string' ? p.taskId : event.taskId,
    agents: Array.isArray(p.agents) ? (p.agents.filter((a) => typeof a === 'string') as string[]) : undefined,
    exitCode: typeof p.exitCode === 'number' ? p.exitCode : undefined,
    blockReason: typeof p.blockReason === 'string' ? p.blockReason : undefined,
    owner: p.owner === 'OWNED' || p.owner === 'DELEGATED' ? p.owner : undefined,
  }
}

// ── Copy (spec §9, §10) ─────────────────────────────────────────────────────

function sessionTitle(type: AttentionType, exitCode?: number, blockReason?: string): string {
  if (type === 'session_crashed') return exitCode !== undefined ? `Crashed (exit ${exitCode})` : 'Crashed'
  if (type === 'session_blocked') {
    if (blockReason === 'permission') return 'Needs approval'
    if (blockReason === 'question') return 'Has a question'
    if (blockReason === 'trust') return 'Needs trust review'
    return 'Needs you'
  }
  return 'Your turn' // session_idle (owned)
}

// ── Live-condition indices ──────────────────────────────────────────────────

interface LiveIndex {
  sessionByKey: Map<string, LiveSession>
  taskByKey: Map<string, LiveTask>
}

function liveKey(project: string, name: string): string {
  return `${project}::${name}`
}

function buildLiveIndex(input: ProjectionInput): LiveIndex {
  const sessionByKey = new Map<string, LiveSession>()
  for (const s of input.sessions) sessionByKey.set(liveKey(s.project, s.name), s)
  const taskByKey = new Map<string, LiveTask>()
  for (const t of input.tasks) taskByKey.set(liveKey(t.project, t.id), t)
  return { sessionByKey, taskByKey }
}

// ── ACT projection (open ⟺ live condition true; spec §5.2, §11.2) ───────────

/** Open ACT items derived purely from the live snapshot. Generation is derived
 *  from the live `statusEnteredAt`/`stateEnteredAt` so it matches the durable
 *  event. Auto-resolves the instant status/state leaves the condition. */
function buildOpenAct(input: ProjectionInput): AttentionItem[] {
  const items: AttentionItem[] = []

  // Session ACT: blocked → action, crashed → critical.
  for (const s of input.sessions) {
    if (s.status !== 'blocked' && s.status !== 'crashed') continue
    const enteredAt = s.statusEnteredAt
    if (!enteredAt) continue // no durable generation key → can't be a stable ACT
    const type: AttentionType = s.status === 'crashed' ? 'session_crashed' : 'session_blocked'
    items.push({
      generation: sessionGenerationId(type, s.project, s.name, enteredAt),
      type,
      tier: TIER_BY_TYPE[type],
      group: 'needs-you',
      subject: { kind: 'session', project: s.project, sessionName: s.name },
      title: sessionTitle(type, s.exitCode, s.blockReason),
      message: `${s.project} · ${s.name}`,
      tsMs: Date.parse(enteredAt) || 0,
      count: 1,
      interrupt: false,
    })
  }

  // Task ACT: state==='blocked' → action.
  for (const t of input.tasks) {
    if (t.state !== 'blocked') continue
    const enteredAt = t.stateEnteredAt
    if (!enteredAt) continue
    items.push({
      generation: taskGenerationId('task_blocked', t.project, t.id, enteredAt),
      type: 'task_blocked',
      tier: 'action',
      group: 'needs-you',
      subject: { kind: 'task', project: t.project, taskId: t.id, sessionNames: t.agents },
      title: `Task blocked: ${t.id}`,
      message: `${t.project} · ${t.id}`,
      tsMs: Date.parse(enteredAt) || 0,
      count: 1,
      interrupt: false,
    })
  }

  return items
}

/** Dedup ACT (spec §8): a `task_blocked` collapses any bound `session_blocked`
 *  (sessions in the task's `agents`) into one task-primary item with a count.
 *  Matching is over the live task's normalized `agents`. */
function dedupAct(items: AttentionItem[]): AttentionItem[] {
  const taskBlockedAgents = new Map<string, Set<string>>() // project → bound session names
  for (const it of items) {
    if (it.type === 'task_blocked' && it.subject.kind === 'task') {
      const set = taskBlockedAgents.get(it.subject.project) ?? new Set<string>()
      for (const a of it.subject.sessionNames) set.add(a)
      taskBlockedAgents.set(it.subject.project, set)
    }
  }

  const out: AttentionItem[] = []
  const collapsedInto = new Map<string, number>() // task generation → folded session count
  for (const it of items) {
    if (
      it.type === 'session_blocked' &&
      it.subject.kind === 'session' &&
      taskBlockedAgents.get(it.subject.project)?.has(it.subject.sessionName)
    ) {
      // Fold this bound session-block into the task-primary item's count.
      for (const t of items) {
        if (
          t.type === 'task_blocked' &&
          t.subject.kind === 'task' &&
          t.subject.project === it.subject.project &&
          t.subject.sessionNames.includes(it.subject.sessionName)
        ) {
          collapsedInto.set(t.generation, (collapsedInto.get(t.generation) ?? 0) + 1)
          break
        }
      }
      continue // drop the standalone session_blocked row
    }
    out.push(it)
  }

  for (const it of out) {
    const folded = collapsedInto.get(it.generation)
    if (folded) it.count += folded
  }
  return out
}

// ── REVIEW projection (unread ⟺ gen.tsMs > max(watermarks); spec §5.3) ──────

/** Latest idle generation per session, plus task_done generations, from the
 *  durable event log. Older idle generations stay in history (supersede, §M12).
 *  Returns only the unacked (Ready) items; acked + FYI rows come from history. */
function buildReview(input: ProjectionInput, live: LiveIndex): { ready: AttentionItem[] } {
  const projectReadAt = input.watermarks.projectReadAt ?? {}
  const sessionReadAt = input.watermarks.sessionReadAt ?? {}
  const taskReadAt = input.watermarks.taskReadAt ?? {}

  // Newest idle generation per (project, session).
  const latestIdleByKey = new Map<string, YacoEvent>()
  const taskDoneEvents: YacoEvent[] = []
  for (const ev of input.events) {
    if (ev.kind === 'session_idle') {
      const m = metaOf(ev)
      if (!m.sessionName) continue
      const key = liveKey(ev.projectId, m.sessionName)
      const prev = latestIdleByKey.get(key)
      if (!prev || tsMsOf(ev) > tsMsOf(prev)) latestIdleByKey.set(key, ev)
    } else if (ev.kind === 'task_done') {
      taskDoneEvents.push(ev)
    }
  }

  // task_done suppresses bound session_idle in the same window (spec §8): a
  // task_done whose bound agents include a session masks that session's idle.
  const suppressedIdleGenerations = new Set<string>()
  for (const ev of taskDoneEvents) {
    const agents = metaOf(ev).agents ?? []
    for (const a of agents) {
      const idle = latestIdleByKey.get(liveKey(ev.projectId, a))
      if (idle) suppressedIdleGenerations.add(idle.id)
    }
  }

  const ready: AttentionItem[] = []

  // Unread iff the generation ts is above BOTH the project and the key
  // watermark (max-merge, spec §5.3). Acked REVIEW falls to history, which
  // `buildHistory` rebuilds from the raw events.
  const pushReview = (item: AttentionItem, keyReadAt: number) => {
    const proj = item.subject.project
    const watermark = Math.max(projectReadAt[proj] ?? 0, keyReadAt)
    if (item.tsMs > watermark) ready.push(item)
  }

  // Owned-idle REVIEW (delegated idle is FYI → handled in history).
  for (const ev of latestIdleByKey.values()) {
    if (suppressedIdleGenerations.has(ev.id)) continue
    const m = metaOf(ev)
    const name = m.sessionName!
    const liveSession = live.sessionByKey.get(liveKey(ev.projectId, name))
    const pinned = isPinned(input.pins, ev.projectId, name)
    // Owner is computed at projection time (pin reclassifies). Fall back to the
    // owner recorded at edge time when the session is no longer live.
    const owner = liveSession
      ? ownerClass(liveSession, pinned)
      : pinned
        ? 'OWNED'
        : (m.owner ?? 'OWNED')
    if (owner !== 'OWNED') continue // delegated idle is FYI, never REVIEW
    const item: AttentionItem = {
      generation: ev.id,
      type: 'session_idle',
      tier: 'handoff',
      group: 'ready',
      subject: { kind: 'session', project: ev.projectId, sessionName: name },
      title: 'Your turn',
      message: `${ev.projectId} · ${name}`,
      tsMs: tsMsOf(ev),
      count: 1,
      interrupt: false,
    }
    pushReview(item, sessionReadAt[`${ev.projectId}::${name}`] ?? 0)
  }

  // task_done REVIEW — newest generation per (project, task).
  const latestDoneByKey = new Map<string, YacoEvent>()
  for (const ev of taskDoneEvents) {
    const taskId = metaOf(ev).taskId
    if (!taskId) continue
    const key = liveKey(ev.projectId, taskId)
    const prev = latestDoneByKey.get(key)
    if (!prev || tsMsOf(ev) > tsMsOf(prev)) latestDoneByKey.set(key, ev)
  }
  for (const ev of latestDoneByKey.values()) {
    const m = metaOf(ev)
    const taskId = m.taskId!
    const item: AttentionItem = {
      generation: ev.id,
      type: 'task_done',
      tier: 'handoff',
      group: 'ready',
      subject: { kind: 'task', project: ev.projectId, taskId, sessionNames: m.agents ?? [] },
      title: `Task done: ${taskId}`,
      message: `${ev.projectId} · ${taskId}`,
      tsMs: tsMsOf(ev),
      count: 1,
      interrupt: false,
    }
    pushReview(item, taskReadAt[`${ev.projectId}::${taskId}`] ?? 0)
  }

  return { ready }
}

// ── History (Recent) projection (spec §10.1, §5.3 clear) ────────────────────

/** Every durable event becomes a history row (newest first). FYI (delegated
 *  idle) lives only here. Clear hides read/resolved/FYI rows with
 *  `tsMs ≤ recentClearedAt[proj]`; open ACT + unacked REVIEW are unaffected
 *  (handled by the caller, which keeps them out of `recent`). */
function buildHistory(
  input: ProjectionInput,
  openActGenerations: Set<string>,
  readyGenerations: Set<string>,
): AttentionItem[] {
  const recentClearedAt = input.watermarks.recentClearedAt ?? {}
  const out: AttentionItem[] = []

  for (const ev of input.events) {
    if (!SESSION_KINDS.has(ev.kind) && !TASK_KINDS.has(ev.kind)) continue
    const m = metaOf(ev)
    const tsMs = tsMsOf(ev)

    // Build the generation id matching ACT/REVIEW so we can skip live rows.
    const generation = ev.id
    let subject: AttentionSubject
    const type = ev.kind as AttentionType
    if (SESSION_KINDS.has(ev.kind)) {
      if (!m.sessionName) continue
      subject = { kind: 'session', project: ev.projectId, sessionName: m.sessionName }
    } else {
      if (!m.taskId) continue
      subject = { kind: 'task', project: ev.projectId, taskId: m.taskId, sessionNames: m.agents ?? [] }
    }

    // Open ACT and unacked REVIEW are NOT history rows (shown live above).
    if (openActGenerations.has(generation) || readyGenerations.has(generation)) continue
    // A superseded older idle stays in history; the latest unacked idle is in `ready`.

    // Clear: hide read/resolved/FYI history with tsMs ≤ recentClearedAt[proj].
    const cleared = recentClearedAt[ev.projectId]
    if (cleared !== undefined && tsMs <= cleared) continue

    const tier = type === 'session_idle' && (m.owner === 'DELEGATED') ? 'fyi' : TIER_BY_TYPE[type]
    out.push({
      generation,
      type,
      tier,
      group: 'recent',
      subject,
      title:
        subject.kind === 'session'
          ? sessionTitle(type, m.exitCode, m.blockReason)
          : type === 'task_done'
            ? `Task done: ${subject.taskId}`
            : `Task blocked: ${subject.taskId}`,
      message: `${ev.projectId} · ${subject.kind === 'session' ? subject.sessionName : subject.taskId}`,
      tsMs,
      count: 1,
      interrupt: false,
    })
  }

  out.sort((a, b) => b.tsMs - a.tsMs)
  return out
}

// ── Badges / rollup (spec §9, §5.6) ─────────────────────────────────────────

function buildBadges(needsYou: AttentionItem[], ready: AttentionItem[]): {
  badgesByProject: Record<string, AttentionBadge>
  badgesBySession: Record<string, AttentionBadge>
  global: AttentionBadge
} {
  const byProject = new Map<string, { count: number; color: BadgeColor }>()
  const bySession = new Map<string, { count: number; color: BadgeColor }>()
  let globalCount = 0
  let globalColor: BadgeColor = null

  const account = (item: AttentionItem) => {
    const color = badgeColorForTier(item.tier)
    const proj = item.subject.project
    const p = byProject.get(proj) ?? { count: 0, color: null }
    p.count += 1
    p.color = worseColor(p.color, color)
    byProject.set(proj, p)

    // Session badge keyed by the subject's session(s) so a collapsed parent can
    // sum its subtree (the engine maps names → subtree; here we key by name).
    const names =
      item.subject.kind === 'session' ? [item.subject.sessionName] : item.subject.sessionNames
    for (const name of names) {
      const key = liveKey(proj, name)
      const s = bySession.get(key) ?? { count: 0, color: null }
      s.count += 1
      s.color = worseColor(s.color, color)
      bySession.set(key, s)
    }

    globalCount += 1
    globalColor = worseColor(globalColor, color)
  }

  for (const it of needsYou) account(it)
  for (const it of ready) account(it)

  const badgesByProject: Record<string, AttentionBadge> = {}
  for (const [k, v] of byProject) badgesByProject[k] = { count: v.count, color: v.color }
  const badgesBySession: Record<string, AttentionBadge> = {}
  for (const [k, v] of bySession) badgesBySession[k] = { count: v.count, color: v.color }

  return { badgesByProject, badgesBySession, global: { count: globalCount, color: globalColor } }
}

// ── Top-level projection ─────────────────────────────────────────────────────

/** Project the full attention snapshot. Pure: same input ⇒ same output. */
export function projectAttention(input: ProjectionInput): AttentionSnapshot {
  const live = buildLiveIndex(input)

  const rawAct = buildOpenAct(input)
  const needsYou = dedupAct(rawAct)
  const { ready } = buildReview(input, live)

  // Every open ACT generation (incl. session_blocks folded into a task by
  // dedup) is "live" and must not also appear in history.
  const openActGenerations = new Set(rawAct.map((i) => i.generation))
  const readyGenerations = new Set(ready.map((i) => i.generation))

  const recent = buildHistory(input, openActGenerations, readyGenerations)

  const { badgesByProject, badgesBySession, global } = buildBadges(needsYou, ready)

  return { needsYou, ready, recent, badgesByProject, badgesBySession, global }
}

/** Convenience for the engine's boot reconciliation: the set of currently-open
 *  ACT conditions + the current REVIEW conditions, as generation ids, that must
 *  have a durable event (spec §5.1). */
export function openAndReviewGenerations(input: ProjectionInput): {
  type: AttentionType
  generation: string
  subject: AttentionSubject
  meta: { exitCode?: number; blockReason?: string; agents?: string[]; owner?: OwnerClass }
  tsMs: number
}[] {
  const live = buildLiveIndex(input)
  const out: ReturnType<typeof openAndReviewGenerations> = []

  for (const it of buildOpenAct(input)) {
    const meta =
      it.subject.kind === 'session'
        ? {
            exitCode: input.sessions.find((s) => s.name === (it.subject as { sessionName: string }).sessionName)?.exitCode,
            blockReason: input.sessions.find((s) => s.name === (it.subject as { sessionName: string }).sessionName)?.blockReason,
          }
        : { agents: it.subject.kind === 'task' ? it.subject.sessionNames : [] }
    out.push({ type: it.type, generation: it.generation, subject: it.subject, meta, tsMs: it.tsMs })
  }

  // Current REVIEW conditions: owned-idle sessions + done tasks from the live
  // snapshot (so a crash/idle present at boot ensures its event exists).
  for (const s of input.sessions) {
    if (s.status !== 'idle' || !s.statusEnteredAt) continue
    const pinned = isPinned(input.pins, s.project, s.name)
    const owner = ownerClass(s, pinned)
    const type: AttentionType = 'session_idle'
    out.push({
      type,
      generation: sessionGenerationId(type, s.project, s.name, s.statusEnteredAt),
      subject: { kind: 'session', project: s.project, sessionName: s.name },
      meta: { owner },
      tsMs: Date.parse(s.statusEnteredAt) || 0,
    })
  }
  for (const t of input.tasks) {
    if (t.state !== 'done' || !t.stateEnteredAt) continue
    out.push({
      type: 'task_done',
      generation: taskGenerationId('task_done', t.project, t.id, t.stateEnteredAt),
      subject: { kind: 'task', project: t.project, taskId: t.id, sessionNames: t.agents },
      meta: { agents: t.agents },
      tsMs: Date.parse(t.stateEnteredAt) || 0,
    })
  }

  return out
}
