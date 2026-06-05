import { useState, useCallback, useRef, useEffect } from 'react'

export function useResize(initial: number, min: number, max: number | (() => number), direction: 'left' | 'right' | 'down' | 'up' = 'left') {
  const [size, setSize] = useState(initial)
  const [isDragging, setIsDragging] = useState(false)
  const dragging = useRef(false)
  const startPos = useRef(0)
  const startSize = useRef(0)
  const maxRef = useRef(max)
  useEffect(() => { maxRef.current = max })
  const resolveMax = () => typeof maxRef.current === 'function' ? maxRef.current() : maxRef.current
  const clamp = useCallback((value: number) => Math.min(resolveMax(), Math.max(min, value)), [min])
  const setClampedSize = useCallback((value: number) => {
    setSize(clamp(value))
  }, [clamp])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true; setIsDragging(true)
    startPos.current = direction === 'down' || direction === 'up' ? e.clientY : e.clientX
    startSize.current = size; e.preventDefault()
  }, [direction, size])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const pos = direction === 'down' || direction === 'up' ? e.clientY : e.clientX
      const delta = direction === 'right' || direction === 'up' ? startPos.current - pos : pos - startPos.current
      setSize(clamp(startSize.current + delta))
    }
    const onMouseUp = () => { dragging.current = false; setIsDragging(false) }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp) }
  }, [clamp, direction])

  return { size, setSize: setClampedSize, isDragging, onMouseDown }
}
