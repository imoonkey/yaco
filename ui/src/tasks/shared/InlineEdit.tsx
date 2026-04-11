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
}

export function InlineEdit({
  value,
  onSave,
  type = 'text',
  options,
  placeholder,
  className = '',
  displayClassName = '',
}: InlineEditProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null)

  useEffect(() => { setDraft(value) }, [value])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

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

  if (!editing) {
    if (type === 'dropdown') {
      const selected = options?.find(o => o.value === value)
      return (
        <button
          onClick={() => setEditing(true)}
          className={`inline-flex items-center gap-1 cursor-pointer rounded transition-colors hover:bg-sol-hover-bg ${displayClassName}`}
        >
          <span style={selected?.color ? { color: selected.color } : undefined}>
            {selected?.label ?? value}
          </span>
          <ChevronDown size={12} style={{ color: 'var(--sol-base1)' }} />
        </button>
      )
    }

    return (
      <button
        onClick={() => setEditing(true)}
        className={`cursor-pointer text-left rounded transition-colors hover:bg-sol-hover-bg ${displayClassName}`}
      >
        {value || <span style={{ color: 'var(--sol-base1)' }}>{placeholder ?? 'Click to edit'}</span>}
      </button>
    )
  }

  if (type === 'dropdown') {
    return (
      <select
        ref={inputRef as React.RefObject<HTMLSelectElement>}
        value={draft}
        onChange={e => { setDraft(e.target.value); setEditing(false); onSave(e.target.value) }}
        onBlur={() => setEditing(false)}
        onKeyDown={handleKeyDown}
        className={`rounded px-1 py-0.5 outline-none ${className}`}
        style={{
          border: '2px solid var(--sol-focus-border)',
          backgroundColor: 'var(--sol-bg)',
          color: 'var(--sol-text)',
        }}
      >
        {options?.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
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
        className={`w-full rounded px-2 py-1 outline-none resize-y text-[12px] ${className}`}
        style={{
          border: '2px solid var(--sol-focus-border)',
          backgroundColor: 'var(--sol-bg)',
          color: 'var(--sol-text)',
          fontFamily: 'var(--font-ui)',
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
      className={`w-full rounded px-1 py-0.5 outline-none ${className}`}
      style={{
        border: '2px solid var(--sol-focus-border)',
        backgroundColor: 'var(--sol-bg)',
        color: 'var(--sol-text)',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        fontWeight: 'inherit',
      }}
    />
  )
}
