import { useState } from 'react'
import { ProviderIcon } from '../components/SessionIcons'
import { formatRelativeTime } from '../lib/formatTime'
import { startSession } from '../hooks/useApi'
import type { HistorySession } from '../types'

let resumeCounter = 0

function HistoryItem({
  entry,
  isResuming,
  onResume,
  onGoLive,
}: {
  entry: HistorySession
  isResuming: boolean
  onResume: () => void
  onGoLive: () => void
}) {
  const isLive = entry.liveSessionName != null
  const primary = entry.title ?? entry.summary
  const secondary = entry.title && entry.title !== entry.summary
    ? entry.summary : entry.id.slice(0, 8)

  const meta: string[] = []
  if (entry.gitBranch) meta.push(entry.gitBranch)
  if (entry.messageCount != null) meta.push(`${entry.messageCount} msgs`)

  return (
    <div
      onClick={isResuming ? undefined : isLive ? onGoLive : onResume}
      className="flex flex-wrap items-baseline gap-x-2 gap-y-0 px-2 py-1.5 rounded cursor-pointer text-[12px]"
      style={{ color: 'var(--sol-text)', opacity: isResuming ? 0.6 : 1, fontFamily: 'var(--font-ui)', transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1)' }}
      onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--sol-hover-bg)' }}
      onMouseLeave={e => { e.currentTarget.style.backgroundColor = '' }}
    >
      <div className="flex items-center gap-2 shrink-0">
        <ProviderIcon provider={entry.provider} className="w-4 h-4 shrink-0" />
        {isLive && (
          <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--sol-cyan)] status-pulse" />
        )}
        {isResuming && (
          <span className="w-3 h-3 shrink-0 border-2 border-current border-t-transparent rounded-full animate-spin" style={{ color: 'var(--sol-muted)' }} />
        )}
        <span className="min-w-0 truncate">{primary}</span>
      </div>
      <span className="text-[10px] min-w-0" style={{ color: 'var(--sol-muted)' }}>
        {secondary}
        {meta.length > 0 && ` · ${meta.join(' · ')}`}
      </span>
      <span className="shrink-0 text-[10px] ml-auto" style={{ color: 'var(--sol-muted)' }}>
        {formatRelativeTime(entry.modified)}
      </span>
    </div>
  )
}

export function WorkspaceHistoryList({
  history,
  loading,
  resumingId,
  projectPath,
  setResumingId,
  onResumed,
  onGoLive,
}: {
  history: HistorySession[] | null
  loading: boolean
  resumingId: string | null
  projectPath: string
  setResumingId: (id: string | null) => void
  onResumed: (sessionName: string) => void
  onGoLive: (liveSessionName: string) => void
}) {
  const [error, setError] = useState<string | null>(null)

  const handleResume = async (entry: HistorySession) => {
    setError(null)
    setResumingId(entry.id)
    try {
      const name = entry.title ?? `${entry.provider}-resume-${++resumeCounter}`
      const handle = await startSession(entry.provider, projectPath, entry.id, name)
      onResumed(handle)
    } catch (e) {
      setResumingId(null)
      setError(e instanceof Error ? e.message : 'Resume failed')
    }
  }

  if (loading && !history) {
    return <div className="px-2 py-3 text-[11px] text-center" style={{ color: 'var(--sol-muted)', fontFamily: 'var(--font-ui)' }}>Loading…</div>
  }

  if (!history || history.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-center" style={{ color: 'var(--sol-muted)', fontFamily: 'var(--font-ui)' }}>No past sessions</div>
  }

  return (
    <>
      {error && (
        <div className="px-2 py-1 text-[10px] rounded mx-1 mb-1" style={{ color: 'var(--sol-red)', backgroundColor: 'var(--sol-red-bg, rgba(220,50,47,0.08))' }}>
          {error}
        </div>
      )}
      {history.map(entry => (
        <HistoryItem
          key={entry.id}
          entry={entry}
          isResuming={resumingId === entry.id}
          onResume={() => { void handleResume(entry) }}
          onGoLive={() => entry.liveSessionName && onGoLive(entry.liveSessionName)}
        />
      ))}
    </>
  )
}
