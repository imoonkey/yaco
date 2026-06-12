import { useCallback } from 'react'
import { isDiffTab, isFileTab } from '../hooks/workspaceTypes'
import type { SearchEntry } from './WorkspaceSearch'
import type { FileExplorerHandle } from '../components/FileExplorer'
import { TASKS_FILE_PATH } from '../hooks/useTaskGraph'
import { useWorkspaceCommands, useWorkspaceSelection, useWorkspaceLayout, type FocusTarget } from './context'

interface UseWorkspaceNavigationOpts {
  // File-tree primitives stay screen-owned until FilesPanel takes them (phase 3).
  expandDir: (path: string) => Promise<void>
  explorerRef: React.RefObject<FileExplorerHandle | null>
}

export function useWorkspaceNavigation(opts: UseWorkspaceNavigationOpts) {
  const { expandDir, explorerRef } = opts
  const commands = useWorkspaceCommands()
  const { activeTab, previewTab } = useWorkspaceSelection()
  const { layout } = useWorkspaceLayout()
  const { showSidebar, showExplorer } = layout
  const actions = commands.actions
  const setSelectedFilePath = commands.setSelectedFilePath
  const setFocusTarget = commands.setFocusTarget

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

  const handleOpenTasksFile = useCallback(() => {
    openFile(TASKS_FILE_PATH)
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
    handleExpandFolder,
    revealInExplorer,
    handleSearchSelect,
    activateChange,
    handleOpenTasksFile,
    handleSelectTab,
    handleDoubleClickTab,
  }
}
