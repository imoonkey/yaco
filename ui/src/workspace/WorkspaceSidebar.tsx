import { FileTypeIcon, FolderIcon, GIT_COLORS } from '../components/fileExplorerIcons'
import type { GitChange } from '../types'

export function GitChangeItem({ change, isActive, onActivate, onFolderClick }: { change: GitChange; isActive: boolean; onActivate: () => void; onFolderClick?: (dir: string) => void }) {
  const isDir = change.path.endsWith('/')
  const cleanPath = isDir ? change.path.slice(0, -1) : change.path
  const name = cleanPath.split('/').pop() || cleanPath
  const dir = cleanPath.includes('/') ? cleanPath.slice(0, cleanPath.lastIndexOf('/')) : ''
  return (
    <div onClick={onActivate}
      className={`flex items-center gap-1 px-1 h-[22px] rounded cursor-pointer text-[12px] ${isActive ? 'bg-[var(--sol-blue)]/15' : 'hover:bg-sol-hover-bg'}`}
      title={cleanPath}
      style={{ transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1)' }}>
      {isDir ? <FolderIcon /> : <FileTypeIcon name={name} />}
      <span className="truncate" style={{ color: GIT_COLORS[change.status] || 'var(--sol-text)' }}>{name}</span>
      {dir && <span
        className="truncate text-[10px] hover:underline shrink min-w-0"
        style={{ color: 'var(--sol-muted)' }}
        onClick={onFolderClick ? (e) => { e.stopPropagation(); onFolderClick(dir) } : undefined}
      >{dir}</span>}
      <span className="ml-auto text-[10px] font-semibold shrink-0" style={{ color: GIT_COLORS[change.status] }}>{change.status}</span>
    </div>
  )
}
