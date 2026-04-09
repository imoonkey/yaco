import { useState, useRef, useEffect } from 'react'
import { Pin } from 'lucide-react'
import { ProviderIcon } from '../components/SessionIcons'

import { Menu, MenuItem, useContextMenu } from '../components/Menu'
import type { AgentSession } from '../types'

export function SessionItem({
  session,
  isActive,
  pinned,
  dragging,
  unreadCount,
  pendingName,
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
  unreadCount?: number
  pendingName?: string
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
  const [showTip, setShowTip] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const summaryRef = useRef<HTMLDivElement>(null)
  const itemRef = useRef<HTMLDivElement>(null)
  const tipTimer = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.focus()
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
      className={`flex flex-col gap-0 px-2.5 py-2 rounded cursor-pointer text-[12px] ${isActive ? 'bg-[var(--sol-blue)]/15 text-[var(--sol-blue)]' : ''}`}
      style={{ ...(isActive ? {} : { color: 'var(--sol-text)' }), opacity: dragging ? 0.55 : 1, fontFamily: 'var(--font-ui)', transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1)' }}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.backgroundColor = 'var(--sol-hover-bg)' }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.backgroundColor = '' }}>
      <div className="flex items-center gap-2">
        {onPin && (
          <button
            onClick={e => { e.stopPropagation(); onPin() }}
            className="shrink-0 cursor-pointer opacity-40 hover:opacity-100"
            title={pinned ? 'Unpin' : 'Pin to top'}
            style={{ color: pinned ? 'var(--sol-blue)' : 'var(--sol-muted)', opacity: pinned ? 0.9 : undefined }}
          >
            <Pin size={12} />
          </button>
        )}
        <ProviderIcon provider={session.provider} className="w-4 h-4 shrink-0" />
        <span className={`w-2 h-2 rounded-full shrink-0 ${session.status === 'processing' ? 'bg-[var(--sol-cyan)] status-pulse' : 'bg-[var(--sol-base1)]'}`} />
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
            style={{ borderColor: 'var(--sol-accent)', color: 'inherit' }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">
            {session.name}
            {pendingName && <span style={{ color: 'var(--sol-muted)' }}>{` → ${pendingName}`}</span>}
          </span>
        )}
        {!!unreadCount && unreadCount > 0 && (
          <span
            className="shrink-0 min-w-[18px] h-[16px] rounded-full text-[9px] font-bold text-white flex items-center justify-center px-1"
            style={{ backgroundColor: 'var(--sol-orange)' }}
          >
            {unreadCount}
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onKill()
          }}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] cursor-pointer border border-[var(--sol-red)]/20 text-[var(--sol-red)] hover:bg-[var(--sol-red)]/8"
          title={`Kill ${session.name}`}
          style={{ fontFamily: 'var(--font-ui)' }}
        >
          Kill
        </button>
      </div>
      {session.summary && !renaming && (
        <div className="relative" style={{ paddingLeft: onPin ? 42 : 26 }}>
          <div
            ref={summaryRef}
            className="truncate text-[10px]"

            style={{ color: 'var(--sol-muted)' }}
            onMouseEnter={() => {
              const el = summaryRef.current
              if (el && el.scrollWidth > el.clientWidth) {
                tipTimer.current = setTimeout(() => setShowTip(true), 300)
              }
            }}
            onMouseLeave={() => {
              if (tipTimer.current) clearTimeout(tipTimer.current)
              setShowTip(false)
            }}
          >
            {session.summary}
          </div>
          {showTip && (
            <div
              className="absolute left-0 top-full mt-1 z-40 px-2 py-1 rounded shadow-lg text-[11px] whitespace-pre-wrap break-words"
              style={{ backgroundColor: 'var(--sol-editor-bg)', border: '1px solid var(--sol-border)', color: 'var(--sol-text)', boxShadow: 'var(--elevation-2)', animation: 'menu-enter 200ms cubic-bezier(0.2, 0, 0, 1) both' }}
              onMouseEnter={() => { if (tipTimer.current) clearTimeout(tipTimer.current) }}
              onMouseLeave={() => setShowTip(false)}
            >
              {session.summary}
            </div>
          )}
        </div>
      )}
      {menu.position && onRename && (
        <Menu position={menu.position}>
          <MenuItem label="Rename" onClick={startRename} />
        </Menu>
      )}
    </div>
  )
}
