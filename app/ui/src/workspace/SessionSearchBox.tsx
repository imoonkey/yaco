import { Search, X } from 'lucide-react'

export function SessionSearchBox({
  value,
  placeholder,
  resultCount,
  totalCount,
  onChange,
  onClear,
}: {
  value: string
  placeholder: string
  resultCount: number
  totalCount: number
  onChange: (value: string) => void
  onClear: () => void
}) {
  const hasQuery = value.trim().length > 0

  return (
    <div className="px-1 pb-1">
      <div
        className="flex items-center gap-1 rounded px-1.5 py-1"
        style={{ border: '1px solid var(--sol-border)', backgroundColor: 'var(--sol-subtle-bg)' }}
      >
        <Search size={13} className="shrink-0" style={{ color: 'var(--sol-text-faint)' }} />
        <input
          type="search"
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-w-0 flex-1 bg-transparent outline-none text-ui-sm"
          style={{ color: 'var(--sol-text)' }}
        />
        {hasQuery && (
          <span className="shrink-0 text-ui-2xs tabular-nums" style={{ color: 'var(--sol-text-faint)' }}>
            {resultCount}/{totalCount}
          </span>
        )}
        {hasQuery && (
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 flex items-center justify-center w-[18px] h-[18px] rounded cursor-pointer hover:bg-sol-hover-bg"
            title="Clear session search"
            aria-label="Clear session search"
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  )
}
