import { useState, useRef, useEffect } from 'react'
import { Pin, FolderGit2 } from 'lucide-react'
import { ProviderIcon } from '../components/SessionIcons'

import { Menu, MenuItem } from '../components/Menu'
import { useContextMenu } from '../components/useContextMenu'
import { BadgeCount } from '../components/BadgeCount'
import type { AgentSession, SessionStatus } from '../types'

// Static style constants extracted from render
const INACTIVE_COLOR: React.CSSProperties = { color: 'var(--sol-text)' }
const SESSION_TRANSITION: React.CSSProperties = { transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1)' }
const RENAME_INPUT_STYLE: React.CSSProperties = { borderColor: 'var(--sol-accent)', color: 'inherit' }

const STATUS_DOT_CLASS: Record<SessionStatus, string> = {
  processing: 'bg-[var(--sol-cyan)] status-pulse',
  idle: 'bg-[var(--sol-base1)]',
  starting: 'bg-[var(--sol-yellow)] status-pulse',
}

export function SessionItem({
  session,
  isActive,
  pinned,
  dragging,
  depth = 0,
  unreadCount,
  pendingName,
  shortcutIndex,
  onClick,
  onKill,
  onPin,
  onRename,
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
  unreadCount?: number
  pendingName?: string
  shortcutIndex?: number | null
  onClick: () => void
  onKill: () => void
  onPin?: () => void
  onRename?: (newName: string) => void
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

  return (
    <div ref={itemRef} onClick={renaming ? undefined : onClick}
      draggable={!!onDragStart && !renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      {...menu.bind()}
      className={`flex items-center gap-2 px-2 py-0.5 rounded cursor-pointer text-[12px] ${isActive ? 'bg-[var(--sol-blue)]/15 text-[var(--sol-blue)]' : 'hover:bg-sol-hover-bg'}`}
      style={{ ...(isActive ? undefined : INACTIVE_COLOR), opacity: dragging ? 0.55 : 1, ...(depth > 0 ? { paddingLeft: 8 + depth * 14 } : null), ...SESSION_TRANSITION }}>
      {onPin && (
        <button
          onClick={e => { e.stopPropagation(); onPin() }}
          className="shrink-0 cursor-pointer hover:opacity-80"
          title={pinned ? 'Unpin' : 'Pin to top'}
          style={{ color: pinned ? 'var(--sol-blue)' : 'var(--sol-muted)' }}
        >
          <Pin size={12} />
        </button>
      )}
      <ProviderIcon provider={session.provider} className="w-4 h-4 shrink-0" />
      <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT_CLASS[session.status] ?? 'bg-[var(--sol-base1)]'}`} aria-label={session.status} />
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
          className="min-w-0 flex-1 bg-transparent border-b outline-none text-[12px]"
          style={RENAME_INPUT_STYLE}
        />
      ) : (
        <div className="min-w-0 flex-1 line-clamp-2">
          <span>{session.name}</span>
          {shortcutIndex != null && (
            <span
              className="text-[10px] tabular-nums px-1 rounded ml-1.5 align-middle"
              style={{
                color: 'var(--sol-muted)',
                border: '1px solid var(--sol-border)',
                background: 'var(--sol-subtle-bg)',
              }}
              title={`Cmd+Ctrl+${shortcutIndex}`}
            >
              {shortcutIndex}
            </span>
          )}
          {pendingName && <span style={{ color: 'var(--sol-muted)' }}>{` → ${pendingName}`}</span>}
          {session.worktree && (
            <span
              className="inline-flex items-center gap-0.5 px-1 py-px rounded text-[9px] font-medium ml-1.5 align-middle"
              style={{ color: 'var(--sol-muted)', backgroundColor: 'var(--sol-subtle-bg)' }}
            >
              <FolderGit2 size={9} />
              {session.worktree}
            </span>
          )}
          {session.summary && (
            <span className="text-[10px] ml-1.5" style={{ color: 'var(--sol-muted)' }}>{session.summary}</span>
          )}
        </div>
      )}
      <span className="flex items-center gap-1 shrink-0">
        <BadgeCount count={unreadCount ?? 0} />
        <button
          onClick={(e) => {
            e.stopPropagation()
            onKill()
          }}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] cursor-pointer text-[var(--sol-red)] hover:bg-[var(--sol-red)]/8"
          style={{ border: '1px solid color-mix(in srgb, var(--sol-red) 20%, transparent)' }}
          title={`Kill ${session.name}`}
          aria-label={`Kill session ${session.name}`}
        >
          Kill
        </button>
      </span>
      {menu.position && onRename && (
        <Menu position={menu.position} exiting={menu.exiting} onExitDone={menu.onExitDone}>
          <MenuItem label="Rename" onClick={startRename} />
        </Menu>
      )}
    </div>
  )
}
