import { useState, useEffect, useRef, useCallback } from 'react'

// Voice notification read-back over the browser's built-in Web Speech API
// (`speechSynthesis`) — no backend, no key, no dependency. Foreground-only by
// construction: the one caller (`useAttention.surfaceInterrupts`) only speaks in
// its visible branch, matching where audio playback is actually allowed.

const SUPPORTED =
  typeof window !== 'undefined' &&
  'speechSynthesis' in window &&
  typeof SpeechSynthesisUtterance !== 'undefined'

const STORAGE_KEY = 'yaco.voiceReadback'

// CJK Ext-A + Unified + Compatibility Ideographs — any hit ⇒ a Mandarin voice.
const CJK = /[㐀-鿿豈-﫿]/

function loadEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
}

/** Pick the utterance language from the text. A zh-CN voice handles embedded
 *  English fine, so "any CJK ⇒ zh-CN" is the right split for the user's mixed
 *  中英文 notices; pure-English notices read with an English voice. */
function detectLang(text: string): string {
  return CJK.test(text) ? 'zh-CN' : 'en-US'
}

export interface UseSpeech {
  /** The browser exposes `speechSynthesis` — gate the toggle UI on this. */
  supported: boolean
  enabled: boolean
  /** Persisted; toggling on primes the audio engine (call from a user gesture). */
  setEnabled: (on: boolean) => void
  /** Speak `text` now, preempting any in-flight read-back. No-op when
   *  unsupported / disabled / empty. */
  speak: (text: string) => void
}

/** The toggle slice of `UseSpeech` the notification UI drives (no `speak`). */
export type VoiceReadback = Pick<UseSpeech, 'supported' | 'enabled' | 'setEnabled'>

/**
 * iOS (and other browsers) forbid starting audio outside a user gesture, once per
 * page load. We "prime" the engine by speaking a silent utterance inside a gesture
 * call-stack: from the toggle tap directly, or — when `enabled` was restored from a
 * prior session with no gesture yet — from a one-shot pointerdown listener. After
 * priming, programmatic `speak()` from a notification works.
 */
export function useSpeech(): UseSpeech {
  const [enabled, setEnabledState] = useState<boolean>(() => SUPPORTED && loadEnabled())
  const primedRef = useRef(false)

  const prime = useCallback(() => {
    if (!SUPPORTED || primedRef.current) return
    try {
      const u = new SpeechSynthesisUtterance(' ')
      u.volume = 0 // silent: this call only exists to unlock the engine
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(u)
      primedRef.current = true
    } catch { /* ignore */ }
  }, [])

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on)
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0') } catch { /* ignore */ }
    if (!SUPPORTED) return
    if (on) prime() // the toggle tap is a gesture → unlock now
    else window.speechSynthesis.cancel() // stop any in-flight read-back
  }, [prime])

  // Restored-enabled after a reload has no gesture yet → unlock on the next tap,
  // before any notification needs to speak. once:true self-removes after firing.
  useEffect(() => {
    if (!SUPPORTED || !enabled || primedRef.current) return
    const onGesture = () => prime()
    window.addEventListener('pointerdown', onGesture, { capture: true, once: true })
    return () => window.removeEventListener('pointerdown', onGesture, true)
  }, [enabled, prime])

  const speak = useCallback((text: string) => {
    if (!SUPPORTED || !enabled || !text) return
    try {
      window.speechSynthesis.cancel() // latest-wins: a new notice preempts a stale one
      const u = new SpeechSynthesisUtterance(text)
      u.lang = detectLang(text)
      window.speechSynthesis.speak(u)
    } catch { /* ignore */ }
  }, [enabled])

  return { supported: SUPPORTED, enabled, setEnabled, speak }
}
