export function VResizeHandle({ onMouseDown, isDragging }: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }) {
  return (
    <div onMouseDown={onMouseDown}
      className="shrink-0 cursor-col-resize"
      style={{ width: 3, marginLeft: -1, marginRight: -1, zIndex: 1, backgroundColor: isDragging ? 'var(--sol-accent)' : 'var(--sol-border)', transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1)' }}
    />
  )
}

export function HResizeHandle({ onMouseDown, isDragging }: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }) {
  return (
    <div onMouseDown={onMouseDown}
      className="shrink-0 cursor-row-resize"
      style={{ height: 3, marginTop: -1, marginBottom: -1, zIndex: 1, backgroundColor: isDragging ? 'var(--sol-accent)' : 'var(--sol-border)', transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1)' }}
    />
  )
}
