import {
  StateField,
  StateEffect,
  EditorSelection,
  Compartment,
  Prec,
} from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import {
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType,
  keymap,
} from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import { SOLARIZED_LIGHT } from '../solarizedLight'

// --- Provider contract ---

export type CompletionProvider = (
  prefix: string,
  suffix: string,
  filePath: string,
  signal: AbortSignal,
) => Promise<string>

// --- Suggestion state ---

type SuggestionState = { text: string; pos: number; docVersion: number } | null

const setSuggestion = StateEffect.define<SuggestionState>()

const suggestionField = StateField.define<SuggestionState>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSuggestion)) return e.value
    }
    // Clear on any doc change or explicit selection change
    if (value && (tr.docChanged || tr.selection)) return null
    return value
  },
})

// --- Ghost text widgets ---

const GHOST_STYLE = {
  color: SOLARIZED_LIGHT.base1,
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
    span.className = 'cm-inline-ghost'
    return span
  }

  eq(other: InlineGhostWidget) { return this.text === other.text }
  ignoreEvent() { return true }
}

class BlockGhostWidget extends WidgetType {
  lines: string[]
  constructor(lines: string[]) { super(); this.lines = lines }

  toDOM() {
    const div = document.createElement('div')
    div.style.color = GHOST_STYLE.color
    div.style.opacity = GHOST_STYLE.opacity
    div.style.fontStyle = GHOST_STYLE.fontStyle
    div.style.whiteSpace = 'pre'
    div.className = 'cm-block-ghost'
    div.textContent = this.lines.join('\n')
    return div
  }

  eq(other: BlockGhostWidget) {
    return this.lines.length === other.lines.length &&
      this.lines.every((l, i) => l === other.lines[i])
  }

  ignoreEvent() { return true }
}

// --- Decoration field ---

const ghostDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_, tr) {
    const suggestion = tr.state.field(suggestionField)
    if (!suggestion) return Decoration.none

    const { text, pos } = suggestion
    if (pos > tr.state.doc.length) return Decoration.none

    const lines = text.split('\n')
    const line = tr.state.doc.lineAt(pos)
    const atEol = pos === line.to

    const decos = [
      Decoration.widget({ widget: new InlineGhostWidget(lines[0]), side: 1 }).range(pos),
    ]

    // Only render multi-line ghost text when cursor is at end of line
    if (lines.length > 1 && atEol) {
      decos.push(
        Decoration.widget({
          widget: new BlockGhostWidget(lines.slice(1)),
          block: true,
          side: 1,
        }).range(line.to),
      )
    }

    return Decoration.set(decos, true)
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

function createFetchPlugin(provider: CompletionProvider, filePath: string) {
  return ViewPlugin.define(view => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let abortController: AbortController | null = null
    let enabled: boolean | null = null // null = not yet checked
    let fetchVersion = 0

    function initStatus() {
      checkEnabled().then(e => { enabled = e })
    }
    initStatus()

    function cancelPending() {
      if (debounceTimer != null) { clearTimeout(debounceTimer); debounceTimer = null }
      if (abortController) { abortController.abort(); abortController = null }
    }

    return {
      update(update: ViewUpdate) {
        // Re-check status after backoff if previously disabled/unknown
        if (enabled === false && statusCache && Date.now() - statusCache.checkedAt >= STATUS_BACKOFF_MS) {
          initStatus()
        }
        if (!enabled) {
          // Cancel any pending work if we just got disabled
          cancelPending()
          return
        }

        // Cancel pending on any non-typing invalidation (cursor move, selection change, external refresh)
        if (!update.transactions.some(tr => tr.isUserEvent('input') && !tr.isUserEvent('input.complete'))) {
          if (update.selectionSet || update.docChanged) {
            cancelPending()
          }
          return
        }

        // Skip if pre-change selection was non-empty (replace-selection)
        if (!update.startState.selection.main.empty) return

        // Skip non-empty post-change selection
        if (!update.state.selection.main.empty) return

        // Skip IME composition
        if (view.composing) return

        // Minimum chars threshold: require at least 3 non-whitespace chars on current line before cursor
        const pos = update.state.selection.main.head
        const line = update.state.doc.lineAt(pos)
        const lineTextBeforeCursor = update.state.doc.sliceString(line.from, pos)
        if (lineTextBeforeCursor.trim().length < 3) return

        cancelPending()
        fetchVersion++

        const myVersion = fetchVersion
        const docLen = update.state.doc.length

        debounceTimer = setTimeout(async () => {
          // Re-validate before fetching — doc/cursor may have changed during debounce
          if (fetchVersion !== myVersion) return
          if (view.state.selection.main.head !== pos) return
          if (view.state.doc.length !== docLen) return

          abortController = new AbortController()
          const { signal } = abortController

          const doc = view.state.doc
          const prefix = doc.sliceString(0, pos)
          const suffix = doc.sliceString(pos)

          try {
            const text = await provider(prefix, suffix, filePath, signal)
            if (signal.aborted) return

            // Stale response guard: version, cursor, AND doc length must still match
            if (fetchVersion !== myVersion) return
            if (view.state.selection.main.head !== pos) return
            if (view.state.doc.length !== docLen) return

            if (text) {
              view.dispatch({
                effects: setSuggestion.of({ text, pos, docVersion: myVersion }),
              })
            }
          } catch (err) {
            if (signal.aborted) return
          }
        }, 1500)
      },

      destroy() {
        cancelPending()
      },
    }
  })
}

// --- Keymap (high-precedence) ---

const ghostKeymap = Prec.highest(keymap.of([
  {
    key: 'Tab',
    run(view) {
      const suggestion = view.state.field(suggestionField)
      if (!suggestion) return false

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
    key: 'Escape',
    run(view) {
      if (!view.state.field(suggestionField)) return false
      view.dispatch({ effects: setSuggestion.of(null) })
      return true
    },
  },
]))

// --- Blur/paste handler (also cancels pending work) ---

const eventHandlers = EditorView.domEventHandlers({
  blur(_, view) {
    if (view.state.field(suggestionField)) {
      view.dispatch({ effects: setSuggestion.of(null) })
    }
    return false
  },
  // Clear ghost text before paste so widget decoration doesn't interfere with paste position
  paste(_, view) {
    if (view.state.field(suggestionField)) {
      view.dispatch({ effects: setSuggestion.of(null) })
    }
    return false // let CM6 handle the actual paste
  },
})

// --- Compartment & Export ---

export const autocompleteCompartment = new Compartment()

export function inlineAutocomplete(
  provider: CompletionProvider,
  filePath: string,
): Extension {
  return [
    suggestionField,
    ghostDecorations,
    createFetchPlugin(provider, filePath),
    ghostKeymap,
    eventHandlers,
  ]
}
