import { useState, useRef, useEffect } from 'react'
import { Pin, FolderGit2, Columns2 } from 'lucide-react'
import { ProviderIcon } from '../components/SessionIcons'

import { Menu, MenuItem } from '../components/Menu'
import { useContextMenu } from '../components/useContextMenu'
import { BadgeCount } from '../components/BadgeCount'
import { sanitizeSummary } from './sanitizeSummary'
import { SearchHighlightedText } from './SearchHighlightedText'
import { fieldMatch, type SearchMatch } from './sessionSearch'
import type { AgentSession, BlockReason, SessionStatus } from '../types'

// Indentation geometry for nested (parent → child) sessions. Each child level is
// indented one step so the dashed guide columns read as a hierarchy. The provider
// icon leads the row; a parent's icon doubles as the collapse toggle, with a small
// triangle badge in its corner.
const INDENT_BASE = 8
const INDENT_STEP = 14
// Dashed guide column sits centred in the indent step, left of the child icon.
const GUIDE_OFFSET = 7

// Static style constants extracted from render
const INACTIVE_COLOR: React.CSSProperties = { color: 'var(--sol-text)' }
const SESSION_TRANSITION: React.CSSProperties = { transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1)' }
const RENAME_INPUT_STYLE: React.CSSProperties = { borderColor: 'var(--sol-accent)', color: 'inherit' }
const PIN_ICON_STYLE: React.CSSProperties = { transform: 'rotate(45deg)', transformOrigin: 'center' }

const STATUS_DOT_CLASS: Record<SessionStatus, string> = {
  processing: 'bg-[var(--sol-cyan)] status-pulse',
  idle: 'bg-[var(--sol-base1)]',
  starting: 'bg-[var(--sol-yellow)] status-pulse',
  // Distinct from processing's cyan glow: orange "needs you" dot with an
  // opacity pulse so a waiting session reads as attention, not activity.
  blocked: 'bg-[var(--sol-orange)] animate-pulse',
}

// Reason a blocked session is waiting → human-readable badge / a11y text.
const BLOCK_REASON_LABEL: Record<BlockReason, string> = {
  permission: 'needs approval',
  question: 'has a question',
  trust: 'needs trust review',
}

export function SessionItem({
  session,
  isActive,
  pinned,
  dragging,
  depth = 0,
  hasChildren,
  collapsed,
  unreadCount,
  shortcutIndex,
  searchMatch,
  onClick,
  onKill,
  onPin,
  onToggleCollapse,
  onRename,
  onOpenBeside,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  session: AgentSession
  isActive: boolean
  pinned?: boolean
  dragging?: boolean
  depth?: number
  hasChildren?: boolean
  collapsed?: boolean
  unreadCount?: number
  shortcutIndex?: number | null
  searchMatch?: SearchMatch | null
  onClick: () => void
  onKill: () => void
  onPin?: () => void
  onToggleCollapse?: () => void
  onRename?: (newName: string) => void
  /** Open this session in a NEW terminal beside the active one (1-per-session
   *  guarded in the command). Undefined → no affordance (e.g. mobile). */
  onOpenBeside?: () => void
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const menu = useContextMenu()
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus({ preventScroll: true })
      // Delay scroll until after mobile keyboard animation (~400ms)
      setTimeout(() => inputRef.current?.scrollIntoView({ block: 'nearest' }), 400)
    }
  }, [renaming])

  useEffect(() => {
    if (isActive) itemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [isActive])

  const startRename = () => {
    menu.close()
    setRenameValue(session.name)
    setRenaming(true)
  }

  const commitRename = () => {
    setRenaming(false)
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== session.name && onRename) {
      onRename(trimmed)
    }
  }

  const summary = sanitizeSummary(session.summary, session.name)
  const blockLabel = session.status === 'blocked' && session.blockReason
    ? BLOCK_REASON_LABEL[session.blockReason]
    : null
  const nameMatch = fieldMatch(searchMatch, 'name')
  const summaryMatch = fieldMatch(searchMatch, 'summary')
  const worktreeMatch = fieldMatch(searchMatch, 'worktree')
  const snippet = searchMatch?.snippet
  const summarySnippet = snippet?.key === 'summary' ? snippet : null
  const worktreeSnippet = snippet?.key === 'worktree' ? snippet : null
  const extraSnippet = snippet && !summarySnippet && !worktreeSnippet ? snippet : null
  const summaryText = summarySnippet?.text ?? summary
  const summaryPositions = summarySnippet?.positions ?? summaryMatch?.positions
  const worktreeText = worktreeSnippet?.text ?? session.worktree ?? ''

  return (
    <div ref={itemRef} onClick={renaming ? undefined : onClick}
      data-active={isActive || undefined}
      draggable={!!onDragStart && !renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      {...menu.bind()}
      className={`group relative flex items-center gap-2 px-2 py-0.5 rounded cursor-pointer text-ui-md ${isActive ? 'bg-[var(--sol-blue)]/15 text-[var(--sol-blue)]' : 'hover:bg-sol-hover-bg'}`}
      style={{ ...(isActive ? undefined : INACTIVE_COLOR), opacity: dragging ? 0.55 : 1, ...(depth > 0 ? { paddingLeft: INDENT_BASE + depth * INDENT_STEP } : null), ...SESSION_TRANSITION }}>
      {depth > 0 && Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{ left: INDENT_BASE + level * INDENT_STEP + GUIDE_OFFSET, borderLeft: '1px dashed var(--sol-muted)', opacity: 0.6 }}
        />
      ))}
      {onPin && (
        <button
          onClick={e => { e.stopPropagation(); onPin() }}
          className="shrink-0 cursor-pointer hover:opacity-80"
          title={pinned ? 'Unpin' : 'Pin to top'}
          style={{ color: pinned ? 'var(--sol-blue)' : 'var(--sol-muted)' }}
        >
          <Pin size={12} style={PIN_ICON_STYLE} />
        </button>
      )}
      {hasChildren ? (
        <button
          onClick={e => { e.stopPropagation(); onToggleCollapse?.() }}
          className="relative shrink-0 cursor-pointer hover:opacity-80"
          title={collapsed ? 'Expand' : 'Collapse'}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${session.name}`}
          aria-expanded={!collapsed}
        >
          <ProviderIcon provider={session.provider} className="w-4 h-4" />
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center w-3 h-3 rounded-full"
            style={{ background: 'var(--sol-blue)', color: 'var(--sol-bg)', boxShadow: '0 0 0 1.5px var(--sol-sidebar-bg)' }}
          >
            <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
              <path d={collapsed ? 'M3.5 2 L8 5 L3.5 8 Z' : 'M2 3.5 L8 3.5 L5 8 Z'} />
            </svg>
          </span>
        </button>
      ) : (
        <ProviderIcon provider={session.provider} className="w-4 h-4 shrink-0" />
      )}
      <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT_CLASS[session.status] ?? 'bg-[var(--sol-base1)]'}`} aria-label={blockLabel ? `blocked: ${blockLabel}` : session.status} />
      {renaming ? (
        <input
          ref={inputRef}
          value={renameValue}
          onChange={e => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') setRenaming(false)
          }}
          onClick={e => e.stopPropagation()}
          className="min-w-0 flex-1 bg-transparent border-b outline-none text-ui-md"
          style={RENAME_INPUT_STYLE}
        />
      ) : (
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2">
            <SearchHighlightedText text={session.name} positions={nameMatch?.positions} className="font-medium" />
            {shortcutIndex != null && (
              <span
                className="text-ui-xs tabular-nums px-1 rounded ml-1.5 align-middle"
                style={{
                  color: 'var(--sol-text-faint)',
                  border: '1px solid var(--sol-border)',
                  background: 'var(--sol-subtle-bg)',
                }}
                title={`Cmd+Ctrl+${shortcutIndex}`}
              >
                {shortcutIndex}
              </span>
            )}
            {session.worktree && (
              <span
                className="inline-flex items-center gap-0.5 px-1 py-px rounded text-ui-2xs font-medium ml-1.5 align-middle"
                style={{ color: 'var(--sol-text-faint)', backgroundColor: 'var(--sol-subtle-bg)' }}
              >
                <FolderGit2 size={9} />
                <SearchHighlightedText text={worktreeText} positions={worktreeSnippet?.positions ?? worktreeMatch?.positions} />
              </span>
            )}
            {blockLabel && (
              <span
                className="inline-flex items-center px-1 py-px rounded text-ui-2xs font-medium ml-1.5 align-middle"
                style={{ color: 'var(--sol-orange)', backgroundColor: 'color-mix(in srgb, var(--sol-orange) 14%, transparent)' }}
                title={blockLabel}
                aria-label={blockLabel}
              >
                {blockLabel}
              </span>
            )}
            {summary && (
              <SearchHighlightedText
                text={summaryText}
                positions={summaryPositions}
                className="text-ui-xs ml-1.5"
                style={{ color: 'var(--sol-text-faint)' }}
              />
            )}
          </div>
          {extraSnippet && (
            <div className="text-ui-xs mt-0.5 truncate" style={{ color: 'var(--sol-text-faint)' }}>
              <span className="uppercase text-ui-2xs mr-1" style={{ color: 'var(--sol-muted)' }}>{extraSnippet.label}:</span>
              <SearchHighlightedText text={extraSnippet.text} positions={extraSnippet.positions} />
            </div>
          )}
        </div>
      )}
      <span className="flex items-center gap-1 shrink-0">
        <BadgeCount count={unreadCount ?? 0} />
        {onOpenBeside && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onOpenBeside()
            }}
            className="shrink-0 rounded-md px-1 py-0.5 cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-sol-hover-bg"
            style={{ color: 'var(--sol-text-faint)' }}
            title="Open beside"
            aria-label={`Open ${session.name} beside`}
          >
            <Columns2 size={13} />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onKill()
          }}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-ui-xs cursor-pointer text-[var(--sol-red)] hover:bg-[var(--sol-red)]/8"
          style={{ border: '1px solid color-mix(in srgb, var(--sol-red) 20%, transparent)' }}
          title={`Kill ${session.name}`}
          aria-label={`Kill session ${session.name}`}
        >
          Kill
        </button>
      </span>
      {menu.position && (onRename || onOpenBeside) && (
        <Menu position={menu.position} exiting={menu.exiting} onExitDone={menu.onExitDone}>
          {onOpenBeside && <MenuItem label="Open beside" onClick={() => { menu.close(); onOpenBeside() }} />}
          {onRename && <MenuItem label="Rename" onClick={startRename} />}
        </Menu>
      )}
    </div>
  )
}
