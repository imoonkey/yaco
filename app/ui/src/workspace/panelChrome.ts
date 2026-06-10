// Panel chrome slots — how a renderer parameterizes a framed panel's section
// chrome without the panel (or PanelFrame) knowing which renderer hosts it.
//
// A framed panel draws a `SectionHeader`-equivalent header plus a body. WHERE it
// collapses to, and how tall/wide its body is, are RENDERER decisions (the old
// `WorkspaceLayout` sized each section body and toggled it via `show*` flags).
// The renderer publishes one slot per visible panel id; `PanelHost` looks up its
// panel's slot and hands it to `PanelFrame`. No slot (isolation tests, or a
// renderer that does not size sections) means "expanded, default fill" — the
// frame still renders, it just stops collapsing and uses its default body box.
//
// This is the same seam the phase-5 tree renderer will reuse, so collapse/size
// wiring lives in the renderer, not smeared across the panels.
import { createContext, useContext, type CSSProperties } from 'react'

export type PanelChromeSlot = {
  /** Section collapsed? Drives the header chevron/aria-expanded and hides the body. */
  collapsed: boolean
  /** Toggle handler the header invokes (maps to the renderer's collapse command). */
  onToggle: () => void
  /** Outer panel container className (default: a full-height flex column). */
  containerClassName?: string
  containerStyle?: CSSProperties
  /** Body wrapper className/style — carries the section's height/flex so the body
   *  measures exactly like the old per-section wrapper (default: flex-1 fill). */
  bodyClassName?: string
  bodyStyle?: CSSProperties
}

/** Keyed by panel id (string, not PanelId) so a stale/garbage id from a corrupt
 *  layout tree misses safely. `null` = no renderer slots in scope. */
export const PanelChromeContext =
  createContext<Record<string, PanelChromeSlot> | null>(null)

/** The chrome slot for a panel id, or undefined when no renderer published one. */
export function usePanelChromeSlot(id: string): PanelChromeSlot | undefined {
  return useContext(PanelChromeContext)?.[id]
}
