/** Attention engine (Facet B producer — spec §5).
 *
 *  Stateful, change-driven producer that sits between the runtime state files
 *  and the pure projector. It keeps an in-memory cache of last-seen session
 *  statuses + task states, detects status/state EDGES on each recompute, appends
 *  each edge to the durable event log idempotently (so history survives even a
 *  self-resolving edge), then projects ACT(open)+REVIEW(unacked)+counts via the
 *  pure projector and pushes the snapshot over the `attention` SSE event.
 *
 *  Triggers: session fs-watch, task fs-watch, pin change (`ui-state:changed`),
 *  and a 60s safety tick. Owner/tier are computed at PROJECTION time, so a later
 *  pin reclassifies without re-minting an edge.
 *
 *  Boot reconciliation (R3): the engine cannot trust an empty cache to mean "no
 *  edges happened" — a crash/block while the server was down must surface. On
 *  startup it treats the current snapshot as truth for open ACT + current
 *  REVIEW, derives each generation id, and id-scans events.jsonl; missing events
 *  are appended idempotently. `interrupt` is true only for a genuinely new live
 *  edge observed after boot — never for a pre-existing/acked/boot-discovered
 *  condition.
 *
 *  Readers are injectable so unit tests drive the engine without fs.
 */

import { appendEvent as defaultAppendEvent, readEvents as defaultReadEvents, type YacoEvent, type EventInput } from './eventsLog'
import { broadcastAttention as defaultBroadcast } from './notify'
import {
  projectAttention,
  openAndReviewGenerations,
  idleNotifiable,
  ownerClass,
  sessionGenerationId,
  taskGenerationId,
  type AttentionSnapshot,
  type AttentionType,
  type LiveSession,
  type LiveTask,
  type ProjectionInput,
  type Watermarks,
} from './attention-projection'

/** Hold a debounced session edge (`blocked`/`idle`) this long before appending +
 *  pushing, so a permission-then-auto-allow flicker — or an idle the user instantly
 *  continues — produces no item (spec §5.1, M11). Measured as `now − statusEnteredAt`
 *  and re-evaluated against the fresh snapshot each recompute; a wake timer only
 *  schedules that re-evaluation, it never appends. */
export const EDGE_DEBOUNCE_MS = 1_500
/** A session must have done at least this much real work — idle entry minus the
 *  start of its active span — before an idle transition produces a `session_idle`
 *  edge, so a near-instant / zero-work idle (a spurious or no-op turn) never
 *  notifies. A fixed duration (both ends parsed from status timestamps), so a
 *  trivial turn never drifts into one on a later tick (spec §11.3). Distinct from
 *  `EDGE_DEBOUNCE_MS`, which gates the idle DWELL (`now − statusEnteredAt`), not
 *  the work span — the two measure adjacent intervals and are not interchangeable. */
export const MIN_PROCESSING_MS = 1_500
/** 60s safety tick — a recompute backstop in case a watcher event is missed. */
export const SAFETY_TICK_MS = 60_000

/** ACT generation types that can carry a dismiss tombstone (REVIEW idle/done can
 *  not be dismissed). Used to prune the tombstone store to live `rawAct`. */
const ACT_GENERATION_TYPES = new Set<AttentionType>(['session_blocked', 'session_crashed', 'task_blocked'])

// ── Injectable dependencies (real ones default to fs/SSE) ───────────────────

export interface AttentionEngineDeps {
  readSessions: () => Promise<LiveSession[]>
  readTasks: () => Promise<LiveTask[]>
  /** project → pinned session names. */
  readPins: () => Promise<Record<string, Set<string>>>
  readWatermarks: () => Promise<Watermarks>
  /** Distinct project ids that may carry events (so boot scans the right logs). */
  listProjects: () => Promise<string[]>
  readEvents: (projectId: string) => Promise<YacoEvent[]>
  appendEvent: (projectId: string, input: EventInput) => Promise<YacoEvent>
  /** Per-generation ACT dismiss tombstones (`ui-state/dismissed-act-generations.json`). */
  readDismissedActGen: () => Promise<Set<string>>
  /** Remove proven-dead tombstones under the store lock (subtract from CURRENT
   *  on-disk set), so a concurrent `/dismiss` add of a still-live id is preserved. */
  removeDismissedActGen: (dead: Set<string>) => Promise<void>
  broadcast: (snapshot: AttentionSnapshot) => void
  now: () => number
}

// ── Edge cache ───────────────────────────────────────────────────────────────

interface SessionCacheEntry {
  status: LiveSession['status']
  statusEnteredAt?: string
  /** ms the session entered the FIRST active status (processing|blocked) of its
   *  current active span — carried across the span and into idle so the
   *  MIN_PROCESSING work-duration gate is fixed at idle entry. */
  activeSince?: number
}

interface TaskCacheEntry {
  state: LiveTask['state']
  stateEnteredAt?: string
}

function sKey(project: string, name: string): string {
  return `${project}::${name}`
}

function isActiveStatus(status: LiveSession['status']): boolean {
  return status === 'processing' || status === 'blocked'
}

/** ms a session's active span started, parsed from its `statusEnteredAt`. undefined
 *  for a non-active status or an unparseable timestamp. */
function activeSinceFrom(s: LiveSession): number | undefined {
  if (!isActiveStatus(s.status)) return undefined
  const ms = Date.parse(s.statusEnteredAt ?? '')
  return Number.isFinite(ms) ? ms : undefined
}

/** True when an idle session's turn did ≥ MIN_PROCESSING of real work: idle entry
 *  minus the start of its active span. Both ends are fixed status timestamps, so
 *  this never drifts true on a later tick. Requires a parseable idle
 *  `statusEnteredAt` and a known active span. */
function idleIsRealWork(s: LiveSession, activeSince: number | undefined): boolean {
  if (activeSince === undefined) return false
  const idleAt = Date.parse(s.statusEnteredAt ?? '')
  return Number.isFinite(idleAt) && idleAt - activeSince >= MIN_PROCESSING_MS
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class AttentionEngine {
  private deps: AttentionEngineDeps
  private sessionCache = new Map<string, SessionCacheEntry>()
  private taskCache = new Map<string, TaskCacheEntry>()
  /** Generations that already exist durably (event present or acked) → no toast. */
  private knownGenerations = new Set<string>()
  /** Generations whose edge we appended live in THIS run → interrupt eligible. */
  private liveEdgeGenerations = new Set<string>()
  private booted = false
  private recomputeInFlight = false
  private recomputeQueued = false
  private safetyTimer: ReturnType<typeof setInterval> | null = null
  /** Per-session one-shot timers that only trigger a recompute after the debounce
   *  window — they never append. The append decision is made in `detectEdges`
   *  against the fresh snapshot. */
  private wakeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(deps: Partial<AttentionEngineDeps> = {}) {
    this.deps = {
      readSessions: deps.readSessions ?? (async () => []),
      readTasks: deps.readTasks ?? (async () => []),
      readPins: deps.readPins ?? (async () => ({})),
      readWatermarks: deps.readWatermarks ?? (async () => ({ projectReadAt: {}, sessionReadAt: {} })),
      listProjects: deps.listProjects ?? (async () => []),
      readEvents: deps.readEvents ?? defaultReadEvents,
      appendEvent: deps.appendEvent ?? defaultAppendEvent,
      readDismissedActGen: deps.readDismissedActGen ?? (async () => new Set()),
      removeDismissedActGen: deps.removeDismissedActGen ?? (async () => {}),
      broadcast: deps.broadcast ?? defaultBroadcast,
      now: deps.now ?? (() => Date.now()),
    }
  }

  /** Start the engine: boot reconciliation + safety tick. */
  async start(): Promise<void> {
    await this.boot()
    this.safetyTimer = setInterval(() => void this.recompute(), SAFETY_TICK_MS)
    this.safetyTimer.unref?.()
  }

  stop(): void {
    if (this.safetyTimer) { clearInterval(this.safetyTimer); this.safetyTimer = null }
    for (const t of this.wakeTimers.values()) clearTimeout(t)
    this.wakeTimers.clear()
  }

  /** Test-only: reset all in-memory state. */
  __resetForTest(): void {
    this.sessionCache.clear()
    this.taskCache.clear()
    this.knownGenerations.clear()
    this.liveEdgeGenerations.clear()
    this.booted = false
    for (const t of this.wakeTimers.values()) clearTimeout(t)
    this.wakeTimers.clear()
  }

  // Triggers (project-watcher / ui-state). All collapse into one recompute.
  notifySessionChange(): void { void this.recompute() }
  notifyTaskChange(): void { void this.recompute() }
  notifyPinChange(): void { void this.recompute() }
  /** Ack/clear advanced a watermark. Recompute + push so every client (incl. the
   *  acting one) reflects the new read/clear state without a 60s tick (F2). */
  notifyWatermarkChange(): void { void this.recompute() }

  // ── Boot reconciliation (R3) ───────────────────────────────────────────────

  /** Treat the current snapshot as truth for open ACT + current REVIEW; ensure
   *  each generation's event exists by id-scan; seed caches; mark every
   *  boot-discovered generation as known so it surfaces without re-toasting. */
  private async boot(): Promise<void> {
    const snapshot = await this.readSnapshot()

    // Seed caches so the first live recompute diffs against the boot truth (no
    // phantom edges from an empty cache).
    for (const s of snapshot.sessions) {
      this.sessionCache.set(sKey(s.project, s.name), {
        status: s.status,
        statusEnteredAt: s.statusEnteredAt,
        activeSince: activeSinceFrom(s),
      })
    }
    for (const t of snapshot.tasks) {
      this.taskCache.set(sKey(t.project, t.id), { state: t.state, stateEnteredAt: t.stateEnteredAt })
    }

    // Index acked generations: a REVIEW generation whose ts ≤ its watermark is
    // already seen on another device/run → known, no toast.
    const conditions = openAndReviewGenerations(snapshot)
    for (const cond of conditions) {
      const projectId = cond.subject.project
      const existing = await this.findEvent(projectId, cond.generation)
      if (!existing) {
        await this.appendEdge(projectId, cond.type, cond.generation, cond.subject, cond.meta, cond.tsMs)
      }
      // Boot-discovered OR pre-existing → known (surfaces, never re-toasts).
      this.knownGenerations.add(cond.generation)
    }

    this.booted = true
    await this.project(snapshot)
  }

  // ── Recompute (change-driven edge detection) ────────────────────────────────

  /** Read the snapshot, diff vs cache to find edges, debounce per tier, append
   *  edges idempotently, then project + push. Serialized: a trigger during an
   *  in-flight recompute coalesces into one trailing run. */
  async recompute(): Promise<void> {
    if (!this.booted) return
    if (this.recomputeInFlight) { this.recomputeQueued = true; return }
    this.recomputeInFlight = true
    try {
      do {
        this.recomputeQueued = false
        const snapshot = await this.readSnapshot()
        await this.detectEdges(snapshot)
        await this.project(snapshot)
      } while (this.recomputeQueued)
    } finally {
      this.recomputeInFlight = false
    }
  }

  private async readSnapshot(): Promise<ProjectionInput> {
    const [sessions, tasks, pins, watermarks, storedDismissed] = await Promise.all([
      this.deps.readSessions(),
      this.deps.readTasks(),
      this.deps.readPins(),
      this.deps.readWatermarks(),
      this.deps.readDismissedActGen(),
    ])
    // nowMs flows to project()/__projectOnce()/boot via the returned input so the
    // pure projector reads no wall clock (design §T2). Prune the tombstone store
    // to the conditions still live in rawAct each recompute (keeps it bounded).
    const input: ProjectionInput = { sessions, tasks, pins, watermarks, events: [], nowMs: this.deps.now() }
    const dismissedActGen = await this.pruneDismissedToLive(input, storedDismissed)
    return { ...input, dismissedActGen }
  }

  /** Drop every tombstone whose ACT condition is no longer live in `rawAct` (a
   *  resolved condition can never recur under the same generation id) and return
   *  the still-live subset for this recompute's projection. Computes the DEAD set
   *  explicitly from what it read and removes ONLY those under the store lock — it
   *  never overwrites the whole set — so a concurrent `/dismiss` add of a
   *  still-live generation (never in `dead`) is preserved. Reuses the projector's
   *  `openAndReviewGenerations` so "what is live" has a single source of truth. */
  private async pruneDismissedToLive(input: ProjectionInput, stored: Set<string>): Promise<Set<string>> {
    if (stored.size === 0) return stored
    const liveActGenerations = new Set(
      openAndReviewGenerations(input)
        .filter((c) => ACT_GENERATION_TYPES.has(c.type))
        .map((c) => c.generation),
    )
    const dead = new Set<string>()
    const pruned = new Set<string>()
    for (const gen of stored) {
      if (liveActGenerations.has(gen)) pruned.add(gen)
      else dead.add(gen)
    }
    if (dead.size > 0) await this.deps.removeDismissedActGen(dead)
    return pruned
  }

  /** Diff the live snapshot vs the cache and produce durable edge events. */
  private async detectEdges(snapshot: ProjectionInput): Promise<void> {
    const now = this.deps.now()
    const liveSessionKeys = new Set<string>()

    for (const s of snapshot.sessions) {
      const key = sKey(s.project, s.name)
      liveSessionKeys.add(key)
      const prev = this.sessionCache.get(key)

      // Track the start of the active span: set on the first active observation,
      // preserved across processing↔blocked and into idle (so the work-duration
      // gate is fixed at idle entry), cleared on starting/crashed.
      let activeSince = prev?.activeSince
      if (isActiveStatus(s.status)) {
        if (!prev || !isActiveStatus(prev.status)) activeSince = activeSinceFrom(s) ?? now
      } else if (s.status !== 'idle') {
        activeSince = undefined
      }

      // ── Crash edge — immediate, never debounced ─────────────────────────────
      if (s.status === 'crashed' && s.statusEnteredAt && this.statusEntered(prev, s)) {
        await this.appendSessionEdge('session_crashed', s, now)
      }

      // ── Debounced session edge — blocked + idle ─────────────────────────────
      // One mechanism: append once the session has held the same statusEnteredAt
      // generation for ≥ EDGE_DEBOUNCE_MS. Idle additionally requires a fixed
      // ≥MIN_PROCESSING work span (idle entry − active span start).
      const debounced: 'session_blocked' | 'session_idle' | null =
        s.status === 'blocked' ? 'session_blocked'
        : s.status === 'idle' && idleNotifiable(s) && idleIsRealWork(s, activeSince) ? 'session_idle'
        : null
      if (debounced && s.statusEnteredAt) await this.evaluateDebouncedEdge(key, debounced, s, now)
      else this.clearWakeTimer(key)

      // Commit the cache LAST: an append above that throws leaves the prior
      // generation uncached, so the edge is retried on the next recompute rather
      // than swallowed (e.g. a crash whose event write failed).
      this.sessionCache.set(key, { status: s.status, statusEnteredAt: s.statusEnteredAt, activeSince })
    }

    // Prune sessions that disappeared (frees the cache + any wake timer).
    for (const key of [...this.sessionCache.keys()]) {
      if (!liveSessionKeys.has(key)) { this.sessionCache.delete(key); this.clearWakeTimer(key) }
    }

    // ── Task edges — immediate ──────────────────────────────────────────────
    const liveTaskKeys = new Set<string>()
    for (const t of snapshot.tasks) {
      const key = sKey(t.project, t.id)
      liveTaskKeys.add(key)
      const prev = this.taskCache.get(key)
      const changed = !prev || prev.state !== t.state || prev.stateEnteredAt !== t.stateEnteredAt
      if (changed && t.stateEnteredAt) {
        if (t.state === 'done') await this.appendTaskEdge('task_done', t, now)
        else if (t.state === 'blocked') await this.appendTaskEdge('task_blocked', t, now)
      }
      this.taskCache.set(key, { state: t.state, stateEnteredAt: t.stateEnteredAt })
    }
    for (const key of [...this.taskCache.keys()]) {
      if (!liveTaskKeys.has(key)) this.taskCache.delete(key)
    }
  }

  /** True iff `s` represents a different status generation than the cache. */
  private statusEntered(prev: SessionCacheEntry | undefined, s: LiveSession): boolean {
    return !prev || prev.status !== s.status || prev.statusEnteredAt !== s.statusEnteredAt
  }

  // ── Blocked debounce ────────────────────────────────────────────────────────

  // ── Debounced session edge (blocked + idle) ─────────────────────────────────

  /** Append `type` once the session has held the same `statusEnteredAt` generation
   *  for ≥ EDGE_DEBOUNCE_MS, evaluated against the FRESH snapshot `s`. A wake timer
   *  only schedules the re-evaluation (`recompute`); it never appends from cache.
   *  A non-finite OR future-dated `statusEnteredAt` is anomalous (you can't enter a
   *  status in the future) → fail open (append now) rather than parking a wake loop
   *  that re-arms until wall time catches up. Idle never reaches here on a bad
   *  timestamp because `idleIsRealWork` already screened it out. */
  private async evaluateDebouncedEdge(
    key: string,
    type: 'session_blocked' | 'session_idle',
    s: LiveSession,
    now: number,
  ): Promise<void> {
    const generation = sessionGenerationId(type, s.project, s.name, s.statusEnteredAt!)
    // Already durably recorded — appended live this run OR boot-discovered. The
    // edge exists; re-evaluating would re-append (idempotent no-op) and re-arm a
    // wake timer every tick forever. Stop here: no re-append, no wake-loop, no
    // second interrupt.
    if (this.liveEdgeGenerations.has(generation) || this.knownGenerations.has(generation)) {
      this.clearWakeTimer(key)
      return
    }
    const enteredMs = Date.parse(s.statusEnteredAt!)
    const elapsed = Number.isFinite(enteredMs) && enteredMs <= now ? now - enteredMs : EDGE_DEBOUNCE_MS
    if (elapsed >= EDGE_DEBOUNCE_MS) {
      this.clearWakeTimer(key)
      await this.appendSessionEdge(type, s, now)
    } else {
      this.ensureWakeTimer(key, EDGE_DEBOUNCE_MS - elapsed)
    }
  }

  /** Schedule a single recompute after `ms` so the debounce gate is re-evaluated
   *  against a fresh snapshot. `ms` is always within (0, EDGE_DEBOUNCE_MS] at the
   *  call site (elapsed is clamped non-negative); the timer ONLY triggers recompute. */
  private ensureWakeTimer(key: string, ms: number): void {
    if (this.wakeTimers.has(key)) return
    const timer = setTimeout(() => { this.wakeTimers.delete(key); void this.recompute() }, Math.max(0, ms))
    timer.unref?.()
    this.wakeTimers.set(key, timer)
  }

  private clearWakeTimer(key: string): void {
    const t = this.wakeTimers.get(key)
    if (t) { clearTimeout(t); this.wakeTimers.delete(key) }
  }

  // ── Edge append (idempotent; marks the generation as a live edge → toast) ───

  private async appendSessionEdge(
    type: 'session_idle' | 'session_blocked' | 'session_crashed',
    s: LiveSession,
    nowMs: number,
  ): Promise<void> {
    if (type === 'session_idle' && !idleNotifiable(s)) return
    const generation = sessionGenerationId(type, s.project, s.name, s.statusEnteredAt!)
    // Record the edge-time owner for FYI history fallback; the projector
    // recomputes owner with LIVE pins, so a later pin still reclassifies.
    const owner = ownerClass(s, false)
    await this.appendEdge(
      s.project,
      type,
      generation,
      { kind: 'session', project: s.project, sessionName: s.name },
      { exitCode: s.exitCode, blockReason: s.blockReason, owner, notice: s.notice },
      Date.parse(s.statusEnteredAt!) || nowMs,
    )
    this.liveEdgeGenerations.add(generation)
  }

  private async appendTaskEdge(
    type: 'task_done' | 'task_blocked',
    t: LiveTask,
    nowMs: number,
  ): Promise<void> {
    const generation = taskGenerationId(type, t.project, t.id, t.stateEnteredAt!)
    await this.appendEdge(
      t.project,
      type,
      generation,
      { kind: 'task', project: t.project, taskId: t.id, sessionNames: t.agents },
      { agents: t.agents, notice: t.notice },
      Date.parse(t.stateEnteredAt!) || nowMs,
    )
    this.liveEdgeGenerations.add(generation)
  }

  private async appendEdge(
    projectId: string,
    type: AttentionType,
    generation: string,
    subject: { kind: 'session'; project: string; sessionName: string } | { kind: 'task'; project: string; taskId: string; sessionNames: string[] },
    meta: { exitCode?: number; blockReason?: string; agents?: string[]; owner?: 'OWNED' | 'DELEGATED'; notice?: string },
    tsMs: number,
  ): Promise<void> {
    const payload: Record<string, unknown> = {}
    if (subject.kind === 'session') payload.sessionName = subject.sessionName
    else { payload.taskId = subject.taskId; payload.agents = subject.sessionNames }
    if (meta.exitCode !== undefined) payload.exitCode = meta.exitCode
    if (meta.blockReason !== undefined) payload.blockReason = meta.blockReason
    if (meta.agents !== undefined) payload.agents = meta.agents
    if (meta.owner !== undefined) payload.owner = meta.owner
    if (meta.notice !== undefined) payload.notice = meta.notice

    await this.deps.appendEvent(projectId, {
      id: generation,
      ts: new Date(tsMs).toISOString(),
      kind: type,
      ...(subject.kind === 'session' ? { sessionId: subject.sessionName } : { taskId: subject.taskId }),
      payload,
    })
  }

  private async findEvent(projectId: string, generation: string): Promise<YacoEvent | null> {
    const events = await this.deps.readEvents(projectId)
    return events.find((e) => e.id === generation) ?? null
  }

  // ── Project + push ──────────────────────────────────────────────────────────

  /** Build the snapshot from the live inputs + the durable events of every
   *  project that has any live/known subject, set interrupt flags, and push. */
  private async project(snapshot: ProjectionInput): Promise<void> {
    const projectIds = new Set<string>(await this.deps.listProjects())
    for (const s of snapshot.sessions) projectIds.add(s.project)
    for (const t of snapshot.tasks) projectIds.add(t.project)

    const events: YacoEvent[] = []
    for (const projectId of projectIds) {
      const projEvents = await this.deps.readEvents(projectId)
      for (const e of projEvents) events.push(e)
    }

    const projected = projectAttention({ ...snapshot, events })

    // Interrupt = a genuinely new live edge observed THIS run that the client
    // has not seen before (not boot-discovered, not pre-acked).
    for (const item of [...projected.needsYou, ...projected.ready]) {
      item.interrupt = this.liveEdgeGenerations.has(item.generation) && !this.knownGenerations.has(item.generation)
      // Once surfaced, it is known: it must not re-toast on the next push.
      if (item.interrupt) this.knownGenerations.add(item.generation)
    }

    this.deps.broadcast(projected)
  }

  /** Test-only: run boot then return the projected snapshot for assertions. */
  async __projectOnce(): Promise<AttentionSnapshot> {
    const snapshot = await this.readSnapshot()
    const projectIds = new Set<string>(await this.deps.listProjects())
    for (const s of snapshot.sessions) projectIds.add(s.project)
    for (const t of snapshot.tasks) projectIds.add(t.project)
    const events: YacoEvent[] = []
    for (const projectId of projectIds) for (const e of await this.deps.readEvents(projectId)) events.push(e)
    return projectAttention({ ...snapshot, events })
  }
}
