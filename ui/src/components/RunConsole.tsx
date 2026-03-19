import { agentSessions, projects, type AgentSession, type SessionStatus } from '../data'

const statusDisplay: Record<SessionStatus, { label: string; text: string; dot: string }> = {
  processing: { label: 'Running', text: 'text-[#859900]', dot: 'bg-[#859900] animate-pulse' },
  idle:       { label: 'Idle',    text: 'text-[#93a1a1]', dot: 'bg-[#93a1a1]' },
}

function formatDuration(startedAt: string): string {
  const diff = Date.now() - new Date(startedAt).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

function SessionCard({ session }: { session: AgentSession }) {
  const cfg = statusDisplay[session.status]
  const proj = projects.find(p => p.id === session.project)

  return (
    <div className={`border rounded-lg p-4 ${session.status === 'processing' ? 'border-[#93a1a1]/30 bg-[#fdf6e3]' : 'border-[#eee8d5] bg-[#fdf6e3]/50'}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
          <span className={`text-[11px] font-bold uppercase ${cfg.text}`}>{cfg.label}</span>
          <span className="text-[11px] px-1.5 rounded bg-[#eee8d5] text-[#586e75] uppercase">{session.agent}</span>
        </div>
        <span className="text-[11px] text-[#93a1a1]">{formatDuration(session.startedAt)}</span>
      </div>
      <div className="text-sm text-[#073642] mb-1">{session.label}</div>
      <div className="text-[11px] text-[#93a1a1]">{proj?.name} — {session.handle}</div>
    </div>
  )
}

export function RunConsole() {
  const processing = agentSessions.filter(s => s.status === 'processing')
  const idle = agentSessions.filter(s => s.status === 'idle')

  return (
    <div className="p-6 max-w-3xl">
      <h2 className="text-base font-medium text-[#073642] mb-1">Runs</h2>
      <p className="text-[12px] text-[#93a1a1] mb-5">
        {processing.length} processing, {idle.length} idle — from <code className="text-[11px] bg-[#eee8d5] px-1 rounded">multmux status</code>
      </p>

      {processing.length > 0 && (
        <>
          <div className="text-[11px] text-[#93a1a1] uppercase tracking-wide mb-2">Processing</div>
          <div className="space-y-3 mb-6">{processing.map(s => <SessionCard key={s.id} session={s} />)}</div>
        </>
      )}
      {idle.length > 0 && (
        <>
          <div className="text-[11px] text-[#93a1a1] uppercase tracking-wide mb-2">Idle</div>
          <div className="space-y-3">{idle.map(s => <SessionCard key={s.id} session={s} />)}</div>
        </>
      )}
    </div>
  )
}
