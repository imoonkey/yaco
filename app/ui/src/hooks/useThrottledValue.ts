import { useEffect, useRef, useState } from 'react'

// Leading + trailing throttle of a value: the output updates immediately on the
// first change after an idle gap (leading edge), then at most once per `ms`, and
// always flushes the final value (trailing edge). Used to feed the markdown/HTML
// preview and the editor diff gutter from the live, per-keystroke `draft` without
// reparsing the whole document on every keystroke — VSCode's throttled-preview
// behaviour. It is a DERIVED view; the live value still drives correctness paths.
//
// `resetKey` identifies the logical source (e.g. the open file path). When it
// changes, the new value is adopted IMMEDIATELY with no throttle delay — otherwise
// switching files inside the window would render the previous file's content under
// the new file's path. Same-`resetKey` edits are throttled as usual.
export function useThrottledValue<T>(value: T, ms: number, resetKey?: unknown): T {
  const [throttled, setThrottled] = useState(value)
  const lastRunRef = useRef(0)
  const timerRef = useRef(0)
  const keyRef = useRef(resetKey)

  useEffect(() => {
    if (keyRef.current !== resetKey) {
      keyRef.current = resetKey
      clearTimeout(timerRef.current)
      lastRunRef.current = Date.now()
      setThrottled(value)
      return
    }
    const elapsed = Date.now() - lastRunRef.current
    const commit = () => {
      lastRunRef.current = Date.now()
      setThrottled(value)
    }
    if (elapsed >= ms) {
      commit()
    } else {
      clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(commit, ms - elapsed)
    }
    return () => clearTimeout(timerRef.current)
  }, [value, ms, resetKey])

  return throttled
}
