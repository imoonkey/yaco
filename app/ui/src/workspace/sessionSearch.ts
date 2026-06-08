import type { AgentSession, HistorySession } from '../types'

type SearchField = string | number | null | undefined

function searchTerms(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
}

function matchesTerms(terms: string[], fields: SearchField[]): boolean {
  const haystack = fields
    .filter((field): field is string | number => field != null && field !== '')
    .join(' ')
    .toLocaleLowerCase()

  return terms.every(term => haystack.includes(term))
}

function filterByFields<T>(
  items: T[],
  query: string,
  fieldsFor: (item: T) => SearchField[],
): T[] {
  const terms = searchTerms(query)
  if (terms.length === 0) return items
  return items.filter(item => matchesTerms(terms, fieldsFor(item)))
}

export function filterAgentSessions(sessions: AgentSession[], query: string): AgentSession[] {
  return filterByFields(sessions, query, session => [
    session.name,
    session.provider,
    session.status,
    session.project,
    session.summary,
    session.worktree,
    session.spawnedBy,
    session.parentSession,
  ])
}

export function filterHistorySessions(history: HistorySession[], query: string): HistorySession[] {
  return filterByFields(history, query, entry => [
    entry.id,
    entry.provider,
    entry.title,
    entry.summary,
    entry.created,
    entry.modified,
    entry.messageCount,
    entry.gitBranch,
    entry.liveSessionName,
  ])
}
