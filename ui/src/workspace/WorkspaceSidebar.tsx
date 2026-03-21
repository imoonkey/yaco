import { FileTypeIcon, GIT_COLORS } from '../components/FileExplorer'
import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import type { GitChange } from '../types'

export function GitChangeItem({ change, isActive, onActivate }: { change: GitChange; isActive: boolean; onActivate: () => void }) {
  const name = change.path.split('/').pop() || change.path
  const dir = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : ''
  return (
    <div onClick={onActivate}
      className={`flex items-start gap-2 px-2 py-1 rounded cursor-pointer text-[12px] ${isActive ? 'bg-[#268bd2]/15' : ''}`}
      title={change.path}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.backgroundColor = C.hover }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.backgroundColor = '' }}>
      <FileTypeIcon name={name} />
      <div className="min-w-0 flex-1 overflow-hidden leading-tight">
        <div className="truncate" style={{ color: GIT_COLORS[change.status] || C.text }}>{name}</div>
        {dir && <div className="truncate pt-0.5 text-[10px]" style={{ color: C.muted }}>{dir}</div>}
      </div>
      <span className="ml-auto pt-[1px] text-[10px] font-semibold shrink-0" style={{ color: GIT_COLORS[change.status] }}>{change.status}</span>
    </div>
  )
}
