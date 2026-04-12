import { useCallback } from 'react'
import { isDiffTab, isFileTab } from '../hooks/workspaceTypes'
import type { MobilePane } from '../hooks/workspaceTypes'
import type { SearchEntry } from './WorkspaceSearch'
import type { FileExplorerHandle } from '../components/FileExplorer'

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'

interface UseWorkspaceNavigationOpts {
  actions: {
    openFileTab: (path: string) => void
    openPreviewTab: (path: string) => void
    openPreviewDiffTab: (path: string) => void
    openDiffTab: (path: string) => void
    openTasksTab: () => void
    setActiveTab: (tab: string) => void
    setMobilePane: (pane: MobilePane) => void
    updateLayout: (patch: Record<string, unknown>) => void
  }
  activeTab: string | null
  previewTab: string | null
  showSidebar: boolean
  showExplorer: boolean
  expandDir: (path: string) => Promise<void>
  explorerRef: React.RefObject<FileExplorerHandle | null>
  setSelectedFilePath: (path: string | null) => void
  setFocusTarget: (t: FocusTarget) => void
}

export function useWorkspaceNavigation(opts: UseWorkspaceNavigationOpts) {
  const {
    actions, activeTab, previewTab,
    showSidebar, showExplorer, expandDir, explorerRef,
    setSelectedFilePath, setFocusTarget,
  } = opts

  const openFile = useCallback((path: string, focus: FocusTarget = 'editor') => {
    actions.openFileTab(path)
    setSelectedFilePath(path)
    setFocusTarget(focus)
    actions.setMobilePane('editor')
  }, [actions, setSelectedFilePath, setFocusTarget])

  const openFileFromExplorer = useCallback((path: string) => {
    openFile(path, 'explorer')
  }, [openFile])

  const openPreviewFromExplorer = useCallback((path: string) => {
    actions.openPreviewTab(path)
    setSelectedFilePath(path)
    setFocusTarget('explorer')
    actions.setMobilePane('editor')
  }, [actions, setSelectedFilePath, setFocusTarget])

  /** Load all parent directories from the server so their children are available in the tree */
  const revealInExplorer = useCallback(async (filePath: string) => {
    const parts = filePath.split('/')
    for (let i = 1; i < parts.length; i++) {
      await expandDir(parts.slice(0, i).join('/'))
    }
  }, [expandDir])

  const handleExpandFolder = useCallback(async (folderPath: string) => {
    // Load parent dirs + target dir from server so children are in the tree
    const parts = folderPath.split('/')
    for (let i = 1; i <= parts.length; i++) {
      await expandDir(parts.slice(0, i).join('/'))
    }
    if (!showSidebar || !showExplorer) {
      actions.updateLayout({ showSidebar: true, showExplorer: true })
      requestAnimationFrame(() => explorerRef.current?.expandToPath(folderPath))
    } else {
      explorerRef.current?.expandToPath(folderPath)
    }
  }, [showSidebar, showExplorer, actions, explorerRef, expandDir])

  const openFileAtLine = useCallback(async (path: string, _line: number, _column: number) => {
    await revealInExplorer(path)
    actions.openFileTab(path)
    setSelectedFilePath(path)
    setFocusTarget('editor')
    actions.setMobilePane('editor')
  }, [actions, revealInExplorer, setSelectedFilePath, setFocusTarget])

  const handleSearchSelect = useCallback(async (entry: SearchEntry) => {
    await revealInExplorer(entry.path)
    actions.openPreviewTab(entry.path)
    setSelectedFilePath(entry.path)
    setFocusTarget('editor')
    actions.setMobilePane('editor')
  }, [revealInExplorer, actions, setSelectedFilePath, setFocusTarget])

  const activateChange = useCallback(async (path: string) => {
    if (activeTab === `diff:${path}`) {
      openFile(path)
      return
    }
    // Reveal in explorer: load parent dirs so the file appears in the tree
    await revealInExplorer(path)
    actions.openPreviewDiffTab(path)
    setSelectedFilePath(path)
    setFocusTarget('editor')
    actions.setMobilePane('editor')
  }, [activeTab, actions, openFile, revealInExplorer, setSelectedFilePath, setFocusTarget])

  const handleOpenTasks = useCallback(() => {
    actions.openTasksTab()
    setFocusTarget('editor')
    actions.setMobilePane('editor')
  }, [actions, setFocusTarget])

  const handleOpenTasksFile = useCallback(() => {
    openFile('doc/todo/tasks.json')
  }, [openFile])

  const handleSelectTab = useCallback((tab: string) => {
    actions.setActiveTab(tab)
    setFocusTarget('editor')
    if (isFileTab(tab)) {
      setSelectedFilePath(tab)
    }
  }, [actions, setFocusTarget, setSelectedFilePath])

  const handleDoubleClickTab = useCallback((tab: string) => {
    if (tab !== previewTab) return
    if (isFileTab(tab)) actions.openFileTab(tab)
    if (isDiffTab(tab)) actions.openDiffTab(tab.slice(5))
  }, [previewTab, actions])

  return {
    openFile,
    openFileFromExplorer,
    openPreviewFromExplorer,
    openFileAtLine,
    handleExpandFolder,
    revealInExplorer,
    handleSearchSelect,
    activateChange,
    handleOpenTasks,
    handleOpenTasksFile,
    handleSelectTab,
    handleDoubleClickTab,
  }
}
