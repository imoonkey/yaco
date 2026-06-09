// Local-only, content-free metrics for the markdown inline-suggestion feature.
// The app is local-first single-user, so these counters never leave the machine
// and exist only to inform the keep/tune/delete gate (design §12).
//
// HARD PRIVACY CONSTRAINT — content-free by construction:
//   The public API surface is (project, worktree, event-name). No function here
//   accepts or persists document text, prompt text, suggestion text, file
//   contents, or absolute paths. Every write is a fixed-shape record of integer
//   counters; the read path sanitizes back to that shape, so a tampered blob
//   carrying text cannot survive a read-modify-write.

// Storage-key prefix. `rg "yaco-inline-suggestions" app/ui/src` finds this.
export const SUGGESTION_METRICS_PREFIX = 'yaco-inline-suggestions'

// Lifecycle events, one per counter. These names match the task accept criteria.
export type SuggestionEvent =
  | 'shown'
  | 'accepted_full'
  | 'accepted_word'
  | 'dismissed_escape'
  | 'dismissed_typing'
  | 'disabled_after_shown'
  | 'error'

export type SuggestionCounters = Record<SuggestionEvent, number>

// The canonical event list — drives sanitization (only these keys are kept).
export const SUGGESTION_EVENTS: readonly SuggestionEvent[] = [
  'shown',
  'accepted_full',
  'accepted_word',
  'dismissed_escape',
  'dismissed_typing',
  'disabled_after_shown',
  'error',
]

export function zeroCounters(): SuggestionCounters {
  return {
    shown: 0,
    accepted_full: 0,
    accepted_word: 0,
    dismissed_escape: 0,
    dismissed_typing: 0,
    disabled_after_shown: 0,
    error: 0,
  }
}

// Runtime membership check. TypeScript's union erases at compile time, so a
// miscast/`any`/foreign-JS caller could otherwise pass arbitrary text as an
// event and have it written as a JSON key. This is the runtime gate.
const EVENT_SET: ReadonlySet<string> = new Set(SUGGESTION_EVENTS)

export function isSuggestionEvent(value: unknown): value is SuggestionEvent {
  return typeof value === 'string' && EVENT_SET.has(value)
}

// Reduce a key component to a conservative slug so the storage key can never
// embed a path — absolute or relative. Anything outside [A-Za-z0-9._-] (path
// separators `/` `\`, the `:` delimiter, whitespace, NUL/control chars) becomes
// `_`, so a miscall passing an absolute path cannot leak it into the key.
function safeSlug(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, '_')
}

// Keyed per project AND worktree so dogfooding signal is not mixed across repos
// or worktrees. A null/undefined worktree (main checkout) yields a trailing ":".
export function metricsKey(project: string, worktree?: string | null): string {
  return `${SUGGESTION_METRICS_PREFIX}:${safeSlug(project)}:${safeSlug(worktree ?? '')}`
}

// Minimal storage surface so callers can inject a fake in tests and so a missing
// localStorage (SSR / privacy mode) degrades to a no-op instead of throwing.
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

// Coerce an arbitrary parsed value into the fixed counter shape: keep only known
// keys whose value is a finite non-negative number. This is the content-free
// guard on the read path — anything else (strings, extra keys) is dropped.
function sanitize(raw: unknown): SuggestionCounters {
  const counters = zeroCounters()
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    for (const event of SUGGESTION_EVENTS) {
      const value = record[event]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        counters[event] = Math.floor(value)
      }
    }
  }
  return counters
}

export function readCounters(
  project: string,
  worktree?: string | null,
  storage: StorageLike | null = defaultStorage(),
): SuggestionCounters {
  if (!storage) return zeroCounters()
  try {
    const raw = storage.getItem(metricsKey(project, worktree))
    return raw ? sanitize(JSON.parse(raw)) : zeroCounters()
  } catch {
    return zeroCounters()
  }
}

// Atomic-ish read-modify-write of the JSON blob. Best-effort: storage failures
// (quota, unavailable) never block editing. Returns the updated counters.
//
// The serialized object is always the freshly-constructed fixed-shape record
// returned by readCounters() (exactly the SUGGESTION_EVENTS keys, all integers)
// — the caller's `event` is only ever used to index a known key, never spread
// or echoed as a key — and an unrecognized event is a no-op write.
export function recordSuggestionEvent(
  project: string,
  worktree: string | null | undefined,
  event: SuggestionEvent,
  storage: StorageLike | null = defaultStorage(),
): SuggestionCounters {
  const counters = readCounters(project, worktree, storage)
  if (!isSuggestionEvent(event)) return counters // reject text/foreign keys
  counters[event] += 1
  if (storage) {
    try {
      storage.setItem(metricsKey(project, worktree), JSON.stringify(counters))
    } catch {
      /* storage full / unavailable — metrics are best-effort */
    }
  }
  return counters
}

// Derived gate metric: accept rate = (accepted_full + accepted_word) / shown.
// Zero when nothing has been shown (avoids a divide-by-zero spike at startup).
export function acceptanceRate(counters: SuggestionCounters): number {
  if (counters.shown <= 0) return 0
  return (counters.accepted_full + counters.accepted_word) / counters.shown
}
