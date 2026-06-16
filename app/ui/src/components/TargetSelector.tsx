// TargetSelector — the voice target dropdown shown in the ComposeTray header
// (design: Multi-Instance Panels §G). It names the instance a confirmed take is
// inserted into and lets the user re-point it: editors (file basename) and bound
// terminals (session name), editors first. Re-pointing routes the next Insert to
// the chosen pane — the target binds at Insert, not at record.
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, FileText, SquareTerminal } from 'lucide-react'
import type { VoiceInstance, VoiceInstanceKind } from './GlobalVoiceControl'

export function InstanceIcon({ kind }: { kind: VoiceInstanceKind }) {
  return kind === 'editor'
    ? <FileText size={13} aria-hidden="true" />
    : <SquareTerminal size={13} aria-hidden="true" />
}

type TargetSelectorProps = {
  /** The instance the next Insert routes into (the open run's current target). */
  target: VoiceInstance | null
  /** Eligible instances the dropdown offers. */
  instances: VoiceInstance[]
  onSelect: (inst: VoiceInstance) => void
}

export function TargetSelector({ target, instances, onSelect }: TargetSelectorProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLSpanElement>(null)

  // Close the dropdown on an outside click (matches the bell/quick-open chrome).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])

  // Re-pointing is allowed for the whole open lifecycle — even while recording —
  // because the draft only routes to a pane at Insert (RETARGET just moves where
  // it will land). The only gate is having somewhere to point.
  const canChoose = instances.length > 0
  const pick = (inst: VoiceInstance) => { onSelect(inst); setOpen(false) }

  return (
    <span ref={containerRef} className="relative inline-flex items-center">
      <button
        className="flex items-center gap-1 h-7 px-1.5 rounded cursor-pointer text-ui-md border border-[var(--sol-border)] hover:bg-[var(--sol-subtle-bg)] disabled:opacity-40 disabled:cursor-default max-w-[280px]"
        onClick={() => canChoose && setOpen(v => !v)}
        disabled={!canChoose}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={target ? `Insert target: ${target.label}` : 'No insert target'}
        style={{ color: 'var(--sol-text)' }}
      >
        {target
          ? <><InstanceIcon kind={target.kind} /><span className="truncate">{target.label}</span></>
          : <span className="truncate" style={{ color: 'var(--sol-muted)' }}>No target</span>}
        <ChevronDown size={12} aria-hidden="true" style={{ flexShrink: 0 }} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-8 z-50 min-w-[200px] rounded-md border border-[var(--sol-border)] py-1 shadow-[var(--elevation-2)]"
          style={{ background: 'var(--sol-editor-bg)' }}
        >
          {instances.map(inst => {
            const selected = !!target && target.kind === inst.kind && target.instanceId === inst.instanceId
            return (
              <button
                key={`${inst.kind}:${inst.instanceId}`}
                role="menuitemradio"
                aria-checked={selected}
                className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-ui-sm cursor-pointer hover:bg-[var(--sol-subtle-bg)]"
                style={{ color: selected ? 'var(--sol-blue)' : 'var(--sol-text)' }}
                onClick={() => pick(inst)}
              >
                <InstanceIcon kind={inst.kind} />
                <span className="truncate">{inst.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </span>
  )
}
