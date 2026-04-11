import type { SearchEntry } from '../lib/fuzzySearch'

type CacheKey = string
type CacheEntry = {
  entries: SearchEntry[]
  stale: boolean
  fetching: boolean
}

const cache = new Map<CacheKey, CacheEntry>()

function key(project: string, includeIgnored: boolean, worktree?: string | null): CacheKey {
  return worktree ? `${project}:wt:${worktree}:${includeIgnored}` : `${project}:${includeIgnored}`
}

export function getCached(project: string, includeIgnored: boolean, worktree?: string | null): SearchEntry[] | null {
  return cache.get(key(project, includeIgnored, worktree))?.entries ?? null
}

export function isCacheStale(project: string, includeIgnored: boolean, worktree?: string | null): boolean {
  const entry = cache.get(key(project, includeIgnored, worktree))
  return !entry || entry.stale
}

/** Mark all cache entries for a project (+ worktree) as stale */
export function markStale(project: string, worktree?: string | null): void {
  const prefix = worktree ? `${project}:wt:${worktree}:` : `${project}:`
  for (const [k, v] of cache) {
    if (k.startsWith(prefix)) {
      v.stale = true
    }
  }
}

/** Fetch search index from server and update cache */
export async function fetchIndex(
  project: string,
  includeIgnored: boolean,
  signal?: AbortSignal,
  worktree?: string | null,
): Promise<SearchEntry[]> {
  const k = key(project, includeIgnored, worktree)
  const existing = cache.get(k)
  if (existing?.fetching) return existing.entries

  if (existing) existing.fetching = true

  try {
    let qs = includeIgnored ? '?ignored=true' : ''
    if (worktree) {
      qs += (qs ? '&' : '?') + `worktree=${encodeURIComponent(worktree)}`
    }
    const res = await fetch(
      `/api/files/${encodeURIComponent(project)}/search-index${qs}`,
      { signal },
    )
    if (!res.ok) {
      throw new Error(`Search index fetch failed: ${res.status}`)
    }
    const data = await res.json()
    if (!Array.isArray(data)) {
      throw new Error('Search index response is not an array')
    }
    cache.set(k, { entries: data as SearchEntry[], stale: false, fetching: false })
    return data as SearchEntry[]
  } catch (e) {
    if (existing) existing.fetching = false
    throw e
  }
}
