// WorktreePicker — the Files-panel-body worktree selector (design: §P2…§P2e).
//
// Mirrors the Changes "Compare ref" interaction (ChangesPanel + CompareRefPicker): the
// picker renders INLINE in the panel body as an accent box (accent top-border + tinted
// bg), pushing the file tree down — NOT a floating dropdown. The non-default state for a
// worktree is APP state, not a UI mode:
//
//   - PRIMARY active (`activeWorktree === null`) and CLOSED: nothing renders — exactly as
//     Compare ref shows nothing when not comparing. The Files header's `GitBranch` toggle
//     is the entry point that opens the inline list.
//   - A NON-PRIMARY worktree active and CLOSED: a persistent collapsed INDICATOR box
//     renders atop the Files body AT ALL TIMES (tree and search mode) — the reminder, the
//     analogue of the CompareRefPicker box that stays shown while in compare mode. It
//     carries the worktree's branch + dirty/ahead-behind, an `X` that REMOVES the worktree
//     (`onSelect(null)` → back to primary, like Compare ref's exit-to-default), and is
//     itself a trigger that opens the list.
//   - OPEN (header toggle on, any state): the accent box wraps the full worktree LIST
//     inline — every worktree as a row. The list is git-sourced (P1: `useProjectWorktrees`),
//     so manually-created and task-less worktrees appear. Selecting a row calls
//     `onSelect(id | null)` (primary → `null`) and closes.
//
// Inline rendering needs no `position:fixed` anchor, no `autoFocusRef`/`restoreFocus`: the
// list lives in the panel flow, and closing it never restores focus to the header button,
// so the P2d stray-Enter-reopen regression cannot occur.
import { GitBranch, Check, ChevronDown, X } from 'lucide-react'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'

interface WorktreePickerProps {
  worktrees: WorktreeInfo[]
  /** The selected worktree's absolute-path id, or null for the primary checkout. */
  activeWorktree: string | null
  /** Bind a worktree by id; null returns to the primary checkout. */
  onSelect: (id: string | null) => void
  /** Whether the inline list is expanded (lives in FilesPanel's module store — the
   *  header toggle and this body region are PanelFrame siblings). */
  open: boolean
  onOpenChange: (open: boolean) => void
}

// The shared accent box — CompareRefPicker styling. Both the collapsed indicator and the
// open list use it so the two states read as one surface.
const ACCENT_BOX = 'mx-1 mt-1 rounded-md'
const ACCENT_BOX_STYLE: React.CSSProperties = {
  borderTop: '2px solid var(--sol-accent)',
  backgroundColor: 'color-mix(in srgb, var(--sol-accent) 3%, var(--sol-bg))',
}

/** Resolve the currently-selected worktree: the one whose id matches the selection,
 *  else the primary, else the first listed. The primary fallback runs even when
 *  `activeWorktree` is a non-null id no longer registered (a stale selection App clears
 *  on its next pass) — so a gone worktree reads as "on primary" (no indicator) and the
 *  header tooltip never names a worktree that has gone away. */
// eslint-disable-next-line react-refresh/only-export-components
export function currentWorktreeEntry(
  worktrees: WorktreeInfo[], activeWorktree: string | null,
): WorktreeInfo | null {
  if (worktrees.length === 0) return null
  return worktrees.find(wt => wt.id === activeWorktree)
    ?? worktrees.find(wt => wt.isPrimary)
    ?? worktrees[0]
}

/** Dirty dot + ahead/behind, shared by the indicator box and the list rows. */
function WorktreeMeta({ wt }: { wt: WorktreeInfo }) {
  return (
    <>
      {(wt.ahead > 0 || wt.behind > 0) && (
        <span className="text-ui-2xs tabular-nums shrink-0 whitespace-nowrap" style={{ color: 'var(--sol-text-faint)' }}>
          {wt.ahead > 0 && `↑${wt.ahead}`}{wt.ahead > 0 && wt.behind > 0 && ' '}{wt.behind > 0 && `↓${wt.behind}`}
        </span>
      )}
      {wt.dirty && (
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: 'var(--sol-warning)' }} />
      )}
    </>
  )
}

export function WorktreePicker({ worktrees, activeWorktree, onSelect, open, onOpenChange }: WorktreePickerProps) {
  // Nothing to pick (non-git project, or the list is still loading): render no
  // affordance. The header toggle guards on the same count.
  if (worktrees.length === 0) return null

  // OPEN (any active worktree): the full list inline. The active row carries the `Check`,
  // so picking `primary` here is the return-to-main path (the indicator's X equivalent).
  if (open) {
    return (
      <div className={ACCENT_BOX} style={ACCENT_BOX_STYLE}>
        <div role="listbox" aria-label="Worktrees" className="flex flex-col py-1 max-h-[min(320px,50vh)] overflow-y-auto">
          {worktrees.map((wt) => {
            const isActive = wt.isPrimary ? activeWorktree === null : wt.id === activeWorktree
            return (
              <button
                key={wt.id}
                type="button"
                role="option"
                aria-selected={isActive}
                data-worktree-id={wt.id}
                onClick={() => { onSelect(wt.isPrimary ? null : wt.id); onOpenChange(false) }}
                className="flex items-center gap-1.5 h-[24px] mx-1 px-1.5 rounded-sm text-ui-md cursor-pointer text-left"
                style={{ color: 'var(--sol-text)', transition: 'background-color 120ms' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--sol-hover-bg)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
                title={wt.name}
              >
                <GitBranch size={11} className="shrink-0 opacity-60" />
                <span className="truncate flex-1" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '-0.01em' }}>
                  {wt.branch}
                </span>
                {wt.isPrimary && (
                  <span
                    className="text-ui-2xs uppercase tracking-wider px-1 rounded shrink-0"
                    style={{ color: 'var(--sol-text-faint)', border: '1px solid var(--sol-border)', background: 'var(--sol-subtle-bg)' }}
                  >
                    primary
                  </span>
                )}
                <WorktreeMeta wt={wt} />
                <Check size={12} className="shrink-0" style={{ opacity: isActive ? 1 : 0 }} />
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  const current = currentWorktreeEntry(worktrees, activeWorktree)
  // CLOSED + primary (or a gone/stale selection that resolves to primary): nothing
  // persistent — exactly as Compare ref shows nothing when not comparing.
  if (!current || current.isPrimary) return null

  // CLOSED + non-primary: the persistent indicator box (Compare-ref styling). A clickable
  // region opens the inline list; a sibling X removes the worktree (→ primary). The two
  // affordances are siblings (no nested interactive element).
  return (
    <div className={ACCENT_BOX} style={ACCENT_BOX_STYLE}>
      <div className="flex items-center h-[24px] mx-1 my-1 gap-1">
        <button
          type="button"
          aria-label={`Worktree: ${current.branch}`}
          aria-expanded={open}
          className="flex flex-1 min-w-0 items-center h-full cursor-pointer rounded-sm px-1 gap-1.5"
          style={{ transition: 'background-color 120ms' }}
          onClick={() => onOpenChange(!open)}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--sol-hover-bg)')}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
        >
          <span
            className="shrink-0 text-ui-2xs uppercase tracking-wider font-semibold"
            style={{ color: 'var(--sol-text)' }}
          >worktree</span>
          <span
            className="flex-1 text-ui-md truncate font-medium text-left"
            style={{ color: 'var(--sol-text-dark)', fontFamily: 'var(--font-mono)', letterSpacing: '-0.01em' }}
          >{current.branch}</span>
          <WorktreeMeta wt={current} />
          <ChevronDown
            size={10}
            className="shrink-0"
            style={{
              color: open ? 'var(--sol-accent)' : 'var(--sol-text)',
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 200ms cubic-bezier(0.2, 0, 0, 1), color 120ms',
            }}
          />
        </button>
        <button
          type="button"
          aria-label="Remove worktree (return to primary)"
          title="Remove worktree (return to primary)"
          className="flex items-center justify-center shrink-0 w-[18px] h-[18px] rounded-sm"
          style={{ color: 'var(--sol-text)', transition: 'color 120ms, background-color 120ms' }}
          onClick={() => onSelect(null)}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--sol-accent)'; e.currentTarget.style.backgroundColor = 'var(--sol-hover-bg)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--sol-text)'; e.currentTarget.style.backgroundColor = '' }}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
