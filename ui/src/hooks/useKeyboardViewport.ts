import { useEffect } from 'react'

/**
 * Adjusts app height when the virtual keyboard is visible.
 *
 * Sets --kb-viewport CSS variable on <html> when keyboard is detected
 * via the Visual Viewport API. #root uses var(--kb-viewport, 100dvh).
 *
 * iOS standalone PWA does not update visualViewport.height until the
 * user interacts with the keyboard (first keystroke). Three mechanisms:
 * 1. visualViewport events — instant on browsers that fire them
 * 2. keydown — catches the moment iOS finalizes viewport resize
 * 3. setInterval(200ms) — catches any delayed updates
 */
export function useKeyboardViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    let fullHeight = vv.height

    const apply = () => {
      if (vv.height > fullHeight) fullHeight = vv.height
      const diff = fullHeight - vv.height
      if (diff > 50) {
        root.style.setProperty('--kb-viewport', `${vv.height}px`)
      } else {
        root.style.removeProperty('--kb-viewport')
      }
    }

    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    document.addEventListener('keydown', apply, true)
    const intervalId = setInterval(apply, 200)

    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      document.removeEventListener('keydown', apply, true)
      clearInterval(intervalId)
      root.style.removeProperty('--kb-viewport')
    }
  }, [])
}
