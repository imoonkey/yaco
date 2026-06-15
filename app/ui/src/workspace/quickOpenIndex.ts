import type { SearchEntry } from '../lib/fuzzySearch'

type CacheKey = string

const cache = new Map<CacheKey, SearchEntry[]>()

function key(project: string, includeIgnored: boolean, worktree?: string | null): CacheKey {
  return worktree ? `${project}:wt:${worktree}:${includeIgnored}` : `${project}:${includeIgnored}`
}

export function getCached(project: string, includeIgnored: boolean, worktree?: string | null): SearchEntry[] | null {
  return cache.get(key(project, includeIgnored, worktree)) ?? null
}

/** Fetch the search index from the server and update the cache. Every Cmd+P open
 *  calls this; the cached entries (returned by getCached) paint instantly while
 *  this refresh runs. No in-flight dedup — each open owns its own AbortController,
 *  so a rapid close/reopen always gets a live request, never a stale early-return. */
export async function fetchIndex(
  project: string,
  includeIgnored: boolean,
  signal?: AbortSignal,
  worktree?: string | null,
): Promise<SearchEntry[]> {
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
  cache.set(key(project, includeIgnored, worktree), data as SearchEntry[])
  return data as SearchEntry[]
}
