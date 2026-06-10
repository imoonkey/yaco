// Panel registry — the contract each panel exports, plus the lookup the renderer
// drives through `PanelHost`.
//
// Design: "Panels are registered once and rendered through PanelHost." A panel
// is a self-contained component that reads the workspace contexts via hooks, so
// its definition carries no props. The component-free half of that definition —
// where it docks on mobile, its order, its min size, whether it draws its own
// chrome (`unframed`) or borrows the shared panel header (`framed`), and its
// title — lives in `panelMeta` (the source of truth the pure layout logic reads
// for min sizes). This file COMPOSES that metadata with each panel's React
// `Component` (and, for framed panels, the panel-local `useHeader` hook that
// publishes the header's dynamic title, actions, badge, and stats).
import type { ComponentType, ReactNode } from 'react'
import type { PanelMeta } from './panelMeta'
import { projectsPanelDef } from './panels/ProjectsPanel'
import { filesPanelDef } from './panels/FilesPanel'
import { changesPanelDef } from './panels/ChangesPanel'
import { sessionsPanelDef } from './panels/SessionsPanel'
import { editorPanelDef } from './panels/EditorPanel'
import { terminalPanelDef } from './panels/TerminalPanel'
import { taskGraphPanelDef } from './panels/TaskGraphPanel'

// What a framed panel publishes into its shared header, laid out by PanelFrame
// the same way `SectionHeader` lays out its title/stats/badge/actions. Every
// field is optional: a plain framed panel publishes nothing and just shows its
// static title. `title` here overrides the def's static title for headers whose
// label depends on live state (e.g. Changes stale flag, dynamic explorer title).
export type PanelHeaderSlots = {
  title?: string
  actions?: ReactNode
  badge?: number
  stats?: ReactNode
}

// Published by a framed panel as a hook so it runs inside the workspace
// providers and can read contexts/resources. Returns the live header slots.
export type PanelHeaderHook = () => PanelHeaderSlots

// A full panel definition is its component-free metadata plus the React surface:
// the propless `Component`, and (framed panels only) the `useHeader` hook. Omit
// `useHeader` for a header with no actions/badge/stats, or for unframed panels.
export type PanelDefinition = PanelMeta & {
  Component: ComponentType
  useHeader?: PanelHeaderHook
}

// Assembled from the per-panel exported defs. Registration order is the mobile
// projection / tree-renderer read order; dock/min-size metadata lives on each
// def (spread from `panelMeta`). The merge hotspot is exactly this one array.
const PANEL_DEFINITIONS: readonly PanelDefinition[] = [
  projectsPanelDef,
  filesPanelDef,
  changesPanelDef,
  sessionsPanelDef,
  editorPanelDef,
  terminalPanelDef,
  taskGraphPanelDef,
]

// Keyed by string (not PanelId) so a corrupt/stale id from a persisted layout
// tree looks up safely and misses, instead of forcing callers to cast.
const REGISTRY: ReadonlyMap<string, PanelDefinition> = new Map(
  PANEL_DEFINITIONS.map((def) => [def.id, def]),
)

/** The registered panel, or `undefined` for anything no panel has registered: a
 *  stale/garbage id from a corrupt layout tree, or a non-string value. Callers
 *  render a placeholder for `undefined`; this never throws. */
export function getPanelDefinition(id: unknown): PanelDefinition | undefined {
  return typeof id === 'string' ? REGISTRY.get(id) : undefined
}

/** All registered panels in registration order — used by the mobile projection
 *  and tree renderer to read dock/order/min-size metadata. */
export function allPanelDefinitions(): readonly PanelDefinition[] {
  return PANEL_DEFINITIONS
}
