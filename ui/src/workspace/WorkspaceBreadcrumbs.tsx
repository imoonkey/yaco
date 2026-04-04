import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
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
      style={{ height: 24, fontSize: 12, color: C.muted, backgroundColor: C.editorBg, borderBottom: `1px solid ${C.border}` }}
    >
      {dirSegments.map((seg, i) => {
        const dirPath = segments.slice(0, i + 1).join('/')
        return (
          <span key={dirPath} className="flex items-center shrink-0">
            <span
              className="cursor-pointer transition-colors"
              style={{ color: C.muted }}
              onMouseEnter={e => (e.currentTarget.style.color = C.accent)}
              onMouseLeave={e => (e.currentTarget.style.color = C.muted)}
              onClick={() => onNavigateDir(dirPath)}
            >
              {seg}
            </span>
            <span className="mx-1" style={{ color: C.muted }}>›</span>
          </span>
        )
      })}
      <span style={{ color: C.textDim }}>{fileName}</span>
    </div>
  )
}
