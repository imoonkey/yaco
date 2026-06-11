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
type SearchTerm =
  | { kind: 'literal'; value: string }
  | { kind: 'pattern'; regex: RegExp | null }
type ParsedSearchQuery =
  | { kind: 'empty' }
  | { kind: 'regex'; regex: RegExp | null }
  | { kind: 'terms'; terms: SearchTerm[] }

export type SearchFieldMatch = {
  key: SearchFieldKey
  label: string
  text: string
  positions: Set<number>
}

export type SearchSnippet = {
  key: SearchFieldKey
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

  return { key: field.key, label: field.label, text, positions: snippetPositions }
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

  const snippetField = fields
    .filter(field => snippetKeys.has(field.key))
    .sort((a, b) => b.positions.size - a.positions.size)[0]
  return { fields, snippet: snippetField ? buildSnippet(snippetField) : null }
}

function queryTerms(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
}

function hasWildcard(term: string): boolean {
  return term.includes('*') || term.includes('?')
}

function wildcardToRegex(term: string): RegExp | null {
  let pattern = ''
  for (const char of term) {
    if (char === '*') {
      pattern += '\\S*'
    } else if (char === '?') {
      pattern += '\\S'
    } else {
      pattern += char.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')
    }
  }
  return compileSearchRegex(pattern)
}

function isEscapedSlash(value: string, index: number): boolean {
  let backslashCount = 0
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) backslashCount += 1
  return backslashCount % 2 === 1
}

function closingSlashIndex(value: string): number {
  for (let index = value.length - 1; index > 0; index--) {
    if (value[index] === '/' && !isEscapedSlash(value, index)) return index
  }
  return -1
}

function compileSearchRegex(pattern: string, flags = ''): RegExp | null {
  const supportedFlags = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v'])
  if ([...flags].some(flag => !supportedFlags.has(flag))) return null

  const effectiveFlags = new Set(flags)
  effectiveFlags.add('g')
  effectiveFlags.add('i')

  try {
    return new RegExp(pattern, [...effectiveFlags].join(''))
  } catch {
    return null
  }
}

function parseRegexQuery(query: string): { regex: RegExp | null } | null {
  if (query.startsWith('re:')) {
    return { regex: query.length > 3 ? compileSearchRegex(query.slice(3)) : null }
  }
  if (!query.startsWith('/')) return null

  const end = closingSlashIndex(query)
  if (end <= 0) return { regex: null }
  return {
    regex: compileSearchRegex(query.slice(1, end), query.slice(end + 1)),
  }
}

function parseSearchQuery(query: string): ParsedSearchQuery {
  const trimmed = query.trim()
  if (!trimmed) return { kind: 'empty' }

  const regexQuery = parseRegexQuery(trimmed)
  if (regexQuery) return { kind: 'regex', regex: regexQuery.regex }

  return {
    kind: 'terms',
    terms: queryTerms(trimmed).map(term => (
      hasWildcard(term)
        ? { kind: 'pattern', regex: wildcardToRegex(term) }
        : { kind: 'literal', value: term }
    )),
  }
}

function termPositions(text: string, term: string): Set<number> | null {
  const positions = new Set<number>()
  let start = 0

  while (start < text.length) {
    const index = text.indexOf(term, start)
    if (index === -1) break
    for (let offset = 0; offset < term.length; offset++) {
      positions.add(index + offset)
    }
    start = index + Math.max(1, term.length)
  }

  return positions.size > 0 ? positions : null
}

function regexPositions(text: string, regex: RegExp): Set<number> | null {
  const positions = new Set<number>()
  regex.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const value = match[0]
    for (let offset = 0; offset < value.length; offset++) {
      positions.add(match.index + offset)
    }
    if (value.length === 0) regex.lastIndex += 1
  }

  return positions.size > 0 ? positions : null
}

function termMatchPositions(text: string, term: SearchTerm): Set<number> | null {
  if (term.kind === 'literal') return termPositions(text, term.value)
  return term.regex ? regexPositions(text, term.regex) : null
}

function queryMatchPositions(text: string, query: ParsedSearchQuery): Set<number> | null {
  if (query.kind === 'regex') return query.regex ? regexPositions(text, query.regex) : null
  if (query.kind === 'empty') return new Set()

  const positions = new Set<number>()

  for (const term of query.terms) {
    const termMatch = termMatchPositions(text, term)
    if (!termMatch) return null
    for (const position of termMatch) positions.add(position)
  }

  return positions
}

function matchByFields<T extends object>(
  items: T[],
  query: string,
  fieldsFor: (item: T) => SearchFieldInput[],
  snippetKeys: SearchFieldKey[],
): SearchResult<T>[] {
  const parsedQuery = parseSearchQuery(query)
  if (parsedQuery.kind === 'empty') return items.map(item => ({ item, match: null }))

  const searchable = items.map(item => toSearchableItem(item, fieldsFor(item)))
  const snippetKeySet = new Set(snippetKeys)
  const results: SearchResult<T>[] = []

  for (const entry of searchable) {
    const positions = queryMatchPositions(entry.text, parsedQuery)
    if (!positions) continue
    results.push({
      item: entry.item,
      match: buildMatch(entry, positions, snippetKeySet),
    })
  }

  return results
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
