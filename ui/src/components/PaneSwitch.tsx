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
    <div className="inline-flex w-full rounded border border-[var(--sol-tab-bg)] bg-[var(--sol-base2)] p-0.5">
      {options.map(option => {
        const active = option.id === value
        return (
          <button
            key={option.id}
            onClick={() => onChange(option.id)}
            className={`flex-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
              active
                ? 'bg-[var(--sol-base3)] text-[var(--sol-blue)] shadow-[inset_0_0_0_1px_rgba(38,139,210,0.12)]'
                : 'text-[var(--sol-base01)] hover:text-[var(--sol-base02)]'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
