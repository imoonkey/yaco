import { useRef, useEffect, useState, useCallback, createContext, useContext } from 'react'
import { Tree } from 'react-arborist'
import type { NodeRendererProps } from 'react-arborist'
import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import { moveFile, renameFile, deleteFile, createFile, createDir } from '../hooks/useApi'
import { writeTextToClipboard } from '../lib/clipboard'
import type { FileNode } from '../types'

// --- Shared icon colors ---
export const FILE_COLORS: Record<string, string> = {
  ts: '#3178C6', tsx: '#3178C6', js: '#CBCB41', jsx: '#CBCB41', json: '#B58900',
  md: '#519ABA', py: '#3776AB', css: '#42A5F5', scss: '#CD6799', html: '#E44D26',
  yml: '#F44D27', yaml: '#F44D27', sh: '#4EAA25', toml: '#9C4121', lock: '#93A1A1',
  svg: '#FFB13B', txt: '#93A1A1',
}
export const GIT_COLORS: Record<string, string> = { M: '#C4A241', U: '#73C991', A: '#73C991', D: '#C74E39' }

// --- Icons (shared with Workspace) ---
export function FileTypeIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const c = FILE_COLORS[ext] || C.muted
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0">
      <path d="M3.5 1C2.67 1 2 1.67 2 2.5v11c0 .83.67 1.5 1.5 1.5h9c.83 0 1.5-.67 1.5-1.5V5.5L9.5 1H3.5z" fill={c} fillOpacity="0.15" stroke={c} strokeOpacity="0.5" strokeWidth="0.8" />
      <path d="M9.5 1V5.5H13" fill="none" stroke={c} strokeOpacity="0.5" strokeWidth="0.8" />
    </svg>
  )
}

export function FolderIcon({ open }: { open?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0">
      {open
        ? <path d="M1.5 14h13c.28 0 .5-.22.5-.5V5H7.5L6 3.5H2c-.28 0-.5.22-.5.5v10c0 .28.22.5.5.5z" fill="#C09553" fillOpacity="0.75" />
        : <path d="M1.5 14h13c.28 0 .5-.22.5-.5V4.5c0-.28-.22-.5-.5-.5H7L5.5 2.5c-.2-.3-.5-.5-.8-.5H2c-.28 0-.5.22-.5.5v11c0 .28.22.5.5.5z" fill="#C09553" fillOpacity="0.75" />
      }
    </svg>
  )
}

export function NewFileIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0">
      <path d="M9.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5L9.5 1z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 7v4M6 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

export function NewFolderIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0">
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h2.879a1 1 0 0 1 .707.293L8.5 3.707a1 1 0 0 0 .707.293H12.5A1.5 1.5 0 0 1 14 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 7v4M6 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

// --- Context for passing data to node renderer ---
type ContextMenuState = { x: number; y: number; path: string; type: 'file' | 'dir' } | null

const ExplorerContext = createContext<{
  gitMap: Map<string, string>
  gitFolders: Set<string>
  openContextMenu: (e: React.MouseEvent, path: string, type: 'file' | 'dir') => void
}>({ gitMap: new Map(), gitFolders: new Set(), openContextMenu: () => {} })

// --- Context menu ---
function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div
      className="px-3 py-1 text-[12px] cursor-pointer"
      style={{ color: C.text }}
      onMouseEnter={e => (e.currentTarget.style.backgroundColor = C.hover)}
      onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
      onClick={onClick}
    >
      {label}
    </div>
  )
}

function MenuDivider() {
  return <div className="my-1" style={{ borderTop: `1px solid ${C.border}` }} />
}

// --- Custom node renderer ---
function FileNodeRenderer({ node, style, dragHandle }: NodeRendererProps<FileNode>) {
  const { gitMap, gitFolders, openContextMenu } = useContext(ExplorerContext)
  const d = node.data
  const gitStatus = gitMap.get(d.path)
  const folderChanged = d.type === 'dir' && gitFolders.has(d.path)
  const isSelected = node.isSelected
  const nameColor = gitStatus ? (GIT_COLORS[gitStatus] || C.text)
    : folderChanged ? '#C4A241'
    : isSelected ? C.accent
    : C.text

  if (node.isEditing) {
    return (
      <div style={style} ref={dragHandle}>
        <div className="flex items-center gap-1 h-full px-1">
          {d.type === 'dir' ? <FolderIcon open={node.isOpen} /> : <FileTypeIcon name={d.name} />}
          <input
            autoFocus
            className="flex-1 text-[12px] bg-transparent outline-none border-b min-w-0"
            style={{ color: C.text, borderColor: C.accent }}
            defaultValue={d.name}
            onBlur={() => node.reset()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') node.submit(e.currentTarget.value)
              if (e.key === 'Escape') node.reset()
            }}
          />
        </div>
      </div>
    )
  }

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (d.type === 'dir') {
      node.select()
      node.focus()
      node.toggle()
      return
    }
    node.handleClick(e)
  }

  return (
    <div style={style} ref={dragHandle}>
      <div
        className={`flex w-full items-center gap-1 h-full px-1 rounded cursor-pointer text-[12px] ${isSelected ? 'bg-[#268bd2]/15' : ''}`}
        onClick={handleClick}
        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.backgroundColor = C.hover }}
        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.backgroundColor = '' }}
        onContextMenu={e => { e.preventDefault(); openContextMenu(e, d.path, d.type) }}
      >
        {d.type === 'dir' ? <FolderIcon open={node.isOpen} /> : <FileTypeIcon name={d.name} />}
        <span className="flex-1 truncate" style={{ color: nameColor }}>{d.name}</span>
        {gitStatus && <span className="text-[10px] font-semibold shrink-0" style={{ color: GIT_COLORS[gitStatus] }}>{gitStatus}</span>}
        {folderChanged && !gitStatus && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: '#C4A241' }} />}
      </div>
    </div>
  )
}

// --- FileExplorer component ---
interface FileExplorerProps {
  projectName: string
  tree: FileNode[] | null
  gitMap: Map<string, string>
  gitFolders: Set<string>
  selectedFile: string | null
  onSelectFile: (path: string) => void
  onFocusExplorer: () => void
}

export function FileExplorer({ projectName, tree, gitMap, gitFolders, selectedFile, onSelectFile, onFocusExplorer }: FileExplorerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const rafIdRef = useRef<number | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const treeRef = useRef<any>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>(null)

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

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', onKey) }
  }, [ctxMenu])

  const openContextMenu = useCallback((e: React.MouseEvent, path: string, type: 'file' | 'dir') => {
    setCtxMenu({ x: e.clientX, y: e.clientY, path, type })
  }, [])

  const parentOf = (path: string) => {
    const i = path.lastIndexOf('/')
    return i > 0 ? path.slice(0, i) : ''
  }

  const handleNewFile = useCallback(async (parentPath: string) => {
    setCtxMenu(null)
    const name = prompt('New file name:')
    if (!name || name.includes('..')) return
    const fullPath = parentPath ? `${parentPath}/${name}` : name
    try {
      await createFile(projectName, fullPath)
      onSelectFile(fullPath)
    } catch (err) { console.error('Failed to create file:', err) }
  }, [projectName, onSelectFile])

  const handleNewFolder = useCallback(async (parentPath: string) => {
    setCtxMenu(null)
    const name = prompt('New folder name:')
    if (!name || name.includes('..')) return
    const fullPath = parentPath ? `${parentPath}/${name}` : name
    try { await createDir(projectName, fullPath) }
    catch (err) { console.error('Failed to create folder:', err) }
  }, [projectName])

  const handleRename = useCallback(async (path: string) => {
    setCtxMenu(null)
    const node = treeRef.current?.get(path)
    if (node) node.edit()
  }, [])

  const handleDelete = useCallback(async (path: string) => {
    setCtxMenu(null)
    const name = path.split('/').pop()
    if (!confirm(`Delete "${name}"?`)) return
    try { await deleteFile(projectName, path) }
    catch (err) { console.error('Failed to delete:', err) }
  }, [projectName])

  const handleCopyPath = useCallback((path: string) => {
    setCtxMenu(null)
    void writeTextToClipboard(path)
  }, [])

  // react-arborist callbacks
  const onMove = useCallback(async ({ dragIds, parentId }: { dragIds: string[]; parentId: string | null; index: number }) => {
    const sourcePath = dragIds[0]
    if (!sourcePath) return
    const destDir = parentId || ''
    try { await moveFile(projectName, sourcePath, destDir) }
    catch (err) { console.error('Failed to move:', err) }
  }, [projectName])

  const onRename = useCallback(async ({ id, name }: { id: string; name: string }) => {
    const oldPath = id
    const parent = parentOf(oldPath)
    const newPath = parent ? `${parent}/${name}` : name
    if (newPath === oldPath) return
    try { await renameFile(projectName, oldPath, newPath) }
    catch (err) { console.error('Failed to rename:', err) }
  }, [projectName])

  if (!tree) {
    return <div className="flex-1 px-2 py-2 text-[11px]" style={{ color: C.muted }}>Loading...</div>
  }

  const ctxParent = ctxMenu
    ? (ctxMenu.type === 'dir' ? ctxMenu.path : parentOf(ctxMenu.path))
    : ''

  return (
    <ExplorerContext.Provider value={{ gitMap, gitFolders, openContextMenu }}>
      <div ref={setContainerNode} className="flex-1 min-h-0 min-w-0" onMouseDown={onFocusExplorer}>
        {size.width > 0 && size.height > 0 && (
          <Tree
            ref={treeRef}
            data={tree}
            idAccessor="path"
            childrenAccessor="children"
            width={size.width}
            height={size.height}
            rowHeight={22}
            indent={12}
            openByDefault={false}
            disableMultiSelection
            selection={selectedFile ?? undefined}
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

      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[160px] py-1 rounded shadow-lg"
          style={{ left: ctxMenu.x, top: ctxMenu.y, backgroundColor: C.editorBg, border: `1px solid ${C.border}` }}
          onClick={e => e.stopPropagation()}
        >
          <MenuItem label="New File" onClick={() => handleNewFile(ctxParent)} />
          <MenuItem label="New Folder" onClick={() => handleNewFolder(ctxParent)} />
          <MenuDivider />
          <MenuItem label="Rename" onClick={() => handleRename(ctxMenu.path)} />
          <MenuItem label="Delete" onClick={() => handleDelete(ctxMenu.path)} />
          <MenuDivider />
          <MenuItem label="Copy Path" onClick={() => handleCopyPath(ctxMenu.path)} />
        </div>
      )}
    </ExplorerContext.Provider>
  )
}
