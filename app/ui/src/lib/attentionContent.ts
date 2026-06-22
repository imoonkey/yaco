import type { AttentionItem } from '../hooks/useAttention'

/** The identity shown on a row's scan line — the session name or the task id.
 *  This is the unique thing the user scans for ("which of my agents"); the
 *  project is rendered separately as faint meta. */
export function identityKey(item: AttentionItem): string {
  const s = item.subject
  return s.kind === 'session' ? s.sessionName : s.taskId
}

/** Short, identity-free state label for the colored content lead-in. Task titles
 *  embed the id the row already shows as its identity (`Task done: T1`), so task
 *  types collapse to a bare verb; session titles are already clean state phrases
 *  (`Your turn`, `Needs approval`, `Crashed (exit 1)`). */
export function stateLabel(item: AttentionItem): string {
  if (item.type === 'task_blocked') return 'Blocked'
  if (item.type === 'task_done') return 'Done'
  return item.title
}

/** The captured notice to render on the content line. The server emits '' when
 *  there is no notice (no location filler — the scan line already carries identity
 *  + project), so the client renders `message` verbatim; an empty value means the
 *  row shows just its state label. Carries the agent's (near-)full final message —
 *  the voice read-back paraphrases it; visual surfaces clamp via `noticeDisplay`. */
export function noticeContent(item: AttentionItem): string {
  return item.message ?? ''
}

/** Short visual teaser for the toast / panel / OS notification. `message` now
 *  carries the full final message (for speech), so the visual surfaces clamp it
 *  here — the fork: speech reads `noticeContent` (full), the eye gets this. Slice
 *  by codepoints so a non-BMP char at the boundary isn't split. */
const NOTICE_DISPLAY_MAX = 200
export function noticeDisplay(item: AttentionItem): string {
  const text = noticeContent(item)
  // Count + slice by codepoints so an exactly-200-codepoint non-BMP teaser isn't
  // over-ellipsized and a boundary char isn't split.
  const cps = [...text]
  if (cps.length <= NOTICE_DISPLAY_MAX) return text
  return `${cps.slice(0, NOTICE_DISPLAY_MAX).join('')}…`
}

/** The spoken string for a batch of freshly-surfaced interrupts (voice read-back).
 *  Mirrors the toast's single-vs-burst split (`surfaceInterrupts`): one item reads
 *  its state then its notice (`"Your turn. Finished the parser refactor."`), an
 *  empty notice collapses to the state alone (`"Crashed (exit 1)"`); a burst reads
 *  a count, never N messages. '' when there is nothing to say. */
export function speechTextFor(items: AttentionItem[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) {
    const item = items[0]
    return [stateLabel(item), noticeContent(item)].filter(Boolean).join('. ')
  }
  return `${items.length} agents need your attention`
}
