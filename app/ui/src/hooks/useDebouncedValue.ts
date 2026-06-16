import { useEffect, useRef, useState } from 'react'

// Debounce of a value: the output updates only after `ms` of quiet — i.e. when the
// input stops changing. Unlike a throttle (which still emits *during* a burst), a
// debounce emits ZERO times mid-burst, so feeding the markdown/HTML preview from it
// means a large document is never re-parsed or re-laid-out while the user is actively
// typing — only once they pause. The live `draft` still drives every correctness path;
// this is a render-only gate for the preview.
//
// `resetKey` identifies the logical source (e.g. the open file path). When it changes,
// the new value is adopted IMMEDIATELY (no debounce delay) so switching files never
// shows the previous file's content under the new file's path.
export function useDebouncedValue<T>(value: T, ms: number, resetKey?: unknown): T {
  const [debounced, setDebounced] = useState(value)
  const keyRef = useRef(resetKey)

  useEffect(() => {
    if (keyRef.current !== resetKey) {
      keyRef.current = resetKey
      setDebounced(value)
      return
    }
    const timer = window.setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms, resetKey])

  return debounced
}
