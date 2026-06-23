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
  /** Always `1`. The ACT dedup fold was removed (design §"No dedup fold"): every
   *  condition is its own row, and multi-agent summarization is handled by the
   *  badge rollup. Retained for the snapshot shape / REVIEW symmetry. */
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
  idleReason?: 'interrupted'
  spawnedBy?: 'user:web' | 'user:terminal' | 'agent'
  parentSession?: string
  /** Transient line-2 content for the current attention state (CLI-captured). */
  notice?: string
}

/** Live task snapshot the projector reads. */
export interface LiveTask {
  project: string
  id: string
  state: 'ready' | 'running' | 'done' | 'blocked' | 'cancelled'
  stateEnteredAt?: string
  /** Normalized bound session handles (spec §8 — matching is over `agents`). */
  agents: string[]
  /** Line-2 content for a task row (the task title, clamped). */
  notice?: string
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
  /** Server time (ms) injected by the engine/cold-feed so the projector stays
   *  pure (it reads no wall clock). Optional: defaults to `0` in `projectAttention`,
   *  which fails the `enteredMs <= nowMs` freshness guard → delegated blocks
   *  fail open to SURFACE (safe). T2 wires the real clock at the call sites. */
  nowMs?: number
  /** Per-generation ACT dismiss tombstones (`<type>:<proj>::<key>:<enteredAt>`).
   *  A dismissed generation is ACKED → muted in Recent, never in `needsYou`. A
   *  re-entry mints a new generation id, so it always re-surfaces. Optional:
   *  defaults to an empty set in `projectAttention`. T2 reads the store here. */
  dismissedActGen?: Set<string>
}

// ── Generation ids (spec §4, §5.1) ──────────────────────────────────────────

const SESSION_KINDS = new Set(['session_idle', 'session_blocked', 'session_crashed'])
const TASK_KINDS = new Set(['task_done', 'task_blocked'])

/** ACT (critical/action) types. Any ACT row that reaches Recent is — by
 *  construction (`liveOutOfRecent` holds out every live NEEDS_YOU/SUPPRESSED
 *  generation) — acked-while-live or resolved, so `buildHistory` mutes it to
 *  `fyi` + past tense rather than the open-question present tense. */
const ACT_TYPES = new Set<AttentionType>(['session_crashed', 'session_blocked', 'task_blocked'])

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

export function idleNotifiable(session: { idleReason?: string } | null | undefined): boolean {
  return session?.idleReason !== 'interrupted'
}

function interruptedIdleGeneration(session: LiveSession): string | null {
  if (session.status !== 'idle' || session.idleReason !== 'interrupted' || !session.statusEnteredAt) return null
  return sessionGenerationId('session_idle', session.project, session.name, session.statusEnteredAt)
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
  /** Line-2 content captured at edge-append (the question/permission/idle/title). */
  notice?: string
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
    notice: typeof p.notice === 'string' && p.notice ? p.notice : undefined,
  }
}

/** A row's content line: the captured `notice`, trimmed, or '' when absent. The
 *  web client renders identity + project on the scan line, so an empty notice
 *  needs no location filler — the row shows just its state label. The caller
 *  passes notice from the LIVE snapshot for ACT rows, from the event payload
 *  (`metaOf`) for REVIEW/history. */
function noticeText(notice: string | undefined): string {
  return notice?.trim() ?? ''
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

/** Muted, PAST-TENSE copy for a session ACT row in Recent (design §"History
 *  tense"). Mirrors `sessionTitle`'s signature; a blocked/crashed row only ever
 *  reaches Recent once resolved or acked, so it reads as completed, never the
 *  open-question present tense. */
function sessionPastTitle(type: AttentionType, exitCode?: number, blockReason?: string): string {
  if (type === 'session_crashed') return exitCode !== undefined ? `Crashed (exit ${exitCode})` : 'Crashed'
  // session_blocked (the only other ACT session type that reaches Recent).
  return blockReason === 'question' ? 'Had a question' : 'Was blocked'
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

// ── ACT projection (single disposition pass; design §"Single disposition pass") ─

/** A live ACT condition is classified once into one of three dispositions, and
 *  everything downstream (needsYou, what stays out of Recent) derives from it. */
type ActDisposition = 'NEEDS_YOU' | 'SUPPRESSED' | 'ACKED'

/** Owner-routing verdict for a live ACT condition. */
type OwnerVerdict = 'SURFACE' | 'SUPPRESS'

interface ClassifiedAct {
  item: AttentionItem
  disposition: ActDisposition
}

/** A delegated block is the parent coordinator's job for this long; past it the
 *  question escalates to the human (the parent may be stale/ignoring). */
const GRACE_MS = 10 * 60 * 1000 // 10 min

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
      // Crashed ignores notice (the exit code is already in the title) → '';
      // blocked shows the live question/permission content.
      message: type === 'session_crashed' ? '' : noticeText(s.notice),
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
      message: noticeText(t.notice),
      tsMs: Date.parse(enteredAt) || 0,
      count: 1,
      interrupt: false,
    })
  }

  return items
}

/** Owner routing for a live ACT condition (design §"Owner routing"):
 *  - `session_crashed` ⇒ always SURFACE (page the human).
 *  - `task_blocked` ⇒ SURFACE (tasks carry no owner/parent — page unless ACKED).
 *  - `session_blocked` ⇒ pinned/owned SURFACE; a delegated block SUPPRESSES only
 *    while its immediate same-project parent is `processing` AND the block is
 *    fresh (`enteredMs <= nowMs && age < GRACE_MS`); otherwise it escalates
 *    (SURFACE). Missing/cross-project parent and future-dated blocks fail open. */
function ownerDisposition(
  item: AttentionItem,
  input: ProjectionInput,
  live: LiveIndex,
  nowMs: number,
): OwnerVerdict {
  if (item.type === 'session_crashed') return 'SURFACE'
  if (item.type === 'task_blocked') return 'SURFACE'
  if (item.subject.kind !== 'session') return 'SURFACE' // session_blocked only below
  const proj = item.subject.project
  const name = item.subject.sessionName
  const session = live.sessionByKey.get(liveKey(proj, name))
  if (!session) return 'SURFACE' // item came from live; fail open if it vanished

  const pinned = isPinned(input.pins, proj, name)
  if (ownerClass(session, pinned) === 'OWNED') return 'SURFACE' // pin ⇒ treat as mine

  // Delegated block: the immediate, same-project parent owns it while live + fresh.
  const parentName = session.parentSession
  if (!parentName) return 'SURFACE' // no parent → fail open
  const parent = live.sessionByKey.get(liveKey(proj, parentName))
  if (!parent) return 'SURFACE' // missing / cross-project parent → fail open

  // Parse from the live session, not item.tsMs (which collapses a parse failure
  // to 0). An unparseable statusEnteredAt is NOT fresh → escalate (fail open).
  const enteredMs = Date.parse(session.statusEnteredAt ?? '')
  const fresh =
    Number.isFinite(enteredMs) && enteredMs <= nowMs && nowMs - enteredMs < GRACE_MS // future-dated/unparseable ⇒ not fresh
  if (parent.status === 'processing' && fresh) return 'SUPPRESS'
  return 'SURFACE' // parent gone / idle / starting / grace-expired / future-dated / unparseable
}

/** Classify every live ACT condition once. `acked` is exact-generation membership
 *  in the dismiss tombstone set, so a re-entry (new generation id) re-surfaces. */
function classifyAct(
  input: ProjectionInput,
  live: LiveIndex,
  nowMs: number,
  dismissedActGen: Set<string>,
): ClassifiedAct[] {
  return buildOpenAct(input).map((item) => {
    const acked = dismissedActGen.has(item.generation)
    const verdict = ownerDisposition(item, input, live, nowMs)
    const disposition: ActDisposition = acked
      ? 'ACKED' // user dismissed this exact generation → muted past-tense Recent row
      : verdict === 'SUPPRESS'
        ? 'SUPPRESSED' // parent is on it → shown nowhere while live
        : 'NEEDS_YOU' // owned / escalated / crashed → bell "Needs you"
    return { item, disposition }
  })
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

  // task_done suppresses bound session_idle in the same handoff window (spec §8):
  // a task_done whose bound agents include a session masks that session's idle —
  // but only when the done is the same-or-later edge (tsMs(done) >= tsMs(idle)).
  // An OLDER task_done (before the idle) is a stale completion that must NOT mask
  // a newer "your turn" idle, which is a fresh handoff back to the owner.
  const suppressedIdleGenerations = new Set<string>()
  for (const ev of taskDoneEvents) {
    const agents = metaOf(ev).agents ?? []
    for (const a of agents) {
      const idle = latestIdleByKey.get(liveKey(ev.projectId, a))
      if (idle && tsMsOf(ev) >= tsMsOf(idle)) suppressedIdleGenerations.add(idle.id)
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
    // F1: "Your turn" is gated on the session being CURRENTLY idle AND this being
    // the session's CURRENT idle generation. A session that resumed
    // (processing/blocked/crashed/starting), is gone, or re-entered idle before
    // the engine recorded the new edge (so the latest idle EVENT is stale) has no
    // live Ready item — it stays in Recent (buildHistory); the matching event
    // surfaces it once appended.
    if (liveSession?.status !== 'idle' || !liveSession.statusEnteredAt) continue
    if (!idleNotifiable(liveSession)) continue
    if (ev.id !== sessionGenerationId('session_idle', ev.projectId, name, liveSession.statusEnteredAt)) continue
    const pinned = isPinned(input.pins, ev.projectId, name)
    // Owner is computed at projection time (pin reclassifies).
    const owner = ownerClass(liveSession, pinned)
    if (owner !== 'OWNED') continue // delegated idle is FYI, never REVIEW
    const item: AttentionItem = {
      generation: ev.id,
      type: 'session_idle',
      tier: 'handoff',
      group: 'ready',
      subject: { kind: 'session', project: ev.projectId, sessionName: name },
      title: 'Your turn',
      message: noticeText(m.notice),
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
      message: noticeText(m.notice),
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
 *  `tsMs ≤ recentClearedAt[proj]`. `liveOutOfRecent` holds out every ACT
 *  generation that is currently NEEDS_YOU or SUPPRESSED (shown live / nowhere);
 *  an ACKED-but-still-live condition is NOT in it, so it shows once in Recent.
 *
 *  Every ACT-typed row (`session_blocked`/`session_crashed`/`task_blocked`) that
 *  reaches Recent is — by construction — acked-while-live or resolved, so it
 *  renders `tier:'fyi'` + past tense unconditionally (no liveness check needed).
 *  `live` is threaded in for any session/task copy details the caller already
 *  has (design §"History tense"). */
function buildHistory(
  input: ProjectionInput,
  live: LiveIndex,
  liveOutOfRecent: Set<string>,
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
    if (type === 'session_idle' && subject.kind === 'session') {
      const liveSession = live.sessionByKey.get(liveKey(ev.projectId, subject.sessionName))
      if (liveSession && interruptedIdleGeneration(liveSession) === generation) continue
    }

    // Live NEEDS_YOU/SUPPRESSED ACT and unacked REVIEW are NOT history rows
    // (shown live above / held out while live). ACKED-live falls through here.
    if (liveOutOfRecent.has(generation) || readyGenerations.has(generation)) continue
    // A superseded older idle stays in history; the latest unacked idle is in `ready`.

    // Clear: hide read/resolved/FYI history with tsMs ≤ recentClearedAt[proj].
    const cleared = recentClearedAt[ev.projectId]
    if (cleared !== undefined && tsMs <= cleared) continue

    // ACT rows in Recent are muted past-tense (`fyi`) unconditionally; non-ACT
    // rows keep their tier (delegated idle → fyi) and present-tense copy.
    const isAct = ACT_TYPES.has(type)
    const tier: AttentionTier = isAct
      ? 'fyi'
      : type === 'session_idle' && m.owner === 'DELEGATED'
        ? 'fyi'
        : TIER_BY_TYPE[type]
    const title =
      subject.kind === 'session'
        ? isAct
          ? sessionPastTitle(type, m.exitCode, m.blockReason)
          : sessionTitle(type, m.exitCode, m.blockReason)
        : isAct
          ? `Was blocked: ${subject.taskId}` // task_blocked
          : `Task done: ${subject.taskId}` // task_done
    out.push({
      generation,
      type,
      tier,
      group: 'recent',
      subject,
      title,
      // Crashed has no content (the exit code is in the title) → ''; every other
      // row shows the notice captured in the event payload, else ''.
      message: type === 'session_crashed' ? '' : noticeText(m.notice),
      tsMs,
      count: 1,
      interrupt: false,
    })
  }

  out.sort((a, b) => b.tsMs - a.tsMs)
  return out
}

// ── Badges / rollup (spec §9, §5.6) ─────────────────────────────────────────

/** project → (session name → parent session name), derived from the live
 *  snapshot. Used to roll a subtree's actionable items up to a collapsed parent. */
function buildParentMap(sessions: LiveSession[]): Map<string, Map<string, string>> {
  const byProject = new Map<string, Map<string, string>>()
  for (const s of sessions) {
    if (!s.parentSession) continue
    const m = byProject.get(s.project) ?? new Map<string, string>()
    m.set(s.name, s.parentSession)
    byProject.set(s.project, m)
  }
  return byProject
}

/** Subject session name(s) plus every ancestor up the parentSession chain,
 *  deduped, so an item rolls up to each collapsed parent without double-counting
 *  a shared ancestor (multi-agent task) or an ancestor that is itself a subject. */
function sessionRollupNames(
  names: string[],
  parents: Map<string, string> | undefined,
): Set<string> {
  const keys = new Set<string>()
  for (const name of names) {
    let cur: string | undefined = name
    while (cur && !keys.has(cur)) {
      keys.add(cur)
      cur = parents?.get(cur)
    }
  }
  return keys
}

function buildBadges(
  needsYou: AttentionItem[],
  ready: AttentionItem[],
  parentByProject: Map<string, Map<string, string>>,
): {
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

    // Session badge: increment the subject session(s) AND every ancestor up the
    // parentSession chain so a collapsed parent shows its subtree's actionable
    // count (spec §5.6). Keys are deduped per item (sessionRollupNames) so a
    // multi-agent task does not double-count a shared ancestor.
    const names =
      item.subject.kind === 'session' ? [item.subject.sessionName] : item.subject.sessionNames
    for (const name of sessionRollupNames(names, parentByProject.get(proj))) {
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
  // Safe defaults so the server compiles before T2 wires the clock + store.
  // nowMs=0 fails the freshness guard → delegated blocks fail open (SURFACE).
  const nowMs = input.nowMs ?? 0
  const dismissedActGen = input.dismissedActGen ?? new Set<string>()

  // Single disposition pass: one classifier per live ACT condition. No dedup fold
  // — every condition is its own independently-dismissible row (design §"No dedup fold").
  const classified = classifyAct(input, live, nowMs, dismissedActGen)
  const needsYou = classified.filter((c) => c.disposition === 'NEEDS_YOU').map((c) => c.item)
  // Held out of Recent while live: NEEDS_YOU (shown above) ∪ SUPPRESSED (shown
  // nowhere). ACKED is excluded → an acked-live condition shows once in Recent.
  const liveOutOfRecent = new Set(
    classified.filter((c) => c.disposition !== 'ACKED').map((c) => c.item.generation),
  )

  const { ready } = buildReview(input, live)
  const readyGenerations = new Set(ready.map((i) => i.generation))

  const recent = buildHistory(input, live, liveOutOfRecent, readyGenerations)

  const { badgesByProject, badgesBySession, global } = buildBadges(
    needsYou,
    ready,
    buildParentMap(input.sessions),
  )

  return { needsYou, ready, recent, badgesByProject, badgesBySession, global }
}

/** Convenience for the engine's boot reconciliation: the set of currently-open
 *  ACT conditions + the current REVIEW conditions, as generation ids, that must
 *  have a durable event (spec §5.1). */
export function openAndReviewGenerations(input: ProjectionInput): {
  type: AttentionType
  generation: string
  subject: AttentionSubject
  meta: { exitCode?: number; blockReason?: string; agents?: string[]; owner?: OwnerClass; notice?: string }
  tsMs: number
}[] {
  const live = buildLiveIndex(input)
  const out: ReturnType<typeof openAndReviewGenerations> = []

  for (const it of buildOpenAct(input)) {
    let meta: { exitCode?: number; blockReason?: string; agents?: string[]; owner?: OwnerClass; notice?: string }
    if (it.subject.kind === 'session') {
      // Key by project::name (not a name-only `find`), so two projects sharing a
      // session name never cross-contaminate each other's edge meta.
      const s = live.sessionByKey.get(liveKey(it.subject.project, it.subject.sessionName))
      meta = { exitCode: s?.exitCode, blockReason: s?.blockReason, notice: s?.notice }
    } else {
      const t = live.taskByKey.get(liveKey(it.subject.project, it.subject.taskId))
      meta = { agents: it.subject.sessionNames, notice: t?.notice }
    }
    out.push({ type: it.type, generation: it.generation, subject: it.subject, meta, tsMs: it.tsMs })
  }

  // Current REVIEW conditions: owned-idle sessions + done tasks from the live
  // snapshot (so a crash/idle present at boot ensures its event exists).
  for (const s of input.sessions) {
    if (s.status !== 'idle' || !s.statusEnteredAt) continue
    if (!idleNotifiable(s)) continue
    const pinned = isPinned(input.pins, s.project, s.name)
    const owner = ownerClass(s, pinned)
    const type: AttentionType = 'session_idle'
    out.push({
      type,
      generation: sessionGenerationId(type, s.project, s.name, s.statusEnteredAt),
      subject: { kind: 'session', project: s.project, sessionName: s.name },
      meta: { owner, notice: s.notice },
      tsMs: Date.parse(s.statusEnteredAt) || 0,
    })
  }
  for (const t of input.tasks) {
    if (t.state !== 'done' || !t.stateEnteredAt) continue
    out.push({
      type: 'task_done',
      generation: taskGenerationId('task_done', t.project, t.id, t.stateEnteredAt),
      subject: { kind: 'task', project: t.project, taskId: t.id, sessionNames: t.agents },
      meta: { agents: t.agents, notice: t.notice },
      tsMs: Date.parse(t.stateEnteredAt) || 0,
    })
  }

  return out
}
