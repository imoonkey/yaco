import { progressEntries, agentSessions, projects, type ProgressEntry, type ProgressType, type AgentSession, type SessionStatus } from '../data'

// --- Notifications (right column) ---
const typeConfig: Record<ProgressType, { label: string; text: string; bg: string; border: string }> = {
  blocked:      { label: 'BLOCKED', text: 'text-[#dc322f]', bg: 'bg-[#dc322f]/8',  border: 'border-[#dc322f]/20' },
  human_review: { label: 'REVIEW',  text: 'text-[#6c71c4]', bg: 'bg-[#6c71c4]/8',  border: 'border-[#6c71c4]/20' },
  info:         { label: 'INFO',    text: 'text-[#268bd2]', bg: 'bg-[#268bd2]/5',   border: 'border-[#268bd2]/15' },
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function NotificationCard({ entry }: { entry: ProgressEntry }) {
  const cfg = typeConfig[entry.type]
  const isDismissed = entry.status === 'dismissed'
  return (
    <div className={`border rounded-lg p-3 ${cfg.bg} ${cfg.border} ${isDismissed ? 'opacity-35' : ''}`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${cfg.text} bg-[#fdf6e3]/80`}>{cfg.label}</span>
          <span className="text-[10px] text-[#93a1a1] uppercase">{entry.agent}</span>
        </div>
        <span className="text-[10px] text-[#93a1a1]">{timeAgo(entry.timestamp)}</span>
      </div>
      <div className="text-[12px] text-[#073642] mb-1.5">{entry.message}</div>
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-[#93a1a1]">
          {projects.find(p => p.id === entry.project)?.name ?? entry.project} / {entry.workstream}
        </div>
        {!isDismissed && (
          <div className="flex gap-1.5">
            <button className="text-[10px] px-2 py-0.5 rounded bg-[#eee8d5] hover:bg-[#ddd6c1] border border-[#93a1a1]/30 text-[#586e75] cursor-pointer">
              Open Doc
            </button>
            <button className="text-[10px] px-2 py-0.5 rounded bg-[#eee8d5] hover:bg-[#ddd6c1] border border-[#93a1a1]/30 text-[#586e75] cursor-pointer">
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// --- Sessions (left column) ---
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
    <div className="border border-[#eee8d5] rounded-lg p-3 cursor-pointer hover:border-[#93a1a1]/40 transition-colors bg-[#fdf6e3]">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
          <span className={`text-[11px] font-bold uppercase ${cfg.text}`}>{cfg.label}</span>
          <span className="text-[11px] px-1.5 rounded bg-[#eee8d5] text-[#586e75] uppercase">{session.agent}</span>
        </div>
        <span className="text-[11px] text-[#93a1a1]">{formatDuration(session.startedAt)}</span>
      </div>
      <div className="text-[12px] text-[#073642]">{session.label}</div>
      <div className="text-[10px] text-[#93a1a1]">{proj?.name} — {session.handle}</div>
    </div>
  )
}

// --- Two-column Monitor ---
export function Monitor({ filterProject }: { filterProject: string | null }) {
  const allProgress = filterProject
    ? progressEntries.filter(e => e.project === filterProject)
    : progressEntries
  const allSessions = filterProject
    ? agentSessions.filter(s => s.project === filterProject)
    : agentSessions

  const activeEntries = allProgress.filter(e => e.status === 'active')
  const dismissedEntries = allProgress.filter(e => e.status === 'dismissed')
  const processing = allSessions.filter(s => s.status === 'processing')
  const idle = allSessions.filter(s => s.status === 'idle')

  return (
    <div className="h-full flex">
      {/* Left: Sessions */}
      <div className="w-1/2 border-r border-[#eee8d5] overflow-y-auto p-5">
        <h2 className="text-base font-medium text-[#073642] mb-1">Sessions</h2>
        <p className="text-[12px] text-[#93a1a1] mb-4">
          {processing.length} processing, {idle.length} idle — <code className="text-[11px] bg-[#eee8d5] px-1 rounded">multmux status</code>
        </p>

        {processing.length > 0 && (
          <>
            <div className="text-[10px] text-[#93a1a1] uppercase tracking-wide mb-2">Processing</div>
            <div className="space-y-2 mb-5">{processing.map(s => <SessionCard key={s.id} session={s} />)}</div>
          </>
        )}
        {idle.length > 0 && (
          <>
            <div className="text-[10px] text-[#93a1a1] uppercase tracking-wide mb-2">Idle</div>
            <div className="space-y-2">{idle.map(s => <SessionCard key={s.id} session={s} />)}</div>
          </>
        )}
      </div>

      {/* Right: Notifications */}
      <div className="w-1/2 overflow-y-auto p-5">
        <h2 className="text-base font-medium text-[#073642] mb-1">Notifications</h2>
        <p className="text-[12px] text-[#93a1a1] mb-4">
          {activeEntries.length} active — from <code className="text-[11px] bg-[#eee8d5] px-1 rounded">progress.json</code>
        </p>

        {activeEntries.length > 0 && (
          <div className="space-y-2 mb-5">
            {activeEntries.map(e => <NotificationCard key={e.id} entry={e} />)}
          </div>
        )}

        {dismissedEntries.length > 0 && (
          <>
            <div className="text-[10px] text-[#93a1a1] uppercase tracking-wide mb-2">Dismissed</div>
            <div className="space-y-2">
              {dismissedEntries.map(e => <NotificationCard key={e.id} entry={e} />)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
