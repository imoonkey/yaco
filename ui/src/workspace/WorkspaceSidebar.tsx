import { FileTypeIcon, FolderIcon, GIT_COLORS } from '../components/fileExplorerIcons'
import type { GitChange } from '../types'

export function GitChangeItem({ change, isActive, onActivate, onFolderClick }: { change: GitChange; isActive: boolean; onActivate: () => void; onFolderClick?: (dir: string) => void }) {
  const isDir = change.path.endsWith('/')
  const cleanPath = isDir ? change.path.slice(0, -1) : change.path
  const name = cleanPath.split('/').pop() || cleanPath
  const dir = cleanPath.includes('/') ? cleanPath.slice(0, cleanPath.lastIndexOf('/')) : ''
  return (
    <div onClick={onActivate}
      className={`flex items-start gap-2 px-2 py-1 rounded cursor-pointer text-[12px] ${isActive ? 'bg-[var(--sol-blue)]/15' : 'hover:bg-sol-hover-bg'}`}
      title={cleanPath}
      style={{ transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1)' }}>
      {isDir ? <FolderIcon /> : <FileTypeIcon name={name} />}
      <div className="min-w-0 flex-1 overflow-hidden leading-tight">
        <div className="truncate" style={{ color: GIT_COLORS[change.status] || 'var(--sol-text)' }}>{name}</div>
        {dir && <div
          className="truncate pt-0.5 text-[10px] hover:underline"
          style={{ color: 'var(--sol-muted)' }}
          onClick={onFolderClick ? (e) => { e.stopPropagation(); onFolderClick(dir) } : undefined}
        >{dir}</div>}
      </div>
      <span className="ml-auto pt-[1px] text-[10px] font-semibold shrink-0" style={{ color: GIT_COLORS[change.status] }}>{change.status}</span>
    </div>
  )
}
