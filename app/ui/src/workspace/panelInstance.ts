// PanelInstance — the per-instance identity a panel reads to know WHICH instance
// of its type it is (design: Multi-Instance Panels §D). The desktop/mobile
// renderers publish it via PanelHost; singletons get instanceId === type and
// ignore it. Also hosts the pure split-axis geometry helper and the focus/active
// marker decision so both stay component-free + unit-testable.
import { createContext, useContext } from 'react'
import type { PanelId, SplitSide } from './context'
import type { FocusedPane } from '../hooks/workspaceTypes'

/** `visible` is false for a body the renderer keeps MOUNTED but out of sight (a
 *  group's keep-alive terminal tabs — see `mountedTabs`). A panel that owns
 *  focus or a live connection reads it to know a switch happened; everything
 *  else can ignore it. */
export type PanelInstance = { type: PanelId; instanceId: string; visible: boolean }

const PanelInstanceContext = createContext<PanelInstance | null>(null)
export const PanelInstanceProvider = PanelInstanceContext.Provider

/** The pane's instance identity, or null outside a PanelHost (isolation tests). */
export function usePanelInstance(): PanelInstance | null {
  return useContext(PanelInstanceContext)
}

/** Default split side from a pane's live geometry (design: Interactions): a wide
 *  pane splits to the right (vertical divider), a tall one splits below. */
export function splitSideFromGeometry(width: number, height: number): SplitSide {
  return width >= height ? 'right' : 'below'
}

/** The orthogonal side (Cmd+K Cmd+\ flips the geometry default). */
export function orthogonalSide(side: SplitSide): SplitSide {
  return side === 'right' ? 'below' : side === 'below' ? 'right' : side === 'left' ? 'above' : 'left'
}

export type PaneMarker = { focused: boolean; active: boolean }

const NO_MARKER: PaneMarker = { focused: false, active: false }

/** Focus/active markers for an editor/terminal pane (design: §D). The focused
 *  pane is bright; the active-but-unfocused instance of that type is dim — but the
 *  dim marker is SUPPRESSED when the type has only one instance (no ambiguity).
 *  Non-whitelisted panels never get a marker. */
export function paneMarker(
  type: PanelId,
  instanceId: string,
  focusedPane: FocusedPane,
  activeEditorId: string,
  activeTerminalId: string | null,
  editorCount: number,
  terminalCount: number,
): PaneMarker {
  if (type !== 'editor' && type !== 'terminal') return NO_MARKER
  const focused = focusedPane.kind === type && focusedPane.instanceId === instanceId
  const activeId = type === 'editor' ? activeEditorId : activeTerminalId
  const count = type === 'editor' ? editorCount : terminalCount
  const active = !focused && activeId === instanceId && count > 1
  return { focused, active }
}
