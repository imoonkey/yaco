interface PaneSwitchOption {
  id: string
  label: string
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
    <div className="inline-flex w-full rounded border border-[var(--sol-tab-bg)] bg-[var(--sol-base2)] p-1">
      {options.map(option => {
        const active = option.id === value
        return (
          <button
            key={option.id}
            onClick={() => onChange(option.id)}
            className={`flex-1 rounded px-2.5 py-1 text-[12px] font-medium cursor-pointer ${
              active
                ? 'bg-[var(--sol-base3)] text-[var(--sol-blue)]'
                : 'text-[var(--sol-base01)] hover:text-[var(--sol-base02)]'
            }`}
            style={{
              transition: 'all 120ms cubic-bezier(0.2, 0, 0, 1)',
              ...(active ? { boxShadow: 'var(--elevation-1)' } : {}),
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
