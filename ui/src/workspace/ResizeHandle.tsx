import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'

export function VResizeHandle({ onMouseDown, isDragging }: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }) {
  return (
    <div onMouseDown={onMouseDown}
      className={`shrink-0 cursor-col-resize transition-all ${isDragging ? 'w-[3px]' : 'w-[1px] hover:w-[3px]'}`}
      style={{ backgroundColor: isDragging ? C.sash : C.border }}
      onMouseEnter={e => { if (!isDragging) (e.target as HTMLElement).style.backgroundColor = C.sash }}
      onMouseLeave={e => { if (!isDragging) (e.target as HTMLElement).style.backgroundColor = C.border }}
    />
  )
}

export function HResizeHandle({ onMouseDown, isDragging }: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }) {
  return (
    <div onMouseDown={onMouseDown}
      className={`shrink-0 cursor-row-resize transition-all ${isDragging ? 'h-[3px]' : 'h-[1px] hover:h-[3px]'}`}
      style={{ backgroundColor: isDragging ? C.sash : C.border }}
      onMouseEnter={e => { if (!isDragging) (e.target as HTMLElement).style.backgroundColor = C.sash }}
      onMouseLeave={e => { if (!isDragging) (e.target as HTMLElement).style.backgroundColor = C.border }}
    />
  )
}
