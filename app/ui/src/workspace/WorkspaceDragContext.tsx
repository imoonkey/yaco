// WorkspaceDragContext — the dragged pane's identity during an HTML5 drag.
//
// Because `dataTransfer` is unreadable during `dragover`, the dragged identity
// can't ride the native event — it lives here instead, the analog of VSCode's
// `LocalSelectionTransfer`: a single shared transfer for the whole workspace
// tree. It is a module-level reactive store (not a React.createContext) so it is
// genuinely one identity across every group/dock and so `useDrag()` works in an
// isolation harness with no provider mounted.
//
// A custom `dataTransfer` type `application/yaco-pane` is set alongside the
// payload so the browser shows a move cursor and so foreign/native drags and the
// existing `text/plain` list reorders (ProjectList, WorkspaceSessionList) stay
// distinguishable — every pane drop target requires BOTH a live payload AND this
// mime, so a stray text/plain drag is never mistaken for a pane drag.
//
// Lifecycle cleanup is mandatory: the payload clears on drop, dragend, and a
// canceled drop at the source, plus window-level `dragend`/`drop` fallbacks here
// for a native drop outside the workspace or an unmount mid-drag (a stale payload
// would otherwise make the next innocuous dragover look like a live pane drag).
import { useSyncExternalStore } from 'react'
import type { PanelId } from './context'

/** The custom dataTransfer mime that marks a drag as a workspace pane drag. */
export const PANE_MIME = 'application/yaco-pane'

export type DragPayload =
  | { kind: 'tab'; fromGroupId: string; instanceId: string; tabKind: 'editor' | 'terminal' }
  | { kind: 'group'; groupId: string }
  | { kind: 'dock'; instanceId: string; panel: PanelId }

// The single shared transfer. A stable reference between changes means
// `useSyncExternalStore` re-renders consumers only when the payload truly flips.
let payload: DragPayload | null = null
const listeners = new Set<() => void>()
let notifyScheduled = false

function getPayload(): DragPayload | null {
  return payload
}

// Re-render subscribers on the NEXT frame, never synchronously. ANY synchronous React
// re-render committed from inside the `dragstart` handler makes Chrome ABORT the
// just-started native drag — no ghost, no dragover/drop/dragend, payload left stuck and
// the header frozen. This is NOT only about the source element: arming the drop overlays
// (a real DOM mutation) during the same dragstart dispatch aborts the drag too — verified
// with OS-level input. So even though drag SOURCES use the non-subscribing
// `useDragControls` (they never re-render on the flip they cause), the SUBSCRIBING drop
// targets must still be notified one frame LATER. The store VALUE is set synchronously
// below, so `peek()` (used by drop handlers) is always current; only the visual re-render
// is deferred one frame, after the drag is committed — well before the first dragover.
function scheduleNotify() {
  if (notifyScheduled) return
  notifyScheduled = true
  const run = () => {
    notifyScheduled = false
    for (const notify of listeners) notify()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else run()
}

function setPayload(next: DragPayload | null) {
  if (payload === next) return
  payload = next
  scheduleNotify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Begin a pane drag: record the identity AND tag the native event so the move
 *  cursor shows and drop targets can tell this apart from a foreign/list drag. */
function start(e: React.DragEvent, next: DragPayload) {
  // react-arborist (the file tree) mounts react-dnd's HTML5Backend, which installs a
  // window-level `dragstart` handler that calls preventDefault() on any native drag
  // it doesn't own — i.e. it would CANCEL our hand-rolled pane drag outright (no
  // ghost, no dragover/drop/dragend, payload left stuck). Stop the event before it
  // bubbles up to that window listener so our drag survives. (react-dnd's matching
  // capture-phase handler only records state; it never preventDefaults.)
  e.stopPropagation()
  if (e.dataTransfer) {
    e.dataTransfer.setData(PANE_MIME, next.kind)
    e.dataTransfer.effectAllowed = 'move'
  }
  setPayload(next)
}

/** Drop the dragged identity. Idempotent — safe to call from every cleanup path. */
function clear() {
  setPayload(null)
}

/** True when a drag carries our pane mime — the foreign-drag gate. A drop target
 *  must check this AND a live `peek()` payload before acting. */
export function isPaneDrag(e: React.DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(PANE_MIME)
}

// Window-level fallback: a native drop outside the workspace, or an unmount
// mid-drag, never reaches a source's `onDragEnd`, so clear here too.
if (typeof window !== 'undefined') {
  window.addEventListener('dragend', clear)
  window.addEventListener('drop', clear)
}

export type WorkspaceDrag = {
  /** Reactive snapshot for render-time feedback (e.g. dimming the dragged tab). */
  payload: DragPayload | null
  /** Live read for event handlers — avoids a stale snapshot closure on drop. */
  peek: () => DragPayload | null
  start: (e: React.DragEvent, payload: DragPayload) => void
  clear: () => void
}

/** Drag CONTROLS for drag SOURCES — `{ start, clear, peek }` only, with NO
 *  `useSyncExternalStore` subscription, so a source never re-renders on the payload
 *  flip its own `dragstart` causes (a synchronous re-render there aborts the native
 *  drag in Chrome; the subscribing drop targets are notified one frame later — see
 *  `scheduleNotify`). Module-level stable refs → identity-stable across renders. */
export function useDragControls(): Omit<WorkspaceDrag, 'payload'> {
  return { peek: getPayload, start, clear }
}

/** Read + drive the shared pane-drag identity. Subscribes — use ONLY in DROP
 *  targets that need the reactive `payload` (drop overlays / edge strips / tab-bar
 *  feedback), never on a drag SOURCE element (see `useDragControls`). */
export function useDrag(): WorkspaceDrag {
  const snapshot = useSyncExternalStore(subscribe, getPayload, getPayload)
  return { payload: snapshot, peek: getPayload, start, clear }
}
