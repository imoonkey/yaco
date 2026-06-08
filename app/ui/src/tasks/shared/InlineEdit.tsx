import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'

type InlineEditProps = {
  value: string
  onSave: (value: string) => void
  type?: 'text' | 'textarea' | 'dropdown'
  options?: { value: string; label: string; color?: string }[]
  placeholder?: string
  className?: string
  displayClassName?: string
  readOnly?: boolean
}

function DropdownPopover({ options, value, onSelect, onClose }: {
  options: { value: string; label: string; color?: string }[]
  value: string
  onSelect: (value: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [focusedIdx, setFocusedIdx] = useState(() => {
    const idx = options.findIndex(o => o.value === value)
    return idx >= 0 ? idx : 0
  })

  // Click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'ArrowDown') { e.preventDefault(); setFocusedIdx(i => Math.min(i + 1, options.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setFocusedIdx(i => Math.max(i - 1, 0)) }
      if (e.key === 'Enter') { e.preventDefault(); onSelect(options[focusedIdx].value) }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, onSelect, options, focusedIdx])

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-1 py-1 rounded-md z-30 min-w-[120px]"
      style={{
        backgroundColor: 'var(--sol-editor-bg)',
        border: '1px solid var(--sol-border)',
        boxShadow: 'var(--elevation-2)',
      }}
    >
      {options.map((opt, i) => {
        const isSelected = opt.value === value
        const isFocused = i === focusedIdx
        return (
          <button
            key={opt.value}
            onClick={() => onSelect(opt.value)}
            onMouseEnter={() => setFocusedIdx(i)}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-ui-sm text-left cursor-pointer transition-colors"
            style={{
              color: opt.color ?? 'var(--sol-text)',
              backgroundColor: isFocused
                ? 'var(--sol-hover-bg)'
                : isSelected
                  ? 'color-mix(in srgb, var(--sol-accent) 6%, transparent)'
                  : 'transparent',
              fontWeight: isSelected ? 600 : 400,
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export function InlineEdit({
  value,
  onSave,
  type = 'text',
  options,
  placeholder,
  className = '',
  displayClassName = '',
  readOnly = false,
}: InlineEditProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  // Reset draft when the source value changes (adjust state during render).
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    setDraft(value)
  }

  useEffect(() => {
    if (editing && type !== 'dropdown') inputRef.current?.focus()
  }, [editing, type])

  const save = useCallback(() => {
    setEditing(false)
    if (draft !== value) onSave(draft)
  }, [draft, value, onSave])

  const cancel = useCallback(() => {
    setEditing(false)
    setDraft(value)
  }, [value])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); cancel() }
    if (e.key === 'Enter' && type !== 'textarea') { e.preventDefault(); save() }
    if (e.key === 'Enter' && e.metaKey && type === 'textarea') { e.preventDefault(); save() }
  }, [cancel, save, type])

  if (!editing || readOnly) {
    if (type === 'dropdown') {
      const selected = options?.find(o => o.value === value)
      return (
        <span
          onClick={readOnly ? undefined : () => setEditing(true)}
          className={`inline-flex items-center gap-1 rounded px-1 py-0.5 ${readOnly ? '' : 'cursor-pointer transition-colors hover:bg-sol-hover-bg'} ${displayClassName}`}
        >
          <span style={selected?.color ? { color: selected.color } : undefined}>
            {selected?.label ?? value}
          </span>
          {!readOnly && <ChevronDown size={10} style={{ color: 'var(--sol-text)' }} />}
        </span>
      )
    }

    return (
      <span
        onClick={readOnly ? undefined : () => setEditing(true)}
        className={`text-left rounded px-1 py-0.5 ${readOnly ? '' : 'cursor-pointer transition-colors hover:bg-sol-hover-bg'} ${displayClassName}`}
        style={{ color: 'var(--sol-text-dark)' }}
      >
        {value || <span style={{ color: 'var(--sol-text-faint)', fontStyle: 'italic' }}>{readOnly ? '\u2014' : (placeholder ?? 'Click to edit')}</span>}
      </span>
    )
  }

  if (type === 'dropdown') {
    return (
      <div className="relative inline-block">
        <button
          className={`inline-flex items-center gap-1 rounded px-1 py-0.5 ${displayClassName}`}
          style={{
            border: '1.5px solid var(--sol-accent)',
            backgroundColor: 'var(--sol-editor-bg)',
          }}
        >
          <span style={{ color: options?.find(o => o.value === value)?.color ?? 'var(--sol-text)' }}>
            {options?.find(o => o.value === value)?.label ?? value}
          </span>
          <ChevronDown size={10} style={{ color: 'var(--sol-accent)' }} />
        </button>
        <DropdownPopover
          options={options ?? []}
          value={value}
          onSelect={(v) => { setEditing(false); if (v !== value) onSave(v) }}
          onClose={() => setEditing(false)}
        />
      </div>
    )
  }

  if (type === 'textarea') {
    return (
      <textarea
        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={4}
        className={`w-full rounded px-2 py-1.5 outline-none resize-y text-ui-md ${className}`}
        style={{
          border: '1.5px solid var(--sol-accent)',
          backgroundColor: 'var(--sol-editor-bg)',
          color: 'var(--sol-text)',
          fontFamily: 'var(--font-ui)',
          lineHeight: 1.5,
        }}
      />
    )
  }

  return (
    <input
      ref={inputRef as React.RefObject<HTMLInputElement>}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      className={`w-full rounded px-1.5 py-0.5 outline-none ${className}`}
      style={{
        border: '1.5px solid var(--sol-accent)',
        backgroundColor: 'var(--sol-editor-bg)',
        color: 'var(--sol-text-dark)',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        fontWeight: 'inherit',
      }}
    />
  )
}
