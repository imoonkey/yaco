export function VResizeHandle({ onMouseDown, isDragging }: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }) {
  return (
    <div onMouseDown={onMouseDown}
      className="resize-handle-v shrink-0 cursor-col-resize relative"
      style={{ width: 3, zIndex: 1, backgroundColor: isDragging ? 'var(--sol-accent)' : 'var(--sol-border)', transition: 'background-color var(--transition-fast)' }}
    />
  )
}

export function HResizeHandle({ onMouseDown, isDragging }: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }) {
  return (
    <div onMouseDown={onMouseDown}
      className="resize-handle-h shrink-0 cursor-row-resize relative"
      style={{ height: 3, zIndex: 1, backgroundColor: isDragging ? 'var(--sol-accent)' : 'var(--sol-border)', transition: 'background-color var(--transition-fast)' }}
    />
  )
}
