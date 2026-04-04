import { useRef, useEffect, useState, useCallback, useMemo, forwardRef, useImperativeHandle, memo } from 'react'
import { Tree } from 'react-arborist'
import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import { moveFile, renameFile, deleteFile, createFile, createDir, revealInFinder } from '../hooks/useApi'
import { writeTextToClipboard } from '../lib/clipboard'
import { Menu, MenuItem, MenuDivider, useContextMenu } from './Menu'
import type { FileNode } from '../types'
export { GIT_COLORS, FileTypeIcon, FolderIcon, NewFileIcon, NewFolderIcon, CollapseAllIcon } from './fileExplorerIcons'
import { ExplorerContext, FileNodeRenderer } from './fileExplorerNode'

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
  tree: FileNode[] | null
  gitMap: Map<string, string>
  gitFolders: Set<string>
  selectedFile: string | null
  onSelectFile: (path: string) => void
  onPreviewFile?: (path: string) => void
  onExpandDir?: (path: string) => void
  onFocusExplorer: () => void
  onContextFolder?: (path: string) => void
  onFileRenamed?: (oldPath: string, newPath: string) => void
  onFileDeleted?: (path: string) => void
  patchTree?: (fn: (prev: FileNode[] | null) => FileNode[] | null) => void
  refreshTree?: () => void
}

const FileExplorerInner = forwardRef<FileExplorerHandle, FileExplorerProps>(
function FileExplorer({ projectName, tree, gitMap, gitFolders, selectedFile, onSelectFile, onPreviewFile, onExpandDir, onFocusExplorer, onContextFolder, onFileRenamed, onFileDeleted, patchTree, refreshTree }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const rafIdRef = useRef<number | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const treeRef = useRef<any>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const menu = useContextMenu()
  const [menuTarget, setMenuTarget] = useState<{ path: string; type: 'file' | 'dir' } | null>(null)
  const [pendingCreate, setPendingCreate] = useState<{ path: string; type: 'file' | 'dir' } | null>(null)
  const pendingRef = useRef(pendingCreate)
  pendingRef.current = pendingCreate

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
  }, [onContextFolder])

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

  const handleDelete = useCallback(async (path: string) => {
    menu.close()
    const name = path.split('/').pop()
    if (!confirm(`Delete "${name}"?`)) return
    // Optimistic: remove from tree visually
    patchTree?.(prev => prev ? removeNodeFromTree(prev, path) : prev)
    try {
      await deleteFile(projectName, path)
      // Only close tabs and remove state after server confirms
      onFileDeleted?.(path)
    }
    catch (err) {
      console.error('Failed to delete:', err)
      refreshTree?.()
    }
  }, [projectName, menu, patchTree, refreshTree, onFileDeleted])

  const handleCopyPath = useCallback((path: string) => {
    menu.close()
    void writeTextToClipboard(path)
  }, [menu])

  const handleReveal = useCallback((path: string) => {
    menu.close()
    void revealInFinder(projectName, path)
  }, [projectName, menu])

  // react-arborist callbacks
  const onMove = useCallback(async ({ dragIds, parentId }: { dragIds: string[]; parentId: string | null; index: number }) => {
    const sourcePath = dragIds[0]
    if (!sourcePath) return
    const destDir = parentId || ''
    if (!destDir) return // Cannot move to root — server rejects empty destDir
    // Optimistic: move node in tree
    patchTree?.(prev => {
      if (!prev) return prev
      const result = moveNodeInTree(prev, sourcePath, destDir)
      return result ? result.tree : prev
    })
    const expectedNewPath = `${destDir}/${sourcePath.split('/').pop()}`
    onFileRenamed?.(sourcePath, expectedNewPath)
    try { await moveFile(projectName, sourcePath, destDir) }
    catch (err) {
      console.error('Failed to move:', err)
      // Rollback: undo tab/state retargeting
      onFileRenamed?.(expectedNewPath, sourcePath)
      refreshTree?.()
    }
  }, [projectName, patchTree, refreshTree, onFileRenamed])

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
    const tempId = `\0new:${crypto.randomUUID()}`
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
          await createDir(projectName, fullPath)
        } else {
          await createFile(projectName, fullPath)
          onSelectFile(fullPath)
        }
      } catch (err) { console.error('Failed to create:', err) }
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
    try { await renameFile(projectName, oldPath, newPath) }
    catch (err) {
      console.error('Failed to rename:', err)
      // Rollback: undo tab/state retargeting
      onFileRenamed?.(newPath, oldPath)
      refreshTree?.()
    }
  }, [projectName, onSelectFile, patchTree, refreshTree, onFileRenamed])

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
          <div className="px-2 py-2 text-[11px]" style={{ color: C.muted }}>Loading...</div>
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
            disableMultiSelection
            selection={selectedFile ?? undefined}
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
        <Menu position={menu.position}>
          <MenuItem label="New File" onClick={() => handleNewFile(ctxParent)} />
          <MenuItem label="New Folder" onClick={() => handleNewFolder(ctxParent)} />
          <MenuDivider />
          <MenuItem label="Rename" onClick={() => handleRename(menuTarget.path)} />
          <MenuItem label="Delete" onClick={() => handleDelete(menuTarget.path)} />
          <MenuDivider />
          <MenuItem label="Copy Path" onClick={() => handleCopyPath(menuTarget.path)} />
          <MenuItem label="Reveal in Finder" onClick={() => handleReveal(menuTarget.path)} />
        </Menu>
      )}
    </ExplorerContext.Provider>
  )
})

export const FileExplorer = memo(FileExplorerInner) as typeof FileExplorerInner
