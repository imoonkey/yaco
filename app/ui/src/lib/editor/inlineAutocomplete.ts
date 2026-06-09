import {
  StateField,
  StateEffect,
  EditorSelection,
  Compartment,
  Prec,
} from '@codemirror/state'
import type { Extension, EditorState, Text } from '@codemirror/state'
import {
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType,
  keymap,
} from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import type { SuggestionEvent } from './suggestionMetrics'

// --- Provider contract ---

export type CompletionProvider = (
  prefix: string,
  suffix: string,
  filePath: string,
  signal: AbortSignal,
) => Promise<string>

// Content-free lifecycle sink. The extension only emits event names; storage and
// per-(project, worktree) keying live in suggestionMetrics, kept out of the
// editor so no document/suggestion text can reach the metrics layer.
export type SuggestionSink = (event: SuggestionEvent) => void
const noopSink: SuggestionSink = () => {}

// --- Tunable constants ---

// Debounce before an auto-triggered request fires. Cautious on purpose: prose
// writing should not flicker. Manual trigger bypasses the debounce.
export const SUGGESTION_DEBOUNCE_MS = 1000
const REQUEST_TIMEOUT_MS = 3000

// Markdown is the only in-scope file type (mirrors binaryFiles MARKDOWN_EXTS).
const MARKDOWN_EXTS = ['.md', '.markdown', '.mdx']

// --- File eligibility (defensive; Editor also mounts only for markdown) ---

function isMarkdownPath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return MARKDOWN_EXTS.some(ext => lower.endsWith(ext))
}

// Likely-secret files are excluded even when markdown — no content leaves the
// machine for these. Mirrors the server-side defensive gate.
export function isSecretPath(filePath: string): boolean {
  const segments = filePath.split('/')
  const base = segments[segments.length - 1] ?? filePath
  if (/^\.env/.test(base)) return true
  if (/\.(pem|key|crt)$/i.test(base)) return true
  if (base === 'id_rsa') return true
  if (segments.includes('.ssh')) return true
  if (segments.includes('secrets')) return true
  return false
}

function isEligibleFile(filePath: string): boolean {
  return isMarkdownPath(filePath) && !isSecretPath(filePath)
}

// --- Cursor-context guards ---

// Inside a fenced code block when an opener above the cursor is still unclosed.
// Tracks the opener's char and length so a shorter same-char line (or a
// different-char line) inside the block does not falsely close it; a closing
// fence must be the same char, at least as long, with only trailing whitespace.
export function isInsideFence(doc: Text, pos: number): boolean {
  const before = doc.sliceString(0, pos)
  let fence: { char: string; len: number } | null = null
  for (const line of before.split('\n')) {
    const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (!m) continue
    const char = m[1][0]
    const len = m[1].length
    if (!fence) {
      fence = { char, len } // opener (may carry an info string in m[2])
    } else if (char === fence.char && len >= fence.len && m[2].trim() === '') {
      fence = null // valid closing fence
    }
  }
  return fence !== null
}

// Mid-word when a word char sits on both sides of the cursor.
export function isMidWord(doc: Text, pos: number): boolean {
  const charBefore = pos > 0 ? doc.sliceString(pos - 1, pos) : ''
  const charAfter = pos < doc.length ? doc.sliceString(pos, pos + 1) : ''
  return /\w/.test(charBefore) && /\w/.test(charAfter)
}

// The ghost may span the current line plus one next line/block. The server already
// caps this; clamp defensively to MAX_GHOST_LINES non-empty lines.
const MAX_GHOST_LINES = 2
function clampGhostLines(text: string): string {
  const kept: string[] = []
  let content = 0
  for (const line of text.split('\n')) {
    if (line.trim()) {
      if (content === MAX_GHOST_LINES) break
      content++
    }
    kept.push(line)
  }
  return kept.join('\n').replace(/\s+$/, '')
}

// --- Suggestion state ---

type SuggestionState = { text: string; pos: number; docVersion: number } | null

// Carries a (possibly re-anchored) suggestion. The state field gives this effect
// priority over the doc/selection clear, so accept-word can mutate the doc while
// keeping the remainder visible; a plain edit (no effect) still clears.
const setSuggestion = StateEffect.define<SuggestionState>()

// Manual-invoke signal — the fetch plugin requests a suggestion at the cursor
// regardless of the length threshold.
const requestSuggestion = StateEffect.define<null>()

// Cancel signal — the fetch plugin clears the pending debounce + in-flight
// request and bumps its version so a late response is dropped; the state field
// clears any visible ghost. Dispatched on blur, paste, Esc, and dismiss.
const cancelSuggestion = StateEffect.define<null>()

const suggestionField = StateField.define<SuggestionState>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSuggestion)) return e.value
      if (e.is(cancelSuggestion)) return null
    }
    // Any other doc change or selection change clears a visible suggestion.
    if (value && (tr.docChanged || tr.selection)) return null
    return value
  },
})

// --- Ghost text widget (current line + an optional next line/block) ---

const GHOST_STYLE = {
  color: 'var(--sol-base1)',
  opacity: '0.7',
  fontStyle: 'italic',
} as const

class InlineGhostWidget extends WidgetType {
  text: string
  constructor(text: string) { super(); this.text = text }

  toDOM() {
    const span = document.createElement('span')
    span.textContent = this.text
    span.style.color = GHOST_STYLE.color
    span.style.opacity = GHOST_STYLE.opacity
    span.style.fontStyle = GHOST_STYLE.fontStyle
    span.style.whiteSpace = 'pre-wrap' // honor newlines so a next-line suggestion wraps below the cursor
    span.className = 'cm-inline-ghost'
    return span
  }

  eq(other: InlineGhostWidget) { return this.text === other.text }
  ignoreEvent() { return true }
}

// --- Decoration field ---

const ghostDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_, tr) {
    const suggestion = tr.state.field(suggestionField)
    if (!suggestion || !suggestion.text) return Decoration.none
    if (suggestion.pos > tr.state.doc.length) return Decoration.none

    return Decoration.set([
      Decoration.widget({ widget: new InlineGhostWidget(suggestion.text), side: 1 }).range(suggestion.pos),
    ])
  },
  provide: f => EditorView.decorations.from(f),
})

// --- Status cache (module-level, shared across editors) ---

let statusCache: { enabled: boolean; checkedAt: number } | null = null
const STATUS_BACKOFF_MS = 60_000

async function checkEnabled(): Promise<boolean> {
  if (statusCache && Date.now() - statusCache.checkedAt < STATUS_BACKOFF_MS) {
    return statusCache.enabled
  }
  try {
    const res = await fetch('/api/autocomplete/status')
    if (!res.ok) throw new Error()
    const data = await res.json()
    statusCache = { enabled: data.enabled === true, checkedAt: Date.now() }
  } catch {
    statusCache = { enabled: false, checkedAt: Date.now() }
  }
  return statusCache.enabled
}

// --- Fetch plugin ---

function createFetchPlugin(provider: CompletionProvider, filePath: string, onEvent: SuggestionSink) {
  const eligibleFile = isEligibleFile(filePath)

  return ViewPlugin.define(view => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let abortController: AbortController | null = null
    let enabled: boolean | null = null // null = not yet checked
    let fetchVersion = 0

    function initStatus() {
      checkEnabled().then(e => { enabled = e })
    }
    if (eligibleFile) initStatus()

    // Every cancellation path (blur, paste, Esc, dismiss, disable, destroy)
    // routes through here, so bumping the version uniformly drops any late
    // in-flight response that resolves after cancellation.
    function cancelPending() {
      if (debounceTimer != null) { clearTimeout(debounceTimer); debounceTimer = null }
      if (abortController) { abortController.abort(); abortController = null }
      fetchVersion++
    }

    // Context guards: only an empty selection, not mid-IME, not inside a fenced
    // code block, and not mid-word. Triggering itself is gated on genuine typing.
    function contextEligible(state: EditorState): boolean {
      const sel = state.selection.main
      if (!sel.empty) return false
      if (view.composing) return false
      if (isInsideFence(state.doc, sel.head)) return false
      if (isMidWord(state.doc, sel.head)) return false
      return true
    }

    async function fetchAt(pos: number, docLen: number, myVersion: number) {
      const controller = new AbortController()
      abortController = controller
      const { signal } = controller
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      const doc = view.state.doc
      const prefix = doc.sliceString(0, pos)
      const suffix = doc.sliceString(pos)

      try {
        const raw = await provider(prefix, suffix, filePath, signal)
        if (signal.aborted) return

        // Stale-response guard: version, cursor, AND doc length must still match.
        if (fetchVersion !== myVersion) return
        if (view.state.selection.main.head !== pos) return
        if (view.state.doc.length !== docLen) return

        const text = clampGhostLines(raw)
        if (text) {
          // shown: a server-produced ghost becomes visible.
          onEvent('shown')
          view.dispatch({
            effects: setSuggestion.of({ text, pos, docVersion: myVersion }),
          })
        }
      } catch {
        // A genuine provider/network rejection — not a user-cancel or timeout
        // abort (those set signal.aborted and are expected, not errors).
        if (signal.aborted) return
        onEvent('error')
      } finally {
        clearTimeout(timeout)
      }
    }

    function schedule(manual: boolean) {
      if (!enabled) return
      if (!contextEligible(view.state)) return
      // Auto-trigger never replaces a visible suggestion; manual may.
      if (!manual && view.state.field(suggestionField)) return

      cancelPending() // also advances fetchVersion
      const myVersion = fetchVersion
      const pos = view.state.selection.main.head
      const docLen = view.state.doc.length
      const run = () => {
        if (fetchVersion !== myVersion) return
        if (view.state.selection.main.head !== pos) return
        if (view.state.doc.length !== docLen) return
        void fetchAt(pos, docLen, myVersion)
      }
      if (manual) run()
      else debounceTimer = setTimeout(run, SUGGESTION_DEBOUNCE_MS)
    }

    return {
      update(update: ViewUpdate) {
        if (!eligibleFile) return

        // Re-check status after backoff if previously disabled/unknown.
        if (enabled === false && statusCache && Date.now() - statusCache.checkedAt >= STATUS_BACKOFF_MS) {
          initStatus()
        }
        if (!enabled) { cancelPending(); return }

        // Explicit cancel (blur, paste, Esc, dismiss): drop pending + in-flight.
        if (update.transactions.some(tr => tr.effects.some(e => e.is(cancelSuggestion)))) {
          cancelPending()
          return
        }

        // Manual invoke bypasses the length threshold.
        if (update.transactions.some(tr => tr.effects.some(e => e.is(requestSuggestion)))) {
          schedule(true)
          return
        }

        // Only genuine user typing auto-triggers — never paste, drop, accept,
        // or programmatic sync (CodeMirror tags paste/drop as `input` events too).
        const typing = update.transactions.some(tr => tr.isUserEvent('input.type'))
        if (!typing) {
          if (update.selectionSet || update.docChanged) cancelPending()
          return
        }

        // Genuine typing onto a visible ghost dismisses it (the state field's
        // reducer already cleared it); record that before scheduling the next.
        if (update.startState.field(suggestionField)) onEvent('dismissed_typing')

        // Skip replace-selection (non-empty selection before the change).
        if (!update.startState.selection.main.empty) return

        schedule(false)
      },

      destroy() {
        cancelPending()
      },
    }
  })
}

// --- Keymap (high-precedence) ---

function createGhostKeymap(onEvent: SuggestionSink) {
  return Prec.highest(keymap.of([
  {
    // Accept the full suggestion.
    key: 'Tab',
    run(view) {
      const suggestion = view.state.field(suggestionField)
      if (!suggestion) return false

      onEvent('accepted_full')
      view.dispatch({
        changes: { from: suggestion.pos, insert: suggestion.text },
        selection: EditorSelection.cursor(suggestion.pos + suggestion.text.length),
        effects: setSuggestion.of(null),
        annotations: isolateHistory.of('full'),
        userEvent: 'input.complete',
      })
      return true
    },
  },
  {
    // Dismiss: cancel pending/in-flight work and clear the ghost. Consume the
    // key only when a ghost was visible, so Esc still reaches other handlers
    // (e.g. search panel) when there is nothing to dismiss.
    key: 'Escape',
    run(view) {
      const had = view.state.field(suggestionField) != null
      if (had) onEvent('dismissed_escape')
      view.dispatch({ effects: cancelSuggestion.of(null) })
      return had
    },
  },
  {
    // Manual invoke at the cursor (ignores the length threshold). Alt-Tab keeps
    // the suggestion keys clustered around Tab; on macOS this is Option-Tab.
    key: 'Alt-Tab',
    run(view) {
      view.dispatch({ effects: requestSuggestion.of(null) })
      return true
    },
  },
  ]))
}

// --- Blur/paste handler (also cancels pending work) ---

const eventHandlers = EditorView.domEventHandlers({
  // Cancel pending/in-flight work and clear the ghost when focus leaves — a
  // request scheduled during debounce must not fire after blur.
  blur(_, view) {
    view.dispatch({ effects: cancelSuggestion.of(null) })
    return false
  },
  // Cancel + clear before paste so the widget decoration doesn't interfere with
  // the paste position, and a pending request can't race the pasted text.
  paste(_, view) {
    view.dispatch({ effects: cancelSuggestion.of(null) })
    return false // let CM6 handle the actual paste
  },
})

// --- Compartment & Export ---

export const autocompleteCompartment = new Compartment()

export function inlineAutocomplete(
  provider: CompletionProvider,
  filePath: string,
  onEvent: SuggestionSink = noopSink,
): Extension {
  return [
    suggestionField,
    ghostDecorations,
    createFetchPlugin(provider, filePath, onEvent),
    createGhostKeymap(onEvent),
    eventHandlers,
  ]
}
