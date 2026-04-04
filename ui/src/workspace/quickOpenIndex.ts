import type { SearchEntry } from '../lib/fuzzySearch'

type CacheKey = string
type CacheEntry = {
  entries: SearchEntry[]
  stale: boolean
  fetching: boolean
}

const cache = new Map<CacheKey, CacheEntry>()

function key(project: string, includeIgnored: boolean): CacheKey {
  return `${project}:${includeIgnored}`
}

export function getCached(project: string, includeIgnored: boolean): SearchEntry[] | null {
  return cache.get(key(project, includeIgnored))?.entries ?? null
}

export function isCacheStale(project: string, includeIgnored: boolean): boolean {
  const entry = cache.get(key(project, includeIgnored))
  return !entry || entry.stale
}

/** Mark all cache entries for a project as stale (both tracked and ignored) */
export function markStale(project: string): void {
  for (const [k, v] of cache) {
    if (k.startsWith(project + ':')) {
      v.stale = true
    }
  }
}

/** Fetch search index from server and update cache */
export async function fetchIndex(
  project: string,
  includeIgnored: boolean,
  signal?: AbortSignal,
): Promise<SearchEntry[]> {
  const k = key(project, includeIgnored)
  const existing = cache.get(k)
  if (existing?.fetching) return existing.entries

  if (existing) existing.fetching = true

  try {
    const qs = includeIgnored ? '?ignored=true' : ''
    const res = await fetch(
      `/api/files/${encodeURIComponent(project)}/search-index${qs}`,
      { signal },
    )
    const data: SearchEntry[] = await res.json()
    cache.set(k, { entries: data, stale: false, fetching: false })
    return data
  } catch (e) {
    if (existing) existing.fetching = false
    throw e
  }
}
