export function SectionHeader({ title, collapsed, onToggle, actions, badge }: {
  title: string; collapsed: boolean; onToggle: () => void; actions?: React.ReactNode; badge?: number
}) {
  return (
    <div className="flex items-center h-[22px] px-2 text-[11px] font-semibold uppercase tracking-wider cursor-pointer select-none shrink-0"
      style={{ backgroundColor: 'var(--sol-header-bg)', color: 'var(--sol-text-brown)' }} onClick={onToggle}>
      <span className="text-[9px] w-3 text-center">{collapsed ? '▸' : '▾'}</span>
      <span className="flex-1 ml-0.5">{title}</span>
      {badge != null && badge > 0 && (
        <span className="w-[18px] h-[14px] rounded-full text-[9px] flex items-center justify-center font-bold" style={{ backgroundColor: '#C4A24130', color: '#C4A241' }}>{badge}</span>
      )}
      {!collapsed && actions && <div onClick={e => e.stopPropagation()}>{actions}</div>}
    </div>
  )
}
