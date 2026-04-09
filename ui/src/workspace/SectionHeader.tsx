import { ChevronRight } from 'lucide-react'

export function SectionHeader({ title, collapsed, onToggle, actions, badge }: {
  title: string; collapsed: boolean; onToggle: () => void; actions?: React.ReactNode; badge?: number
}) {
  return (
    <div className="flex items-center h-7 px-2 text-[11px] font-semibold uppercase tracking-wider cursor-pointer select-none shrink-0"
      style={{ backgroundColor: 'var(--sol-header-bg)', color: 'var(--sol-text-brown)', borderBottom: '1px solid color-mix(in srgb, var(--sol-border) 50%, transparent)' }} onClick={onToggle}>
      <span className="w-3 flex items-center justify-center"><ChevronRight size={12} style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 200ms cubic-bezier(0.2, 0, 0, 1)' }} /></span>
      <span className="flex-1 ml-0.5">{title}</span>
      {badge != null && badge > 0 && (
        <span className="w-[18px] h-[14px] rounded-full text-[9px] flex items-center justify-center font-bold" style={{ backgroundColor: 'color-mix(in srgb, var(--sol-warning) 19%, transparent)', color: 'var(--sol-warning)' }}>{badge}</span>
      )}
      {!collapsed && actions && <div onClick={e => e.stopPropagation()}>{actions}</div>}
    </div>
  )
}
