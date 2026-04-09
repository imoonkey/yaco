import { createContext, useContext, useRef, useEffect } from 'react'
import type { NodeRendererProps } from 'react-arborist'
import { FileTypeIcon, FolderIcon, GIT_COLORS } from './fileExplorerIcons'
import type { ContextMenuHandlers } from './Menu'
import type { FileNode } from '../types'

// --- Context for passing data to node renderer ---
export type ContextMenuState = { x: number; y: number; path: string; type: 'file' | 'dir' } | null

export const ExplorerContext = createContext<{
  gitMap: Map<string, string>
  gitFolders: Set<string>
  bindContextMenu: (path: string, type: 'file' | 'dir') => ContextMenuHandlers
  reportContextFolder: (path: string, type: 'file' | 'dir') => void
  onPreviewFile?: (path: string) => void
  onPinFile?: (path: string) => void
  onExpandDir?: (path: string) => void
  pendingNewId: string | null
  cancelCreate: () => void
}>({ gitMap: new Map(), gitFolders: new Set(), bindContextMenu: () => ({ onContextMenu: () => {}, onTouchStart: () => {}, onTouchMove: () => {}, onTouchEnd: () => {}, onTouchCancel: () => {} }), reportContextFolder: () => {}, pendingNewId: null, cancelCreate: () => {} })

// --- Editing row (separate component to satisfy Rules of Hooks) ---
function EditingRow({ node, style, dragHandle, data, pendingNewId, cancelCreate }: {
  node: NodeRendererProps<FileNode>['node']
  style: React.CSSProperties
  dragHandle: NodeRendererProps<FileNode>['dragHandle']
  data: FileNode
  pendingNewId: string | null
  cancelCreate: () => void
}) {
  const isNew = data.path === pendingNewId
  const inputRef = useRef<HTMLInputElement>(null)

  // Select stem only on rename (not new file creation)
  useEffect(() => {
    const input = inputRef.current
    if (!input || isNew) return
    const name = data.name
    const dotIndex = name.lastIndexOf('.')
    if (dotIndex > 0 && data.type === 'file') {
      input.setSelectionRange(0, dotIndex)
    } else {
      input.select()
    }
  }, [])

  return (
    <div style={style} ref={dragHandle}>
      <div className="flex items-center gap-1 h-full px-1">
        {data.type === 'dir' ? <FolderIcon open={node.isOpen} /> : <FileTypeIcon name={data.name} />}
        <input
          ref={inputRef}
          autoFocus
          className="flex-1 text-[12px] bg-transparent outline-none border-b min-w-0"
          style={{ color: 'var(--sol-text)', borderColor: 'var(--sol-accent)' }}
          defaultValue={isNew ? '' : data.name}
          onBlur={() => { node.reset(); if (isNew) cancelCreate() }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const val = e.currentTarget.value.trim()
              if (val) node.submit(val)
              else { node.reset(); if (isNew) cancelCreate() }
            }
            if (e.key === 'Escape') { node.reset(); if (isNew) cancelCreate() }
          }}
        />
      </div>
    </div>
  )
}

// --- Custom node renderer ---
export function FileNodeRenderer({ node, style, dragHandle }: NodeRendererProps<FileNode>) {
  const { gitMap, gitFolders, bindContextMenu, reportContextFolder, onPreviewFile, onPinFile, onExpandDir, pendingNewId, cancelCreate } = useContext(ExplorerContext)
  const d = node.data
  const gitStatus = gitMap.get(d.path)
  const folderChanged = d.type === 'dir' && gitFolders.has(d.path)
  const isSelected = node.isSelected
  const isGitignored = d.gitignored === true
  const nameColor = isGitignored ? 'var(--sol-muted)'
    : gitStatus ? (GIT_COLORS[gitStatus] || 'var(--sol-text)')
    : folderChanged ? 'var(--sol-warning)'
    : isSelected ? 'var(--sol-accent)'
    : 'var(--sol-text)'

  if (node.isEditing) {
    return <EditingRow node={node} style={style} dragHandle={dragHandle} data={d} pendingNewId={pendingNewId} cancelCreate={cancelCreate} />
  }

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation()
    reportContextFolder(d.path, d.type)
    if (d.type === 'dir') {
      node.select()
      node.focus()
      if (!node.isOpen) onExpandDir?.(d.path)
      node.toggle()
      return
    }
    if (onPreviewFile) {
      onPreviewFile(d.path)
    } else {
      node.handleClick(e)
    }
  }

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (d.type === 'file' && onPinFile) {
      onPinFile(d.path)
    }
  }

  return (
    <div style={style} ref={dragHandle}>
      <div
        className={`flex w-full items-center gap-1 h-full px-1 rounded cursor-pointer text-[12px] ${isSelected ? 'bg-[var(--sol-blue)]/15' : 'hover:bg-sol-hover-bg'}`}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        {...bindContextMenu(d.path, d.type)}
      >
        {d.type === 'dir'
          ? <span style={isGitignored ? { opacity: 0.5 } : undefined}><FolderIcon open={node.isOpen} /></span>
          : <span style={isGitignored ? { opacity: 0.5 } : undefined}><FileTypeIcon name={d.name} /></span>}
        <span className="flex-1 truncate" style={{ color: nameColor }}>{d.name}</span>
        {!isGitignored && gitStatus && <span className="text-[10px] font-semibold shrink-0" style={{ color: GIT_COLORS[gitStatus] }}>{gitStatus}</span>}
        {!isGitignored && folderChanged && !gitStatus && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: 'var(--sol-warning)' }} />}
      </div>
    </div>
  )
}
