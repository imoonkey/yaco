import { isFileTab } from '../hooks/workspaceTypes'

export function WorkspaceBreadcrumbs({
  activeTab,
  onNavigateDir,
}: {
  activeTab: string | null
  onNavigateDir: (dirPath: string) => void
}) {
  if (!isFileTab(activeTab)) return null

  const segments = activeTab.split('/')
  if (segments.length <= 1) return null

  const dirSegments = segments.slice(0, -1)
  const fileName = segments[segments.length - 1]

  return (
    <div
      className="flex items-center px-3 shrink-0 overflow-x-auto"
      style={{ height: 28, fontSize: 12, color: 'var(--sol-text)', backgroundColor: 'var(--sol-editor-bg)', borderBottom: '1px solid var(--sol-border)' }}
    >
      {dirSegments.map((seg, i) => {
        const dirPath = segments.slice(0, i + 1).join('/')
        return (
          <span key={dirPath} className="flex items-center shrink-0">
            <span
              className="cursor-pointer"
              style={{ color: 'var(--sol-text)', transition: 'color 120ms cubic-bezier(0.2, 0, 0, 1)' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--sol-accent)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--sol-text)')}
              onClick={() => onNavigateDir(dirPath)}
            >
              {seg}
            </span>
            <span className="mx-1" style={{ color: 'var(--sol-text)' }}>›</span>
          </span>
        )
      })}
      <span style={{ color: 'var(--sol-text-dark)' }}>{fileName}</span>
    </div>
  )
}
