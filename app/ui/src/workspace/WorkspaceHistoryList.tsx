import { useState } from 'react'
import { ProviderIcon } from '../components/SessionIcons'
import { formatRelativeTime } from '../lib/formatTime'
import { startSession } from '../hooks/useApi'
import { SearchHighlightedText } from './SearchHighlightedText'
import { fieldMatch, type SearchMatch } from './sessionSearch'
import type { HistorySession } from '../types'

let resumeCounter = 0

function HistoryItem({
  entry,
  isResuming,
  searchMatch,
  onResume,
  onGoLive,
}: {
  entry: HistorySession
  isResuming: boolean
  searchMatch?: SearchMatch | null
  onResume: () => void
  onGoLive: () => void
}) {
  const isLive = entry.liveSessionName != null
  const primary = entry.title ?? entry.summary
  const secondary = entry.title && entry.title !== entry.summary
    ? entry.summary : entry.id.slice(0, 8)
  const primaryKey = entry.title ? 'title' : 'summary'
  const secondaryKey = entry.title && entry.title !== entry.summary ? 'summary' : 'id'
  const primaryMatch = fieldMatch(searchMatch, primaryKey)
  const secondaryMatch = fieldMatch(searchMatch, secondaryKey)
  const branchMatch = fieldMatch(searchMatch, 'gitBranch')
  const snippet = searchMatch?.snippet

  const showBranch = !!(entry.gitBranch && entry.gitBranch !== 'main' && entry.gitBranch !== 'master')

  return (
    <div
      onClick={isResuming ? undefined : isLive ? onGoLive : onResume}
      className="flex items-start gap-2 px-2 py-0.5 rounded cursor-pointer text-ui-md hover:bg-sol-hover-bg"
      style={{ color: 'var(--sol-text)', opacity: isResuming ? 0.6 : 1, transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1)' }}
    >
      <ProviderIcon provider={entry.provider} className="w-4 h-4 shrink-0 mt-0.5" />
      {isLive && (
        <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 bg-[var(--sol-cyan)] status-pulse" />
      )}
      {isResuming && (
        <span className="w-3 h-3 shrink-0 mt-0.5 border-2 border-current border-t-transparent rounded-full animate-spin" style={{ color: 'var(--sol-muted)' }} />
      )}
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2">
          <SearchHighlightedText text={primary} positions={primaryMatch?.positions} className="font-medium" />
          <span className="text-ui-xs ml-1.5" style={{ color: 'var(--sol-text-faint)' }}>
            <SearchHighlightedText text={secondary} positions={secondaryMatch?.positions} />
            {showBranch && (
              <>
                {' · '}
                <SearchHighlightedText text={entry.gitBranch!} positions={branchMatch?.positions} />
              </>
            )}
            {entry.messageCount != null && ` · ${entry.messageCount} msgs`}
          </span>
        </div>
        {snippet && (
          <div className="text-ui-xs mt-0.5 truncate" style={{ color: 'var(--sol-text-faint)' }}>
            <span className="uppercase text-ui-2xs mr-1" style={{ color: 'var(--sol-muted)' }}>{snippet.label}:</span>
            <SearchHighlightedText text={snippet.text} positions={snippet.positions} />
          </div>
        )}
      </div>
      <span className="shrink-0 text-ui-xs mt-0.5" style={{ color: 'var(--sol-text-faint)' }}>
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
  searchMatches,
  emptyMessage = 'No past sessions',
}: {
  history: HistorySession[] | null
  loading: boolean
  resumingId: string | null
  projectPath: string
  setResumingId: (id: string | null) => void
  onResumed: (sessionName: string) => void
  onGoLive: (liveSessionName: string) => void
  searchMatches?: Map<string, SearchMatch | null>
  emptyMessage?: string
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
    return <div className="px-2 py-3 text-ui-sm text-center" style={{ color: 'var(--sol-text)' }}>Loading…</div>
  }

  if (!history || history.length === 0) {
    return <div className="px-2 py-3 text-ui-sm text-center" style={{ color: 'var(--sol-text)' }}>{emptyMessage}</div>
  }

  return (
    <>
      {error && (
        <div className="px-2 py-1 text-ui-xs rounded mx-1 mb-1" style={{ color: 'var(--sol-red)', backgroundColor: 'var(--sol-red-bg, rgba(220,50,47,0.08))' }}>
          {error}
        </div>
      )}
      {history.map(entry => (
        <HistoryItem
          key={entry.id}
          entry={entry}
          isResuming={resumingId === entry.id}
          searchMatch={searchMatches?.get(entry.id)}
          onResume={() => { void handleResume(entry) }}
          onGoLive={() => entry.liveSessionName && onGoLive(entry.liveSessionName)}
        />
      ))}
    </>
  )
}
