import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo, forwardRef, useImperativeHandle, memo } from 'react'
import { Tree } from 'react-arborist'
import { moveFile, renameFile, deleteFile, createFile, createDir, revealInFinder } from '../hooks/useApi'
import { writeTextToClipboard } from '../lib/clipboard'
import { toast } from 'sonner'
import { ConfirmDialog } from './ConfirmDialog'
import { Menu, MenuItem, MenuDivider } from './Menu'
import { useContextMenu } from './useContextMenu'
import type { FileNode } from '../types'
export { GIT_COLORS } from './fileGitColors'
export { FileTypeIcon, FolderIcon } from './fileExplorerIcons'
import { FileNodeRenderer } from './fileExplorerNode'
import { ExplorerContext } from './explorerContext'

function insertPendingNode(nodes: FileNode[], pending: FileNode): FileNode[] {
  const i = pending.path.lastIndexOf('/')
  const parentPath = i > 0 ? pending.path.slice(0, i) : ''
  if (!parentPath) return [...nodes, pending]
  return nodes.map(n => {
    if (n.path === parentPath && n.type === 'dir') {
      return { ...n, children: [...(n.children || []), pending] }
    }
    return n.children ? { ...n, children: insertPendingNode(n.children, pending) } : n
  })
}

/** Rename a node in the tree (update path, name, and children paths recursively) */
function renameNodeInTree(nodes: FileNode[], oldPath: string, newPath: string): FileNode[] {
  const newName = newPath.split('/').pop() || ''
  return nodes.map(n => {
    if (n.path === oldPath) {
      const updated: FileNode = { ...n, path: newPath, name: newName }
      if (n.children) {
        updated.children = repathChildren(n.children, oldPath, newPath)
      }
      return updated
    }
    if (n.children) {
      return { ...n, children: renameNodeInTree(n.children, oldPath, newPath) }
    }
    return n
  })
}

/** Recursively update path prefixes for all children under a renamed dir */
function repathChildren(nodes: FileNode[], oldPrefix: string, newPrefix: string): FileNode[] {
  return nodes.map(n => {
    const newNodePath = newPrefix + n.path.slice(oldPrefix.length)
    const updated: FileNode = { ...n, path: newNodePath }
    if (n.children) {
      updated.children = repathChildren(n.children, oldPrefix, newPrefix)
    }
    return updated
  })
}

/** Remove a node from the tree by path */
function removeNodeFromTree(nodes: FileNode[], path: string): FileNode[] {
  return nodes.filter(n => n.path !== path).map(n => {
    if (n.children) return { ...n, children: removeNodeFromTree(n.children, path) }
    return n
  })
}

/** Move a node from one location to another in the tree */
function moveNodeInTree(nodes: FileNode[], sourcePath: string, destDir: string): { tree: FileNode[]; newPath: string } | null {
  // Find and extract the node
  let sourceNode: FileNode | null = null
  function findAndRemove(ns: FileNode[]): FileNode[] {
    return ns.filter(n => {
      if (n.path === sourcePath) { sourceNode = n; return false }
      return true
    }).map(n => n.children ? { ...n, children: findAndRemove(n.children) } : n)
  }
  const trimmed = findAndRemove(nodes)
  if (!sourceNode) return null

  const name = (sourceNode as FileNode).name
  const newPath = destDir ? `${destDir}/${name}` : name
  const movedNode: FileNode = { ...(sourceNode as FileNode), path: newPath }
  if (movedNode.children) {
    movedNode.children = repathChildren(movedNode.children, sourcePath, newPath)
  }

  // Insert into destination
  if (!destDir) return { tree: [...trimmed, movedNode], newPath }
  function insertInto(ns: FileNode[]): FileNode[] {
    return ns.map(n => {
      if (n.path === destDir && n.type === 'dir') {
        return { ...n, children: [...(n.children || []), movedNode] }
      }
      return n.children ? { ...n, children: insertInto(n.children) } : n
    })
  }
  return { tree: insertInto(trimmed), newPath }
}

// --- FileExplorer component ---
export interface FileExplorerHandle {
  createFile: (parentPath?: string) => void
  createFolder: (parentPath?: string) => void
  expandToPath: (folderPath: string) => void
  collapseAll: () => void
}

interface FileExplorerProps {
  projectName: string
  projectPath: string
  worktree?: string | null
  tree: FileNode[] | null
  gitMap: Map<string, string>
  gitFolders: Set<string>
  selectedFile: string | null
  onSelectFile: (path: string) => void
  onPreviewFile?: (path: string) => void
  onExpandDir?: (path: string) => void
  onFocusExplorer: () => void
  onContextFolder?: (path: string) => void
  onNodeFocused?: (path: string) => void
  onFileRenamed?: (oldPath: string, newPath: string) => void
  onFileDeleted?: (path: string) => void
  patchTree?: (fn: (prev: FileNode[] | null) => FileNode[] | null) => void
  refreshTree?: () => void | Promise<void>
}

const FileExplorerInner = forwardRef<FileExplorerHandle, FileExplorerProps>(
function FileExplorer({ projectName, projectPath, worktree, tree, gitMap, gitFolders, selectedFile, onSelectFile, onPreviewFile, onExpandDir, onFocusExplorer, onContextFolder, onNodeFocused, onFileRenamed, onFileDeleted, patchTree, refreshTree }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const rafIdRef = useRef<number | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const treeRef = useRef<any>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const menu = useContextMenu()
  const [menuTarget, setMenuTarget] = useState<{ path: string; type: 'file' | 'dir' } | null>(null)
  const [pendingCreate, setPendingCreate] = useState<{ path: string; type: 'file' | 'dir' } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)
  const pendingRef = useRef(pendingCreate)
  pendingRef.current = pendingCreate

  // P3 drop-remount: the workspace no longer remounts per worktree, so a worktree
  // switch re-roots the explorer to a different working directory IN PLACE. Drop any
  // armed interaction carried from the previous worktree — an open context menu, a
  // pending create input, a delete confirmation — BEFORE the next paint: confirming it
  // would run a destructive op (delete / move / rename / create) against the NEWLY
  // selected worktree's tree, and the callbacks already close over the new worktree.
  // useLayoutEffect resets pre-paint so no stale armed dialog is ever interactable.
  useLayoutEffect(() => {
    setMenuTarget(null)
    setConfirmDelete(null)
    setPendingCreate(null)
    pendingRef.current = null
    menu.close()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktree])

  const cancelCreate = useCallback(() => {
    pendingRef.current = null
    setPendingCreate(null)
  }, [])

  const measureContainer = useCallback((node?: HTMLDivElement | null) => {
    const container = node ?? containerRef.current
    if (!container) return
    const { width, height } = container.getBoundingClientRect()
    const next = {
      width: Math.round(width),
      height: Math.round(height),
    }
    setSize(current => current.width === next.width && current.height === next.height ? current : next)
  }, [])

  const setContainerNode = useCallback((node: HTMLDivElement | null) => {
    if (rafIdRef.current != null) {
      window.cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    resizeObserverRef.current?.disconnect()
    containerRef.current = node
    if (!node) return
    measureContainer(node)
    resizeObserverRef.current = new ResizeObserver(() => measureContainer(node))
    resizeObserverRef.current.observe(node)
    rafIdRef.current = window.requestAnimationFrame(() => measureContainer(node))
  }, [measureContainer])

  useEffect(() => () => {
    resizeObserverRef.current?.disconnect()
    if (rafIdRef.current != null) {
      window.cancelAnimationFrame(rafIdRef.current)
    }
  }, [])

  // Sync external selection → tree (e.g. when clicking a tab)
  useEffect(() => {
    if (!treeRef.current) return
    if (selectedFile) {
      const node = treeRef.current.get(selectedFile)
      if (node) {
        if (!node.isSelected) node.select()
        let parent = node.parent
        while (parent) {
          if (!parent.isOpen) parent.open()
          parent = parent.parent
        }
      }
    } else {
      treeRef.current.deselectAll()
    }
  }, [selectedFile])

  const bindContextMenu = (path: string, type: 'file' | 'dir') =>
    menu.bind(() => setMenuTarget({ path, type }))

  const reportContextFolder = useCallback((path: string, type: 'file' | 'dir') => {
    const folder = type === 'dir' ? path : parentOf(path)
    onContextFolder?.(folder)
    onNodeFocused?.(path)
  }, [onContextFolder, onNodeFocused])

  const parentOf = (path: string) => {
    const i = path.lastIndexOf('/')
    return i > 0 ? path.slice(0, i) : ''
  }

  const handleNewFile = useCallback((parentPath: string) => {
    menu.close()
    treeRef.current?.create({ type: 'leaf', parentId: parentPath || null })
  }, [menu])

  const handleNewFolder = useCallback((parentPath: string) => {
    menu.close()
    treeRef.current?.create({ type: 'internal', parentId: parentPath || null })
  }, [menu])

  const handleRename = useCallback(async (path: string) => {
    menu.close()
    const node = treeRef.current?.get(path)
    if (node) node.edit()
  }, [menu])

  const handleDelete = useCallback((path: string) => {
    menu.close()
    const selectedIds = treeRef.current?.selectedIds as Set<string> | undefined
    const targets = selectedIds && selectedIds.size > 1 && selectedIds.has(path)
      ? Array.from(selectedIds)
      : [path]
    setConfirmDelete(targets)
  }, [menu])

  const doDelete = useCallback(async () => {
    const paths = confirmDelete
    if (!paths || paths.length === 0) return
    patchTree?.(prev => {
      if (!prev) return prev
      let next = prev
      for (const p of paths) next = removeNodeFromTree(next, p)
      return next
    })
    const failures: string[] = []
    await Promise.all(paths.map(async (path) => {
      try {
        await deleteFile(projectName, path, worktree)
        onFileDeleted?.(path)
      } catch (err) {
        failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }))
    if (failures.length) {
      toast.error(failures.length === 1 ? `Failed to delete: ${failures[0]}` : `Failed to delete ${failures.length} items`)
      void refreshTree?.()
    }
  }, [confirmDelete, projectName, worktree, patchTree, refreshTree, onFileDeleted])

  const handleCopyRelativePath = useCallback((path: string) => {
    menu.close()
    void writeTextToClipboard(path)
  }, [menu])

  const handleCopyAbsolutePath = useCallback((path: string) => {
    menu.close()
    // worktree is the selected worktree's absolute path (null → the project root).
    const root = worktree ?? projectPath
    void writeTextToClipboard(`${root}/${path}`)
  }, [menu, projectPath, worktree])

  const handleReveal = useCallback((path: string) => {
    menu.close()
    void revealInFinder(projectName, path, worktree)
  }, [projectName, worktree, menu])

  // react-arborist callbacks
  const onMove = useCallback(async ({ dragIds, parentId }: { dragIds: string[]; parentId: string | null; index: number }) => {
    if (!dragIds.length) return
    const destDir = parentId || ''
    if (!destDir) return // Cannot move to root — server rejects empty destDir
    const moves = dragIds.map(source => ({
      source,
      expectedNew: `${destDir}/${source.split('/').pop()}`,
    }))
    // Optimistic: move nodes in tree
    patchTree?.(prev => {
      if (!prev) return prev
      let next = prev
      for (const m of moves) {
        const result = moveNodeInTree(next, m.source, destDir)
        if (result) next = result.tree
      }
      return next
    })
    for (const m of moves) onFileRenamed?.(m.source, m.expectedNew)
    const failed: typeof moves = []
    await Promise.all(moves.map(async (m) => {
      try { await moveFile(projectName, m.source, destDir, worktree) }
      catch (err) {
        console.error('Failed to move:', err)
        failed.push(m)
      }
    }))
    if (failed.length) {
      for (const m of failed) onFileRenamed?.(m.expectedNew, m.source)
      void refreshTree?.()
    }
  }, [projectName, worktree, patchTree, refreshTree, onFileRenamed])

  const onCreate = useCallback(({ parentId, type }: { parentId: string | null; type: 'internal' | 'leaf' }) => {
    // Open parent chain so the pending node will be visible
    if (parentId) {
      const segments = parentId.split('/')
      for (let i = 1; i <= segments.length; i++) {
        const dirPath = segments.slice(0, i).join('/')
        treeRef.current?.open(dirPath)
        // Register with useFileTree so SSE refresh re-fetches children
        onExpandDir?.(dirPath)
      }
    }
    const parentPath = parentId || ''
    // crypto.randomUUID requires a secure context — falls back for plain-HTTP LAN access
    const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const tempId = `\0new:${rand}`
    const tempPath = parentPath ? `${parentPath}/${tempId}` : tempId
    const nodeType = type === 'internal' ? 'dir' as const : 'file' as const
    const pending = { path: tempPath, type: nodeType }
    pendingRef.current = pending
    setPendingCreate(pending)
    return { id: tempPath }
  }, [onExpandDir])

  const onRename = useCallback(async ({ id, name }: { id: string; name: string }) => {
    const pending = pendingRef.current
    if (pending && id === pending.path) {
      pendingRef.current = null
      setPendingCreate(null)
      if (!name.trim() || name.includes('..') || name.includes('/')) return
      const parentPath = parentOf(id)
      const fullPath = parentPath ? `${parentPath}/${name}` : name
      try {
        if (pending.type === 'dir') {
          await createDir(projectName, fullPath, worktree)
        } else {
          await createFile(projectName, fullPath, worktree)
          onSelectFile(fullPath)
        }
      } catch (err) {
        toast.error(`Failed to create: ${err instanceof Error ? err.message : String(err)}`)
        void refreshTree?.()
      }
      return
    }
    // Validate rename
    if (!name.trim() || name.includes('..') || name.includes('/')) return
    const oldPath = id
    const parent = parentOf(oldPath)
    const newPath = parent ? `${parent}/${name}` : name
    if (newPath === oldPath) return
    // Optimistic: rename in tree
    patchTree?.(prev => prev ? renameNodeInTree(prev, oldPath, newPath) : prev)
    onFileRenamed?.(oldPath, newPath)
    try { await renameFile(projectName, oldPath, newPath, worktree) }
    catch (err) {
      console.error('Failed to rename:', err)
      // Rollback: undo tab/state retargeting
      onFileRenamed?.(newPath, oldPath)
      void refreshTree?.()
    }
  }, [projectName, worktree, onSelectFile, patchTree, refreshTree, onFileRenamed])

  const treeData = useMemo(() => {
    if (!tree) return null
    if (!pendingCreate) return tree
    return insertPendingNode(tree, { name: '', path: pendingCreate.path, type: pendingCreate.type })
  }, [tree, pendingCreate])

  // Reset virtual-list scroll only on first load (null → data) to prevent
  // stale scrollOffset leaving items below an empty gap. Do NOT reset on
  // subsequent refetches — the tree reference changes every poll/SSE cycle.
  const hadTreeRef = useRef(!!tree)
  useEffect(() => {
    if (!hadTreeRef.current && tree && treeRef.current?.list?.current) {
      treeRef.current.list.current.scrollTo(0)
    }
    hadTreeRef.current = !!tree
  }, [tree])

  useImperativeHandle(ref, () => ({
    createFile: (parentPath) => {
      treeRef.current?.create({ type: 'leaf', parentId: parentPath || null })
    },
    createFolder: (parentPath) => {
      treeRef.current?.create({ type: 'internal', parentId: parentPath || null })
    },
    expandToPath: (folderPath) => {
      if (!treeRef.current) return
      // Open all ancestors using string IDs — works without node visibility
      const parts = folderPath.split('/')
      for (let i = 1; i <= parts.length; i++) {
        treeRef.current.open(parts.slice(0, i).join('/'))
      }
      // Select after re-render so the target node is in the visible list
      setTimeout(() => {
        const target = treeRef.current?.get(folderPath)
        if (target) {
          target.select()
          target.focus()
        }
      })
    },
    collapseAll: () => {
      treeRef.current?.closeAll()
    },
  }), [])

  const ctxParent = menuTarget
    ? (menuTarget.type === 'dir' ? menuTarget.path : parentOf(menuTarget.path))
    : ''

  return (
    <ExplorerContext.Provider value={{ gitMap, gitFolders, bindContextMenu, reportContextFolder, onPreviewFile, onPinFile: onSelectFile, onExpandDir, pendingNewId: pendingCreate?.path ?? null, cancelCreate }}>
      <div ref={setContainerNode} className="flex-1 min-h-0 min-w-0 overflow-hidden" onMouseDown={onFocusExplorer}>
        {!treeData || size.height < 1 ? (
          <div className="px-3 py-2 flex flex-col gap-2.5">
            <div className="skeleton-row" style={{ width: '60%' }} />
            <div className="skeleton-row" style={{ width: '45%', marginLeft: 12 }} />
            <div className="skeleton-row" style={{ width: '70%', marginLeft: 12 }} />
            <div className="skeleton-row" style={{ width: '40%' }} />
          </div>
        ) : (
          <Tree
            ref={treeRef}
            data={treeData}
            idAccessor="path"
            childrenAccessor="children"
            width={size.width}
            height={size.height}
            rowHeight={22}
            indent={12}
            openByDefault={false}
            onCreate={onCreate}
            onMove={onMove}
            onRename={onRename}
            onActivate={(node) => {
              if (node.data.type === 'file') {
                onSelectFile(node.data.path)
              }
            }}
          >
            {FileNodeRenderer}
          </Tree>
        )}
      </div>

      {menu.position && menuTarget && (
        <Menu position={menu.position} exiting={menu.exiting} armed={menu.armed} focusOnOpen={menu.focusOnOpen} onExitDone={menu.onExitDone}>
          <MenuItem label="New File" onClick={() => handleNewFile(ctxParent)} />
          <MenuItem label="New Folder" onClick={() => handleNewFolder(ctxParent)} />
          <MenuDivider />
          <MenuItem label="Rename" onClick={() => handleRename(menuTarget.path)} />
          <MenuItem label="Delete" onClick={() => handleDelete(menuTarget.path)} />
          <MenuDivider />
          <MenuItem label="Copy Relative Path" onClick={() => handleCopyRelativePath(menuTarget.path)} />
          <MenuItem label="Copy Absolute Path" onClick={() => handleCopyAbsolutePath(menuTarget.path)} />
          <MenuItem label="Reveal in Finder" onClick={() => handleReveal(menuTarget.path)} />
        </Menu>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={confirmDelete.length === 1
            ? `Delete "${confirmDelete[0].split('/').pop()}"?`
            : `Delete ${confirmDelete.length} items?`}
          confirmLabel="Delete"
          danger
          onConfirm={doDelete}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </ExplorerContext.Provider>
  )
})

export const FileExplorer = memo(FileExplorerInner) as typeof FileExplorerInner
