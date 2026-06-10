// Panel registry — the contract each phase-3 panel exports, plus the lookup the
// renderer drives through `PanelHost`.
//
// Design: "Panels are registered once and rendered through PanelHost." A panel
// is a self-contained component that reads the workspace contexts via hooks, so
// its definition carries no props — only the metadata layout/host code needs:
// where it docks on mobile, its order, its min size, whether it draws its own
// chrome (`unframed`) or borrows the shared panel header (`framed`), and — for
// framed panels — a panel-local hook that publishes the header's dynamic title,
// actions, badge, and stats (design: "panel actions are owned by panels … a
// framed panel can publish header actions through a small panel-local hook …
// used by PanelFrame").
//
// This file is SCAFFOLDING: `PANEL_DEFINITIONS` is empty in phase 2. Phase 3h
// (the serial integrator) assembles it from the per-panel exported defs — it is
// the single edit point, so the parallel phase-3 panel workers never touch this
// file and never conflict with each other.
import type { ComponentType, ReactNode } from 'react'
import type { PanelId, WorkspaceEnv } from './context'
import { projectsPanelDef } from './panels/ProjectsPanel'
import { filesPanelDef } from './panels/FilesPanel'
import { changesPanelDef } from './panels/ChangesPanel'
import { sessionsPanelDef } from './panels/SessionsPanel'
import { editorPanelDef } from './panels/EditorPanel'
import { terminalPanelDef } from './panels/TerminalPanel'
import { taskGraphPanelDef } from './panels/TaskGraphPanel'

// Mobile docks the four-pane projection renders into (design: Mobile rendering).
export type MobileDock = 'browse' | 'editor' | 'tasks' | 'terminal'

// `framed` borrows the shared panel header (projects/files/changes/sessions);
// `unframed` panels (editor/terminal/tasks) already own their chrome.
export type PanelChrome = 'framed' | 'unframed'

export type PanelMinSize = { width: number; height: number }

// A dynamic title resolves against the static/slow-changing env only, so a
// title may interpolate project/worktree without subscribing to hot selection
// state. Most panels use a plain string. Header state driven by live resources
// (e.g. Changes "(stale)") is published through `useHeader` instead.
export type PanelTitleContext = { env: WorkspaceEnv }

export type PanelTitle = string | ((ctx: PanelTitleContext) => string)

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

export type PanelDefinition = {
  id: PanelId
  title: PanelTitle
  chrome: PanelChrome
  mobileDock: MobileDock
  mobileOrder: number
  minSize: PanelMinSize
  Component: ComponentType
  // Framed panels only. Omit for a header with no actions/badge/stats, or for
  // unframed panels (which own their chrome).
  useHeader?: PanelHeaderHook
}

// Assembled (phase 3h) from the per-panel exported defs. Registration order is
// the mobile projection / tree-renderer read order; dock/min-size metadata lives
// on each def. The merge hotspot is exactly this one array, edited only here.
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

/** The registered panel, or `undefined` for anything no panel has registered:
 *  every id in phase 2, a stale/garbage id from a corrupt layout tree, or a
 *  non-string value. Callers render a placeholder for `undefined`; this never
 *  throws. */
export function getPanelDefinition(id: unknown): PanelDefinition | undefined {
  return typeof id === 'string' ? REGISTRY.get(id) : undefined
}

/** All registered panels in registration order — used by the mobile projection
 *  and tree renderer to read dock/order/min-size metadata. */
export function allPanelDefinitions(): readonly PanelDefinition[] {
  return PANEL_DEFINITIONS
}

/** Resolve a panel title to a string for the frame header. */
export function resolvePanelTitle(title: PanelTitle, env: WorkspaceEnv): string {
  return typeof title === 'function' ? title({ env }) : title
}
