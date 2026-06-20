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
 *  row shows just its state label. */
export function noticeContent(item: AttentionItem): string {
  return item.message ?? ''
}
