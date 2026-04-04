import { Fzf, byLengthAsc, extendedMatch } from 'fzf'
import type { Tiebreaker } from 'fzf'

export type SearchEntry = { name: string; path: string; type: 'file' | 'dir' }

export type FuzzyResult = {
  entry: SearchEntry
  positions: Set<number>
}

function byRecency(recentFiles: string[]): Tiebreaker<SearchEntry> {
  const recencyMap = new Map(recentFiles.map((f, i) => [f, i]))
  return (a, b) => {
    const aIdx = recencyMap.get(a.item.path) ?? Infinity
    const bIdx = recencyMap.get(b.item.path) ?? Infinity
    return aIdx - bIdx
  }
}

/**
 * Fuzzy-search file entries using fzf algorithm.
 * - Filters directories client-side
 * - Multi-term: spaces split into AND terms via extendedMatch
 * - Empty query: recent files first, then alphabetical
 * - Path-aware: forward matching when query contains '/'
 * - Results capped at 30
 */
export function fuzzySearch(
  files: SearchEntry[],
  query: string,
  recentFiles: string[],
): FuzzyResult[] {
  const fileOnly = files.filter(f => f.type === 'file')

  const trimmed = query.trim()
  if (!trimmed) {
    const fileMap = new Map(fileOnly.map(f => [f.path, f]))
    const seen = new Set<string>()
    const result: FuzzyResult[] = []
    for (const path of recentFiles) {
      const f = fileMap.get(path)
      if (f && !seen.has(path)) {
        seen.add(path)
        result.push({ entry: f, positions: new Set() })
      }
      if (result.length >= 30) return result
    }
    for (const f of fileOnly) {
      if (!seen.has(f.path)) {
        seen.add(f.path)
        result.push({ entry: f, positions: new Set() })
      }
      if (result.length >= 30) return result
    }
    return result
  }

  const fzf = new Fzf(fileOnly, {
    selector: (entry: SearchEntry) => entry.path,
    tiebreakers: [byRecency(recentFiles), byLengthAsc],
    limit: 30,
    forward: trimmed.includes('/'),
    match: extendedMatch,
  })

  return fzf.find(trimmed).map(r => ({
    entry: r.item,
    positions: r.positions,
  }))
}

/** Map path-level positions to name-level positions for display */
export function namePositions(entry: SearchEntry, pathPositions: Set<number>): Set<number> {
  const nameStart = entry.path.length - entry.name.length
  const result = new Set<number>()
  for (const p of pathPositions) {
    if (p >= nameStart) result.add(p - nameStart)
  }
  return result
}
