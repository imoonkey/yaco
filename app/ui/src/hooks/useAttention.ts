import { useState, useEffect, useRef, useCallback, createElement } from 'react'
import { toast } from 'sonner'
import { addSSEListener } from './useSSE'
import { ApiError } from '../lib/apiError'

// ── Client-local mirror of the server's AttentionSnapshot shape ────────────────
// Facet B is server-projected and pushed over the `attention` SSE event / served
// by `GET /api/attention/feed`. These types mirror the server contract
// (`app/server/src/lib/attention-projection.ts`); we deliberately do NOT import
// across packages (R4) — the client only consumes the JSON shape.

export type AttentionTier = 'critical' | 'action' | 'handoff' | 'fyi'

export type AttentionType =
  | 'session_crashed'
  | 'session_blocked'
  | 'task_blocked'
  | 'session_idle'
  | 'task_done'

export type AttentionGroup = 'needs-you' | 'ready' | 'recent'

export type AttentionSubject =
  | { kind: 'session'; project: string; sessionName: string }
  | { kind: 'task'; project: string; taskId: string; sessionNames: string[] }

export interface AttentionItem {
  generation: string
  type: AttentionType
  tier: AttentionTier
  group: AttentionGroup
  subject: AttentionSubject
  title: string
  message: string
  tsMs: number
  count: number
  interrupt: boolean
}

export type BadgeColor = 'red' | 'orange' | 'yellow' | null

export interface AttentionBadge {
  count: number
  color: BadgeColor
}

export interface AttentionSnapshot {
  needsYou: AttentionItem[]
  ready: AttentionItem[]
  recent: AttentionItem[]
  badgesByProject: Record<string, AttentionBadge>
  badgesBySession: Record<string, AttentionBadge>
  global: AttentionBadge
}

/** Task ids (for one project) the task graph chips off of: a `task_blocked` →
 *  blocked chip; a `task_done` → done chip. Derived from the snapshot. */
export interface AttentionTaskIds {
  blocked: Set<string>
  done: Set<string>
}

/** `/feed` adds the recent-history pagination cursor to the snapshot. */
interface AttentionFeed extends AttentionSnapshot {
  nextBefore: number | null
}

/** The session the user is currently attached to + viewing — the active-viewing
 *  target whose interrupts are suppressed and auto-acked (spec §5.5). */
export interface AttentionTarget {
  project: string
  sessionName: string
}

const EMPTY: AttentionSnapshot = {
  needsYou: [], ready: [], recent: [],
  badgesByProject: {}, badgesBySession: {}, global: { count: 0, color: null },
}

/** Coerce a (possibly partial/malformed) payload into the full snapshot shape.
 *  The cold feed and the SSE push are both external JSON; a missing array would
 *  crash `ingest` (it spreads `needsYou`/`ready`). Normalizing at the boundary
 *  keeps the app rendering even against a stale/empty server response. */
function normalizeSnapshot(raw: Partial<AttentionSnapshot> | null | undefined): AttentionSnapshot {
  return {
    needsYou: Array.isArray(raw?.needsYou) ? raw.needsYou : [],
    ready: Array.isArray(raw?.ready) ? raw.ready : [],
    recent: Array.isArray(raw?.recent) ? raw.recent : [],
    badgesByProject: raw?.badgesByProject ?? {},
    badgesBySession: raw?.badgesBySession ?? {},
    global: raw?.global ?? { count: 0, color: null },
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

async function fetchFeed(limit?: number, before?: number, signal?: AbortSignal): Promise<AttentionFeed> {
  const params = new URLSearchParams()
  if (limit != null) params.set('limit', String(limit))
  if (before != null) params.set('before', String(before))
  const qs = params.toString()
  const res = await fetch(`/api/attention/feed${qs ? `?${qs}` : ''}`, signal ? { signal } : undefined)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
  return res.json()
}

async function postAck(scope: 'project' | 'session' | 'task', project: string, key?: string): Promise<void> {
  const body = key != null ? { scope, project, key } : { scope, project }
  const res = await fetch('/api/attention/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const resBody = await res.json().catch(() => ({}))
    throw new ApiError(res.status, resBody)
  }
}

async function postClear(project: string): Promise<void> {
  const res = await fetch('/api/attention/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project }),
  })
  if (!res.ok) {
    const resBody = await res.json().catch(() => ({}))
    throw new ApiError(res.status, resBody)
  }
}

// ── Interrupt presentation ─────────────────────────────────────────────────────

function itemTitle(item: AttentionItem): string {
  const s = item.subject
  const loc = s.kind === 'session' ? `${s.project} / ${s.sessionName}` : `${s.project} / ${s.taskId}`
  return `${loc}: ${item.title}`
}

function hasPermission(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

export interface UseAttention {
  snapshot: AttentionSnapshot
  nextBefore: number | null
  loadMore: () => void
  ackProject: (project: string) => void
  ackSession: (project: string, sessionName: string) => void
  ackTask: (project: string, taskId: string) => void
  clear: (project: string) => void
  /** Request OS notification permission. Call ONLY from a user gesture (the bell);
   *  NEVER on mount (M13). No-op when unsupported / already decided. */
  requestPermission: () => void
  /** Current OS notification permission, or 'unsupported'. */
  permission: NotificationPermission | 'unsupported'
}

/**
 * Hidden-tab-safe Facet B consumer (spec §5.4, §5.5; eng-design §6 T7).
 *
 *  - Cold mount: `GET /api/attention/feed` for the initial snapshot.
 *  - Live: subscribe to the `attention` SSE event DIRECTLY (delivered even while
 *    `document.hidden`, unlike the polling hook) and replace the snapshot.
 *  - Interrupts: a newly-seen `interrupt` item fires a toast (visible) or an OS
 *    `new Notification` (hidden) — coalesced per generation, a burst collapsed to
 *    one summary (§10.5).
 *  - Active-viewing guard: when the user is visible && window-focused && attached
 *    to a target session, its interrupt is suppressed and its generation auto-acked
 *    (server records it monotonically; the live dot is unaffected).
 *
 * @param activeTarget the session the user is attached to + viewing (or null).
 * @param onItemClick  optional routing invoked when an interrupt is clicked.
 */
export function useAttention(
  activeTarget: AttentionTarget | null,
  onItemClick?: (item: AttentionItem) => void,
): UseAttention {
  const [snapshot, setSnapshot] = useState<AttentionSnapshot>(EMPTY)
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  )

  // Generations we've already interrupted for — dedupe so a reconnect / re-projection
  // re-pushing the same snapshot never re-toasts (§10.5).
  const seenInterrupts = useRef<Set<string>>(new Set())

  // Keep the active target + click handler in refs so the SSE listener effect
  // (registered once) always reads the latest without re-subscribing.
  const activeTargetRef = useRef(activeTarget)
  useEffect(() => { activeTargetRef.current = activeTarget }, [activeTarget])
  const onClickRef = useRef(onItemClick)
  useEffect(() => { onClickRef.current = onItemClick }, [onItemClick])

  const ackSession = useCallback((project: string, sessionName: string) => {
    postAck('session', project, sessionName).catch(() => { /* server resyncs via SSE */ })
  }, [])
  const ackProject = useCallback((project: string) => {
    postAck('project', project).catch(() => { /* server resyncs via SSE */ })
  }, [])
  const ackTask = useCallback((project: string, taskId: string) => {
    postAck('task', project, taskId).catch(() => { /* server resyncs via SSE */ })
  }, [])
  const clear = useCallback((project: string) => {
    postClear(project).catch(() => { /* server resyncs via SSE */ })
  }, [])

  /** visible && window-focused && this is the attached session (spec §5.5, M10). */
  const isActivelyViewing = useCallback((item: AttentionItem): boolean => {
    const target = activeTargetRef.current
    if (!target) return false
    if (document.visibilityState !== 'visible') return false
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false
    const s = item.subject
    if (s.kind === 'session') return s.project === target.project && s.sessionName === target.sessionName
    return s.project === target.project && s.sessionNames.includes(target.sessionName)
  }, [])

  /** Fire a toast (visible) or one OS notification (hidden) for a batch of newly
   *  interrupting items. A burst collapses to a single summary (§10.5). */
  const surfaceInterrupts = useCallback((items: AttentionItem[]) => {
    if (items.length === 0) return
    const visible = document.visibilityState === 'visible'

    if (items.length === 1) {
      const item = items[0]
      const title = itemTitle(item)
      if (visible) {
        toast.custom((id) =>
          createElement('div', {
            style: { padding: '12px 16px', cursor: 'pointer' },
            onClick: () => { toast.dismiss(id); onClickRef.current?.(item) },
          },
            createElement('div', { className: 'font-medium' }, title),
            item.message
              ? createElement('div', { style: { opacity: 0.7, fontSize: '0.875em', marginTop: 2 } }, item.message)
              : null,
          ),
        )
      } else if (hasPermission()) {
        const n = new Notification(title, { body: item.message, tag: item.generation })
        n.onclick = () => { window.focus(); onClickRef.current?.(item); n.close() }
      }
      return
    }

    // Burst → one summary (don't spam).
    const title = `${items.length} sessions need attention`
    const body = items.map(itemTitle).slice(0, 4).join('\n')
    if (visible) {
      toast.custom(() => createElement('div', { style: { padding: '12px 16px' } },
        createElement('div', { className: 'font-medium' }, title),
        createElement('div', { style: { opacity: 0.7, fontSize: '0.875em', marginTop: 2, whiteSpace: 'pre-line' } }, body),
      ))
    } else if (hasPermission()) {
      new Notification(title, { body, tag: 'attention-burst' })
    }
  }, [])

  /** Replace the snapshot + process interrupts (the single ingest point for both
   *  the cold feed and live SSE pushes). Normalizes the payload so a partial /
   *  malformed response can't crash the render. */
  const ingest = useCallback((raw: Partial<AttentionSnapshot> | null | undefined) => {
    const next = normalizeSnapshot(raw)
    setSnapshot(next)

    const fresh: AttentionItem[] = []
    for (const item of [...next.needsYou, ...next.ready]) {
      if (!item.interrupt) continue
      if (seenInterrupts.current.has(item.generation)) continue
      seenInterrupts.current.add(item.generation)
      if (isActivelyViewing(item)) {
        // Suppress + auto-ack the actively-viewed target's generation.
        if (item.subject.kind === 'session') ackSession(item.subject.project, item.subject.sessionName)
        continue
      }
      fresh.push(item)
    }
    surfaceInterrupts(fresh)
  }, [isActivelyViewing, ackSession, surfaceInterrupts])

  const ingestRef = useRef(ingest)
  useEffect(() => { ingestRef.current = ingest }, [ingest])

  // Cold mount: initial feed fetch.
  const loadFeed = useCallback((before?: number, signal?: AbortSignal) => {
    fetchFeed(undefined, before, signal)
      .then((feed) => {
        if (signal?.aborted) return
        const { nextBefore: nb, ...snap } = feed
        if (before == null) {
          ingestRef.current(snap)
          setNextBefore(nb)
        } else {
          // Pagination: append older recent rows, advance the cursor.
          const older = Array.isArray(snap.recent) ? snap.recent : []
          setSnapshot((prev) => ({ ...prev, recent: [...prev.recent, ...older] }))
          setNextBefore(nb)
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.warn('[useAttention] feed fetch failed:', err)
      })
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    loadFeed(undefined, ctrl.signal)
    return () => ctrl.abort()
  }, [loadFeed])

  const nextBeforeRef = useRef(nextBefore)
  useEffect(() => { nextBeforeRef.current = nextBefore }, [nextBefore])
  const loadMore = useCallback(() => {
    if (nextBeforeRef.current == null) return
    loadFeed(nextBeforeRef.current)
  }, [loadFeed])

  // Live: the `attention` SSE push (hidden-safe). Registered once.
  useEffect(() => {
    return addSSEListener('attention', (e) => {
      try {
        const snap = JSON.parse(e.data) as AttentionSnapshot
        ingestRef.current(snap)
      } catch { /* ignore malformed push */ }
    })
  }, [])

  // On visibilitychange → visible, refetch the feed (SSE force-reconnect lives in
  // useSSE). Cross-device acks/clears land too.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') loadFeed()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [loadFeed])

  const requestPermission = useCallback(() => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'default') return
    Notification.requestPermission().then((p) => setPermission(p)).catch(() => { /* ignore */ })
  }, [])

  return { snapshot, nextBefore, loadMore, ackProject, ackSession, ackTask, clear, requestPermission, permission }
}
