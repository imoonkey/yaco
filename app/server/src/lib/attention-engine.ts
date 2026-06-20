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

/** Hold a `session_blocked` this long before appending + pushing, so a
 *  permission-then-auto-allow flicker does not produce an item (spec §5.1, M11). */
export const BLOCKED_DEBOUNCE_MS = 1_500
/** A session must have been active (processing|blocked) at least this long before
 *  an idle transition can produce a `session_idle` edge (spec §11.3). */
export const MIN_PROCESSING_MS = 15_000
/** Consecutive idle observations required to confirm idle (debounce flap). */
export const IDLE_CONFIRM_COUNT = 2
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
  /** ms the session first observed active (processing|blocked) in this streak. */
  activeSince?: number
  /** consecutive idle observations. */
  idleStreak: number
}

interface TaskCacheEntry {
  state: LiveTask['state']
  stateEnteredAt?: string
}

/** A pending debounced `session_blocked` edge. `latestSession` is refreshed on
 *  every recompute while the same generation (`enteredAt`) is still blocked, so
 *  the timer appends the FRESHEST snapshot — capturing a notice that filled AFTER
 *  the first blocked observation (events are idempotent by generation id, so a
 *  late notice could never be corrected by a second append). */
interface BlockedPending {
  enteredAt: string
  latestSession: LiveSession
  timer: ReturnType<typeof setTimeout>
}

function sKey(project: string, name: string): string {
  return `${project}::${name}`
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
  private blockedTimers = new Map<string, BlockedPending>()

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
    for (const p of this.blockedTimers.values()) clearTimeout(p.timer)
    this.blockedTimers.clear()
  }

  /** Test-only: reset all in-memory state. */
  __resetForTest(): void {
    this.sessionCache.clear()
    this.taskCache.clear()
    this.knownGenerations.clear()
    this.liveEdgeGenerations.clear()
    this.booted = false
    for (const p of this.blockedTimers.values()) clearTimeout(p.timer)
    this.blockedTimers.clear()
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
        idleStreak: s.status === 'idle' ? IDLE_CONFIRM_COUNT : 0,
        activeSince: s.status === 'processing' || s.status === 'blocked' ? 0 : undefined,
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
      const active = s.status === 'processing' || s.status === 'blocked'

      // Track active-since (for idle MIN_PROCESSING) + idle streak. activeSince
      // is preserved across the idle streak so the MIN_PROCESSING gate still
      // sees how long the session worked before it went idle.
      let activeSince = prev?.activeSince
      let idleStreak = prev?.idleStreak ?? 0
      if (active) {
        if (!prev || (prev.status !== 'processing' && prev.status !== 'blocked')) activeSince = now
        idleStreak = 0
      } else if (s.status === 'idle') {
        idleStreak = idleStreak + 1
      } else {
        idleStreak = 0
        activeSince = undefined
      }

      // ── Crash edge — immediate ──────────────────────────────────────────────
      if (s.status === 'crashed' && s.statusEnteredAt && this.statusEntered(prev, s)) {
        await this.appendSessionEdge('session_crashed', s, now)
      }

      // ── Blocked edge — debounced ~1 confirm ─────────────────────────────────
      if (s.status === 'blocked' && s.statusEnteredAt) {
        this.scheduleBlockedEdge(s)
      } else {
        this.cancelBlockedEdge(key)
      }

      // ── Idle edge — ≥MIN_PROCESSING + idle-confirm streak ───────────────────
      // Appends when the idle streak first reaches the confirm count. The
      // generation is statusEnteredAt-keyed so re-appends are idempotent no-ops;
      // a newer idle (new statusEnteredAt) resets the streak and re-confirms.
      if (s.status === 'idle' && s.statusEnteredAt && idleStreak >= IDLE_CONFIRM_COUNT) {
        const wasRealWork = activeSince !== undefined && now - activeSince >= MIN_PROCESSING_MS
        if (wasRealWork) {
          await this.appendSessionEdge('session_idle', s, now)
        }
      }

      this.sessionCache.set(key, { status: s.status, statusEnteredAt: s.statusEnteredAt, activeSince, idleStreak })
    }

    // Prune sessions that disappeared (resolves blocked timers, frees the cache).
    for (const key of [...this.sessionCache.keys()]) {
      if (!liveSessionKeys.has(key)) { this.sessionCache.delete(key); this.cancelBlockedEdge(key) }
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

  private scheduleBlockedEdge(s: LiveSession): void {
    const key = sKey(s.project, s.name)
    const enteredAt = s.statusEnteredAt!
    const generation = sessionGenerationId('session_blocked', s.project, s.name, enteredAt)
    // Already durably recorded — appended live this run OR boot-discovered. The
    // edge exists; scheduling again would make a persistently-blocked session
    // re-append (idempotent no-op) + rebroadcast every debounce interval forever,
    // because the timer deletes its entry before the post-append recompute lands.
    if (this.liveEdgeGenerations.has(generation) || this.knownGenerations.has(generation)) {
      this.cancelBlockedEdge(key)
      return
    }
    const existing = this.blockedTimers.get(key)
    if (existing) {
      if (existing.enteredAt === enteredAt) {
        // Same generation still blocked — refresh the snapshot so the pending
        // timer appends the latest (a notice may have filled since it was
        // scheduled). Do NOT reset the timer: the debounce window is anchored to
        // the first observation.
        existing.latestSession = s
        return
      }
      // A new generation (rapid re-block) — the old timer would no-op against the
      // new statusEnteredAt and never schedule this one until the safety tick.
      // Cancel it and reschedule for the new generation.
      clearTimeout(existing.timer)
      this.blockedTimers.delete(key)
    }
    const timer = setTimeout(() => {
      const pending = this.blockedTimers.get(key)
      this.blockedTimers.delete(key)
      // Confirm the session is STILL blocked on the same generation before
      // appending, then append the FRESHEST captured snapshot.
      const cur = this.sessionCache.get(key)
      if (pending && cur?.status === 'blocked' && cur.statusEnteredAt === enteredAt) {
        void this.appendSessionEdge('session_blocked', pending.latestSession, this.deps.now()).then(() => void this.recompute())
      }
    }, BLOCKED_DEBOUNCE_MS)
    timer.unref?.()
    this.blockedTimers.set(key, { enteredAt, latestSession: s, timer })
  }

  private cancelBlockedEdge(key: string): void {
    const p = this.blockedTimers.get(key)
    if (p) { clearTimeout(p.timer); this.blockedTimers.delete(key) }
  }

  // ── Edge append (idempotent; marks the generation as a live edge → toast) ───

  private async appendSessionEdge(
    type: 'session_idle' | 'session_blocked' | 'session_crashed',
    s: LiveSession,
    nowMs: number,
  ): Promise<void> {
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
