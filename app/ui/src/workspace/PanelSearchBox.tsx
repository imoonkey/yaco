import { forwardRef } from 'react'
import { Search, X } from 'lucide-react'

export const PanelSearchBox = forwardRef<HTMLInputElement, {
  value: string
  placeholder: string
  ariaLabel?: string
  countLabel?: string
  clearLabel?: string
  className?: string
  onChange: (value: string) => void
  onClear: () => void
}>(function PanelSearchBox({
  value,
  placeholder,
  ariaLabel,
  countLabel,
  clearLabel = 'Clear search',
  className = 'px-1 pb-1',
  onChange,
  onClear,
}, ref) {
  const hasQuery = value.trim().length > 0

  return (
    <div className={className}>
      <div className="panel-search-box flex items-center gap-1 rounded px-1.5 py-1">
        <Search size={13} className="shrink-0" style={{ color: 'var(--sol-text-faint)' }} />
        <input
          ref={ref}
          type="text"
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel ?? placeholder}
          className="min-w-0 flex-1 bg-transparent outline-none text-ui-sm"
          style={{ color: 'var(--sol-text)' }}
          spellCheck={false}
        />
        {hasQuery && countLabel && (
          <span className="shrink-0 text-ui-2xs tabular-nums" style={{ color: 'var(--sol-text-faint)' }}>
            {countLabel}
          </span>
        )}
        {hasQuery && (
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 flex items-center justify-center w-[18px] h-[18px] rounded cursor-pointer hover:bg-sol-hover-bg"
            title={clearLabel}
            aria-label={clearLabel}
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  )
})
