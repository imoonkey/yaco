// FilesPanel — the framed Files/Explorer panel.
//
// Owns (design: FilesPanel): `useFileTree`, the `FileExplorer` ref, the
// tree/search swap, lazy text search, create file/folder, collapse all, refresh,
// the git change markers (`gitMap`/`gitFolders`), and the local file-reveal
// controller (drains the provider's deferred reveal buffer).
//
// It is a pure consumer of the T1b contexts: it never imports `WorkspaceScreen`
// or the registry object. Layout/tab/session mutations all go through the command
// surface; only the file-tree-owned primitives (reveal + explorer create/refresh)
// stay panel-local.
//
// Chrome is `framed`: the shared section header is drawn by `PanelFrame`, and the
// dynamic title + explorer toolbar are published through `useFilesHeader` (the
// `useHeader` contract from `panelRegistry`).
import {
  lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import {
  ChevronsDownUp, FilePlus, FileSearch as FileSearchIcon, FolderPlus,
  Search, SearchCode, Undo2,
} from 'lucide-react'
import { useFileTree } from '../../hooks/useApi'
import { FileExplorer, type FileExplorerHandle } from '../../components/FileExplorer'
import { SectionRefreshButton } from '../SectionHeader'
import { useWorkspaceNavigation } from '../useWorkspaceNavigation'
import {
  useWorkspaceEnv, useWorkspaceDataContext, useWorkspaceSelection,
  useWorkspaceLayout, useWorkspaceCommands, useWorkspaceControllers,
  useOptionalWorkspacePanelResources,
} from '../context'
import { PANEL_META } from '../panelMeta'
import type { PanelDefinition, PanelHeaderSlots } from '../panelRegistry'

// Text search pulls the ripgrep stream UI; it stays lazy inside the panel.
const LazyWorkspaceTextSearch = lazy(() =>
  import('../WorkspaceTextSearch').then(m => ({ default: m.WorkspaceTextSearch })),
)

const TextSearchFallback = (
  <div className="flex items-center justify-center py-4">
    <div className="loading-spinner" />
  </div>
)

// Panel-local seam between the framed header and the body. `PanelFrame` renders
// the header (`useFilesHeader`) as a SIBLING of the body, so the two share no
// provider; the header's create/collapse/refresh actions need the body's
// imperative explorer handles. FilesPanel appears at most once in the layout
// tree, so a module-scoped handle is the simplest correct channel.
type FilesToolbar = {
  newFile: () => void
  newFolder: () => void
  collapseAll: () => void
  refresh: () => void | Promise<void>
}

const NOOP_TOOLBAR: FilesToolbar = {
  newFile: () => {},
  newFolder: () => {},
  collapseAll: () => {},
  refresh: () => {},
}

const toolbarRef: { current: FilesToolbar } = { current: NOOP_TOOLBAR }

// Reset targets for the file-reveal callbacks on unmount (ownership-checked).
// A hidden-dock / layout-move unmount must not leave provider commands calling
// this instance's stale closures. SessionsPanel owns `onSessionChange`; it is
// never registered or cleared here.
const NOOP_REVEAL_PARENTS = async (): Promise<void> => {}
const NOOP_DRAIN = (): void => {}

// The panel body. Exported for direct mounting/tests; integration consumes the
// `filesPanelDef` below.
export function FilesPanel() {
  const env = useWorkspaceEnv()
  const data = useWorkspaceDataContext()
  const { selectedFilePath } = useWorkspaceSelection()
  const { layout } = useWorkspaceLayout()
  const commands = useWorkspaceCommands()
  const { controllers: controllersRef, revealBuffer: revealBufferRef } = useWorkspaceControllers()

  const { name: projectName, path: projectPath, worktree } = env.project
  const showTextSearch = layout.showTextSearch
  const changes = data.git.changes
  const actions = commands.actions

  const explorerRef = useRef<FileExplorerHandle>(null)
  const [contextFolder, setContextFolder] = useState('')

  // Consume the provider-owned, ALWAYS-ON file tree (it survives section collapse
  // and dock hide, so loaded dirs + the quick-open staleness SSE never reset). The
  // local hook is a fallback for rendering outside the provider (isolation tests);
  // when the provider supplies the tree, it stays inert (null project → no fetch).
  const resources = useOptionalWorkspacePanelResources()
  const ownTree = useFileTree(resources ? null : projectName, resources ? null : worktree)
  const { data: fileTree, expandDir, patchTree, refresh: refreshTree, clearLoadedDirs } =
    resources?.fileTree ?? ownTree

  const nav = useWorkspaceNavigation({ expandDir, explorerRef })

  // Git status maps for the tree's change markers.
  const gitMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of changes) m.set(c.path, c.status)
    return m
  }, [changes])

  const gitFolders = useMemo(() => {
    const s = new Set<string>()
    for (const c of changes) {
      const parts = c.path.split('/')
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join('/'))
    }
    return s
  }, [changes])

  // Publish the header's imperative actions through the module seam. Reset on
  // unmount only if this instance still owns the handle (defensive against a
  // transient double-mount during a layout move).
  useEffect(() => {
    const toolbar: FilesToolbar = {
      newFile: () => explorerRef.current?.createFile(contextFolder || undefined),
      newFolder: () => explorerRef.current?.createFolder(contextFolder || undefined),
      collapseAll: () => { explorerRef.current?.collapseAll(); clearLoadedDirs() },
      refresh: () => refreshTree(),
    }
    toolbarRef.current = toolbar
    return () => { if (toolbarRef.current === toolbar) toolbarRef.current = NOOP_TOOLBAR }
  }, [contextFolder, clearLoadedDirs, refreshTree])

  // Local file-reveal controller (design: File Reveal Controller). The provider
  // records the latest intent in `revealBuffer` and asks the registered
  // controller to drain it; the panel drains the latest unconsumed intent.
  const { revealInExplorer, handleExpandFolder } = nav
  const drainedRevealKeyRef = useRef(0)
  const drainReveal = useCallback(() => {
    const intent = revealBufferRef.current
    if (!intent || intent.key === drainedRevealKeyRef.current) return
    drainedRevealKeyRef.current = intent.key
    if (intent.kind === 'folder') {
      void handleExpandFolder(intent.path)
    } else {
      void revealInExplorer(intent.path)
      actions.updateLayout({ showSidebar: true, showExplorer: true })
      requestAnimationFrame(() => explorerRef.current?.expandToPath(intent.path))
    }
  }, [revealBufferRef, revealInExplorer, handleExpandFolder, actions])

  // Register the file-reveal callbacks. Patch fields rather than replace the
  // object: `onSessionChange` on the same shared ref is owned by SessionsPanel.
  // Drain on registration and on every tree change so a buffered intent recorded
  // before the panel could act is never lost. On unmount, clear our callbacks
  // (only if still the registered owner) so the provider stops calling them.
  useEffect(() => {
    const ctl = controllersRef.current
    ctl.revealParents = revealInExplorer
    ctl.drainReveal = drainReveal
    drainReveal()
    return () => {
      if (ctl.revealParents === revealInExplorer) ctl.revealParents = NOOP_REVEAL_PARENTS
      if (ctl.drainReveal === drainReveal) ctl.drainReveal = NOOP_DRAIN
    }
  }, [controllersRef, revealInExplorer, drainReveal])
  useEffect(() => { drainReveal() }, [drainReveal, fileTree])

  const handleOpenFileAtLine = useCallback((path: string, line: number, column: number) => {
    void nav.openFileAtLine(path, line, column)
    actions.setJumpRequest({ key: Date.now(), path, line })
  }, [nav, actions])

  // The body is a flex column (min-h-0) so FileExplorer's flex-1 root fills and
  // measures the pane, matching the old section-body wrapper
  // (WorkspaceLayout.tsx). The framed header is supplied by PanelFrame.
  return (
    <div className="h-full min-h-0 flex flex-col">
      {showTextSearch ? (
        <Suspense fallback={TextSearchFallback}>
          <LazyWorkspaceTextSearch
            projectName={projectName}
            worktree={worktree}
            onOpenFileAtLine={handleOpenFileAtLine}
          />
        </Suspense>
      ) : (
        <FileExplorer
          ref={explorerRef}
          projectName={projectName}
          projectPath={projectPath}
          worktree={worktree}
          tree={fileTree}
          gitMap={gitMap}
          gitFolders={gitFolders}
          selectedFile={selectedFilePath}
          onSelectFile={nav.openFileFromExplorer}
          onPreviewFile={nav.openPreviewFromExplorer}
          onExpandDir={expandDir}
          onFocusExplorer={() => commands.setFocusTarget('explorer')}
          onContextFolder={setContextFolder}
          onNodeFocused={commands.setExplorerFocusedPath}
          onFileRenamed={commands.retargetPaths}
          onFileDeleted={commands.deletePath}
          patchTree={patchTree}
          refreshTree={refreshTree}
        />
      )}
    </div>
  )
}

// Framed header: dynamic title (project name, or "Search" in text-search mode)
// plus the explorer toolbar. Tree-mode actions that need the explorer's
// imperative handle dispatch through the module seam; the search-mode swap and
// quick-open route through the command surface (behavior-equivalent to today's
// `showTextSearch` toggle).
function useFilesHeader(): PanelHeaderSlots {
  const env = useWorkspaceEnv()
  const { layout } = useWorkspaceLayout()
  const commands = useWorkspaceCommands()
  const showTextSearch = layout.showTextSearch

  const actions = showTextSearch ? (
    <div className="flex gap-0.5 items-center">
      <button
        type="button"
        onClick={commands.showQuickOpen}
        className="section-header-icon-btn"
        title="Quick file search"
        aria-label="Quick file search"
      >
        <FileSearchIcon />
      </button>
      <button
        type="button"
        className="section-header-icon-btn"
        title="Full text search"
        aria-label="Full text search"
        aria-pressed="true"
      >
        <SearchCode />
      </button>
      <button
        type="button"
        onClick={() => commands.setFilesMode('tree')}
        className="section-header-icon-btn"
        title="Back to explorer"
        aria-label="Back to explorer"
      >
        <Undo2 />
      </button>
    </div>
  ) : (
    <div className="flex gap-0.5 items-center">
      <button
        type="button"
        onClick={() => commands.setFilesMode('search')}
        className="section-header-icon-btn"
        title="Search in files"
        aria-label="Search in files"
      >
        <Search />
      </button>
      <button
        type="button"
        onClick={() => toolbarRef.current.collapseAll()}
        className="section-header-icon-btn"
        title="Collapse All"
        aria-label="Collapse All"
      >
        <ChevronsDownUp />
      </button>
      <button
        type="button"
        onClick={() => toolbarRef.current.newFile()}
        className="section-header-icon-btn"
        title="New File"
        aria-label="New File"
      >
        <FilePlus />
      </button>
      <button
        type="button"
        onClick={() => toolbarRef.current.newFolder()}
        className="section-header-icon-btn"
        title="New Folder"
        aria-label="New Folder"
      >
        <FolderPlus />
      </button>
      <SectionRefreshButton onClick={() => toolbarRef.current.refresh()} title="Refresh explorer" />
    </div>
  )

  return {
    title: showTextSearch ? 'Search' : (env.project.name || 'Explorer'),
    actions,
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export const filesPanelDef: PanelDefinition = {
  ...PANEL_META.files,
  Component: FilesPanel,
  useHeader: useFilesHeader,
}
