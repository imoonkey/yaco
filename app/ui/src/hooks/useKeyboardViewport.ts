import { useEffect } from 'react'

/**
 * Adjusts app height when the virtual keyboard is visible.
 *
 * Sets --kb-viewport CSS variable on <html> when keyboard is detected
 * via the Visual Viewport API. #root uses var(--kb-viewport, 100dvh).
 *
 * iOS standalone PWA: WebKit may delay visualViewport.height updates.
 * Workaround: on user TAP (not scroll), apply cached keyboard height
 * (or 40% estimate). visualViewport then corrects with real value.
 *
 * Tap vs scroll detection: estimate deferred to touchend; touchmove
 * cancels it (scrolls don't open keyboards). For gaining-focus case,
 * focusin handler applies estimate only after a recent touch (avoids
 * false triggers from programmatic term.focus() on mount).
 *
 * Also sets --kb-safe-bottom to 0px when keyboard is open, overriding
 * env(safe-area-inset-bottom) on TerminalKeyBar to eliminate the gap
 * between content and keyboard.
 */

// Module-level cache — persists across focusin/focusout cycles within session.
// Safe because the hook is called exactly once in App.tsx.
let cachedKbHeight: number | null = null
let cachedOrientation: 'portrait' | 'landscape' | null = null

const NON_KB_INPUT_TYPES = new Set([
  'button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color', 'hidden', 'image',
])

function isKbInput(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') return !NON_KB_INPUT_TYPES.has((el as HTMLInputElement).type)
  if ((el as HTMLElement).isContentEditable) return true
  return false
}

function getOrientation(): 'portrait' | 'landscape' {
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait'
}

export function useKeyboardViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    let fullHeight = vv.height
    let isEstimated = false

    const isIOSLike =
      matchMedia('(pointer: coarse)').matches &&
      !('virtualKeyboard' in navigator)

    const setEstimate = () => {
      const orientation = getOrientation()
      const estimate =
        cachedKbHeight !== null && cachedOrientation === orientation
          ? cachedKbHeight
          : fullHeight * 0.4

      root.style.setProperty('--kb-viewport', `${fullHeight - estimate}px`)
      root.style.setProperty('--kb-safe-bottom', '0px')
      isEstimated = true
    }

    const setReal = (height: number) => {
      root.style.setProperty('--kb-viewport', `${height}px`)
      root.style.setProperty('--kb-safe-bottom', '0px')
      isEstimated = false
    }

    const clear = () => {
      root.style.removeProperty('--kb-viewport')
      root.style.removeProperty('--kb-safe-bottom')
      isEstimated = false
    }

    const apply = () => {
      if (vv.height > fullHeight) fullHeight = vv.height
      const diff = fullHeight - vv.height
      if (diff > 50) {
        setReal(vv.height)
        if (isIOSLike) {
          cachedKbHeight = diff
          cachedOrientation = getOrientation()
        }
      } else if (isEstimated) {
        // Keep estimate — iOS hasn't updated visualViewport yet.
      } else {
        clear()
      }
    }

    // --- iOS tap detection ---
    // touchstart/touchmove/touchend distinguish taps from scrolls.
    // focusin catches gaining-focus case (only after a recent touch).
    let touchMoved = false
    let userTouching = false
    let touchedTerminal = false // Was the touch inside a keyboard-triggering area?
    let touchCooldown: ReturnType<typeof setTimeout> | null = null

    const handleTouchStart = (e: Event) => {
      touchMoved = false
      userTouching = true
      // Estimate is an xterm-only workaround (its hidden textarea delays the
      // Visual Viewport on iOS PWA). Other inputs (e.g. the CodeMirror editor)
      // update it reliably, so they use the exact value via apply().
      const target = e.target as Element
      touchedTerminal = !!target.closest?.('.xterm')
      if (touchCooldown) clearTimeout(touchCooldown)
    }

    const handleTouchMove = () => {
      touchMoved = true
    }

    const handleTouchEnd = () => {
      // Keep userTouching=true briefly for the focusin that follows
      touchCooldown = setTimeout(() => { userTouching = false }, 500)

      if (!isIOSLike || touchMoved) return
      if (isEstimated || fullHeight - vv.height > 50) return

      // Tap on already-focused keyboard input (tmux attach case).
      // Delay estimate so visualViewport can update first — if it does,
      // apply() sets the real value and the estimate is skipped (no jitter).
      if (touchedTerminal && isKbInput(document.activeElement)) {
        setTimeout(() => {
          if (isEstimated || fullHeight - vv.height > 50) return
          setEstimate()
        }, 300)
      }
    }

    // Gaining-focus case: element wasn't focused, user tapped it.
    // Only fire after a recent touch to skip programmatic term.focus().
    const handleFocusIn = (e: FocusEvent) => {
      if (!isIOSLike || !userTouching || !touchedTerminal) return
      if (!isKbInput(e.target as Element)) return
      if (isEstimated || fullHeight - vv.height > 50) return
      // Delay so visualViewport can update first (avoids estimate→real jitter)
      setTimeout(() => {
        if (isEstimated || fullHeight - vv.height > 50) return
        setEstimate()
      }, 300)
    }

    const handleFocusOut = () => {
      if (!isIOSLike) return
      setTimeout(() => {
        if (!isKbInput(document.activeElement)) {
          const diff = fullHeight - vv.height
          if (diff <= 50) clear()
        }
      }, 0)
    }

    const handleOrientationChange = () => {
      cachedKbHeight = null
      cachedOrientation = null
      setTimeout(() => { fullHeight = vv.height }, 300)
    }

    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    document.addEventListener('keydown', apply, true)
    document.addEventListener('touchstart', handleTouchStart, true)
    document.addEventListener('touchmove', handleTouchMove, true)
    document.addEventListener('touchend', handleTouchEnd, true)
    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)
    window.addEventListener('orientationchange', handleOrientationChange)
    const intervalId = setInterval(apply, 200)

    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      document.removeEventListener('keydown', apply, true)
      document.removeEventListener('touchstart', handleTouchStart, true)
      document.removeEventListener('touchmove', handleTouchMove, true)
      document.removeEventListener('touchend', handleTouchEnd, true)
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
      window.removeEventListener('orientationchange', handleOrientationChange)
      clearInterval(intervalId)
      if (touchCooldown) clearTimeout(touchCooldown)
      clear()
    }
  }, [])
}
