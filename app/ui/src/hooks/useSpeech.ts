import { useState, useEffect, useRef, useCallback } from 'react'
import { API } from './useApi'

// Voice notification read-back. Server-first: POST the notice to /api/voice/speak,
// which rewrites it into a spoken summary (Groq) and synthesizes a neural voice
// (edge-tts), and play the returned mp3 through a reused <audio> element. If the
// server path is unavailable (offline, 502, or audio not yet unlocked), fall back
// to the browser's Web Speech API — the v1 path, now the degradation tier.
//
// Foreground-only by construction: the one caller (useAttention.surfaceInterrupts)
// only speaks in its visible branch, where audio playback is actually allowed.

// "This browser can play audio." The neural path needs only <audio>, not
// speechSynthesis and not a server key — so the toggle is offered ~everywhere.
const SUPPORTED = typeof window !== 'undefined' && typeof Audio !== 'undefined'

const STORAGE_KEY = 'yaco.voiceReadback'

// CJK Ext-A + Unified + Compatibility Ideographs — any hit ⇒ a Mandarin voice
// (browser-fallback tier only; the neural voice is multilingual).
const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/

// A ~50ms silent mp3, played on the reused <audio> element inside the first
// gesture to unlock it for later programmatic playback (iOS gesture lock).
const SILENT_MP3 =
  'data:audio/mpeg;base64,SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYyLjMuMTAwAAAAAAAAAAAAAAD/84TAAAAAAAAAAAAASW5mbwAAAA8AAAAFAAABOACxsbGxsbGxsbGxsbGxsbGxsbGxxMTExMTExMTExMTExMTExMTExMTY2NjY2NjY2NjY2NjY2NjY2NjY2Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs//////////////////////////8AAAAATGF2YzYyLjExAAAAAAAAAAAAAAAAJARQAAAAAAAAAThc2UIYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/8xTEAAAAA0gAAAAATEFNRTMuMTAxICj/8xTECwAAA0gAAAAAYmV0YSAzKVVVVVX/8xTEFgAAA0gAAAAAVVVVVVVVVVVVVVX/8xTEIQAAA0gAAAAAVVVVVVVVVVVVVVX/8xTELAAAA0gAAAAAVVVVVVVVVVVVVVU='

function loadEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
}

/** Browser Web Speech API — the fallback tier. Checked at call time so tests (and
 *  SSR) don't bake the answer into a module constant. */
function browserTtsAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined'
  )
}

/** Pick the fallback utterance language. A zh-CN voice handles embedded English
 *  fine, so "any CJK ⇒ zh-CN" is the right split for the user's mixed 中英文. */
function detectLang(text: string): string {
  return CJK.test(text) ? 'zh-CN' : 'en-US'
}

function isAbortError(err: unknown): boolean {
  // Name-based, not `instanceof DOMException`: a rejected fetch and a rejected
  // play() may surface AbortError through different error classes.
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

export interface UseSpeech {
  /** The browser can play audio — gate the toggle UI on this. */
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
 * Server-first neural read-back with a browser-TTS fallback, plus latest-wins
 * preemption. A monotonic `speakIdRef` gates every action after an await, so a
 * stale request that resolves (or whose `play()` rejects) after a newer `speak()`
 * can never fire the fallback over fresh audio. An `AbortError` never falls back —
 * the abort means a newer speak (or a toggle-off) already owns playback.
 */
export function useSpeech(): UseSpeech {
  const [enabled, setEnabledState] = useState<boolean>(() => SUPPORTED && loadEnabled())
  // Synchronous source of truth for `speak`: a notification can arrive in the same
  // render the user toggles off, before an effect-updated value would propagate.
  const enabledRef = useRef(enabled)
  const primedRef = useRef(false)
  const speakIdRef = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const urlRef = useRef<string | null>(null)

  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) audioRef.current = new Audio()
    return audioRef.current
  }, [])

  const revokeUrl = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  // Latest-wins teardown: stop whatever the previous speak (or toggle) left running.
  const preempt = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    audioRef.current?.pause()
    if (browserTtsAvailable()) window.speechSynthesis.cancel()
    revokeUrl()
  }, [revokeUrl])

  // The v1 path, now the fallback tier. Callers gate on the generation id first.
  const speakViaBrowser = useCallback((text: string) => {
    if (!browserTtsAvailable() || !enabledRef.current) return
    try {
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = detectLang(text)
      window.speechSynthesis.speak(u)
    } catch { /* ignore */ }
  }, [])

  const prime = useCallback(() => {
    if (!SUPPORTED || primedRef.current) return
    // The unlock IS the in-gesture play() *call*, so mark primed optimistically.
    // If it's somehow blocked, the browser-TTS fallback tier still speaks.
    primedRef.current = true
    // Unlock the <audio> element (neural path): play a silent clip in-gesture.
    try {
      const audio = ensureAudio()
      audio.src = SILENT_MP3
      // Fire-and-forget: the clip is silent and ~50ms, so let it finish rather
      // than pausing at resolve time — a late pause could stop real TTS that a
      // speak() started on this reused element in the meantime.
      audio.play()?.catch(() => { /* autoplay policy; fallback tier still works */ })
    } catch { /* ignore */ }
    // Unlock speechSynthesis (fallback path) with a silent utterance.
    if (browserTtsAvailable()) {
      try {
        const u = new SpeechSynthesisUtterance(' ')
        u.volume = 0
        window.speechSynthesis.cancel()
        window.speechSynthesis.speak(u)
      } catch { /* ignore */ }
    }
  }, [ensureAudio])

  const speak = useCallback((text: string) => {
    if (!SUPPORTED || !enabledRef.current || !text) return
    const id = ++speakIdRef.current
    preempt()

    // True only while this exact speak still owns playback and read-back is on.
    const current = () => id === speakIdRef.current && enabledRef.current

    void (async () => {
      const controller = new AbortController()
      abortRef.current = controller
      let res: Response
      try {
        res = await fetch(`${API}/voice/speak`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        })
      } catch (err) {
        if (isAbortError(err) || !current()) return // a newer speak owns playback
        speakViaBrowser(text)
        return
      }
      if (!current()) return
      if (res.status === 204) return // nothing to say
      if (!res.ok) { speakViaBrowser(text); return } // 502 / 4xx → fallback

      let blob: Blob
      try {
        blob = await res.blob()
      } catch (err) {
        if (isAbortError(err) || !current()) return
        speakViaBrowser(text)
        return
      }
      if (!current()) return

      const audio = ensureAudio()
      revokeUrl()
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      audio.src = url
      try {
        await audio.play()
      } catch (err) {
        if (isAbortError(err) || !current()) return // superseded / aborted mid-play
        speakViaBrowser(text) // unprimed / autoplay-blocked → fallback tier
      }
    })()
  }, [preempt, speakViaBrowser, ensureAudio, revokeUrl])

  const setEnabled = useCallback((on: boolean) => {
    enabledRef.current = on // synchronous: speak() sees the new value immediately
    setEnabledState(on)
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0') } catch { /* ignore */ }
    if (!SUPPORTED) return
    if (on) {
      prime() // the toggle tap is a gesture → unlock now
    } else {
      // Bump the generation so a later re-enable can't resurrect an in-flight
      // speak's stale async branch (its `current()` would otherwise pass again
      // once enabledRef flips back true), then tear down resources.
      speakIdRef.current++
      preempt() // stop any in-flight read-back
    }
  }, [prime, preempt])

  // Restored-enabled after a reload has no gesture yet → unlock on the next tap,
  // before any notification needs to speak. once:true self-removes after firing.
  useEffect(() => {
    if (!SUPPORTED || !enabled || primedRef.current) return
    const onGesture = () => prime()
    window.addEventListener('pointerdown', onGesture, { capture: true, once: true })
    return () => window.removeEventListener('pointerdown', onGesture, true)
  }, [enabled, prime])

  // On unmount, fully preempt: a teardown mid-speak must not leave audio playing,
  // a fetch in flight, or a pending async branch able to act. Bumping the
  // generation makes every in-flight `current()` check fail; preempt() aborts the
  // fetch and pauses audio — that is the whole teardown. It must NOT touch
  // enabledRef: under StrictMode this cleanup runs once at mount, and clearing the
  // flag there would strand enabledRef=false while `enabled` (restored from
  // storage) stays true, silently no-op'ing speak().
  useEffect(() => () => {
    speakIdRef.current++
    preempt()
  }, [preempt])

  return { supported: SUPPORTED, enabled, setEnabled, speak }
}
