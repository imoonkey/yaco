import { PanelSearchBox } from './PanelSearchBox'

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
    <PanelSearchBox
      value={value}
      placeholder={placeholder}
      countLabel={hasQuery ? `${resultCount}/${totalCount}` : undefined}
      clearLabel="Clear session search"
      onChange={onChange}
      onClear={onClear}
    />
  )
}
