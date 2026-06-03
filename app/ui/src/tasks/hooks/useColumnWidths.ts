import { useState, useCallback, useEffect } from 'react'
import { COLUMNS, getDefaultWidths } from '../list/listColumns'
import type { ColumnWidths } from '../list/listColumns'

const STORAGE_KEY = 'workflow-task-list-col-widths'

function loadWidths(): ColumnWidths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...getDefaultWidths(), ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return getDefaultWidths()
}

function saveWidths(widths: ColumnWidths) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths))
  } catch { /* ignore */ }
}

export function useColumnWidths() {
  const [widths, setWidths] = useState<ColumnWidths>(loadWidths)

  // Persist on change
  useEffect(() => { saveWidths(widths) }, [widths])

  const resizeColumn = useCallback((key: string, newWidth: number) => {
    const col = COLUMNS.find(c => c.key === key)
    if (!col) return
    const clamped = Math.max(col.minWidth, Math.round(newWidth))
    setWidths(prev => ({ ...prev, [key]: clamped }))
  }, [])

  // Returns a ref-stable handler factory for drag-based resizing
  const startResize = useCallback((key: string, startX: number) => {
    const startWidth = widths[key]
    if (startWidth == null) return null // flex column, not resizable

    return {
      startWidth,
      startX,
      key,
    }
  }, [widths])

  return { widths, resizeColumn, startResize }
}

/** Imperative drag handler — call from mousedown on a resize handle */
export function createResizeDragger(
  key: string,
  startWidth: number,
  startX: number,
  minWidth: number,
  onResize: (key: string, width: number) => void,
) {
  const handleMove = (e: MouseEvent) => {
    const delta = e.clientX - startX
    const newWidth = Math.max(minWidth, startWidth + delta)
    onResize(key, newWidth)
  }

  const handleUp = () => {
    document.removeEventListener('mousemove', handleMove)
    document.removeEventListener('mouseup', handleUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.addEventListener('mousemove', handleMove)
  document.addEventListener('mouseup', handleUp)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}
