import { useState } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'

export function SectionHeader({ title, collapsed, onToggle, actions, badge, stats }: {
  title: string; collapsed: boolean; onToggle: () => void; actions?: React.ReactNode; badge?: number; stats?: React.ReactNode
}) {
  return (
    <div className="section-header-bar flex items-center h-7 px-2 text-ui-sm font-semibold uppercase tracking-wider cursor-pointer select-none shrink-0"
      style={{ color: 'var(--sol-text-brown)', borderBottom: '1px solid color-mix(in srgb, var(--sol-border) 50%, transparent)', transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1)' }}
      role="button" aria-expanded={!collapsed} aria-label={`${title} section`}
      onClick={onToggle}>
      <span className="w-3 flex items-center justify-center"><ChevronRight size={12} aria-hidden="true" style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 200ms cubic-bezier(0.2, 0, 0, 1)' }} /></span>
      <span className="flex-1 ml-0.5">{title}</span>
      {stats && <div onClick={e => e.stopPropagation()}>{stats}</div>}
      {badge != null && badge > 0 && (
        <span className="w-[18px] h-[14px] rounded-full text-ui-2xs flex items-center justify-center font-bold" style={{ backgroundColor: 'color-mix(in srgb, var(--sol-warning) 19%, transparent)', color: 'var(--sol-warning)' }}>{badge}</span>
      )}
      {!collapsed && actions && <div onClick={e => e.stopPropagation()}>{actions}</div>}
    </div>
  )
}

export function SectionRefreshButton({ onClick, title = 'Refresh' }: {
  onClick: () => void | Promise<void>
  title?: string
}) {
  const [refreshing, setRefreshing] = useState(false)

  return (
    <button
      type="button"
      onClick={async (event) => {
        event.stopPropagation()
        if (refreshing) return
        setRefreshing(true)
        try {
          await onClick()
        } catch (error) {
          console.error(`${title} failed`, error)
        } finally {
          setRefreshing(false)
        }
      }}
      disabled={refreshing}
      className="section-header-icon-btn"
      title={title}
      aria-label={title}
      aria-busy={refreshing}
    >
      <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
    </button>
  )
}
