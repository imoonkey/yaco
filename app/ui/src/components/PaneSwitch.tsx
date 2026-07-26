import type { ReactNode } from 'react'

interface PaneSwitchOption {
  id: string
  label: string
  icon?: ReactNode
}

export function PaneSwitch({
  options,
  value,
  onChange,
}: {
  options: PaneSwitchOption[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="inline-flex w-full rounded border border-[var(--sol-tab-bg)] bg-[var(--sol-tabs-bg)] p-0.5">
      {options.map(option => {
        const active = option.id === value
        return (
          <button
            key={option.id}
            onClick={() => onChange(option.id)}
            className={`flex-1 min-w-0 flex items-center justify-center gap-1 rounded px-1 py-0.5 text-ui-md font-medium cursor-pointer ${
              active
                ? 'bg-[var(--sol-editor-bg)] text-[var(--sol-blue)]'
                : 'text-[var(--sol-text-dim)] hover:text-[var(--sol-text)]'
            }`}
            style={{
              transition: 'all 120ms cubic-bezier(0.2, 0, 0, 1)',
              ...(active ? { boxShadow: 'var(--elevation-1)' } : {}),
            }}
          >
            {option.icon}
            <span className="truncate">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
