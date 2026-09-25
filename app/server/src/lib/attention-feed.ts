/** One page of the attention feed: the full live snapshot (needsYou/ready/badges)
 *  plus a bounded, cursor-paged slice of Recent history. Both `GET /api/attention/feed`
 *  and the `attention` SSE push send this shape, so a push is exactly a first-page
 *  feed refresh and its size never grows with the history. */

import type { AttentionItem, AttentionSnapshot } from './attention-projection'

/** Recent feed page size: a sane default and a hard cap (spec OQ3). */
export const DEFAULT_FEED_LIMIT = 50
export const MAX_FEED_LIMIT = 200

export type FeedPage = AttentionSnapshot & { nextBefore: string | null }

/** Recent pages by a stable COMPOSITE cursor `(tsMs desc, generation desc)`, not
 *  timestamp alone — so rows that share a `tsMs` (rollup-stamped task transitions,
 *  burst events) past a page boundary are never silently skipped. The cursor is
 *  encoded as `"<tsMs>:<generation>"`; `generation` is a stable per-row id and may
 *  itself contain ':', so we split on the FIRST ':' only. */
export interface FeedCursor { tsMs: number; generation: string }

function encodeCursor(item: AttentionItem): string {
  return `${item.tsMs}:${item.generation}`
}

export function parseCursor(raw: string | undefined): FeedCursor | null {
  if (!raw) return null
  const sep = raw.indexOf(':')
  if (sep < 0) return null
  const tsMs = Number(raw.slice(0, sep))
  const generation = raw.slice(sep + 1)
  if (!Number.isFinite(tsMs) || !generation) return null
  return { tsMs, generation }
}

/** Deterministic newest-first order: tsMs desc, then generation desc as a stable
 *  tiebreak so equal-tsMs rows have a total order the cursor can page through. */
function compareRows(a: AttentionItem, b: AttentionItem): number {
  if (a.tsMs !== b.tsMs) return b.tsMs - a.tsMs
  return a.generation < b.generation ? 1 : a.generation > b.generation ? -1 : 0
}

/** A row is strictly older than the cursor under the (tsMs desc, generation desc)
 *  total order — i.e. it sorts AFTER the cursor row. */
function isAfterCursor(r: AttentionItem, cur: FeedCursor): boolean {
  if (r.tsMs !== cur.tsMs) return r.tsMs < cur.tsMs
  return r.generation < cur.generation
}

/** Page a snapshot's Recent history. Sorts deterministically (the projector orders
 *  by tsMs only), keeps every row after the cursor, and cuts `limit` rows.
 *  `nextBefore` is this page's oldest row, or null when the history is exhausted. */
export function feedPage(snapshot: AttentionSnapshot, limit = DEFAULT_FEED_LIMIT, cursor: FeedCursor | null = null): FeedPage {
  const recent = [...snapshot.recent].sort(compareRows)
  const filtered = cursor ? recent.filter((r) => isAfterCursor(r, cursor)) : recent
  const page = filtered.slice(0, limit)
  const nextBefore = filtered.length > page.length && page.length > 0 ? encodeCursor(page[page.length - 1]) : null
  return { ...snapshot, recent: page, nextBefore }
}
