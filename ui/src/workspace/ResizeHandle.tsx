export function VResizeHandle({ onMouseDown, isDragging }: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }) {
  return (
    <div onMouseDown={onMouseDown}
      className="shrink-0 cursor-col-resize flex items-center"
      style={{ width: 3, marginLeft: -1, marginRight: -1, zIndex: 1 }}
    >
      <div
        className={`w-full transition-all ${isDragging ? 'w-[3px]' : 'w-[1px]'}`}
        style={{ height: '100%', backgroundColor: isDragging ? 'var(--sol-sash)' : 'var(--sol-border)', pointerEvents: 'none' }}
      />
    </div>
  )
}

export function HResizeHandle({ onMouseDown, isDragging }: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }) {
  return (
    <div onMouseDown={onMouseDown}
      className="shrink-0 cursor-row-resize flex justify-center"
      style={{ height: 3, marginTop: -1, marginBottom: -1, zIndex: 1 }}
    >
      <div
        className={`h-full transition-all ${isDragging ? 'h-[3px]' : 'h-[1px]'}`}
        style={{ width: '100%', backgroundColor: isDragging ? 'var(--sol-sash)' : 'var(--sol-border)', pointerEvents: 'none' }}
      />
    </div>
  )
}
