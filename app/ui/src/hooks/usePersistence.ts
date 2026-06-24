import { useState, useCallback, useRef, useEffect } from 'react'
import {
  type PersistedState,
  type PersistedDraftsByWorktree,
  type PersistedDraftEntry,
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
 *  Tasks is a group tab now (reopened with Cmd+Shift+T), so it is not a leaf here. */
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

export function loadPersistedState(project: string): PersistedState {
  try {
    const raw = localStorage.getItem(layoutKey(project))
    if (!raw) return defaultPersistedState()
    const parsed = JSON.parse(raw) as Record<string, unknown>

    const pl = (parsed.layout ?? parsed) as Record<string, unknown>
    const layout = parseFlatLayout(pl)

    const stored = asRecord(parsed.panelLayout)
    const isNewGroupBlob = stored.version === 1 && isGroupShapeTree(stored.desktop)
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

/** Validate + salvage one drafts bucket (a `relpath → entry` map): keep only real
 *  file tabs with a well-formed entry. Shared by the new multi-bucket reader and the
 *  legacy `{ files }` readers. */
function parseDraftBucket(raw: unknown): Record<string, PersistedDraftEntry> {
  const out: Record<string, PersistedDraftEntry> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isFileTab(path)) continue
    const e = value as Record<string, unknown>
    if (!e || typeof e !== 'object') continue
    if (typeof e.draft !== 'string' && e.draft !== null) continue
    out[path] = {
      draft: e.draft as string | null,
      baseRevision: typeof e.baseRevision === 'number' ? e.baseRevision : null,
      viewportLine: typeof e.viewportLine === 'number' ? e.viewportLine : 1,
      updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
    }
  }
  return out
}

/** A legacy single-bucket blob carries a top-level `files` object; the new
 *  multi-bucket record is keyed by worktree abspaths (never the literal "files").
 *  This discriminates the two on the SHARED `yaco-drafts:${project}` key. */
function isLegacyPrimaryBlob(parsed: unknown): parsed is { files: unknown } {
  return !!parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).files === 'object'
}

/** Merge a legacy bucket into an existing one, newer `updatedAt` winning per path —
 *  so a worktree carrying BOTH a pre-P1 slug key and a post-P1 abspath key (which
 *  canonicalize to the same bucket) keeps every path's freshest draft, order-
 *  independently. */
function mergeNewerWins(
  into: Record<string, PersistedDraftEntry> | undefined,
  add: Record<string, PersistedDraftEntry>,
): Record<string, PersistedDraftEntry> {
  if (!into) return add
  const out = { ...into }
  for (const [path, entry] of Object.entries(add)) {
    if (!out[path] || entry.updatedAt >= out[path].updatedAt) out[path] = entry
  }
  return out
}

/**
 * Load the on-disk drafts record, folding legacy keys in (design §P3 migration).
 * worktreeKey = abspath; primary = projectPath.
 *
 * Sources, in precedence order (earlier wins — a newer bucket is never clobbered by
 * a stale legacy fold):
 *  1. `yaco-drafts:${project}` — the new multi-bucket record, OR a legacy primary
 *     `{ files }` blob (same key, discriminated by shape → folded into `projectPath`).
 *     These buckets are AUTHORITATIVE (the post-migration store) — no legacy `:wt:`
 *     key overrides them.
 *  2. `yaco-drafts:${project}:wt:<suffix>` — legacy per-worktree blobs. The suffix is
 *     the raw worktree id `draftsKey` was called with: an ABSPATH (post-P1, e.g.
 *     `/repo/proj/.worktrees/B`) is the bucket key verbatim; a bare SLUG (pre-P1, e.g.
 *     `B`) resolves to `${projectPath}/.worktrees/<slug>` (the abspath that slug stood
 *     for). Folded only into buckets NOT already authoritative; duplicates that
 *     canonicalize to the same bucket merge newer-per-path (lossless).
 *
 * Runs synchronously at mount so the merged base exists before any save — this is
 * the r2 "gate the first save until the merge ran" data-loss guard.
 */
export function loadDraftsByWorktree(project: string, projectPath: string): PersistedDraftsByWorktree {
  const record: PersistedDraftsByWorktree = {}
  const authoritative = new Set<string>() // buckets from the primary blob — legacy never overrides

  try {
    const raw = localStorage.getItem(draftsKey(project))
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (isLegacyPrimaryBlob(parsed)) {
        record[projectPath] = parseDraftBucket(parsed.files)
        authoritative.add(projectPath)
      } else if (parsed && typeof parsed === 'object') {
        for (const [key, bucket] of Object.entries(parsed as Record<string, unknown>)) {
          record[key] = parseDraftBucket(bucket)
          authoritative.add(key)
        }
      }
    }
  } catch { /* corrupt blob — fall through to legacy fold */ }

  const legacyWtPrefix = `${draftsKey(project)}:wt:`
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(legacyWtPrefix)) continue
    const suffix = key.slice(legacyWtPrefix.length)
    // Post-P1 the worktree id IS an abspath → use it verbatim; a pre-P1 slug resolves
    // under `.worktrees/`. (A raw abspath suffixed under `.worktrees/<abspath>` would
    // never restore — the live worktree key is the abspath itself.)
    const abspath = suffix.startsWith('/') ? suffix : `${projectPath}/.worktrees/${suffix}`
    if (authoritative.has(abspath)) continue // the multi-bucket record already won
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? '') as { files?: unknown }
      const files = parseDraftBucket(parsed?.files)
      if (Object.keys(files).length > 0) record[abspath] = mergeNewerWins(record[abspath], files)
    } catch { /* skip corrupt legacy blob */ }
  }

  return record
}

// --- Save helpers ---

export function saveLayout(project: string, state: PersistedState): void {
  try {
    localStorage.setItem(layoutKey(project), JSON.stringify(state))
  } catch { /* layout is tiny — quota should never be an issue */ }
}

/** Drop empty buckets so the persisted record never grows a key for a worktree with
 *  no live drafts. */
function pruneEmptyBuckets(record: PersistedDraftsByWorktree): PersistedDraftsByWorktree {
  const out: PersistedDraftsByWorktree = {}
  for (const [key, files] of Object.entries(record)) {
    if (Object.keys(files).length > 0) out[key] = files
  }
  return out
}

function saveDrafts(project: string, record: PersistedDraftsByWorktree): void {
  const pruned = pruneEmptyBuckets(record)
  try {
    localStorage.setItem(draftsKey(project), JSON.stringify(pruned))
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'QuotaExceededError')) return
    // Evict the oldest (bucket, path) entries across ALL worktrees until it fits.
    const entries = Object.entries(pruned).flatMap(([key, files]) =>
      Object.entries(files).map(([path, entry]) => ({ key, path, entry })),
    ).sort((a, b) => a.entry.updatedAt - b.entry.updatedAt)
    while (entries.length > 0) {
      entries.shift()
      const rebuilt: PersistedDraftsByWorktree = {}
      for (const { key, path, entry } of entries) (rebuilt[key] ??= {})[path] = entry
      try {
        localStorage.setItem(draftsKey(project), JSON.stringify(pruneEmptyBuckets(rebuilt)))
        return
      } catch { continue }
    }
    // All evicted — persist empty so next load doesn't restore stale data.
    try { localStorage.setItem(draftsKey(project), JSON.stringify({})) } catch { /* noop */ }
  }
}

/**
 * One-shot migration commit. Legacy per-worktree blobs live under their OWN keys
 * (`yaco-drafts:${project}:wt:<suffix>`), separate from the new record. Folding them
 * into the base in memory is not enough: once a migrated bucket is emptied and
 * `saveDrafts` prunes it from the record, the stale legacy key would re-fold on the
 * next load and resurrect the cleared draft. So retire every legacy `:wt:` key, then
 * persist the merged base.
 *
 * Order matters: the base ALREADY holds the legacy data (folded by
 * `loadDraftsByWorktree` at mount), so we free the legacy storage FIRST and write the
 * merged record second. Writing first would transiently double the legacy data on
 * disk (legacy keys + the merged copy), and a near-quota user would then evict real
 * entries that actually fit post-migration — eviction the subsequent delete makes
 * irreversible. The delete + write are synchronous and adjacent (no await between),
 * so there is no crash window where the in-memory base could be lost.
 * (The legacy primary `{ files }` blob shares the new record's key, so the merged
 *  write overwrites it in place — no separate key to retire, no resurrection path.)
 */
export function commitDraftMigration(project: string, base: PersistedDraftsByWorktree): void {
  const prefix = `${draftsKey(project)}:wt:`
  const legacyKeys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith(prefix)) legacyKeys.push(key)
  }
  if (legacyKeys.length === 0) return
  for (const key of legacyKeys) localStorage.removeItem(key)
  saveDrafts(project, base)
}

// --- Hook ---

/**
 * Two-phase persistence hook.
 * Phase 1: returns initialLayout + initialDraftsByWorktree synchronously at mount.
 * Phase 2: call bindSnapshots() after state hooks are created to enable
 *          debounced saves and synchronous beforeunload/unmount flush.
 *
 * `projectPath` is the project root's absolute path — the primary worktree's bucket
 * key and the base for resolving legacy `:wt:<slug>` → abspath during migration.
 * Drafts persist as a multi-bucket record (one bucket per worktree abspath); layout
 * is project-global. The full migrated record is returned so `useFileState` seeds
 * EVERY bucket up front — under the no-remount flip a worktree switch restores its
 * drafts without a reload.
 */
export function usePersistence(projectName: string, projectPath: string) {
  const [initialLayout] = useState(() => loadPersistedState(projectName))

  // Migrate-on-mount: the full drafts record (legacy keys folded in) is BOTH the seed
  // `useFileState` restores every bucket from AND the base every flush overlays its
  // live buckets onto — so a background or migrated-but-unvisited bucket is never
  // clobbered by an active-only save. Computed once, synchronously, before any save
  // can run: the r2 first-save data-loss gate.
  const [initialDraftsByWorktree] = useState(() => loadDraftsByWorktree(projectName, projectPath))
  const draftsBaseRef = useRef(initialDraftsByWorktree)

  // Commit the migration once at mount: persist the merged base and retire the legacy
  // per-worktree keys so an emptied-then-pruned bucket can never resurrect from them.
  useEffect(() => {
    commitDraftMigration(projectName, draftsBaseRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const projectRef = useRef(projectName)
  // Mirror latest project for flush callbacks that read without re-subscribing.
  useEffect(() => {
    projectRef.current = projectName
  })

  const layoutSnapshotRef = useRef<(() => PersistedState) | null>(null)
  const draftsSnapshotRef = useRef<(() => PersistedDraftsByWorktree) | null>(null)

  const flushLayout = useCallback(() => {
    if (layoutSnapshotRef.current) {
      saveLayout(projectRef.current, layoutSnapshotRef.current())
    }
  }, [])

  const flushDrafts = useCallback(() => {
    if (!draftsSnapshotRef.current) return
    // Overlay the live (visited) buckets onto the migrated base, so unvisited and
    // background-worktree buckets survive every save. The merge becomes the new base.
    const merged = { ...draftsBaseRef.current, ...draftsSnapshotRef.current() }
    draftsBaseRef.current = merged
    saveDrafts(projectRef.current, merged)
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
    draftsRef: () => PersistedDraftsByWorktree
  }) => {
    layoutSnapshotRef.current = snapshots.layoutRef
    draftsSnapshotRef.current = snapshots.draftsRef
  }, [])

  return { initialLayout, initialDraftsByWorktree, bindSnapshots, scheduleLayoutSave, scheduleDraftsSave }
}
