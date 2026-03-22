import { ProviderIcon } from '../components/SessionIcons'
import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import type { AgentSession } from '../types'

export function SessionItem({
  session,
  isActive,
  onClick,
  onKill,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  session: AgentSession
  isActive: boolean
  onClick: () => void
  onKill: () => void
  onDragStart?: () => void
  onDragEnd?: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}) {
  return (
    <div onClick={onClick}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`flex flex-col gap-0 px-2 py-1.5 rounded cursor-pointer text-[12px] ${isActive ? 'bg-[#268bd2]/15 text-[#268bd2]' : ''}`}
      style={isActive ? undefined : { color: C.text }}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.backgroundColor = C.hover }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.backgroundColor = '' }}>
      <div className="flex items-center gap-2">
        <ProviderIcon provider={session.provider} className="w-4 h-4 shrink-0" />
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${session.status === 'processing' ? 'bg-[#859900] animate-pulse' : 'bg-[#93a1a1]'}`} />
        <span className="min-w-0 flex-1 truncate">{session.name}</span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onKill()
          }}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] cursor-pointer border border-[#dc322f]/20 text-[#dc322f] hover:bg-[#dc322f]/8"
          title={`Kill ${session.name}`}
        >
          Kill
        </button>
      </div>
      {session.summary && (
        <div className="truncate pl-[26px] text-[10px]" style={{ color: C.muted }}>
          {session.summary}
        </div>
      )}
    </div>
  )
}
