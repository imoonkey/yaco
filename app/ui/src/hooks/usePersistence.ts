import { useState, useCallback, useRef, useEffect } from 'react'
import {
  type PersistedState,
  type PersistedDrafts,
  type WorkspaceLayout,
  type WorkspacePanelLayout,
  type LayoutNode,
  type EditorView,
  DEFAULT_LAYOUT,
  isFileTab,
  layoutKey,
  draftsKey,
  loadStoredSize,
  dedupeTabs,
} from './workspaceTypes'
import {
  defaultWorkspacePanelLayout, normalizeLayout,
  migrateTreeToGroups, mapEditorMru,
  editorInstancesInOrder, terminalInstancesInOrder,
  centerOf, firstCenterGroupId, groupOf, sidebarVisibility,
} from '../workspace/panelLayoutModel'

// --- Load helpers ---

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function defaultPersistedState(): PersistedState {
  const panelLayout = defaultWorkspacePanelLayout()
  return {
    terminalBindings: {},
    editorMru: [],
    terminalMru: [],
    activeGroupId: firstCenterGroupId(centerOf(panelLayout.desktop)) ?? '',
    mobilePane: 'files',
    layout: { ...DEFAULT_LAYOUT },
    recentFiles: [],
    panelLayout,
  }
}

/** Is this stored desktop tree ALREADY in the flat group shape (tabs nodes carry a
 *  `tabs` array, no `editor`/`terminal` leaves)? Distinguishes a new group blob
 *  (skip migration) from an old `panels[]`/leaf tree (migrate). */
function isGroupShapeTree(node: unknown): boolean {
  const raw = asRecord(node)
  if (raw.kind === 'leaf') return raw.panel !== 'editor' && raw.panel !== 'terminal'
  if (raw.kind === 'tabs') return Array.isArray(raw.tabs)
  if (raw.kind === 'split') {
    const children = Array.isArray(raw.children) ? raw.children : []
    return children.every((c) => isGroupShapeTree(asRecord(c).node))
  }
  return false
}

/** Did an OLD (pre-overlay) tree have its tasks tab active (the old MAIN_TABS node
 *  with `active: 'tasks'`)? That is the only signal that should open the desktop
 *  Tasks overlay on load — a stale `showTasks: true` (the OLD default, meaning the
 *  tasks tab merely existed) must not auto-open the full-width overlay. */
function oldTreeTasksActive(node: unknown): boolean {
  const raw = asRecord(node)
  if (raw.kind === 'tabs' && Array.isArray(raw.panels)) return raw.active === 'tasks'
  if (raw.kind === 'split' && Array.isArray(raw.children)) {
    return raw.children.some((c) => oldTreeTasksActive(asRecord(c).node))
  }
  return false
}

/** Parse the flat `WorkspaceLayout` bag, salvaging every field independently to
 *  its default. `pl` is `parsed.layout` (or `parsed` itself for very old blobs
 *  that stored the fields at the top level). */
function parseFlatLayout(pl: Record<string, unknown>): WorkspaceLayout {
  return {
    showSidebar: typeof pl.showSidebar === 'boolean' ? pl.showSidebar : DEFAULT_LAYOUT.showSidebar,
    showRightPanel: typeof pl.showRightPanel === 'boolean' ? pl.showRightPanel : DEFAULT_LAYOUT.showRightPanel,
    showProjects: typeof pl.showProjects === 'boolean' ? pl.showProjects : DEFAULT_LAYOUT.showProjects,
    showExplorer: typeof pl.showExplorer === 'boolean' ? pl.showExplorer : DEFAULT_LAYOUT.showExplorer,
    showSessions: typeof pl.showSessions === 'boolean' ? pl.showSessions : DEFAULT_LAYOUT.showSessions,
    showChanges: typeof pl.showChanges === 'boolean' ? pl.showChanges : DEFAULT_LAYOUT.showChanges,
    showTasks: typeof pl.showTasks === 'boolean' ? pl.showTasks : DEFAULT_LAYOUT.showTasks,
    showTextSearch: typeof pl.showTextSearch === 'boolean' ? pl.showTextSearch : DEFAULT_LAYOUT.showTextSearch,
    autocompleteEnabled: typeof pl.autocompleteEnabled === 'boolean' ? pl.autocompleteEnabled : DEFAULT_LAYOUT.autocompleteEnabled,
    previewMode: pl.previewMode === 'edit' || pl.previewMode === 'preview' || pl.previewMode === 'split' ? pl.previewMode
      : DEFAULT_LAYOUT.previewMode,
    splitDirection: pl.splitDirection === 'horizontal' || pl.splitDirection === 'vertical' ? pl.splitDirection : DEFAULT_LAYOUT.splitDirection,
    splitSize: typeof pl.splitSize === 'number' && pl.splitSize >= 20 && pl.splitSize <= 80 ? pl.splitSize : DEFAULT_LAYOUT.splitSize,
    leftSize: loadStoredSize(pl.leftSize, DEFAULT_LAYOUT.leftSize),
    rightSize: loadStoredSize(pl.rightSize, DEFAULT_LAYOUT.rightSize),
    explorerSize: loadStoredSize(pl.explorerSize, DEFAULT_LAYOUT.explorerSize),
    searchSize: loadStoredSize(pl.searchSize, DEFAULT_LAYOUT.searchSize),
    changesSize: loadStoredSize(pl.changesSize, DEFAULT_LAYOUT.changesSize),
    sessionSize: loadStoredSize(pl.sessionSize, DEFAULT_LAYOUT.sessionSize),
    projectSize: loadStoredSize(pl.projectSize, DEFAULT_LAYOUT.projectSize),
  }
}

/** Parse + salvage one legacy editor view: dedupe its tabs, drop the pre-group NUL
 *  tasks sentinel, and pin active/preview to a tab that survived. */
function parseEditorView(raw: unknown): EditorView {
  const r = asRecord(raw)
  const openTabs = dedupeTabs(Array.isArray(r.openTabs)
    ? (r.openTabs as unknown[]).filter((t): t is string => typeof t === 'string' && !t.startsWith('\0'))
    : [])
  const activeTab = typeof r.activeTab === 'string' && openTabs.includes(r.activeTab) ? r.activeTab : (openTabs[0] ?? null)
  const previewTab = typeof r.previewTab === 'string' && openTabs.includes(r.previewTab) ? r.previewTab : null
  return { openTabs, activeTab, previewTab }
}

/** The legacy per-editor views: the old `editorViews` map (v1 blob), or the single
 *  flat editor view (oldest blob — top-level openTabs/activeTab/previewTab) keyed as
 *  the home editor. The migration expands each into a group of per-file tabs. */
function parseOldViews(parsed: Record<string, unknown>): Record<string, EditorView> {
  if (parsed.editorViews && typeof parsed.editorViews === 'object') {
    const out: Record<string, EditorView> = {}
    for (const [id, v] of Object.entries(parsed.editorViews as Record<string, unknown>)) out[id] = parseEditorView(v)
    return out
  }
  return { editor: parseEditorView(parsed) }
}

function parseMru(raw: unknown, liveIds: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of raw) {
    if (typeof id === 'string' && liveIds.has(id) && !seen.has(id)) { seen.add(id); out.push(id) }
  }
  return out
}

/** Terminal bindings for live terminals, deduped to one terminal per session
 *  (keep the first in document order) — the 1-per-session invariant on load. */
function parseTerminalBindings(raw: unknown, orderedTerminalIds: string[]): Record<string, string> {
  const r = asRecord(raw)
  const liveIds = new Set(orderedTerminalIds)
  const seenSessions = new Set<string>()
  const out: Record<string, string> = {}
  for (const id of orderedTerminalIds) {
    const session = r[id]
    if (typeof session === 'string' && session && liveIds.has(id) && !seenSessions.has(session)) {
      seenSessions.add(session)
      out[id] = session
    }
  }
  return out
}

/** Does the tree have a group (tabs) node with this id? */
function hasGroupNode(node: LayoutNode, id: string): boolean {
  if (node.kind === 'tabs') return node.id === id
  if (node.kind === 'split') return node.children.some((c) => hasGroupNode(c.node, id))
  return false
}

/** A synthetic OLD-shape default tree (dock + main editor tabs node + optional
 *  terminal leaf + a sessions activity column) used to migrate a flat blob that
 *  never persisted a tree, so it lands the same dock as a stored old tree would.
 *  Tasks is the desktop overlay now, so it is not a leaf here. */
function syntheticOldTree(hasTerminal: boolean): Record<string, unknown> {
  const children: unknown[] = [
    { basis: 220, node: { kind: 'split', id: 'dock', axis: 'col', children: [
      { basis: 120, node: { kind: 'leaf', id: 'projects', panel: 'projects' } },
      { grow: true, node: { kind: 'leaf', id: 'files', panel: 'files' } },
      { basis: 150, node: { kind: 'leaf', id: 'changes', panel: 'changes' } },
    ] } },
    { grow: true, node: { kind: 'tabs', id: 'main', active: 'editor', panels: ['editor'] } },
  ]
  if (hasTerminal) children.push({ node: { kind: 'leaf', id: 'terminal', panel: 'terminal' } })
  children.push({ basis: 280, node: { kind: 'leaf', id: 'sessions', panel: 'sessions' } })
  return { kind: 'split', id: 'root', axis: 'row', children }
}

type LoadedTree = {
  panelLayout: WorkspacePanelLayout
  terminalBindings: Record<string, string>
  editorMru: string[]
  terminalMru: string[]
  activeGroupId: string
}

/** Load a stored NEW group blob: normalize + GC the aux maps, restore activeGroupId
 *  if it still names a live group. No migration. */
function loadGroupBlob(parsed: Record<string, unknown>, stored: Record<string, unknown>): LoadedTree {
  const panelLayout = normalizeLayout(stored)
  const tree = panelLayout.desktop
  const editorIds = new Set(editorInstancesInOrder(tree))
  const terminalOrder = terminalInstancesInOrder(tree)
  const storedActive = typeof parsed.activeGroupId === 'string' ? parsed.activeGroupId : ''
  const activeGroupId = storedActive && hasGroupNode(tree, storedActive) ? storedActive : (firstCenterGroupId(centerOf(tree)) ?? '')
  return {
    panelLayout,
    terminalBindings: parseTerminalBindings(parsed.terminalBindings, terminalOrder),
    editorMru: parseMru(parsed.editorMru, editorIds),
    terminalMru: parseMru(parsed.terminalMru, new Set(terminalOrder)),
    activeGroupId,
  }
}

/** Migrate an OLD blob (v1 panels/leaf tree, or the oldest flat blob) into the
 *  group model: expand every old editor's `openTabs` into per-file tabs, re-point
 *  `editorMru` through the migration id map, preserve terminal bindings + dirty
 *  buffers (the latter via the path-keyed file state), seed activeGroupId from the
 *  MRU head's group. */
function migrateOldBlob(parsed: Record<string, unknown>, flat: WorkspaceLayout): LoadedTree {
  const stored = asRecord(parsed.panelLayout)
  const isV1 = stored.version === 1
  const activeSession = typeof parsed.activeSession === 'string' ? parsed.activeSession : ''

  const oldTree = isV1 && stored.desktop ? stored.desktop : syntheticOldTree(!!activeSession)
  const oldViews = parseOldViews(parsed)
  const { tree: migratedTree, idMap } = migrateTreeToGroups(oldTree, oldViews)

  const panelState = isV1 ? stored.panelState : {
    editor: {
      previewMode: flat.previewMode,
      splitDirection: flat.splitDirection,
      splitSize: flat.splitSize,
      autocompleteEnabled: flat.autocompleteEnabled,
    },
  }
  const panelLayout = normalizeLayout({
    version: 1,
    desktop: migratedTree,
    mobile: isV1 ? stored.mobile : undefined,
    panelState,
  })
  const tree = panelLayout.desktop
  const editorIds = new Set(editorInstancesInOrder(tree))
  const terminalOrder = terminalInstancesInOrder(tree)

  const oldMru = Array.isArray(parsed.editorMru) ? parsed.editorMru : Object.keys(oldViews)
  const editorMru = mapEditorMru(oldMru, idMap).filter((id) => editorIds.has(id))

  let terminalBindings: Record<string, string>
  if (parsed.terminalBindings && typeof parsed.terminalBindings === 'object') {
    terminalBindings = parseTerminalBindings(parsed.terminalBindings, terminalOrder)
  } else if (activeSession && terminalOrder.includes('terminal')) {
    terminalBindings = { terminal: activeSession }
  } else {
    terminalBindings = {}
  }

  const terminalMru = Array.isArray(parsed.terminalMru)
    ? parseMru(parsed.terminalMru, new Set(terminalOrder))
    : (terminalBindings.terminal ? ['terminal'] : [])

  const head = editorMru[0]
  const activeGroupId = (head && groupOf(tree, head)) || (firstCenterGroupId(centerOf(tree)) ?? '')

  return { panelLayout, terminalBindings, editorMru, terminalMru, activeGroupId }
}

export function loadPersistedState(project: string, worktree?: string | null): PersistedState {
  try {
    const raw = localStorage.getItem(layoutKey(project, worktree))
    if (!raw) return defaultPersistedState()
    const parsed = JSON.parse(raw) as Record<string, unknown>

    const pl = (parsed.layout ?? parsed) as Record<string, unknown>
    const layout = parseFlatLayout(pl)

    const stored = asRecord(parsed.panelLayout)
    const isNewGroupBlob = stored.version === 1 && isGroupShapeTree(stored.desktop)
    // Tasks is the desktop overlay now (showTasks). A pre-overlay blob stored
    // showTasks=true as the OLD default (the tasks tab merely existed), which must
    // NOT auto-open the full-width overlay — open it only if tasks was actually active.
    if (!isNewGroupBlob) {
      layout.showTasks = stored.version === 1 && stored.desktop ? oldTreeTasksActive(stored.desktop) : false
    }
    const loaded: LoadedTree = isNewGroupBlob ? loadGroupBlob(parsed, stored) : migrateOldBlob(parsed, layout)

    // The flat `showSidebar`/`showRightPanel` flags and the tree's `hidden` flags
    // are persisted independently (and computed independently by the migration), so
    // a stale or mismatched blob can load with the flag disagreeing with the tree's
    // actual sidebar presence. The provider mirrors them bidirectionally (flag→tree
    // and tree→flag) — a mount-time disagreement makes those two effects fight one
    // render out of phase forever (React "Maximum update depth"). The tree is the
    // richer, DnD-aware representation, so derive the flags FROM it: load is always
    // self-consistent, and neither mirror has anything to reconcile on mount.
    const sidebars = sidebarVisibility(loaded.panelLayout.desktop)
    layout.showSidebar = sidebars.left
    layout.showRightPanel = sidebars.right

    return {
      terminalBindings: loaded.terminalBindings,
      editorMru: loaded.editorMru,
      terminalMru: loaded.terminalMru,
      activeGroupId: loaded.activeGroupId,
      mobilePane: parsed.mobilePane === 'files' || parsed.mobilePane === 'editor' || parsed.mobilePane === 'tasks' || parsed.mobilePane === 'terminal'
        ? parsed.mobilePane as PersistedState['mobilePane'] : 'files',
      layout,
      recentFiles: Array.isArray(parsed.recentFiles)
        ? (parsed.recentFiles as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 50)
        : [],
      panelLayout: loaded.panelLayout,
    }
  } catch {
    return defaultPersistedState()
  }
}

export function loadPersistedDrafts(project: string, worktree?: string | null): PersistedDrafts {
  try {
    const raw = localStorage.getItem(draftsKey(project, worktree))
    if (!raw) return { files: {} }
    const parsed = JSON.parse(raw) as PersistedDrafts
    if (!parsed.files || typeof parsed.files !== 'object') return { files: {} }
    const files = Object.fromEntries(
      Object.entries(parsed.files).filter(([path]) => isFileTab(path))
    )
    return { files }
  } catch {
    return { files: {} }
  }
}

// --- Save helpers ---

export function saveLayout(project: string, worktree: string | null | undefined, state: PersistedState): void {
  try {
    localStorage.setItem(layoutKey(project, worktree), JSON.stringify(state))
  } catch { /* layout is tiny — quota should never be an issue */ }
}

function saveDrafts(project: string, worktree: string | null | undefined, drafts: PersistedDrafts): void {
  try {
    localStorage.setItem(draftsKey(project, worktree), JSON.stringify(drafts))
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      const entries = Object.entries(drafts.files).sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      while (entries.length > 0) {
        entries.shift()
        try {
          localStorage.setItem(draftsKey(project, worktree), JSON.stringify({ files: Object.fromEntries(entries) }))
          return
        } catch { continue }
      }
      // All evicted — persist empty so next load doesn't restore stale data
      try { localStorage.setItem(draftsKey(project, worktree), JSON.stringify({ files: {} })) } catch { /* noop */ }
    }
  }
}

// --- Hook ---

/**
 * Two-phase persistence hook.
 * Phase 1: returns initialLayout + initialDrafts synchronously at mount.
 * Phase 2: call bindSnapshots() after state hooks are created to enable
 *          debounced saves and synchronous beforeunload/unmount flush.
 */
export function usePersistence(projectName: string, worktree?: string | null) {
  const [initialLayout] = useState(() => loadPersistedState(projectName, worktree))
  const [initialDrafts] = useState(() => loadPersistedDrafts(projectName, worktree))

  const projectRef = useRef(projectName)
  const worktreeRef = useRef(worktree)
  // Mirror latest project/worktree for flush callbacks that read without re-subscribing.
  useEffect(() => {
    projectRef.current = projectName
    worktreeRef.current = worktree
  })

  const layoutSnapshotRef = useRef<(() => PersistedState) | null>(null)
  const draftsSnapshotRef = useRef<(() => PersistedDrafts) | null>(null)

  const flushLayout = useCallback(() => {
    if (layoutSnapshotRef.current) {
      saveLayout(projectRef.current, worktreeRef.current, layoutSnapshotRef.current())
    }
  }, [])

  const flushDrafts = useCallback(() => {
    if (draftsSnapshotRef.current) {
      saveDrafts(projectRef.current, worktreeRef.current, draftsSnapshotRef.current())
    }
  }, [])

  // Debounce timers
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const draftsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const scheduleLayoutSave = useCallback(() => {
    clearTimeout(layoutTimer.current)
    layoutTimer.current = setTimeout(flushLayout, 300)
  }, [flushLayout])

  const scheduleDraftsSave = useCallback(() => {
    clearTimeout(draftsTimer.current)
    draftsTimer.current = setTimeout(flushDrafts, 500)
  }, [flushDrafts])

  // Synchronous flush on page unload
  useEffect(() => {
    const onBeforeUnload = () => {
      flushLayout()
      flushDrafts()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushLayout, flushDrafts])

  // Synchronous flush on unmount + timer cleanup
  useEffect(() => () => {
    flushLayout()
    flushDrafts()
    clearTimeout(layoutTimer.current)
    clearTimeout(draftsTimer.current)
  }, [flushLayout, flushDrafts])

  const bindSnapshots = useCallback((snapshots: {
    layoutRef: () => PersistedState
    draftsRef: () => PersistedDrafts
  }) => {
    layoutSnapshotRef.current = snapshots.layoutRef
    draftsSnapshotRef.current = snapshots.draftsRef
  }, [])

  return { initialLayout, initialDrafts, bindSnapshots, scheduleLayoutSave, scheduleDraftsSave }
}
