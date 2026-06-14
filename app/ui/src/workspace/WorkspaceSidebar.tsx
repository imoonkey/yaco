import { FileTypeIcon, FolderIcon } from '../components/fileExplorerIcons'
import { GIT_COLORS } from '../components/fileGitColors'
import type { GitChange } from '../types'

/** Status badge background at low opacity, derived from the status color */
const STATUS_BG: Record<string, string> = {
  M: 'color-mix(in srgb, var(--sol-warning) 14%, transparent)',
  U: 'color-mix(in srgb, var(--sol-diff-add) 14%, transparent)',
  A: 'color-mix(in srgb, var(--sol-diff-add) 14%, transparent)',
  D: 'color-mix(in srgb, var(--sol-diff-del) 14%, transparent)',
}

export function GitChangeItem({
  change, isActive, onActivate, onOpenPinned, onPathClick,
}: {
  change: GitChange
  isActive: boolean
  onActivate: () => void
  onOpenPinned?: () => void
  onPathClick?: (path: string) => void
}) {
  const isDir = change.path.endsWith('/')
  const cleanPath = isDir ? change.path.slice(0, -1) : change.path
  const name = cleanPath.split('/').pop() || cleanPath
  const dir = cleanPath.includes('/') ? cleanPath.slice(0, cleanPath.lastIndexOf('/')) : ''
  const pathLabel = dir || (!isDir ? '.' : '')
  const statusColor = GIT_COLORS[change.status] || 'var(--sol-text)'
  return (
    <div onClick={onActivate}
      onDoubleClick={onOpenPinned ? (e) => { e.stopPropagation(); onOpenPinned() } : undefined}
      data-testid="git-change-item"
      data-change-path={cleanPath}
      className="flex items-center gap-1.5 h-[24px] rounded cursor-pointer text-ui-md"
      title={cleanPath}
      style={{
        paddingLeft: isActive ? 6 : 8,
        paddingRight: 6,
        borderLeft: isActive ? `2px solid ${statusColor}` : '2px solid transparent',
        backgroundColor: isActive ? 'color-mix(in srgb, var(--sol-blue) 10%, transparent)' : undefined,
        transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1), border-color 120ms, padding-left 120ms',
      }}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.backgroundColor = 'var(--sol-hover-bg)' }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.backgroundColor = '' }}
    >
      <span className="shrink-0 flex items-center" style={{ opacity: isActive ? 1 : 0.8 }}>
        {isDir ? <FolderIcon /> : <FileTypeIcon name={name} />}
      </span>
      <span className="truncate" style={{ color: isActive ? 'var(--sol-text-dark)' : 'var(--sol-text)' }}>{name}</span>
      {pathLabel && <span
        className="truncate text-ui-xs hover:underline shrink min-w-0"
        style={{ color: 'var(--sol-text-faint)' }}
        title={`Reveal ${cleanPath}`}
        onClick={onPathClick ? (e) => { e.stopPropagation(); onPathClick(cleanPath) } : undefined}
        onDoubleClick={onPathClick ? (e) => e.stopPropagation() : undefined}
      >{pathLabel}</span>}
      <span
        className="ml-auto shrink-0 rounded text-ui-xs font-bold leading-none"
        style={{
          color: statusColor,
          backgroundColor: STATUS_BG[change.status],
          padding: '2px 4px',
          letterSpacing: '0.02em',
        }}
      >{change.status}</span>
    </div>
  )
}
