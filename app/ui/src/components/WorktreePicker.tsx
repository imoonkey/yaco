// WorktreePicker — the Files-header worktree selector (design: §P2).
//
// Trigger: a compact `GitBranch` + current branch label, composed INSIDE the
// Explorer header's `flex items-center` actions row (the header-actions-one-row
// constraint — a control appended after the actions div wraps into the resize
// handle). Body: a body-anchored, fixed-position dropdown (same technique as
// `RefSearchDropdown` — anchor ref + `position: fixed`, so it escapes the header)
// listing every git-registered worktree by BRANCH name, the main working tree
// tagged with a `primary` chip, each row carrying a dirty dot + ahead/behind.
//
// The list is git-sourced (P1: `useProjectWorktrees`), so manually-created and
// task-less worktrees appear. Selecting a row calls `onSelect(id | null)` — the
// primary maps to `null`, every other worktree to its absolute-path id.
import { useState, useRef, useEffect } from 'react'
import type { CSSProperties } from 'react'
import { GitBranch, Check } from 'lucide-react'
import { DialogShell } from './DialogShell'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'

interface WorktreePickerProps {
  worktrees: WorktreeInfo[]
  /** The selected worktree's absolute-path id, or null for the primary checkout. */
  activeWorktree: string | null
  onSelect: (id: string | null) => void
}

/** Resolve the currently-selected entry: the worktree whose id matches the
 *  selection, else the primary, else the first listed. The primary fallback runs
 *  even when `activeWorktree` is a non-null id that is no longer registered (a
 *  stale selection App clears on its next pass), so the trigger never shows a
 *  linked branch for a worktree that has gone away. */
function currentEntry(worktrees: WorktreeInfo[], activeWorktree: string | null): WorktreeInfo {
  return worktrees.find(wt => wt.id === activeWorktree)
    ?? worktrees.find(wt => wt.isPrimary)
    ?? worktrees[0]
}

export function WorktreePicker({ worktrees, activeWorktree, onSelect }: WorktreePickerProps) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)

  // Nothing to pick (non-git project, or the list is still loading): render no
  // affordance rather than an empty trigger.
  if (worktrees.length === 0) return null

  const current = currentEntry(worktrees, activeWorktree)

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 px-1 h-[18px] rounded text-ui-xs font-medium normal-case tracking-normal cursor-pointer min-w-0 max-w-[140px]"
        style={{ color: open ? 'var(--sol-blue)' : 'var(--sol-text-dim)' }}
        title={`Worktree: ${current.name}`}
        aria-label="Select worktree"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <GitBranch size={12} className="shrink-0" />
        <span className="truncate">{current.branch}</span>
      </button>
      {open && (
        <WorktreeDropdown
          anchorRef={anchorRef}
          worktrees={worktrees}
          activeWorktree={activeWorktree}
          onSelect={id => { onSelect(id); setOpen(false) }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

const DROPDOWN_WIDTH = 248

/** The body-anchored worktree list. Mounts only while open (state resets
 *  naturally); position is computed from the trigger in an effect so the ref is
 *  not read during render, then right-clamped so it never spills past the viewport. */
function WorktreeDropdown({ anchorRef, worktrees, activeWorktree, onSelect, onClose }: {
  anchorRef: React.RefObject<HTMLElement | null>
  worktrees: WorktreeInfo[]
  activeWorktree: string | null
  onSelect: (id: string | null) => void
  onClose: () => void
}) {
  const [posStyle, setPosStyle] = useState<CSSProperties>({ position: 'fixed', left: 0, top: 0, width: DROPDOWN_WIDTH })
  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - DROPDOWN_WIDTH - 8))
    setPosStyle({ position: 'fixed', left, top: rect.bottom + 4, width: DROPDOWN_WIDTH })
  }, [anchorRef])

  return (
    <DialogShell
      onClose={onClose}
      overlay={false}
      animation="panel"
      // A popover selector that re-roots the view on selection — don't return focus to
      // the trigger on close. With the workspace no longer remounting per worktree
      // (P3 drop-remount), the trigger button survives the switch, so restoring focus
      // to it leaves a focused toggle that a later stray Enter (e.g. confirming
      // quick-open) re-activates, reopening the dropdown unexpectedly.
      restoreFocus={false}
      className="rounded-lg overflow-hidden z-50 py-1"
      style={posStyle}
    >
      <div role="listbox" aria-label="Worktrees" className="flex flex-col max-h-[min(320px,50vh)] overflow-y-auto">
        {worktrees.map(wt => {
          const isActive = wt.isPrimary ? activeWorktree === null : wt.id === activeWorktree
          return (
            <button
              key={wt.id}
              type="button"
              role="option"
              aria-selected={isActive}
              data-worktree-id={wt.id}
              onClick={() => onSelect(wt.isPrimary ? null : wt.id)}
              className={`flex items-center gap-1.5 px-2 h-[26px] text-ui-md cursor-pointer text-left ${
                isActive
                  ? 'bg-[var(--sol-blue)]/15 text-[var(--sol-blue)] font-medium'
                  : 'text-[var(--sol-text)] hover:text-[var(--sol-text-dark)] hover:bg-[var(--sol-hover-bg)]'
              }`}
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
              {(wt.ahead > 0 || wt.behind > 0) && (
                <span className="text-ui-2xs tabular-nums shrink-0 whitespace-nowrap" style={{ color: 'var(--sol-text-faint)' }}>
                  {wt.ahead > 0 && `↑${wt.ahead}`}{wt.ahead > 0 && wt.behind > 0 && ' '}{wt.behind > 0 && `↓${wt.behind}`}
                </span>
              )}
              {wt.dirty && (
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: 'var(--sol-warning)' }} />
              )}
              <Check size={12} className="shrink-0" style={{ opacity: isActive ? 1 : 0 }} />
            </button>
          )
        })}
      </div>
    </DialogShell>
  )
}
