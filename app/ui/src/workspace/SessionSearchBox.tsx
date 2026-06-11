import { PanelSearchBox } from './PanelSearchBox'

export function SessionSearchBox({
  value,
  placeholder,
  resultCount,
  totalCount,
  className,
  onChange,
  onClear,
}: {
  value: string
  placeholder: string
  resultCount: number
  totalCount: number
  className?: string
  onChange: (value: string) => void
  onClear: () => void
}) {
  const hasQuery = value.trim().length > 0

  return (
    <PanelSearchBox
      value={value}
      placeholder={placeholder}
      countLabel={hasQuery ? `${resultCount}/${totalCount}` : undefined}
      clearLabel="Clear session search"
      className={className}
      onChange={onChange}
      onClear={onClear}
    />
  )
}
