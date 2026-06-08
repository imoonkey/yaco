import { Fzf, extendedMatch } from 'fzf'
import { sanitizeSummary } from './sanitizeSummary'
import type { AgentSession, HistorySession } from '../types'

export type SearchFieldKey =
  | 'name'
  | 'provider'
  | 'status'
  | 'project'
  | 'summary'
  | 'worktree'
  | 'spawnedBy'
  | 'parentSession'
  | 'id'
  | 'title'
  | 'gitBranch'
  | 'liveSessionName'

type SearchFieldValue = string | number | null | undefined
type SearchFieldInput = { key: SearchFieldKey; label: string; value: SearchFieldValue }
type NormalizedSearchField = {
  key: SearchFieldKey
  label: string
  text: string
  start: number
  end: number
}
type SearchableItem<T> = { item: T; text: string; fields: NormalizedSearchField[] }

export type SearchFieldMatch = {
  key: SearchFieldKey
  label: string
  text: string
  positions: Set<number>
}

export type SearchSnippet = {
  label: string
  text: string
  positions: Set<number>
}

export type SearchMatch = {
  fields: SearchFieldMatch[]
  snippet: SearchSnippet | null
}

export type SearchResult<T> = {
  item: T
  match: SearchMatch | null
}

const SNIPPET_RADIUS = 28

function normalizeFields(fields: SearchFieldInput[]): Pick<SearchableItem<unknown>, 'text' | 'fields'> {
  let text = ''
  const normalized: NormalizedSearchField[] = []

  for (const field of fields) {
    if (field.value == null || field.value === '') continue
    const original = String(field.value)
    if (!original) continue

    if (text) text += ' '
    const start = text.length
    const searchable = original.toLowerCase()
    text += searchable
    normalized.push({
      key: field.key,
      label: field.label,
      text: original,
      start,
      end: start + searchable.length,
    })
  }

  return { text, fields: normalized }
}

function toSearchableItem<T>(item: T, fields: SearchFieldInput[]): SearchableItem<T> {
  return { item, ...normalizeFields(fields) }
}

function buildSnippet(field: SearchFieldMatch): SearchSnippet {
  const positions = [...field.positions].sort((a, b) => a - b)
  const first = positions[0] ?? 0
  const last = positions[positions.length - 1] ?? first
  const start = Math.max(0, first - SNIPPET_RADIUS)
  const end = Math.min(field.text.length, last + SNIPPET_RADIUS + 1)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < field.text.length ? '...' : ''
  const text = `${prefix}${field.text.slice(start, end)}${suffix}`
  const offset = prefix.length - start
  const snippetPositions = new Set(
    positions
      .filter(position => position >= start && position < end)
      .map(position => position + offset),
  )

  return { label: field.label, text, positions: snippetPositions }
}

function buildMatch(
  entry: SearchableItem<unknown>,
  positions: Set<number>,
  snippetKeys: Set<SearchFieldKey>,
): SearchMatch {
  const fields: SearchFieldMatch[] = []

  for (const field of entry.fields) {
    const fieldPositions = new Set<number>()
    for (const position of positions) {
      if (position >= field.start && position < field.end) {
        fieldPositions.add(position - field.start)
      }
    }
    if (fieldPositions.size === 0) continue
    fields.push({
      key: field.key,
      label: field.label,
      text: field.text,
      positions: fieldPositions,
    })
  }

  const snippetField = fields.find(field => snippetKeys.has(field.key))
  return { fields, snippet: snippetField ? buildSnippet(snippetField) : null }
}

function matchByFields<T extends object>(
  items: T[],
  query: string,
  fieldsFor: (item: T) => SearchFieldInput[],
  snippetKeys: SearchFieldKey[],
): SearchResult<T>[] {
  const trimmed = query.trim().toLocaleLowerCase()
  if (!trimmed) return items.map(item => ({ item, match: null }))

  const searchable = items.map(item => toSearchableItem(item, fieldsFor(item)))
  const fzf = new Fzf(searchable, {
    selector: (entry: SearchableItem<T>) => entry.text,
    match: extendedMatch,
    limit: items.length,
    sort: false,
  })
  const snippetKeySet = new Set(snippetKeys)
  return fzf.find(trimmed).map(result => ({
    item: result.item.item,
    match: buildMatch(result.item, result.positions, snippetKeySet),
  }))
}

export function fieldMatch(
  match: SearchMatch | null | undefined,
  key: SearchFieldKey,
): SearchFieldMatch | null {
  return match?.fields.find(field => field.key === key) ?? null
}

export function matchAgentSessions(sessions: AgentSession[], query: string): SearchResult<AgentSession>[] {
  return matchByFields(sessions, query, session => [
    { key: 'name', label: 'name', value: session.name },
    { key: 'provider', label: 'provider', value: session.provider },
    { key: 'status', label: 'status', value: session.status },
    { key: 'project', label: 'project', value: session.project },
    { key: 'summary', label: 'summary', value: sanitizeSummary(session.summary, session.name) },
    { key: 'worktree', label: 'worktree', value: session.worktree },
    { key: 'spawnedBy', label: 'spawned by', value: session.spawnedBy },
    { key: 'parentSession', label: 'parent', value: session.parentSession },
  ], ['summary', 'provider', 'status', 'project', 'worktree', 'spawnedBy', 'parentSession'])
}

export function filterAgentSessions(sessions: AgentSession[], query: string): AgentSession[] {
  if (!query.trim()) return sessions
  return matchAgentSessions(sessions, query).map(result => result.item)
}

export function matchHistorySessions(history: HistorySession[], query: string): SearchResult<HistorySession>[] {
  return matchByFields(history, query, entry => [
    { key: 'id', label: 'id', value: entry.id },
    { key: 'provider', label: 'provider', value: entry.provider },
    { key: 'title', label: 'title', value: entry.title },
    { key: 'summary', label: 'summary', value: entry.summary },
    { key: 'gitBranch', label: 'branch', value: entry.gitBranch },
    { key: 'liveSessionName', label: 'live', value: entry.liveSessionName },
  ], ['summary', 'provider', 'id', 'gitBranch', 'liveSessionName'])
}

export function filterHistorySessions(history: HistorySession[], query: string): HistorySession[] {
  if (!query.trim()) return history
  return matchHistorySessions(history, query).map(result => result.item)
}
