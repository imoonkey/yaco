import { type Page } from '@playwright/test'

// Manual HTML5 drag-and-drop for the workspace pane DnD (combined-e2e).
//
// Headless Chromium does NOT initiate a native HTML5 drag from synthetic mouse
// moves — `page.mouse.down()/move()` never fires `dragstart`, so the app's drag
// handlers would never run (verified: a real-mouse drag renders zero drop-zone
// overlays). Instead we dispatch the genuine `dragstart` → `dragenter` →
// `dragover` → `drop` → `dragend` DOM events ON the real rendered source/target
// elements, at real viewport coordinates, carrying ONE shared `DataTransfer`
// (the app tags it with its pane mime inside `drag.start`). This drives the
// EXACT same React `onDragStart/onDragOver/onDrop` handlers the user's drag
// fires — the same affordances (a tab, a tab-bar background, a dock grab handle,
// a body edge, a sidebar, an edge strip) — so the specs assert user-observable
// outcomes (split axis, merge, bindings), never selector existence alone.
//
// The live drag spans calls: `dragBegin` stores the DataTransfer + source on
// `window.__dnd` (same JS realm across page.evaluate calls) and the app's
// module-singleton payload stays set, so a spec can assert the mid-drag overlay
// feedback (drop-zone / sidebar-drop / edge-strip) BEFORE dropping.

/** A point inside a target rect, as fractions (default = centre). */
export type Frac = { fx?: number; fy?: number }

/** Begin a live pane drag from `srcSel` (its centre). Leaves the drag live: the
 *  app's payload is set and feedback overlays render on subsequent dragover. */
export async function dragBegin(page: Page, srcSel: string): Promise<void> {
  await page.evaluate((srcSel) => {
    const src = document.querySelector(srcSel)
    if (!src) throw new Error(`drag source not found: ${srcSel}`)
    const r = src.getBoundingClientRect()
    const dt = new DataTransfer()
    ;(window as unknown as { __dnd: unknown }).__dnd = { dt, src }
    const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, composed: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 })
    Object.defineProperty(ev, 'dataTransfer', { value: dt })
    src.dispatchEvent(ev)
  }, srcSel)
  // WorkspaceDragContext intentionally notifies drop targets on the next frame so
  // Chrome does not abort the native drag from same-dispatch DOM mutations.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

/** Dispatch dragenter+dragover over `targetSel` at `frac` (default centre),
 *  using the live drag's DataTransfer. Lets feedback overlays render. */
export async function dragOver(page: Page, targetSel: string, frac: Frac = {}): Promise<void> {
  await page.evaluate(({ targetSel, fx, fy }) => {
    const dnd = (window as unknown as { __dnd?: { dt: DataTransfer } }).__dnd
    if (!dnd) throw new Error('dragOver without a live drag')
    const tgt = document.querySelector(targetSel)
    if (!tgt) throw new Error(`drag target not found: ${targetSel}`)
    const r = tgt.getBoundingClientRect()
    const x = r.x + r.width * fx, y = r.y + r.height * fy
    for (const type of ['dragenter', 'dragover']) {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y })
      Object.defineProperty(ev, 'dataTransfer', { value: dnd.dt })
      tgt.dispatchEvent(ev)
    }
  }, { targetSel, fx: frac.fx ?? 0.5, fy: frac.fy ?? 0.5 })
}

/** Drop the live drag on `targetSel` at `frac`, then end the drag (dragend on the
 *  source, clear the handle). The app's drop handler recomputes the zone fresh. */
export async function dragDrop(page: Page, targetSel: string, frac: Frac = {}): Promise<void> {
  await page.evaluate(({ targetSel, fx, fy }) => {
    const dnd = (window as unknown as { __dnd?: { dt: DataTransfer; src: Element } }).__dnd
    if (!dnd) throw new Error('dragDrop without a live drag')
    const tgt = document.querySelector(targetSel)
    if (!tgt) throw new Error(`drop target not found: ${targetSel}`)
    const r = tgt.getBoundingClientRect()
    const x = r.x + r.width * fx, y = r.y + r.height * fy
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y })
    Object.defineProperty(drop, 'dataTransfer', { value: dnd.dt })
    tgt.dispatchEvent(drop)
    const end = new DragEvent('dragend', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y })
    Object.defineProperty(end, 'dataTransfer', { value: dnd.dt })
    dnd.src.dispatchEvent(end)
    delete (window as unknown as { __dnd?: unknown }).__dnd
  }, { targetSel, fx: frac.fx ?? 0.5, fy: frac.fy ?? 0.5 })
}

/** The common case: begin at `srcSel`, drag over `targetSel`, drop there. */
export async function paneDragDrop(page: Page, srcSel: string, targetSel: string, frac: Frac = {}): Promise<void> {
  await dragBegin(page, srcSel)
  await dragOver(page, targetSel, frac)
  await dragDrop(page, targetSel, frac)
}

// --- Stable selectors for the real drag affordances --------------------------

/** A group's body drop surface (the DropOverlay) — the split/merge target. */
export const groupBodySel = (groupId: string) => `[data-group-id="${groupId}"] > div:not([data-group-tab-bar])`
/** A group's tab-bar background — the whole-group drag source AND a merge target. */
export const groupBgSel = (groupId: string) => `[data-group-id="${groupId}"] [data-testid="group-empty-area"]`
/** A group-tab by its visible title — a tab drag source. */
export const tabSel = (title: string) => `[data-testid="group-tab"][title="${title}"]`
/** A dock's grab handle (drag source) by its panel title, e.g. "Files". */
export const dockGrabSel = (title: string) => `button[aria-label="Move ${title} panel"]`
/** A sidebar drop overlay (rendered only while a legal drag is live). */
export const sidebarDropSel = (region: 'left' | 'right') => `[data-sidebar-drop="${region}"]`
/** A far-edge reveal strip (rendered only during a dock drag). */
export const edgeStripSel = (side: 'left' | 'right') => `[data-edge-strip="${side}"]`
