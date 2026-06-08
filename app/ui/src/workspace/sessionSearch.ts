import { Fzf, extendedMatch } from 'fzf'
import type { AgentSession, HistorySession } from '../types'

type SearchField = string | number | null | undefined
type SearchableItem<T> = { item: T; text: string }

function searchableText(fields: SearchField[]): string {
  return fields
    .filter((field): field is string | number => field != null && field !== '')
    .join(' ')
    .toLocaleLowerCase()
}

function filterByFields<T extends object>(
  items: T[],
  query: string,
  fieldsFor: (item: T) => SearchField[],
): T[] {
  const trimmed = query.trim().toLocaleLowerCase()
  if (!trimmed) return items

  const searchable = items.map(item => ({ item, text: searchableText(fieldsFor(item)) }))
  const fzf = new Fzf(searchable, {
    selector: (entry: SearchableItem<T>) => entry.text,
    match: extendedMatch,
    limit: items.length,
    sort: false,
  })
  return fzf.find(trimmed).map(result => result.item.item)
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
    entry.gitBranch,
    entry.liveSessionName,
  ])
}
