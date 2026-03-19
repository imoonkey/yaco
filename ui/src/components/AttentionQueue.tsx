import { attentionEvents, type AttentionEvent, type AttentionType } from '../data'

const typeConfig: Record<AttentionType, { label: string; text: string; bg: string; border: string }> = {
  blocked:      { label: 'BLOCKED', text: 'text-[#dc322f]', bg: 'bg-[#dc322f]/8',  border: 'border-[#dc322f]/20' },
  human_review: { label: 'REVIEW',  text: 'text-[#6c71c4]', bg: 'bg-[#6c71c4]/8',  border: 'border-[#6c71c4]/20' },
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function Btn({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] px-2 py-0.5 rounded bg-[#eee8d5] hover:bg-[#ddd6c1] border border-[#93a1a1]/30 text-[#586e75] cursor-pointer"
    >
      {children}
    </button>
  )
}

function AttentionCard({ event }: { event: AttentionEvent }) {
  const cfg = typeConfig[event.type]
  return (
    <div className={`border rounded-lg p-4 ${cfg.bg} ${cfg.border} ${event.cleared ? 'opacity-40' : ''}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${cfg.text} bg-[#fdf6e3]/80`}>
            {cfg.label}
          </span>
        </div>
        <span className="text-[11px] text-[#93a1a1]">{timeAgo(event.createdAt)}</span>
      </div>
      <div className="text-sm text-[#073642] mb-2">{event.message}</div>
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-[#93a1a1]">{event.project} / {event.workstream}</div>
        {!event.cleared && (
          <div className="flex gap-1.5">
            <Btn>Open Doc</Btn>
            <Btn>Take Over</Btn>
            <Btn>Clear</Btn>
          </div>
        )}
      </div>
    </div>
  )
}

export function AttentionQueue() {
  const active = attentionEvents.filter(e => !e.cleared)
  const cleared = attentionEvents.filter(e => e.cleared)

  return (
    <div className="p-6 max-w-3xl">
      <h2 className="text-base font-medium text-[#073642] mb-1">Attention Queue</h2>
      <p className="text-[12px] text-[#93a1a1] mb-5">{active.length} items need your attention</p>
      <div className="space-y-3">
        {active.map(e => <AttentionCard key={e.id} event={e} />)}
      </div>
      {cleared.length > 0 && (
        <>
          <div className="mt-6 mb-3 text-[11px] text-[#93a1a1] uppercase tracking-wide">Cleared</div>
          <div className="space-y-3">
            {cleared.map(e => <AttentionCard key={e.id} event={e} />)}
          </div>
        </>
      )}
    </div>
  )
}
