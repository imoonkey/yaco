import { useState, useEffect, useCallback } from 'react'
import { Menu, X, FolderOpen, FileCode, ListTodo, SquareTerminal } from 'lucide-react'
import type { MobilePane } from '../hooks/workspaceTypes'

const PANES: { id: MobilePane; icon: typeof FolderOpen; label: string }[] = [
  { id: 'files', icon: FolderOpen, label: 'Browse' },
  { id: 'editor', icon: FileCode, label: 'Editor' },
  { id: 'tasks', icon: ListTodo, label: 'Tasks' },
  { id: 'terminal', icon: SquareTerminal, label: 'Terminal' },
]

const BTN = 32
const TOP = 'max(env(safe-area-inset-top, 0px), 24px)'
const LEFT = 'calc(max(env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px), 36px) - 34px)'

export function LandscapeNav({
  activePane,
  onPaneChange,
}: {
  activePane: MobilePane
  onPaneChange: (pane: MobilePane) => void
}) {
  const [open, setOpen] = useState(false)

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [open, close])

  return (
    <>
      {/* Toggle button — in left margin, below iPhone rounded corner */}
      <button
        className="absolute z-50 flex items-center justify-center rounded-lg cursor-pointer"
        style={{
          top: TOP,
          left: LEFT,
          width: BTN,
          height: BTN,
          backgroundColor: 'var(--sol-glass-bg)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          boxShadow: 'var(--elevation-1)',
          color: open ? 'var(--sol-blue)' : 'var(--sol-text-dim)',
          transition: 'color 120ms',
        }}
        onClick={() => setOpen(!open)}
        aria-label={open ? 'Close navigation' : 'Open navigation'}
        aria-expanded={open}
      >
        {open ? <X size={16} strokeWidth={2.5} /> : <Menu size={16} strokeWidth={2.5} />}
      </button>

      {/* Horizontal nav panel — expands RIGHT from toggle */}
      {open && (
        <>
          <div className="absolute inset-0 z-40" onClick={close} />
          <nav
            aria-label="Pane navigation"
            className="absolute z-50 flex items-center gap-0.5 rounded-xl py-1 px-1"
            style={{
              top: TOP,
              left: `calc(${LEFT} + ${BTN + 4}px)`,
              backgroundColor: 'var(--sol-glass-bg)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              boxShadow: 'var(--elevation-2)',
              animation: 'menu-enter 120ms ease-out',
            }}
          >
            {PANES.map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                className="flex items-center justify-center rounded-lg cursor-pointer"
                style={{
                  width: 36,
                  height: 32,
                  color: id === activePane ? 'var(--sol-blue)' : 'var(--sol-text-dim)',
                  backgroundColor: id === activePane ? 'color-mix(in srgb, var(--sol-blue) 10%, transparent)' : 'transparent',
                  transition: 'color 120ms, background-color 120ms',
                }}
                onClick={() => { onPaneChange(id); close() }}
                title={label}
                aria-label={label}
                aria-current={id === activePane ? 'page' : undefined}
              >
                <Icon size={18} strokeWidth={2} />
              </button>
            ))}
          </nav>
        </>
      )}
    </>
  )
}
