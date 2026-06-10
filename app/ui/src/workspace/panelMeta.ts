// Panel metadata — the component-free facts about each panel: where it docks on
// mobile, its order, its min size, its chrome mode, and its title. This is the
// SOLE source of truth for that metadata; `panelRegistry` composes it with each
// panel's React component into the full `PanelDefinition`.
//
// Why this module is component-free: the pure layout logic (`panelLayoutModel`,
// `usePanelResize`) needs panel min sizes to clamp split bases, but must NOT pull
// in the React components — `panelRegistry` statically imports all seven panels,
// which transitively import `panelLayoutModel`. Reading min sizes from here keeps
// that logic free of any import path back into the components.
import type { PanelId, WorkspaceEnv } from './context'

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

/** The component-free metadata for one panel. `panelRegistry` extends this with
 *  the panel's `Component` (and optional `useHeader`) to form a full
 *  `PanelDefinition`. */
export type PanelMeta = {
  id: PanelId
  title: PanelTitle
  chrome: PanelChrome
  mobileDock: MobileDock
  mobileOrder: number
  minSize: PanelMinSize
}

// The seven panels' metadata, keyed by id. Each panel file spreads its entry
// into the co-located definition it exports; this keeps min sizes / dock / order
// in one place rather than duplicated across the panel modules.
export const PANEL_META: Record<PanelId, PanelMeta> = {
  projects: { id: 'projects', title: 'Projects', chrome: 'framed', mobileDock: 'browse', mobileOrder: 0, minSize: { width: 160, height: 60 } },
  files: { id: 'files', title: ({ env }) => env.project.name || 'Explorer', chrome: 'framed', mobileDock: 'browse', mobileOrder: 1, minSize: { width: 180, height: 80 } },
  changes: { id: 'changes', title: 'Changes', chrome: 'framed', mobileDock: 'browse', mobileOrder: 2, minSize: { width: 140, height: 50 } },
  sessions: { id: 'sessions', title: 'Sessions', chrome: 'framed', mobileDock: 'browse', mobileOrder: 3, minSize: { width: 250, height: 50 } },
  editor: { id: 'editor', title: 'Editor', chrome: 'unframed', mobileDock: 'editor', mobileOrder: 0, minSize: { width: 320, height: 200 } },
  terminal: { id: 'terminal', title: 'Terminal', chrome: 'unframed', mobileDock: 'terminal', mobileOrder: 0, minSize: { width: 280, height: 120 } },
  tasks: { id: 'tasks', title: 'Tasks', chrome: 'unframed', mobileDock: 'tasks', mobileOrder: 0, minSize: { width: 360, height: 240 } },
}

// Keyed by string (not PanelId) so a corrupt/stale id from a persisted layout
// tree looks up safely and misses, instead of forcing callers to cast.
const META_BY_ID: ReadonlyMap<string, PanelMeta> = new Map(
  Object.values(PANEL_META).map((meta) => [meta.id, meta]),
)

/** The metadata for a panel id, or `undefined` for a stale/garbage id from a
 *  corrupt layout tree or a non-string value. Pure-logic callers read min sizes
 *  through this without ever touching the React components. */
export function getPanelMeta(id: unknown): PanelMeta | undefined {
  return typeof id === 'string' ? META_BY_ID.get(id) : undefined
}

/** Resolve a panel title to a string for the frame header. */
export function resolvePanelTitle(title: PanelTitle, env: WorkspaceEnv): string {
  return typeof title === 'function' ? title({ env }) : title
}
